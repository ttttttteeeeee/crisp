const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createStore } = require("./store.js");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = process.env.CRISP_DATA_DIR ? path.resolve(process.env.CRISP_DATA_DIR) : path.join(ROOT, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = Number(process.env.CRISP_MAX_RESPONSE_BYTES || 10 * 1024 * 1024);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);
const MAX_LOG_ENTRIES = 100;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"]);
// Added on first start so the bookstore's "Discover more" search works out of the box.
const DEFAULT_ENDPOINTS = [{
  name: "Open Library search",
  method: "GET",
  path: "/discover",
  upstreamUrl: "https://openlibrary.org/search.json",
}];
const logs = [];

let config = { repository: null, endpoints: [] };
let saveQueue = Promise.resolve();

function jsonResponse(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJson(req) {
  // Browsers can send text/plain or form bodies cross-site without a CORS preflight.
  // Requiring application/json forces a preflight, which this server never approves.
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw httpError(415, "Content-Type must be application/json.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "Request body exceeds the 1 MB limit.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON.");
  }
}

function saveConfig() {
  const snapshot = JSON.stringify(config, null, 2);
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temporaryFile = `${CONFIG_FILE}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, snapshot, "utf8");
    await fs.rename(temporaryFile, CONFIG_FILE);
  });
  return saveQueue;
}

function validRoutePath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && value.length <= 200
    && !/[?#\\\s]/.test(value)
    && !value.split("/").some(part => part === "." || part === "..")
    && !/^\/(?:api|gateway)(?:\/|$)/.test(value);
}

function validateEndpoint(input) {
  if (!input || typeof input !== "object") return "Endpoint details are required.";
  if (!METHODS.has(input.method)) return "Choose GET, POST, PUT, PATCH, DELETE, or ALL.";
  if (!validRoutePath(input.path)) return "Path must start with / and cannot use reserved /api or /gateway paths.";
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80) return "Name is required (80 characters max).";
  if (typeof input.upstreamUrl !== "string" || input.upstreamUrl.length > 2048) return "A valid upstream URL is required.";
  let upstream;
  try {
    upstream = new URL(input.upstreamUrl);
  } catch {
    return "Enter a valid upstream URL.";
  }
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password) {
    return "Upstream URL must use HTTP or HTTPS and cannot include embedded credentials.";
  }
  if (upstream.hash) return "Upstream URL cannot contain a fragment.";
  return null;
}

function routeMatches(routePath, requestPath) {
  const routeParts = routePath.split("/").filter(Boolean);
  const requestParts = requestPath.split("/").filter(Boolean);
  if (routeParts.length !== requestParts.length) return null;
  const params = {};
  for (let index = 0; index < routeParts.length; index += 1) {
    const routePart = routeParts[index];
    if (routePart.startsWith(":")) {
      params[routePart.slice(1)] = requestParts[index];
    } else if (routePart !== requestParts[index]) {
      return null;
    }
  }
  return params;
}

// The server listens on loopback only, but a web page in the user's own browser can still
// reach it. Reject requests whose Host is not a loopback name (DNS rebinding) and admin
// requests that come from any other site (cross-site request forgery).
function hostIsLoopback(hostHeader, port) {
  if (typeof hostHeader !== "string") return false;
  const match = hostHeader.toLowerCase().match(/^([a-z0-9.-]+)(?::(\d+))?$/);
  if (!match || !LOOPBACK_HOSTNAMES.has(match[1])) return false;
  return match[2] === undefined ? port === 80 : Number(match[2]) === port;
}

function originIsAllowed(originHeader, port) {
  if (originHeader === undefined) return true; // Non-browser clients such as curl send no Origin.
  try {
    const origin = new URL(originHeader);
    return origin.protocol === "http:" && hostIsLoopback(origin.host, port);
  } catch {
    return false;
  }
}

function addLog(entry) {
  logs.unshift({ ...entry, time: new Date().toISOString() });
  if (logs.length > MAX_LOG_ENTRIES) logs.length = MAX_LOG_ENTRIES;
}

function getPublicEndpoint(endpoint) {
  return {
    id: endpoint.id,
    name: endpoint.name,
    method: endpoint.method,
    path: endpoint.path,
    upstreamUrl: endpoint.upstreamUrl,
    createdAt: endpoint.createdAt,
  };
}

async function connectGitHub(body) {
  if (!body || typeof body.url !== "string") {
    return { status: 400, error: "Enter a public GitHub repository URL." };
  }
  let parsed;
  try {
    parsed = new URL(body.url.trim());
  } catch {
    return { status: 400, error: "Enter a valid GitHub repository URL." };
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parts.length < 2) {
    return { status: 400, error: "Use a public repository URL like https://github.com/owner/repository." };
  }
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return { status: 400, error: "That repository URL is not valid." };
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Crisp-Mini-API-Gateway" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      if (response.status === 404) return { status: 404, error: "Repository not found or not public." };
      if (response.status === 403 || response.status === 429) return { status: response.status, error: "GitHub API rate limit reached. Try again later." };
      return { status: 502, error: `GitHub returned HTTP ${response.status}.` };
    }
    const repository = await response.json();
    config.repository = {
      fullName: repository.full_name,
      url: repository.html_url,
      defaultBranch: repository.default_branch,
      description: repository.description || "",
      stars: repository.stargazers_count,
      connectedAt: new Date().toISOString(),
    };
    await saveConfig();
    return { status: 200, repository: config.repository };
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return { status: 504, error: "GitHub did not respond in time." };
    }
    console.error("GitHub repository lookup failed:", error.message);
    return { status: 502, error: "Could not reach GitHub. Check your connection and try again." };
  }
}

async function handleAdmin(req, res, url) {
  if (url.pathname === "/api/config" && req.method === "GET") {
    return jsonResponse(res, 200, { repository: config.repository, endpoints: config.endpoints.map(getPublicEndpoint) });
  }
  if (url.pathname === "/api/logs" && req.method === "GET") {
    return jsonResponse(res, 200, { logs });
  }
  if (url.pathname === "/api/github/connect" && req.method === "POST") {
    const result = await connectGitHub(await readJson(req));
    if (result.error) return jsonResponse(res, result.status, { error: result.error });
    return jsonResponse(res, result.status, { repository: result.repository });
  }
  if (url.pathname === "/api/github/connect" && req.method === "DELETE") {
    config.repository = null;
    await saveConfig();
    return jsonResponse(res, 200, { repository: null });
  }
  if (url.pathname === "/api/endpoints" && req.method === "POST") {
    const input = await readJson(req);
    const error = validateEndpoint(input);
    if (error) return jsonResponse(res, 400, { error });
    if (config.endpoints.length >= 50) return jsonResponse(res, 400, { error: "The gateway supports up to 50 endpoints." });
    const endpoint = {
      id: randomUUID(),
      name: input.name.trim(),
      method: input.method,
      path: input.path,
      upstreamUrl: input.upstreamUrl.trim(),
      createdAt: new Date().toISOString(),
    };
    config.endpoints.push(endpoint);
    await saveConfig();
    return jsonResponse(res, 201, { endpoint: getPublicEndpoint(endpoint) });
  }
  const endpointMatch = url.pathname.match(/^\/api\/endpoints\/([0-9a-f-]+)$/i);
  if (endpointMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const index = config.endpoints.findIndex(endpoint => endpoint.id === endpointMatch[1]);
    if (index < 0) return jsonResponse(res, 404, { error: "Endpoint not found." });
    if (req.method === "DELETE") {
      config.endpoints.splice(index, 1);
      await saveConfig();
      return jsonResponse(res, 200, { deleted: true });
    }
    const input = await readJson(req);
    const error = validateEndpoint(input);
    if (error) return jsonResponse(res, 400, { error });
    config.endpoints[index] = {
      ...config.endpoints[index],
      name: input.name.trim(),
      method: input.method,
      path: input.path,
      upstreamUrl: input.upstreamUrl.trim(),
    };
    await saveConfig();
    return jsonResponse(res, 200, { endpoint: getPublicEndpoint(config.endpoints[index]) });
  }
  return jsonResponse(res, 404, { error: "Admin API route not found." });
}

function safeDecodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function proxyRequest(req, res, url) {
  let requestPath;
  try {
    requestPath = decodeURI(url.pathname.slice("/gateway".length)) || "/";
  } catch {
    return jsonResponse(res, 400, { error: "The request path is not valid URL encoding." });
  }
  const endpoint = config.endpoints.find(item => {
    const methodMatches = item.method === "ALL" || item.method === req.method;
    return methodMatches && routeMatches(item.path, requestPath) !== null;
  });
  if (!endpoint) {
    addLog({ method: req.method, path: requestPath, status: 404, durationMs: 0 });
    return jsonResponse(res, 404, { error: "No gateway endpoint matches this method and path." });
  }
  const params = routeMatches(endpoint.path, requestPath);
  let upstreamUrl = endpoint.upstreamUrl;
  for (const [key, value] of Object.entries(params)) {
    upstreamUrl = upstreamUrl.replaceAll(`{${key}}`, encodeURIComponent(safeDecodeComponent(value)));
  }
  const target = new URL(upstreamUrl);
  url.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  const startedAt = Date.now();
  try {
    const headers = {};
    for (const name of ["accept", "content-type", "authorization", "x-api-key"]) {
      const value = req.headers[name];
      if (value) headers[name] = value;
    }
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBodyBuffer(req);
    const upstreamResponse = await fetch(target, {
      method: req.method === "ALL" ? "GET" : req.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const declaredLength = Number(upstreamResponse.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await upstreamResponse.body?.cancel();
      throw httpError(502, "The upstream response is larger than the gateway allows.");
    }
    const responseHeaders = {};
    for (const [name, value] of upstreamResponse.headers) {
      if (!["connection", "transfer-encoding", "content-encoding", "content-length", "set-cookie"].includes(name.toLowerCase())) {
        responseHeaders[name] = value;
      }
    }
    res.writeHead(upstreamResponse.status, responseHeaders);
    let truncated = false;
    if (req.method === "HEAD" || !upstreamResponse.body) {
      res.end();
    } else {
      // Stream instead of buffering, and stop if the body grows past the limit.
      let received = 0;
      for await (const chunk of upstreamResponse.body) {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          truncated = true;
          break;
        }
        if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve));
      }
      if (truncated) res.destroy();
      else res.end();
    }
    addLog({ method: req.method, path: requestPath, status: truncated ? 502 : upstreamResponse.status, durationMs: Date.now() - startedAt });
  } catch (error) {
    const status = error.status || (error.name === "TimeoutError" || error.name === "AbortError" ? 504 : 502);
    addLog({ method: req.method, path: requestPath, status, durationMs: Date.now() - startedAt });
    if (!res.headersSent) jsonResponse(res, status, { error: error.status ? error.message : "The upstream request failed or timed out." });
    else res.destroy();
  }
}

async function readBodyBuffer(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "Request body exceeds the 1 MB limit.");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function serve(req, res) {
  const port = req.socket.localPort;
  if (!hostIsLoopback(req.headers.host, port)) {
    return jsonResponse(res, 421, { error: "This gateway only answers requests addressed to 127.0.0.1 or localhost." });
  }
  const url = new URL(req.url, `http://${HOST}:${port}`);
  if (url.pathname.startsWith("/store/api/")) {
    if (!originIsAllowed(req.headers.origin, port)) {
      return jsonResponse(res, 403, { error: "Store requests from other sites are not allowed." });
    }
    return store.handle(req, res, url);
  }
  if (url.pathname.startsWith("/api/")) {
    if (!originIsAllowed(req.headers.origin, port)) {
      return jsonResponse(res, 403, { error: "Admin requests from other sites are not allowed." });
    }
    return handleAdmin(req, res, url);
  }
  if (url.pathname === "/gateway" || url.pathname.startsWith("/gateway/")) return proxyRequest(req, res, url);
  if (req.method !== "GET" && req.method !== "HEAD") return jsonResponse(res, 405, { error: "Method not allowed." });
  const pages = {
    "/": "crisp.html",
    "/crisp.html": "crisp.html",
    "/bookstore.html": "bookstore.html",
  };
  const pageName = pages[url.pathname];
  if (!pageName) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const page = await fs.readFile(path.join(ROOT, pageName));
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page);
}

