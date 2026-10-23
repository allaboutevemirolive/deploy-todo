# 01. The Backend

> **Status:** ✅ Verified on 2026-10-23 (macOS on Apple silicon, Node 24, Postgres 17). All output shown below is real.

## Goal

A TypeScript API that stores todos in Postgres and answers these requests:

| Method | Path | What it does |
| :--- | :--- | :--- |
| GET | `/api/health` | Says "ok" if the API and the database both work, and which version is running |
| GET | `/api/todos` | Lists all todos |
| POST | `/api/todos` | Creates a todo |
| PATCH | `/api/todos/:id` | Changes `done` and/or `title` |
| DELETE | `/api/todos/:id` | Deletes a todo |

Every path starts with `/api`. That prefix is what lets the reverse proxy in front of the app tell API traffic from page traffic (see [03](03-wiring.md)).

## Steps

### 1. Create the project

```bash
mkdir -p backend/src && cd backend
npm init -y
npm pkg set name=todo-backend version=1.0.0 type=module engines.node=">=24"
npm pkg set private=true --json
npm pkg delete main keywords author license
```

Install the dependencies. **Fastify** is the web framework. **pg** talks to Postgres.

```bash
npm i fastify pg
npm i -D typescript tsx @types/node@24 @types/pg
```

Two details worth noticing:

- `@types/node@24` matches the Node version we will run in Docker later. Type definitions that are newer than your runtime let you write code that crashes in production.
- **tsx** runs TypeScript directly during development. For production we compile to plain JavaScript with `tsc`, so the final container does not need a TypeScript toolchain at all.

Add the scripts:

```bash
npm pkg set scripts.dev="tsx watch src/server.ts"
npm pkg set scripts.build="tsc"
npm pkg set scripts.start="node dist/server.js"
npm pkg set scripts.typecheck="tsc --noEmit"
```

### 2. Configure TypeScript

`backend/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`NodeNext` is the module setting that matches how modern Node loads ES modules. `strict` turns on the checks that catch real bugs. `noUncheckedIndexedAccess` makes `array[0]` possibly `undefined`, which it can be.

Also create `backend/.gitignore` containing `node_modules`, `dist` and `.env`, so none of them are ever committed.

### 3. Read configuration from the environment

`backend/src/config.ts`

```ts
// All configuration comes from environment variables (the "12-factor" way).
// The same image runs on your laptop, in CI and on the server; only the
// environment changes.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Listen on all interfaces so the container is reachable from other
  // containers. (127.0.0.1 would only be reachable from inside itself.)
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: required("DATABASE_URL"),
  // Which commit this build came from. CI bakes it into the image, so the
  // health endpoint can prove which version is actually running.
  version: process.env.APP_VERSION ?? "dev",
};
```

The program takes **everything that differs between machines** from environment variables. It refuses to start without `DATABASE_URL`, which is far better than starting and failing on the first request.

`HOST` defaults to `0.0.0.0`. Inside a container, `127.0.0.1` means "only this container itself", so other containers (Caddy) could never reach the API. `0.0.0.0` means "any network interface".

### 4. Talk to the database

`backend/src/db.ts`

```ts
import pg from "pg";

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

// A real project would use a migration tool (node-pg-migrate, Drizzle, Prisma...).
// For this walkthrough one idempotent statement is enough, and it keeps the
// deployment story simple: the app prepares its own table on startup.
export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
      done       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}
```

`migrate` creates the table if it does not exist. It is safe to run on every start. A bigger project would use a migration tool. Here, one statement keeps the deployment story simple: the app prepares its own table.

### 5. Define the routes

`backend/src/app.ts`

```ts
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { config } from "./config.js";

interface Todo {
  id: number;
  title: string;
  done: boolean;
  created_at: string;
}

const idParams = {
  type: "object",
  properties: { id: { type: "integer", minimum: 1 } },
  required: ["id"],
} as const;

