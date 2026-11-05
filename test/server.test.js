const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crisp-test-"));
process.env.CRISP_DATA_DIR = dataDir;
process.env.CRISP_MAX_RESPONSE_BYTES = String(64 * 1024);

const { start, validRoutePath, validateEndpoint, routeMatches, hostIsLoopback, originIsAllowed } = require("../server.js");

let gateway;
let upstream;
let base;
let upstreamBase;

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${urlPath}`, { method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json, complete: res.complete });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function createRoute(route) {
  return request("POST", "/api/endpoints", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(route),
  });
}

before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url.startsWith("/big")) {
      // Larger than the 64 KB test limit, sent without a Content-Length.
      res.writeHead(200, { "content-type": "text/plain" });
      for (let i = 0; i < 20; i += 1) res.write("x".repeat(8 * 1024));
      return res.end();
    }
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=1" });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || null,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
  });
  upstreamBase = `http://127.0.0.1:${await listen(upstream)}`;
  gateway = await start(0);
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(() => {
  gateway.close();
  upstream.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("validation helpers", () => {
  test("validRoutePath accepts normal paths and rejects reserved or unsafe ones", () => {
    assert.equal(validRoutePath("/users"), true);
    assert.equal(validRoutePath("/users/:id"), true);
    for (const bad of ["users", "/api/x", "/gateway", "/a/../b", "/a?b", "/a b", "/" + "x".repeat(200)]) {
      assert.equal(validRoutePath(bad), false, bad);
    }
  });

  test("validateEndpoint rejects bad methods, URLs and embedded credentials", () => {
    const good = { name: "Users", method: "GET", path: "/users", upstreamUrl: "https://example.com/users" };
    assert.equal(validateEndpoint(good), null);
    assert.match(validateEndpoint({ ...good, method: "TRACE" }), /Choose/);
    assert.match(validateEndpoint({ ...good, upstreamUrl: "ftp://example.com" }), /HTTP or HTTPS/);
    assert.match(validateEndpoint({ ...good, upstreamUrl: "https://user:pw@example.com" }), /credentials/);
    assert.match(validateEndpoint({ ...good, upstreamUrl: "https://example.com/#x" }), /fragment/);
    assert.match(validateEndpoint({ ...good, name: " " }), /Name/);
  });

  test("routeMatches extracts parameters and requires equal segment counts", () => {
    assert.deepEqual(routeMatches("/users/:id", "/users/42"), { id: "42" });
    assert.deepEqual(routeMatches("/users", "/users"), {});
    assert.equal(routeMatches("/users/:id", "/users"), null);
    assert.equal(routeMatches("/users/:id", "/posts/42"), null);
  });

  test("hostIsLoopback and originIsAllowed only trust loopback on the right port", () => {
    assert.equal(hostIsLoopback("127.0.0.1:3000", 3000), true);
    assert.equal(hostIsLoopback("LOCALHOST:3000", 3000), true);
    assert.equal(hostIsLoopback("127.0.0.1:3001", 3000), false);
    assert.equal(hostIsLoopback("evil.example:3000", 3000), false);
    assert.equal(hostIsLoopback(undefined, 3000), false);
    assert.equal(originIsAllowed(undefined, 3000), true);
    assert.equal(originIsAllowed("http://localhost:3000", 3000), true);
    assert.equal(originIsAllowed("https://evil.example", 3000), false);
    assert.equal(originIsAllowed("null", 3000), false);
  });
});

describe("admin API protections", () => {
  test("rejects a cross-site text/plain POST (CSRF) and does not create the route", async () => {
    const res = await request("POST", "/api/endpoints", {
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ name: "pwn", method: "GET", path: "/pwn", upstreamUrl: "https://evil.example" }),
    });
    assert.equal(res.status, 403);
    const config = await request("GET", "/api/config");
    assert.equal(config.json.endpoints.some(e => e.path === "/pwn"), false);
  });

  test("rejects a same-origin POST that is not application/json", async () => {
    const res = await request("POST", "/api/endpoints", {
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(res.status, 415);
  });

  test("rejects requests whose Host header is not loopback (DNS rebinding)", async () => {
    const res = await request("GET", "/api/config", { headers: { host: "attacker-rebind.example" } });
    assert.equal(res.status, 421);
  });

  test("accepts same-origin JSON requests from the dashboard", async () => {
    const res = await request("GET", "/api/config", { headers: { origin: base } });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.endpoints));
  });

  test("creates, updates and deletes a route, and persists it to disk", async () => {
    const created = await createRoute({ name: "Temp", method: "GET", path: "/temp", upstreamUrl: `${upstreamBase}/temp` });
    assert.equal(created.status, 201);
    const { id } = created.json.endpoint;
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.ok(saved.endpoints.some(e => e.id === id));

    const updated = await request("PUT", `/api/endpoints/${id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Temp 2", method: "GET", path: "/temp2", upstreamUrl: `${upstreamBase}/temp2` }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.endpoint.path, "/temp2");

    const deleted = await request("DELETE", `/api/endpoints/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal((await request("DELETE", `/api/endpoints/${id}`)).status, 404);
  });
});

describe("gateway proxy", () => {
  before(async () => {
    assert.equal((await createRoute({ name: "Echo", method: "ALL", path: "/echo/:id", upstreamUrl: `${upstreamBase}/items/{id}` })).status, 201);
    assert.equal((await createRoute({ name: "Big", method: "GET", path: "/big", upstreamUrl: `${upstreamBase}/big` })).status, 201);
  });

  test("forwards method, route params, query, body and allowed headers", async () => {
    const res = await request("POST", "/gateway/echo/a%20b?x=1", {
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: '{"hello":"world"}',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { method: "POST", url: "/items/a%20b?x=1", auth: "Bearer t", body: '{"hello":"world"}' });
    assert.equal(res.headers["set-cookie"], undefined, "upstream cookies must not be set on the gateway origin");
  });

  test("returns 404 when no route matches", async () => {
    assert.equal((await request("GET", "/gateway/nope")).status, 404);
  });

  test("returns 400 instead of 500 for malformed percent-encoding", async () => {
    const res = await request("GET", "/gateway/%E0%A4%A");
    assert.equal(res.status, 400);
  });

  test("does not crash on a parameter that decodes to a bare %", async () => {
    const res = await request("GET", "/gateway/echo/%25");
    assert.equal(res.status, 200);
    assert.equal(res.json.url, "/items/%25");
  });

  test("cuts off upstream responses larger than the limit", async () => {
    const res = await request("GET", "/gateway/big").catch(error => ({ error }));
    assert.ok(res.error || res.complete === false || res.text.length <= 64 * 1024, "oversized body must not be delivered in full");
    const logs = await request("GET", "/api/logs");
    assert.equal(logs.json.logs.find(log => log.path === "/big").status, 502);
  });

  test("rejects oversized request bodies with 413", async () => {
    const res = await request("POST", "/gateway/echo/1", {
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(1024 * 1024 + 1),
    }).catch(error => ({ error }));
    if (!res.error) assert.equal(res.status, 413);
  });
});

describe("static pages", () => {
  test("serves the dashboard and bookstore, 404s everything else", async () => {
    assert.equal((await request("GET", "/")).status, 200);
    assert.equal((await request("GET", "/bookstore.html")).status, 200);
    assert.equal((await request("GET", "/server.js")).status, 404);
  });
});
