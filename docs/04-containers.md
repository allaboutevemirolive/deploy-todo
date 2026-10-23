# 04. Containers

> **Status:** ✅ Verified on 2026-10-23 (Docker 29, Compose v5). Everything in this chapter was run, including the data-persistence test.

## Goal

Package the backend and the frontend as container images, and run the entire system (Caddy, frontend, backend, Postgres) on your laptop with one command.

## Ideas first

**An image is a recipe's result; a container is the thing running.** You build an image once. You can start as many containers from it as you like, on any machine with Docker.

**An image is made of layers.** Every instruction in a Dockerfile adds a layer, and Docker caches layers. If nothing an instruction depends on has changed, Docker reuses the cached layer. That is why Dockerfiles copy `package.json` and run `npm ci` **before** copying the source code: the slow dependency install is only repeated when the dependencies change, not on every edit.

**Multi-stage builds keep images small and safe.** To build TypeScript you need the compiler and every dev dependency. To run the result you need none of that. A multi-stage Dockerfile builds in one stage and copies only the output into a clean second stage. The compiler never reaches production.

## Steps

### 1. The backend image

`backend/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1

# ---- Stage 1: build -------------------------------------------------------
# Installs ALL dependencies (including TypeScript) and compiles to JavaScript.
# Nothing from this stage ships except the compiled output.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime -----------------------------------------------------
# Only production dependencies and compiled code. No compiler, no source.
FROM node:24-alpine
# Links this image to the GitHub repo. GHCR then lets the repo's own
# workflows push to it, and shows the repo on the package page.
LABEL org.opencontainers.image.source="https://github.com/allaboutevemirolive/deploy-todo"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The official node image ships a non-root user called "node".
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Line by line:

- `FROM node:24-alpine AS build` starts stage 1 from a small Linux image with Node 24. `AS build` names the stage.
- `npm ci` installs exactly what `package-lock.json` says. Unlike `npm install` it never changes the lockfile and fails if the lockfile and `package.json` disagree. That makes builds repeatable.
- `RUN npm run build` compiles TypeScript to JavaScript in `/app/dist`.
- The second `FROM` starts stage 2 from a fresh image. Nothing from stage 1 comes along unless we `COPY --from=build` it.
- `npm ci --omit=dev` installs only production dependencies. No TypeScript, no tsx.
- `USER node` stops the process running as root. If someone finds a flaw in the app, they land in an unprivileged account instead of an all-powerful one.
- `LABEL org.opencontainers.image.source=...` tells GitHub which repository this image belongs to. GHCR uses it to link the package to the repo, which is what later allows the repo's own workflow to push to it ([chapter 05](05-registry.md)).

`backend/.dockerignore` lists what must **not** be sent to the builder: `node_modules`, `dist`, `.env`, `.git`. Without it, your local `node_modules` (built for macOS) would be copied into a Linux image, and a `.env` file with secrets could end up inside it.

### 2. The frontend image

`frontend/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1

# ---- Stage 1: build -------------------------------------------------------
# Vite turns the TypeScript/React source into plain static files in /app/dist.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Stage 2: serve -------------------------------------------------------
# The result is just files, so the runtime image is a small web server.
# "nginx-unprivileged" runs as a non-root user and listens on 8080.
FROM nginxinc/nginx-unprivileged:stable-alpine
# Links this image to the GitHub repo. GHCR then lets the repo's own
# workflows push to it, and shows the repo on the package page.
LABEL org.opencontainers.image.source="https://github.com/allaboutevemirolive/deploy-todo"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

Stage 1 builds the static files. Stage 2 contains **no Node at all**, just a web server and your files.

`nginx-unprivileged` is nginx configured to run as a normal user. Because normal users may not use ports below 1024, it listens on **8080** instead of 80.

`frontend/nginx.conf`

```nginx
server {
    listen 8080;
    root /usr/share/nginx/html;
    index index.html;

    # Vite puts a content hash in every file name under /assets, so these
    # files never change: let browsers cache them for a year.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # index.html must always be re-checked, otherwise users keep old builds.
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Single-page app: unknown paths fall back to index.html.
    location / {
        try_files $uri /index.html;
    }
}
```

Three rules, each for a reason:

1. **`/assets/` is cached for a year and marked `immutable`.** Safe, because Vite put a content hash in every file name (you saw `index-C06qZNnt.css`). New content means a new name, so nobody ever gets stale files.
2. **`index.html` is `no-cache`.** It is the one file whose name never changes, and it points at the current hashed files. Browsers must re-check it so they discover new builds.
3. **Unknown paths return `index.html`.** In a single-page app the browser may be at `/some/deep/link`; the file does not exist on disk, but the app can handle that route itself.

### 3. The reverse proxy

`deploy/Caddyfile`