export function buildApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify({ logger: true });

  // Health check: used by Docker, by the smoke test and by you.
  // It touches the database, so "ok" means the whole chain works.
  app.get("/api/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok", version: config.version };
    } catch {
      return reply.code(503).send({ status: "database unavailable" });
    }
  });

  app.get("/api/todos", async () => {
    const { rows } = await pool.query<Todo>(
      "SELECT id, title, done, created_at FROM todos ORDER BY id",
    );
    return rows;
  });

  app.post<{ Body: { title: string } }>(
    "/api/todos",
    {
      schema: {
        body: {
          type: "object",
          properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["title"],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { rows } = await pool.query<Todo>(
        "INSERT INTO todos (title) VALUES ($1) RETURNING id, title, done, created_at",
        [req.body.title.trim()],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  app.patch<{ Params: { id: number }; Body: { done?: boolean; title?: string } }>(
    "/api/todos/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          properties: {
            done: { type: "boolean" },
            title: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
          minProperties: 1,
        },
      },
    },
    async (req, reply) => {
      // COALESCE keeps the existing value when a field is not sent.
      const { rows } = await pool.query<Todo>(
        `UPDATE todos
            SET done  = COALESCE($2, done),
                title = COALESCE($3, title)
          WHERE id = $1
      RETURNING id, title, done, created_at`,
        [req.params.id, req.body.done ?? null, req.body.title?.trim() ?? null],
      );
      if (rows.length === 0) return reply.code(404).send({ error: "Todo not found" });
      return rows[0];
    },
  );

  app.delete<{ Params: { id: number } }>(
    "/api/todos/:id",
    { schema: { params: idParams } },
    async (req, reply) => {
      const result = await pool.query("DELETE FROM todos WHERE id = $1", [req.params.id]);
      if (result.rowCount === 0) return reply.code(404).send({ error: "Todo not found" });
      return reply.code(204).send();
    },
  );

  return app;
}
```

Points to notice:

- **`buildApp(pool)` takes the database pool as an argument.** It does not create one itself. This is what would let you test the app with a fake or a throwaway database.
- **Queries use `$1`, `$2` placeholders.** User input is never pasted into SQL text. That is what prevents SQL injection.
- **Each route has a JSON schema.** Fastify rejects bad input with a `400` before your handler runs. You will see the exact error message below.
- **`/api/health` queries the database.** A health check that only says "the process is running" can be green while the app is useless. This one is green only if the whole chain works. Docker will use it to decide whether the container is healthy. It also reports `version`, the commit the program was built from (`dev` when you run it by hand). That field is how [chapter 08](08-auto-deploy.md) proves the right version is live after a deploy.
- **`PATCH` uses `COALESCE`.** `COALESCE($2, done)` means "use the new value if one was sent, otherwise keep the current one", so you can send just `done` or just `title`.

### 6. Start the server

`backend/src/server.ts`

```ts
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool, migrate } from "./db.js";

const pool = createPool(config.databaseUrl);
await migrate(pool);

const app = buildApp(pool);

// Docker stops containers with SIGTERM. Close cleanly so in-flight requests
// finish and database connections are released.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
```

Docker stops a container by sending it `SIGTERM`. If the program ignored the signal, Docker would wait ten seconds and then kill it, possibly in the middle of a request. The handler closes the server and the database connections first.

### 7. Start a throwaway Postgres for development

```bash
docker run -d --name todo-dev-db \
  -e POSTGRES_USER=todo -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=todo \
  -p 127.0.0.1:5460:5432 \
  postgres:17-alpine
