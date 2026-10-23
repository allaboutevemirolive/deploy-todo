# deploy-todo

A complete, explained walkthrough of deploying a small web application to a real server: **Vite + React** frontend, **TypeScript + Fastify** backend, **Postgres**, containers, **GHCR**, **Caddy** with automatic HTTPS, and a **GitHub Actions** pipeline that deploys on every `git push`.

The app is a todo list. That is deliberate: it is small enough to understand completely, and it still has a frontend, an API and a database. **The deployment is the point.**

```
 Browser --HTTPS--> Caddy --/api/*--> backend (Node/Fastify) --> Postgres
                       \----other---> frontend (nginx, static files)

 git push --> GitHub Actions --> build images --> GHCR --> ssh to server --> docker compose up
```

## Read the walkthrough

Start at [docs/00-introduction.md](docs/00-introduction.md) and follow the chapters in order. Each one ends with a working checkpoint.

| # | Chapter | You will end up with |
| :--- | :--- | :--- |
| 00 | [Introduction](docs/00-introduction.md) | The big picture, vocabulary, prerequisites |
| 01 | [The Backend](docs/01-backend.md) | A TypeScript API on Postgres, with a smoke test |
| 02 | [The Frontend](docs/02-frontend.md) | A Vite + React app |
| 03 | [Wiring](docs/03-wiring.md) | Both running as one site, with no CORS |
| 04 | [Containers](docs/04-containers.md) | The whole system in Docker Compose on your laptop |
| 05 | [The Registry](docs/05-registry.md) | Images in GHCR, and the Mac-vs-server CPU trap |
| 06 | [The Server](docs/06-server.md) | A hardened Ubuntu VPS serving HTTPS |
| 07 | [Continuous Integration](docs/07-ci.md) | GitHub builds and pushes images for you |
| 08 | [Automatic Deployment](docs/08-auto-deploy.md) | Push to `main`; the server updates itself, and the pipeline proves which commit is live |
| 09 | [Operations](docs/09-operations.md) | Logs, rollback, backups, secrets, troubleshooting |
| 10 | [Next to other apps](docs/10-shared-server.md) | Deploying behind a shared reverse proxy on a busy server |

Chapter 00 lists exactly what was tested, where, and what was not. Every deployment chapter was run on a real VPS and real GitHub Actions on 2026-10-23, except the steps marked ⚠️.

## Run it on your laptop in two minutes

You need Docker with Compose v2 or newer (tested with Compose v5.5).

```bash
cd deploy
cp .env.local.example .env.local
docker compose -f docker-compose.yml -f docker-compose.local.yml \
  --env-file .env.local up --build -d
cd ..
./scripts/smoke.sh http://localhost:8088
```

Open <http://localhost:8088>. Stop it with the same `docker compose ... down`.

## Layout

```
backend/            TypeScript API + Dockerfile
frontend/           Vite + React app + Dockerfile + nginx.conf
deploy/             docker-compose.yml, local and shared-proxy overrides, Caddyfile, deploy.sh, .env examples
scripts/smoke.sh    Exercises the API through any URL
docs/               The walkthrough
.github/workflows/  CI/CD pipeline
```

## Conventions

- Image names are `ghcr.io/allaboutevemirolive/deploy-todo/{backend,frontend}`. Replace the owner if you fork this.
- The example domain is `todo.lazuar.dev`. Replace it with yours in `deploy/.env` on the server.
- Secrets are never committed. Only the `*.example` env files are.
