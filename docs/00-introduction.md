# 00. Introduction: What We Are Building and Why

## What you will learn

By the end of this walkthrough you will have a small web application running on the internet at your own HTTPS address, and a pipeline that updates it every time you run `git push`. You will understand every moving part well enough to explain it to someone else and to fix it when it breaks.

The application itself is deliberately boring: a todo list. That is on purpose. The application is not the point. **Deployment is the point.** A todo list is small enough to fit in your head, but it still has everything a real application needs: a frontend, an API, and a database.

## The finished system

```
                         the internet
                              |
                          HTTPS (443)
                              |
                       +--------------+
                       |    Caddy     |   reverse proxy + automatic HTTPS
                       +--------------+
                         |          |
                /api/*   |          |   everything else
                         v          v
                  +-----------+  +------------+
                  |  backend  |  |  frontend  |
                  |  Node.js  |  |   nginx    |
                  |  Fastify  |  |  (static   |
                  +-----------+  |   files)   |
                         |       +------------+
                         v
                  +-----------+
                  | Postgres  |   data lives in a Docker volume
                  +-----------+

     All four boxes are containers on one server, started by Docker Compose.
     Only Caddy is reachable from outside.
```

## The delivery pipeline

```
 you                GitHub                         GHCR                  your server
  |                   |                              |                        |
  | git push main     |                              |                        |
  |------------------>|                              |                        |
  |                   | Actions: build 2 images      |                        |
  |                   |----------------------------->| store images           |
  |                   | Actions: ssh to server       |                        |
  |                   |-------------------------------------------------------->
  |                   |                              |  docker compose pull   |
  |                   |                              |<-----------------------|
  |                   |                              |  docker compose up -d  |
  |                   | smoke test the live site     |                        |
  |                   |-------------------------------------------------------->
```

In words: you push code. GitHub builds two container images (one for the frontend, one for the backend) and stores them in GHCR, the GitHub Container Registry. Then GitHub connects to your server over SSH and tells it to pull the new images and restart. Finally GitHub checks that the live site really works.

## Three decisions that make this simple

These decisions shape the whole project. Each one is explained again where it matters.

1. **One public address, two internal services.** The browser only ever talks to `https://todo.lazuar.dev`. Caddy looks at the path: anything under `/api/` goes to the backend, everything else goes to the frontend. Because the frontend and the API share one origin, there is no CORS configuration and the frontend can call the API with a plain relative URL such as `/api/todos`. The same built frontend works unchanged on your laptop, on a staging server and in production.
2. **Everything is a container.** The server does not need Node.js, nginx or Postgres installed. It only needs Docker. What runs on the server is exactly what you tested on your laptop.
3. **Configuration comes from the environment.** Passwords and addresses are never written into the code or into the images. They are supplied when the container starts.

## Words you will see

| Word | Meaning |
| :--- | :--- |
| **Image** | A frozen, read-only package containing your program and everything it needs to run. Built once, run anywhere. |
| **Container** | A running instance of an image. Start ten containers from one image and you get ten isolated copies. |
| **Dockerfile** | The recipe that builds an image. |
| **Registry** | A server that stores images so other machines can download them. GHCR is GitHub's. |
| **Docker Compose** | A tool that starts several containers together from one YAML file. |
| **Reverse proxy** | A server that receives requests from the internet and forwards them to the right internal service. Caddy plays this role. |
| **CI/CD** | Continuous Integration / Continuous Delivery. Automation that builds, tests and ships your code whenever you push. GitHub Actions is ours. |
| **VPS** | Virtual Private Server: a small rented Linux computer on the internet. |
| **Volume** | Storage managed by Docker that survives when a container is deleted. The database lives in one. |

## What you need before you start

**Accounts**

- A GitHub account.
- A VPS running Ubuntu 24.04 LTS or newer (the test server ran 26.04) with a public IP address. Any provider works. 1 GB of RAM is a comfortable minimum: the three application containers used about 70 MB in total on the test server (Caddy not counted).
- A domain name you control. This guide uses `todo.lazuar.dev`. Use your own.