```

Why port `5460` and not the usual `5432`? So it cannot collide with a Postgres you may already have running. `127.0.0.1:` in front means only your own computer can connect.

Wait a few seconds, then:

```bash
docker exec todo-dev-db pg_isready -U todo
```

```
/var/run/postgresql:5432 - accepting connections
```

### 8. Run the API

```bash
cd backend
DATABASE_URL=postgres://todo:dev@localhost:5460/todo npm run dev
```

The server stays running in this terminal. Open a second terminal for the next section.

## Check it worked

Health:

```bash
curl -i localhost:3000/api/health
```

```
HTTP/1.1 200 OK
...
{"status":"ok","version":"dev"}
```

Create two todos and list them:

```bash
curl -s -X POST localhost:3000/api/todos -H 'content-type: application/json' -d '{"title":"Write the docs"}'
curl -s -X POST localhost:3000/api/todos -H 'content-type: application/json' -d '{"title":"Ship it"}'
curl -s localhost:3000/api/todos
```

```
{"id":1,"title":"Write the docs","done":false,"created_at":"2026-10-23T07:37:08.501Z"}
{"id":2,"title":"Ship it","done":false,"created_at":"2026-10-23T07:37:08.530Z"}
[{"id":1,"title":"Write the docs","done":false,"created_at":"2026-10-23T07:37:08.501Z"},{"id":2,"title":"Ship it","done":false,"created_at":"2026-10-23T07:37:08.530Z"}]
```

Mark the first one done, then try two things that should fail:

```bash
curl -s -X PATCH localhost:3000/api/todos/1 -H 'content-type: application/json' -d '{"done":true}'
curl -s -w ' [%{http_code}]' -X POST localhost:3000/api/todos -H 'content-type: application/json' -d '{"title":""}'
curl -s -w ' [%{http_code}]' -X PATCH localhost:3000/api/todos/999 -H 'content-type: application/json' -d '{"done":true}'
```

```
{"id":1,"title":"Write the docs","done":true,"created_at":"2026-10-23T07:37:08.501Z"}
{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request","message":"body/title must NOT have fewer than 1 characters"} [400]
{"error":"Todo not found"} [404]
```

Delete the second one. A successful delete returns `204 No Content`, which means "done, and there is nothing to send back":

```bash
curl -s -o /dev/null -w '[%{http_code}]' -X DELETE localhost:3000/api/todos/2
```

```
[204]
```

Prove the data is really in Postgres and not in memory:

```bash
docker exec todo-dev-db psql -U todo -d todo -c 'SELECT id, title, done FROM todos'
```

```
 id |     title      | done 
----+----------------+------
  1 | Write the docs | t
(1 row)
```

### The smoke test

Typing curl commands by hand does not scale, and you will want to run the same checks against your laptop, a container and the live server. `scripts/smoke.sh` does exactly that. It takes one argument: the base URL.

```bash
#!/usr/bin/env bash
# Smoke test: exercises the whole API through whatever URL you give it.
#   ./scripts/smoke.sh http://localhost:3000        (backend directly)
#   ./scripts/smoke.sh http://localhost:8088        (through Caddy, local compose)
#   ./scripts/smoke.sh https://todo.lazuar.dev      (production)
#
# Optional second argument: the version (commit SHA) that must be running.
#   ./scripts/smoke.sh https://todo.lazuar.dev "$(git rev-parse HEAD)"
set -euo pipefail

BASE="${1:?usage: smoke.sh <base-url> [expected-version]}"
BASE="${BASE%/}"
EXPECT_VERSION="${2:-}"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

step "GET /api/health"
HEALTH=$(curl -fsS "$BASE/api/health") || fail "health request failed"
echo "$HEALTH"
printf '%s' "$HEALTH" | grep -q '"status":"ok"' || fail "health check"
if [ -n "$EXPECT_VERSION" ]; then
  printf '%s' "$HEALTH" | grep -q "\"version\":\"$EXPECT_VERSION\"" \
    || fail "wrong version running: expected $EXPECT_VERSION"
fi

step "POST /api/todos"
CREATED=$(curl -fsS -X POST "$BASE/api/todos" \
  -H 'content-type: application/json' -d '{"title":"smoke test"}')
echo "$CREATED"
ID=$(printf '%s' "$CREATED" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
[ -n "$ID" ] || fail "could not read id from response"

step "GET /api/todos (must contain id $ID)"
curl -fsS "$BASE/api/todos" | grep -q "\"id\":$ID," || fail "created todo not listed"

step "PATCH /api/todos/$ID"
curl -fsS -X PATCH "$BASE/api/todos/$ID" \
  -H 'content-type: application/json' -d '{"done":true}' | grep -q '"done":true' \
  || fail "todo not marked done"

step "DELETE /api/todos/$ID"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/todos/$ID")
[ "$STATUS" = "204" ] || fail "delete returned $STATUS, expected 204"

step "Validation: empty title must be rejected"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/todos" \
  -H 'content-type: application/json' -d '{"title":""}')
[ "$STATUS" = "400" ] || fail "empty title returned $STATUS, expected 400"

printf '\nAll smoke checks passed against %s\n' "$BASE"
```

```bash
./scripts/smoke.sh http://localhost:3000
```

```
==> GET /api/health
{"status":"ok","version":"dev"}
==> POST /api/todos
{"id":1,"title":"smoke test","done":false,"created_at":"2026-10-23T07:31:51.976Z"}
...
All smoke checks passed against http://localhost:3000
```

You will use this script again in chapters 03, 04 and 08. Passing it a different URL is how you test every environment the same way.

### Compile for production

```bash
npm run typecheck   # checks types, writes nothing
npm run build       # writes dist/*.js
```

```
dist/app.js  dist/config.js  dist/db.js  dist/server.js
```

## How it works

```
 curl / browser ---> Fastify (routes + validation) ---> pg Pool ---> Postgres
```

A **pool** keeps a handful of database connections open and lends them out. Opening a connection for every request would be slow.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `Missing required environment variable: DATABASE_URL` | You started the server without the variable. Prefix the command as shown in step 8. |
| `ECONNREFUSED 127.0.0.1:5460` | The database container is not running or not ready yet. `docker ps` and wait a few seconds. |
| `EADDRINUSE: address already in use :::3000` | Something else uses port 3000. Stop it, or run with `PORT=3001`. |
| `password authentication failed` | The password in `DATABASE_URL` does not match `POSTGRES_PASSWORD` from step 7. A password that was set when the data directory was first created cannot be changed by editing an environment variable later. |

## Recap

- Configuration comes from the environment, and the app fails fast if it is missing.
- The health endpoint checks the database, so "healthy" means something.
- Input is validated and queries are parameterised.
- The app shuts down cleanly on `SIGTERM`.
- `scripts/smoke.sh` is a single test you can aim at any environment.

Next: [02. The Frontend](02-frontend.md)
