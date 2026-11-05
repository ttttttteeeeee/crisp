# Crisp Mini API Gateway

This mini project makes a fresh, modern vision for book discovery.

A lightweight, local Node.js API gateway with a GitHub repository connection and configurable upstream routes.

## Run locally

Requires Node.js 18 or newer. No npm dependencies are required.

```powershell
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The server binds to loopback only. Gateway settings are saved in `data/config.json`.

The customer-facing bookstore is available at [http://127.0.0.1:3000/bookstore.html](http://127.0.0.1:3000/bookstore.html). It loads its 12-book catalog from the server, searches, filters and sorts on the server, places demo orders (no payment), and searches Open Library through the gateway. Clicking a book's cover or title opens a details view with its description, loaded from `GET /store/api/books/:id`.

## Bookstore API

The catalog lives in `books.json`. Orders are saved to `data/orders.json` (the newest 1,000 are kept).

| Method | Path | Purpose |
|---|---|---|
| GET | `/store/api/books?q=&category=&sort=` | List books. `sort` is `featured`, `title`, `low` or `high`. Returns `books`, `categories` and `total`. |
| GET | `/store/api/books/:id` | One book, including its description. |
| POST | `/store/api/orders` | Place an order: `{"items":[{"id":12,"quantity":2}],"name":"optional"}`. Prices and totals are always calculated on the server; any price the client sends is ignored. Quantities are whole numbers from 1 to 20. |
| GET | `/store/api/orders/:id` | Look up an order such as `CR-1A2B3C4D`. |

Store requests follow the same rules as the admin API: loopback `Host` only, no requests from other sites' origins, and JSON bodies only.

## Discover more books (Open Library)

On first start (when there is no saved config), the gateway creates a `GET /discover` route to `https://openlibrary.org/search.json`. The bookstore's "Discover more books" search calls `/gateway/discover?q=...`, so those requests appear in the dashboard's request activity. If you already have a saved config, add that route yourself in the dashboard.

## Connect GitHub

Enter a public repository URL such as `https://github.com/octocat/Hello-World`. The gateway retrieves its name and default branch from GitHub's public API. It does not store a token, clone the repository, deploy it, or execute its code.

## Add a gateway route

Create a route with a method, a gateway path, and an HTTP(S) upstream URL. For example:

| Method | Gateway path | Upstream URL |
|---|---|---|
| GET | `/users` | `https://jsonplaceholder.typicode.com/users` |

Send a request to `http://127.0.0.1:3000/gateway/users`. Query parameters and supported request headers are forwarded. Route parameters such as `/users/:id` can be used with an upstream URL containing `{id}`, for example `https://jsonplaceholder.typicode.com/users/{id}`.

The admin API is local-only:

- `GET /api/config` — repository and route configuration
- `POST /api/github/connect` — connect a public GitHub repository (`{"url":"https://github.com/owner/repo"}`)
- `DELETE /api/github/connect` — disconnect the repository
- `GET /api/endpoints` is represented through `/api/config`; `POST /api/endpoints` creates a route
- `PUT /api/endpoints/:id` and `DELETE /api/endpoints/:id` update or remove a route
- `GET /api/logs` — recent request metadata (no payloads or credentials)

## Local security

The server binds to `127.0.0.1`, and it also defends against web pages open in your own browser:

- Every request must carry a `Host` of `127.0.0.1` or `localhost` on the server's port, or it gets `421`. This blocks DNS-rebinding attacks.
- Admin requests (`/api/*`) sent from another site's `Origin` are rejected with `403`.
- Admin requests with a body must be `Content-Type: application/json` (otherwise `415`), so a cross-site form or `text/plain` post cannot create routes.

Gateway responses are streamed and capped at 10 MB (`CRISP_MAX_RESPONSE_BYTES`). Upstream `Set-Cookie` headers are dropped. Note that `Authorization` and `X-API-Key` headers are forwarded to whatever upstream a route points at, so only add routes you trust.

This is still a local development MVP, not a production-hardened public gateway: it has no user authentication, TLS termination, or persistent audit log. Do not expose it to an untrusted network.

## Tests

```powershell
npm test
```

Tests use Node's built-in test runner and need no dependencies. CI runs them on Node 18, 20 and 22. Set `CRISP_DATA_DIR` to keep test or alternate config out of `data/`.