```caddyfile
# One public address, two internal services.
#   /api/*  -> backend  (the TypeScript API)
#   /*      -> frontend (static files served by nginx)
#
# {$SITE_ADDRESS} comes from the environment (see .env.example):
#   production: todo.lazuar.dev  -> Caddy gets a Let's Encrypt certificate
#   local:      :80              -> plain HTTP, no certificate
{$SITE_ADDRESS} {
	encode zstd gzip

	handle /api/* {
		reverse_proxy backend:3000
	}

	handle {
		reverse_proxy frontend:8080
	}
}
```

This is the production version of the Vite proxy from chapter 03. **Caddy** has one superpower we rely on: give it a real domain name and it obtains and renews a free HTTPS certificate from Let's Encrypt automatically.

`{$SITE_ADDRESS}` is replaced with an environment variable. On the server it will be `todo.lazuar.dev`. On your laptop it will be `:80`, which means "plain HTTP, any host name, no certificate". The same file serves both.

`backend:3000` and `frontend:8080` are not typed addresses. Inside a Compose network every service is reachable by its **service name**. Docker runs a tiny DNS server for this.

### 4. Compose: describe the whole system

`deploy/docker-compose.yml`

```yaml
name: deploy-todo

# Production stack: pulls prebuilt images from GHCR.
# Only Caddy is reachable from the internet. Everything else lives on the
# private compose network.

services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10

  backend:
    image: ghcr.io/allaboutevemirolive/deploy-todo/backend:${TAG:-latest}
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/health"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s

  frontend:
    image: ghcr.io/allaboutevemirolive/deploy-todo/frontend:${TAG:-latest}
    restart: unless-stopped

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "${HTTP_PORT:-80}:80"
      - "${HTTPS_PORT:-443}:443"
      - "${HTTPS_PORT:-443}:443/udp"
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - backend
      - frontend

volumes:
  pgdata:
  caddy_data:
  caddy_config:
```

What matters here:

- **Only Caddy has `ports:`.** The database, backend and frontend are reachable only from inside the Compose network. You can verify this later: port 3000 on your laptop does not answer.
- **`healthcheck` plus `depends_on: condition: service_healthy`.** The backend starts only after Postgres reports it is accepting connections. Without this the backend races the database and crashes on startup.
- **`restart: unless-stopped`.** Containers come back after a crash or a server reboot.
- **`pgdata` is a named volume.** Containers are disposable; the volume is where the data lives. Deleting the container does not delete the data.
- **`DATABASE_URL` is assembled from variables.** Nothing secret is written in this file, so it is safe to commit.
- **`${TAG:-latest}`** means "use the `TAG` variable, or `latest` if it is not set". It is how you will roll back to an earlier build.
- **The `image:` lines point at GHCR.** This file is the production file: it pulls prebuilt images.

### 5. A local override that builds instead of pulls

`deploy/docker-compose.local.yml`

```yaml
# Local override: build the images from source instead of pulling them.
#
#   docker compose -f docker-compose.yml -f docker-compose.local.yml \
#     --env-file .env.local up --build
#
# The image names stay the same, so what you test locally is exactly what
# CI later builds and pushes.

services:
  backend:
    build: ../backend
  frontend:
    build: ../frontend
```

When you pass two `-f` files, Compose merges them. The second one adds a `build:` instruction to the services. Because `image:` names are unchanged, **the image you build locally has exactly the name the production file expects**, so what you test on your laptop is what the pipeline will later build and ship.

### 6. The environment files

`deploy/.env.local.example`

```env
# Local settings. Copy to ".env.local" (it is git-ignored).
#   cp .env.local.example .env.local

# ":80" means "plain HTTP on any host name": no certificate needed.
SITE_ADDRESS=:80

# Host ports. Moved off 80/443 so they do not clash with other things
# running on your machine. Open http://localhost:8088
HTTP_PORT=8088
HTTPS_PORT=8443

POSTGRES_USER=todo
POSTGRES_PASSWORD=local-only-password
POSTGRES_DB=todo

TAG=latest
```

`deploy/.env.example` is the same shape for production (`SITE_ADDRESS=todo.lazuar.dev`, a real password, standard ports). The actual `.env` and `.env.local` files are listed in `.gitignore`. **Only the `.example` files are committed.** A secret in Git history is effectively public forever, even if you delete it in a later commit.

Create your local file:

```bash
cd deploy
cp .env.local.example .env.local
```

### 7. Build and start everything

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml \
  --env-file .env.local up --build -d
```

The first run downloads base images and takes a minute or two. Later runs are mostly cached.

## Check it worked

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local ps
```

