# 02. The Frontend

> **Status:** ✅ Verified on 2026-10-23 (Vite 8, React 19, Node 24). The UI was exercised in a real browser.

## Goal

A small single-page app, built with Vite, React and TypeScript, that lists, adds, ticks and deletes todos by calling the backend from chapter 01.

## Steps

### 1. Create the project

From the repository root:

```bash
npm create vite@latest frontend -- --template react-ts --no-interactive
cd frontend
npm install
```

Vite generates a starter app with a logo, a counter and some demo styling. We do not want any of it. Remove the demo pieces:

```bash
rm -rf src/assets src/App.css public/icons.svg README.md
```

Then set the project name and Node version:

```bash
npm pkg set name=todo-frontend version=1.0.0 engines.node=">=24"
```

The scripts Vite gave you are the ones we use:

| Script | What it does |
| :--- | :--- |
| `npm run dev` | Starts the development server with instant reload on port 5173 |
| `npm run build` | Type-checks and writes the production files to `dist/` |
| `npm run lint` | Runs the linter |

### 2. Call the API with relative URLs

`frontend/src/api.ts`

```ts
// Relative URLs on purpose: "/api/todos", never "https://some-host/api/todos".
// The browser sends the request to whichever host served the page, so the same
// built files work on localhost, on staging and in production.

export interface Todo {
  id: number
  title: string
  done: boolean
  created_at: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there is one. A DELETE with a JSON
  // content-type but no body is rejected by the server with a 400.
  const headers: Record<string, string> = init?.body ? { 'content-type': 'application/json' } : {}
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const api = {
  list: () => request<Todo[]>('/api/todos'),
  create: (title: string) =>
    request<Todo>('/api/todos', { method: 'POST', body: JSON.stringify({ title }) }),
  setDone: (id: number, done: boolean) =>
    request<Todo>(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
  remove: (id: number) => request<void>(`/api/todos/${id}`, { method: 'DELETE' }),
}
```

**This is the most important choice in the frontend.** Look at the paths: `/api/todos`, not `https://something.example.com/api/todos`. A relative URL means "the same host that served this page". So the identical built files work on `localhost`, on a staging server and in production, with nothing to configure and nothing baked in at build time.

(Many tutorials hard-code the API address into the build with an environment variable. That forces you to build a different frontend for every environment, and every address change means a rebuild. We avoid the whole problem.)

### 3. The component

`frontend/src/App.tsx`

```tsx
import { useEffect, useState, type FormEvent } from 'react'
import { api, type Todo } from './api'

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Run an API call; show any failure instead of silently doing nothing.
  async function run(action: () => Promise<void>) {
    try {
      setError(null)
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    }
  }

  const reload = async () => setTodos(await api.list())

  // Load the list once when the page opens. The flag stops a late response
  // from updating state after the component has gone away.
  useEffect(() => {
    let cancelled = false
    api
      .list()
      .then((data) => {
        if (!cancelled) setTodos(data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Something went wrong')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const add = (e: FormEvent) => {
    e.preventDefault()
    const value = title.trim()
    if (!value) return
    // Clear the box right away so the next thing you type is never glued
    // onto the previous title while the request is still in flight.
    setTitle('')
    void run(async () => {
      await api.create(value)
      await reload()
    })
  }

  const toggle = (todo: Todo) =>
    void run(async () => {
      await api.setDone(todo.id, !todo.done)
      await reload()
    })

  const remove = (todo: Todo) =>
    void run(async () => {
      await api.remove(todo.id)
      await reload()
    })

  return (
    <main>
      <h1>Todo</h1>
      <form onSubmit={add}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          maxLength={200}
          aria-label="New todo"
        />
        <button type="submit">Add</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <label className={todo.done ? 'done' : ''}>
              <input type="checkbox" checked={todo.done} onChange={() => toggle(todo)} />
              {todo.title}
            </label>
            <button className="remove" onClick={() => remove(todo)} aria-label={`Delete ${todo.title}`}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {todos.length === 0 && !error && <p className="empty">Nothing to do. Add something above.</p>}
    </main>
  )
}
```

Notes:

- `run(...)` wraps every API call so a failure shows a message instead of silently doing nothing.
- After every change the list is reloaded from the server. This is slightly less snappy than updating the screen optimistically, but the screen can never disagree with the database.
- When you add a todo the input is cleared immediately, before the request finishes. Otherwise anything you type while the request is in flight gets glued onto the old text. This was a real bug found while testing in a browser.

### 4. Styling

`frontend/src/index.css` is plain CSS with no framework. `color-scheme: light dark` makes the page follow the visitor's system theme. It is included in the repository; the file is not interesting enough to reproduce here.

### 5. Tell Vite where the API lives during development

`frontend/vite.config.ts`

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // In development the browser talks to Vite (port 5173) only. Vite forwards
    // anything under /api to the backend. In production Caddy does exactly the
    // same job, so the frontend code never needs to know where the API lives.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
```

This is covered properly in [chapter 03](03-wiring.md). For now: during development, Vite forwards anything under `/api` to the backend on port 3000.

Also change the page title in `frontend/index.html` from `frontend` to `Todo`.

## Check it worked

Build for production first. This runs the TypeScript compiler over everything, so it catches type errors:

```bash
npm run build
```

```
vite v8.3.5 building client environment for production...
✓ 17 modules transformed.
dist/index.html                   0.45 kB │ gzip:  0.29 kB
dist/assets/index-C06qZNnt.css    1.02 kB │ gzip:  0.54 kB
dist/assets/index-CVLsBKEs.js   221.32 kB │ gzip: 69.34 kB
✓ built in 119ms
```

Notice the file names: `index-C06qZNnt.css`. The part in the middle is a **hash of the file's contents**. If the content changes, the name changes. That detail becomes important in [chapter 04](04-containers.md), where it lets browsers cache these files forever without ever showing stale code.

```bash
npm run lint
```

No output means no warnings.

Now see it in a browser. Make sure the backend from chapter 01 is still running, then:

```bash
npm run dev
```

Open <http://localhost:5173>. Add a todo, tick it, delete it. A ticked todo gets a line through it.

## How it works

The built output is nothing but static files: one HTML file, one JavaScript file, one CSS file.

```
  dist/
  ├── index.html
  ├── favicon.svg
  └── assets/
      ├── index-C06qZNnt.css
      └── index-CVLsBKEs.js
```

Any web server can serve them. In production we put them in a tiny nginx container. The JavaScript runs in the visitor's browser and calls `/api/...` on whatever host it came from.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| The page loads but shows `Request failed: 500` or a proxy error | The backend is not running, or it is not on port 3000. Start it as in chapter 01. |
| Clicking delete does nothing and the backend log shows a `400` saying the body cannot be empty | The client sent `content-type: application/json` on a request with no body, and Fastify rejects that. `request()` in `api.ts` sets the header only when there is a body for this reason. |
| `npm run build` fails with type errors that `npm run dev` ignored | Correct behaviour. Vite's dev server does not type-check. The build does. Fix the types. |

## Recap

- The frontend is a static bundle. After `npm run build` it needs no Node at all.
- API calls use relative paths, so the bundle contains no environment-specific values.
- File names carry content hashes, which will matter for caching.

Next: [03. Wiring Frontend and Backend](03-wiring.md)
