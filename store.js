// Bookstore API: catalog browsing and demo orders, served under /store/api.
// Prices are always taken from the server's catalog, never from the client.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const MAX_LINES = 50;
const MAX_QUANTITY = 20;
const MAX_STORED_ORDERS = 1000;
const SORTS = new Set(["featured", "title", "low", "high"]);

function createStore({ catalogFile, dataDir, readJson, jsonResponse, httpError }) {
  const ordersFile = path.join(dataDir, "orders.json");
  let books = [];
  let categories = [];
  let orders = [];
  let saveQueue = Promise.resolve();

  async function load() {
    books = JSON.parse(await fs.readFile(catalogFile, "utf8"));
    categories = [...new Set(books.map(book => book.category))];
    try {
      const saved = JSON.parse(await fs.readFile(ordersFile, "utf8"));
      orders = Array.isArray(saved) ? saved : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Could not load orders: ${error.message}`);
      orders = [];
    }
  }

  function saveOrders() {
    const snapshot = JSON.stringify(orders, null, 2);
    saveQueue = saveQueue.then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporaryFile = `${ordersFile}.${randomUUID()}.tmp`;
      await fs.writeFile(temporaryFile, snapshot, "utf8");
      await fs.rename(temporaryFile, ordersFile);
    });
    return saveQueue;
  }

  function listBooks(params) {
    const query = (params.get("q") || "").trim().toLowerCase().slice(0, 100);
    const category = params.get("category") || "All";
    const sort = SORTS.has(params.get("sort")) ? params.get("sort") : "featured";
    let result = books.filter(book =>
      (category === "All" || book.category === category)
      && (!query || `${book.title} ${book.author} ${book.category}`.toLowerCase().includes(query)));
    if (sort === "title") result = [...result].sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "low") result = [...result].sort((a, b) => a.price - b.price);
    if (sort === "high") result = [...result].sort((a, b) => b.price - a.price);
    return { books: result, categories: ["All", ...categories], total: books.length };
  }

  function validateOrder(input) {
    if (!input || typeof input !== "object" || !Array.isArray(input.items) || input.items.length === 0) {
      return "Your bag is empty.";
    }
    if (input.items.length > MAX_LINES) return `An order can contain at most ${MAX_LINES} different books.`;
    const seen = new Set();
    for (const item of input.items) {
      if (!item || !Number.isInteger(item.id) || !books.some(book => book.id === item.id)) {
        return "One of the books in your bag is no longer available.";
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
        return `Quantities must be whole numbers from 1 to ${MAX_QUANTITY}.`;
      }
      if (seen.has(item.id)) return "Each book should appear only once in an order.";
      seen.add(item.id);
    }
    if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 80)) {
      return "Name must be text of at most 80 characters.";
    }
    return null;
  }

  async function createOrder(input) {
    const error = validateOrder(input);
    if (error) throw httpError(400, error);
    // Work in paise/cents to avoid floating-point rounding errors.
    const lines = input.items.map(({ id, quantity }) => {
      const book = books.find(entry => entry.id === id);
      const unitCents = Math.round(book.price * 100);
      return { id, title: book.title, author: book.author, quantity, unitPrice: unitCents / 100, lineTotal: (unitCents * quantity) / 100 };
    });
    const subtotalCents = lines.reduce((sum, line) => sum + Math.round(line.lineTotal * 100), 0);
    const order = {
      id: `CR-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: typeof input.name === "string" ? input.name.trim() : "",
      items: lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      subtotal: subtotalCents / 100,
      status: "received",
      createdAt: new Date().toISOString(),
    };
    orders.push(order);
    if (orders.length > MAX_STORED_ORDERS) orders.splice(0, orders.length - MAX_STORED_ORDERS);
    await saveOrders();
    return order;
  }

  async function handle(req, res, url) {
    if (url.pathname === "/store/api/books" && req.method === "GET") {
      return jsonResponse(res, 200, listBooks(url.searchParams));
    }
    const bookMatch = url.pathname.match(/^\/store\/api\/books\/(\d{1,9})$/);
    if (bookMatch && req.method === "GET") {
      const book = books.find(entry => entry.id === Number(bookMatch[1]));
      if (!book) return jsonResponse(res, 404, { error: "Book not found." });
      return jsonResponse(res, 200, { book });
    }
    if (url.pathname === "/store/api/orders" && req.method === "POST") {
      const order = await createOrder(await readJson(req));
      return jsonResponse(res, 201, { order });
    }
    const orderMatch = url.pathname.match(/^\/store\/api\/orders\/(CR-[0-9A-F]{8})$/);
    if (orderMatch && req.method === "GET") {
      const order = orders.find(entry => entry.id === orderMatch[1]);
      if (!order) return jsonResponse(res, 404, { error: "Order not found." });
      return jsonResponse(res, 200, { order });
    }
    return jsonResponse(res, 404, { error: "Store API route not found." });
  }

  return { load, handle };
}

module.exports = { createStore };
