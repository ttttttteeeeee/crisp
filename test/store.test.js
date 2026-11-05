const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crisp-store-test-"));
process.env.CRISP_DATA_DIR = dataDir;

const { start } = require("../server.js");
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "books.json"), "utf8"));

let gateway;
let base;
let openLibrary;
let openLibraryRequests = [];

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${urlPath}`, { method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postOrder = (payload, headers = {}) => request("POST", "/store/api/orders", {
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(payload),
});

before(async () => {
  // Stand-in for openlibrary.org/search.json, returning the same response shape.
  openLibrary = http.createServer((req, res) => {
    openLibraryRequests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ numFound: 1, docs: [{ key: "/works/OL1W", title: "A Wizard of Earthsea", author_name: ["Ursula K. Le Guin"], first_publish_year: 1968, cover_i: 1 }] }));
  });
  await new Promise(resolve => openLibrary.listen(0, "127.0.0.1", resolve));
  gateway = await start(0);
  base = `http://127.0.0.1:${gateway.address().port}`;
});

after(() => {
  gateway.close();
  openLibrary.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("catalog", () => {
  test("lists every book with categories and a total", async () => {
    const res = await request("GET", "/store/api/books");
    assert.equal(res.status, 200);
    assert.equal(res.json.books.length, catalog.length);
    assert.equal(res.json.total, catalog.length);
    assert.deepEqual(res.json.categories, ["All", "Fiction", "Technology", "Science", "Biography", "Fantasy"]);
  });

  test("searches title, author and category case-insensitively", async () => {
    const byAuthor = await request("GET", "/store/api/books?q=TOLKIEN");
    assert.deepEqual(byAuthor.json.books.map(book => book.title), ["The Hobbit"]);
    const none = await request("GET", "/store/api/books?q=zzzz");
    assert.equal(none.json.books.length, 0);
  });

  test("filters by category and sorts by price and title", async () => {
    const science = await request("GET", "/store/api/books?category=Science&sort=low");
    assert.ok(science.json.books.every(book => book.category === "Science"));
    const prices = science.json.books.map(book => book.price);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    const high = await request("GET", "/store/api/books?sort=high");
    assert.equal(high.json.books[0].price, Math.max(...catalog.map(book => book.price)));
    const titles = (await request("GET", "/store/api/books?sort=title")).json.books.map(book => book.title);
    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));
  });

  test("ignores an unknown sort instead of failing", async () => {
    const res = await request("GET", "/store/api/books?sort=bogus");
    assert.equal(res.status, 200);
    assert.equal(res.json.books[0].id, catalog[0].id);
  });

  test("returns one book by id, 404 for an unknown id", async () => {
    const res = await request("GET", "/store/api/books/12");
    assert.equal(res.status, 200);
    assert.equal(res.json.book.title, "Dune");
    assert.ok(res.json.book.description);
    assert.equal((await request("GET", "/store/api/books/999")).status, 404);
  });

  test("every catalog book can be opened by id for the details view", async () => {
    for (const book of catalog) {
      const res = await request("GET", `/store/api/books/${book.id}`);
      assert.equal(res.status, 200, `book ${book.id}`);
      assert.equal(res.json.book.title, book.title);
      assert.ok(res.json.book.description.length > 20, `book ${book.id} needs a description`);
    }
  });

  test("returns 404 for a non-numeric book id", async () => {
    const res = await request("GET", "/store/api/books/abc");
    assert.equal(res.status, 404);
    assert.ok(res.json.error);
  });
});

describe("orders", () => {
  test("computes prices on the server and ignores any price the client sends", async () => {
    const res = await postOrder({ items: [{ id: 1, quantity: 2, price: 0.01 }, { id: 3, quantity: 1 }], subtotal: 0 });
    assert.equal(res.status, 201);
    const { order } = res.json;
    assert.match(order.id, /^CR-[0-9A-F]{8}$/);
    assert.equal(order.items[0].unitPrice, 24.99);
    assert.equal(order.items[0].lineTotal, 49.98);
    assert.equal(order.subtotal, 68.48); // 2 × 24.99 + 18.50, with no floating-point drift
    assert.equal(order.itemCount, 3);
  });

  test("saves orders to disk and returns them by id", async () => {
    const { order } = (await postOrder({ items: [{ id: 12, quantity: 1 }], name: "Asha" })).json;
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "orders.json"), "utf8"));
    assert.ok(saved.some(entry => entry.id === order.id));
    const fetched = await request("GET", `/store/api/orders/${order.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.order.name, "Asha");
    assert.equal((await request("GET", "/store/api/orders/CR-00000000")).status, 404);
  });

  test("rejects empty bags, unknown books, bad quantities and duplicates", async () => {
    const cases = [
      {},
      { items: [] },
      { items: [{ id: 999, quantity: 1 }] },
      { items: [{ id: 1, quantity: 0 }] },
      { items: [{ id: 1, quantity: 21 }] },
      { items: [{ id: 1, quantity: 1.5 }] },
      { items: [{ id: "1", quantity: 1 }] },
      { items: [{ id: 1, quantity: 1 }, { id: 1, quantity: 2 }] },
      { items: [{ id: 1, quantity: 1 }], name: "x".repeat(81) },
    ];
    for (const payload of cases) {
      const res = await postOrder(payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.ok(res.json.error);
    }
  });

  test("rejects order requests from other sites and non-JSON bodies", async () => {
    assert.equal((await postOrder({ items: [{ id: 1, quantity: 1 }] }, { origin: "https://evil.example" })).status, 403);
    const plain = await request("POST", "/store/api/orders", { headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(plain.status, 415);
  });

  test("returns 404 for unknown store routes", async () => {
    assert.equal((await request("GET", "/store/api/nope")).status, 404);
  });
});

describe("discovery through the gateway", () => {
  test("a fresh install comes with a GET /discover route to Open Library", async () => {
    const { endpoints } = (await request("GET", "/api/config")).json;
    const route = endpoints.find(endpoint => endpoint.path === "/discover");
    assert.ok(route);
    assert.equal(route.method, "GET");
    assert.equal(route.upstreamUrl, "https://openlibrary.org/search.json");
  });

  test("the bookstore's search request is forwarded with its query", async () => {
    const { endpoints } = (await request("GET", "/api/config")).json;
    const route = endpoints.find(endpoint => endpoint.path === "/discover");
    const upstreamUrl = `http://127.0.0.1:${openLibrary.address().port}/search.json`;
    const updated = await request("PUT", `/api/endpoints/${route.id}`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: route.name, method: "GET", path: "/discover", upstreamUrl }),
    });
    assert.equal(updated.status, 200);
    const res = await request("GET", "/gateway/discover?q=earthsea&limit=12&fields=key,title");
    assert.equal(res.status, 200);
    assert.equal(res.json.docs[0].title, "A Wizard of Earthsea");
    assert.equal(openLibraryRequests.at(-1), "/search.json?q=earthsea&limit=12&fields=key%2Ctitle");
  });
});