```
NAME                     IMAGE                                                     STATUS
deploy-todo-backend-1    ghcr.io/allaboutevemirolive/deploy-todo/backend:latest    Up 12 seconds (healthy)
deploy-todo-caddy-1      caddy:2                                                   Up 12 seconds
deploy-todo-db-1         postgres:17-alpine                                        Up 18 seconds (healthy)
deploy-todo-frontend-1   ghcr.io/allaboutevemirolive/deploy-todo/frontend:latest   Up 18 seconds
```

(Columns trimmed. You will also see the ports line.) Two containers say `(healthy)`: that is the health check from the Compose file passing.

Run the smoke test through Caddy:

```bash
./scripts/smoke.sh http://localhost:8088
```

```
All smoke checks passed against http://localhost:8088
```

Open <http://localhost:8088> in a browser. It is the full stack now: Caddy, nginx, your API and Postgres.

### Look at what was built

```bash
docker images | grep deploy-todo
```

```
ghcr.io/allaboutevemirolive/deploy-todo/frontend:latest   60.2MB
ghcr.io/allaboutevemirolive/deploy-todo/backend:latest    177MB
```

Confirm both run as an unprivileged user:

```bash
docker run --rm --entrypoint id ghcr.io/allaboutevemirolive/deploy-todo/backend:latest
docker run --rm --entrypoint id ghcr.io/allaboutevemirolive/deploy-todo/frontend:latest
```

```
uid=1000(node) gid=1000(node) groups=1000(node),1000(node)
uid=101(nginx) gid=101(nginx) groups=101(nginx),101(nginx)
```

### Check the caching and routing rules

```bash
curl -sI localhost:8088/assets/index-CVLsBKEs.js | grep -iE 'HTTP/|cache-control'
curl -sI localhost:8088/ | grep -iE 'HTTP/|cache-control'
curl -s -o /dev/null -w '%{http_code}\n' localhost:8088/some/deep/link
curl -s -w ' [%{http_code}]\n' localhost:8088/api/nope
```

```
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable
HTTP/1.1 200 OK
Cache-Control: no-cache
200
{"message":"Route GET:/api/nope not found","error":"Not Found","statusCode":404} [404]
```

The hashed asset name will differ in your build. Look at the `src=` attribute in `curl localhost:8088/` to find yours. The last line shows `/api/...` really reaches the backend (that JSON is Fastify's), while `/some/deep/link` returns the frontend page.

### Check that the internals are private

```bash
curl -s -m 2 -o /dev/null -w '%{http_code}\n' localhost:3000/api/health
```

```
000
```

`000` means no connection was possible. The backend is only reachable through Caddy.

### Check that data survives

Add a todo in the browser. Then tear the whole stack down and bring it back:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local down
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up -d
curl -s localhost:8088/api/todos
```

```
[{"id":2,"title":"persist me","done":false,"created_at":"2026-10-23T07:35:00.521Z"}]
```

The containers were destroyed and recreated; the todo is still there, because the database files live in the `pgdata` volume. (`docker compose down -v` would delete the volume and the data. Never add `-v` on a server you care about.)

## Cleaning up

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local down
```

To delete the data too, add `-v`. To remove the development database from chapter 01: `docker rm -f todo-dev-db`. Remove containers **by name**, never with a pattern such as "everything from the postgres image", or you may delete databases that belong to other projects.

## How it works

```
  docker compose up
        |
        +--> network "deploy-todo_default"  (private DNS: db, backend, frontend, caddy)
        |
        +--> db       --healthy--> backend --> (serves /api)
        +--> frontend ------------------------> (serves files)
        +--> caddy  <-- the only published ports (8088, 8443 locally)
```

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `port is already allocated` | Another program uses `8088` or `8443`. Change `HTTP_PORT` / `HTTPS_PORT` in `.env.local`. |
| `unknown flag: --env-file` or `additional properties` errors | Your Compose is too old. `docker compose version` should be v2.24 or newer. |
| Backend keeps restarting | `docker compose logs backend`. Usually a wrong `DATABASE_URL` or a changed `POSTGRES_PASSWORD` (see below). |
| You changed `POSTGRES_PASSWORD` and the backend now fails to log in | Postgres reads that variable **only when it first creates the data directory**. Changing it later does nothing. Either change it inside Postgres with `ALTER USER`, or (local only, destroys data) run `down -v` and start again. |
| Browser shows the old frontend after a rebuild | You are looking at a cached page or an old container. Re-run `up --build -d` and hard-refresh. |
| Everything is built for the wrong CPU | See [chapter 05](05-registry.md). Images built on an Apple-silicon Mac are `arm64`; most servers are `amd64`. |

## Recap

- Multi-stage Dockerfiles keep compilers out of production images.
- The images run as unprivileged users and contain no secrets.
- One Compose file describes the system; a tiny override turns "pull" into "build".
- Only Caddy is exposed. Data lives in a volume.
- The same smoke test passes against the containerised stack.

Next: [05. The Container Registry](05-registry.md)
