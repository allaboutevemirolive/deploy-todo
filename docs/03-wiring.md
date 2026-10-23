# 03. Wiring Frontend and Backend

> **Status:** ✅ Verified on 2026-10-23, including the same smoke test run through the Vite proxy.

## Goal

Run frontend and backend together on your laptop so the browser sees one site, exactly the way it will in production.

## The problem

During development you run two programs:

- the Vite dev server on port **5173** (serves the page)
- the API on port **3000** (serves the data)

A page loaded from `localhost:5173` that calls `localhost:3000` is talking to a **different origin**. The browser's same-origin policy blocks that unless the API sends special CORS headers. You can configure CORS, but then you must also decide which origins to allow in every environment, and keep that list correct forever.

## The solution: make it one origin

The browser should only ever talk to one address. Something in front forwards `/api/*` to the API and everything else to the frontend:

```
 development                                production
 -----------                                ----------

 browser                                    browser
    |                                          |
    v                                          v
 Vite dev server :5173  --- /api/* --->     Caddy :443  --- /api/* --->
    |                      backend :3000       |                       backend :3000
    +-- everything else: the page              +-- everything else: frontend container
```

In development the forwarding is done by Vite. In production it is done by Caddy ([chapter 04](04-containers.md)). The frontend and the backend cannot tell the difference, and there is no CORS to configure.

The development half is the `server.proxy` section you already wrote:

```ts
  server: {
    // In development the browser talks to Vite (port 5173) only. Vite forwards
    // anything under /api to the backend. In production Caddy does exactly the
    // same job, so the frontend code never needs to know where the API lives.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
```

## Steps

You need three things running. Use three terminals.

**Terminal 1: the database** (skip if it is still running from chapter 01)

```bash
docker start todo-dev-db
```

**Terminal 2: the backend**

```bash
cd backend
DATABASE_URL=postgres://todo:dev@localhost:5460/todo npm run dev
```

**Terminal 3: the frontend**

```bash
cd frontend
npm run dev
```

## Check it worked

First, prove the proxy works without a browser. This is the same smoke test as in chapter 01, but aimed at the **Vite port** instead of the backend port:

```bash
./scripts/smoke.sh http://localhost:5173
```

```
==> GET /api/health
{"status":"ok"}
...
All smoke checks passed against http://localhost:5173
```

The request went to Vite, which forwarded it to the API, which queried Postgres, and the answer came back the same way.

Then open <http://localhost:5173> in a browser and use the app. Open the browser's developer tools, go to the **Network** tab and add a todo. You will see a `POST` to `/api/todos` on `localhost:5173`. There is no request to port 3000 anywhere. As far as the browser knows, there is only one server.

## How it works

Vite's `proxy` option installs a small rule in the dev server: "if the path starts with `/api`, send the request to `http://localhost:3000` and relay the response". The same idea, written as a Caddy rule, is what you will deploy.

Because the rule matches the path prefix, this is also why every backend route begins with `/api`. A backend route named `/todos` could not be told apart from a page.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `http proxy error` in the Vite terminal, `ECONNREFUSED` | The backend is not running. Start it in terminal 2. |
| The page works but the list stays empty | Check the browser's Network tab. A `404` on `/api/todos` means you opened the wrong port. A `500` means look at the backend terminal. |
| You changed `vite.config.ts` and nothing happened | Restart `npm run dev`. The proxy configuration is read once at startup. |

## Recap

- One origin for the browser means no CORS and relative URLs.
- Development: Vite forwards `/api`. Production: Caddy forwards `/api`.
- The same smoke test works against any URL that serves the app.

Next: [04. Containers](04-containers.md)