const store = createStore({
  catalogFile: path.join(ROOT, "books.json"),
  dataDir: DATA_DIR,
  readJson,
  jsonResponse,
  httpError,
});

async function loadConfig() {
  config = { repository: null, endpoints: [] };
  try {
    const saved = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
    if (Array.isArray(saved.endpoints)) config.endpoints = saved.endpoints.filter(endpoint => !validateEndpoint(endpoint));
    if (saved.repository && typeof saved.repository.fullName === "string") config.repository = saved.repository;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not load gateway config: ${error.message}`);
    config.endpoints = DEFAULT_ENDPOINTS.map(endpoint => ({ ...endpoint, id: randomUUID(), createdAt: new Date().toISOString() }));
    await saveConfig();
  }
}

function createServer() {
  return http.createServer((req, res) => {
    serve(req, res).catch(error => {
      if (!error.status) console.error("Request failed:", error);
      if (!res.headersSent) jsonResponse(res, error.status || 500, { error: error.status ? error.message : "Internal server error." });
      else res.end();
    });
  });
}

async function start(port = PORT) {
  await loadConfig();
  await store.load();
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  return server;
}

if (require.main === module) {
  start()
    .then(server => console.log(`Crisp API Gateway running at http://${HOST}:${server.address().port}`))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { start, validRoutePath, validateEndpoint, routeMatches, hostIsLoopback, originIsAllowed };