**Tools on your computer**

| Tool | Version used here | Check with |
| :--- | :--- | :--- |
| Node.js | 24 | `node -v` |
| npm | 11 | `npm -v` |
| Docker (Desktop, OrbStack or Engine) | 29 | `docker version` |
| Docker Compose | v2 (tested with v5.5) | `docker compose version` |
| git | any recent | `git --version` |
| curl | any | `curl --version` |

## How each chapter is written

Every chapter follows the same shape so you always know where you are:

1. **Goal.** What you will have at the end.
2. **Steps.** Exact commands and files.
3. **Check it worked.** A command and the output you should see.
4. **How it works.** The explanation, after you have seen it work.
5. **Common problems.** What goes wrong and how to fix it.

## How much was actually tested

Honesty matters in a deployment guide, because the dangerous steps are the ones nobody ran. Each chapter starts with a status line.

- ✅ **Verified** means the author ran it and the output shown is real.
- ⚠️ **Not verified** means the author did not run it. The instructions follow the official documentation, but treat your first run as a test and expect to adjust.

| Chapter | Status |
| :--- | :--- |
| 01 Backend | ✅ Verified |
| 02 Frontend | ✅ Verified in a real browser |
| 03 Wiring | ✅ Verified |
| 04 Containers | ✅ Verified, including a clean-copy rebuild with fresh volumes |
| 05 Registry | ✅ CI push to GHCR, anonymous pull, and the private-image path (refused without login, accepted with a read-only token, token cannot push) verified, plus a full CI run with private packages. ⚠️ Pushing by hand with your own token not run |
| 06 Server | ✅ Verified on a real shared VPS: DNS, certificate, app. ⚠️ Fresh-server steps (new user, SSH hardening, firewall, Docker install, our own Caddy on 80/443) not run, because that server was already set up |
| 07 CI | ✅ Run on real GitHub Actions, with public and with private packages |
| 08 Auto-deploy | ✅ Run on real GitHub Actions and a real VPS, with a restricted SSH key |
| 09 Operations | ✅ Restart, crash recovery, backup, restore and rollback verified on the VPS. ⚠️ A server reboot was not tested |
| 10 Shared server | ✅ Verified on a busy VPS that already had a reverse proxy |

**About the sample output.** Output blocks are real, but identifiers in them (commit SHAs, timestamps, asset hashes) come from the author's runs and yours will differ. The repository history was rewritten once afterwards to remove a commit trailer, so some quoted SHAs no longer exist in it. Host names, container names and paths from the test server are changed in chapters 08 and 10 for privacy. The "Common problems" tables mix problems the author actually hit (they are listed again in the field notes at the end of [chapter 09](09-operations.md)) with well-known failures described from documentation and experience that were **not reproduced** here.

Verified on 2026-10-23 with: macOS on Apple silicon, Node 24, Docker 29, Compose v5; a VPS running Ubuntu 26.04; GitHub Actions `ubuntu-latest`; Let's Encrypt for certificates; Cloudflare for DNS.

**Which path is yours?** Chapter 06 assumes a clean server where this project's own Caddy takes ports 80 and 443. If your server already runs other web applications behind a reverse proxy, do chapter 06 for DNS and files, then follow [chapter 10](10-shared-server.md) instead of starting our own Caddy.

## Repository layout

```
deploy-todo/
├── backend/            TypeScript API (Fastify + Postgres) and its Dockerfile
├── frontend/           Vite + React app and its Dockerfile + nginx config
├── deploy/             What runs on the server: compose files, Caddyfile, deploy.sh, env examples
├── scripts/smoke.sh    One script that exercises the whole API through any URL
├── docs/               This walkthrough
└── .github/workflows/  The CI/CD pipeline
```

The frontend and backend live in one plain Git repository. There is no monorepo tooling: each folder is an ordinary, independent npm project.

Next: [01. The Backend](01-backend.md)
