# 09. Operating the Deployment

> **Status:** ✅ Verified on 2026-10-23 on the real VPS: restart, crash recovery, backup, restore and rollback with a real GHCR tag. ⚠️ A server **reboot** was not tested, because that server hosts other production sites. The remaining sections are standard Docker practice and were not run.

Shipping is half the job. This chapter is the one you come back to at 2 a.m.

All commands run on the server in `~/deploy-todo/deploy`. (Locally, add `-f docker-compose.yml -f docker-compose.local.yml --env-file .env.local` after `docker compose`.)

## Look at what is running

```bash
docker compose ps                  # state and health of each service
docker compose logs -f backend     # follow the API's log (Ctrl-C to stop watching)
docker compose logs --tail=100 caddy
docker stats --no-stream           # CPU and memory per container
```

Logs are the first place to look for every problem. Backend logs are JSON lines, two per request (one when it arrives, one when it completes, with the status code and response time).

## Restart something

```bash
docker compose restart backend     # restart one service
docker compose up -d               # make reality match the compose file
```

`restart` re-runs the same container. `up -d` recreates containers if their image or configuration changed.

## Crash recovery, and a trap in how you test it

`restart: unless-stopped` brings a container back after it **exits by itself**. It does **not** bring back a container that was **stopped on purpose**, and Docker counts a manual `docker stop` or `docker kill` as "on purpose" (the kill was tested; the stop follows Docker's documentation). This matters when you test, because the obvious test is wrong. Both cases were run on the real server:

```bash
# A crash the daemon did not cause: the process exits from inside.
docker exec deploy-todo-backend-1 kill -TERM 1
sleep 8
docker inspect deploy-todo-backend-1 --format '{{.State.Status}} restarts={{.RestartCount}}'
```

```
running restarts=1
```

Health returned `200` again, and the log shows the graceful shutdown line from chapter 01: `SIGTERM received, shutting down`.

```bash
# Now the manual stop.
docker kill deploy-todo-backend-1; sleep 6
docker inspect deploy-todo-backend-1 --format '{{.State.Status}}'
```

```
exited
```

It stayed down: Docker took the kill as your wish. `docker compose up -d` brings it back (`running (healthy)`). The same applies to a service you stopped by hand before a reboot: it will not return on its own.

## Which version is running?

```bash
curl -s https://todo.lazuar.dev/api/health
```

```
{"status":"ok","version":"136bb338f46d96f02f00d190b8268fa3298123b8"}
```

Compare it with `git rev-parse HEAD`. After a rollback it shows the **older** commit that built the pinned image, which is the quickest way to confirm the rollback took effect.

## Deploy a new version by hand

The same three commands CI runs:

```bash
git pull --ff-only
docker compose pull
docker compose up -d --remove-orphans
```

## Roll back

Every CI build pushed an image tagged with its commit SHA. Find a known-good one in the repository's Packages page, or with `git log --oneline`. Then pin the server to it by setting `TAG` in `.env`:

```bash
nano .env          # change TAG=latest to TAG=abc1234  (use the full SHA CI pushed)
docker compose up -d
```

The mechanism was verified locally with a made-up tag, and again on the real server with a **real tag from GHCR** (the full commit SHA that CI pushed): pinning pulled that exact image and restarted only `backend` and `frontend`. Setting `TAG=latest` and running `docker compose up -d` returned them to normal. The output below is from the local run with the made-up tag `abc1234`; the real-server run looked the same, with the full SHA as the tag.

```
SERVICE    IMAGE                                                      STATUS
backend    ghcr.io/allaboutevemirolive/deploy-todo/backend:abc1234    Up 6 seconds (healthy)
caddy      caddy:2                                                    Up 2 minutes
db         postgres:17-alpine                                         Up 2 minutes (healthy)
frontend   ghcr.io/allaboutevemirolive/deploy-todo/frontend:abc1234   Up 6 seconds
```

Note that Caddy and Postgres were not touched. Only the two services whose image changed were recreated.

**Two things to remember:**

1. **While pinned, new pushes do not reach the server.** CI will pull and run the pinned tag. This is intentional (a rollback should stay put) but easy to forget. After you fix the bug, set `TAG=latest` again.
2. **A rollback only reverts code.** If the bad release changed the database, the data is not rolled back. That is the reason backups exist, below.

Use the **full** commit SHA that CI pushed (the tag in the registry), not a shortened one. CI tags with `${{ github.sha }}`, which is the full 40-character value. `git log --oneline` prints short SHAs: turn one into the full value with `git rev-parse <short-sha>`.

## Back up the database

```bash
mkdir -p ~/backups      # outside the repository, so a backup can never be committed by accident
docker compose exec -T db pg_dump -U todo todo | gzip > ~/backups/todo-$(date +%F).sql.gz
```

`-T` stops Compose from allocating a terminal, which would corrupt the piped output. This was run for real:

```
$ ls -l /tmp/todo-backup.sql.gz
916 bytes
```

A backup that has never been restored is a hope, not a backup. **Test the restore.** This was also run for real, into a scratch database so the live data is never touched:

```bash
docker compose exec -T db createdb -U todo todo_restore_test
gunzip -c ~/backups/todo-2026-10-23.sql.gz | docker compose exec -T db psql -q -U todo -d todo_restore_test
docker compose exec -T db psql -U todo -d todo_restore_test -c 'SELECT id, title FROM todos'
docker compose exec -T db dropdb -U todo todo_restore_test
```

```
 id |   title    
----+------------
  2 | persist me
(1 row)
```

(You will also see a couple of `set_config` and `setval` lines. They are normal output from the restore.)

To restore into the real database after a disaster, first stop the backend, then restore into an empty database, then start the backend again.

**Where to keep backups.** A backup on the same server dies with the server. Copy them somewhere else (another machine, object storage, your laptop):

```bash
scp deploy@203.0.113.10:'~/backups/todo-*.sql.gz' ./backups/
```

A cron job on the server is the simplest way to take them regularly:

```bash
crontab -e
```

```
0 3 * * * cd ~/deploy-todo/deploy && docker compose exec -T db pg_dump -U todo todo | gzip > ~/backups/todo-$(date +\%F).sql.gz
```

(`~/backups` must exist; the backup command above creates it. In crontab, `%` must be written as `\%`.) Delete old ones too, or the disk fills up.

## Change a secret

**The database password.** Postgres only reads `POSTGRES_PASSWORD` the first time it creates its data folder. Editing `.env` afterwards does not change the real password. Change it in two places, in this order:

```bash
docker compose exec db psql -U todo -d todo -c "ALTER USER todo PASSWORD 'the-new-password';"
nano .env                        # put the same new password in POSTGRES_PASSWORD
docker compose up -d backend     # recreate the backend with the new DATABASE_URL
```

Use a hex password (`openssl rand -hex 24`), as explained in chapter 06.

**The read-only GHCR token on the server.** Create a new token, run `docker login ghcr.io` with it, then revoke the old one at GitHub.

**The CI SSH key.** Generate a new one (chapter 08), add its public half to `authorized_keys`, update the `SSH_PRIVATE_KEY` secret, then remove the old public key from the server.

## Keep the server healthy

**Disk space.** Old images accumulate. `deploy.sh` ([chapter 08](08-auto-deploy.md)) already removes this project's old images, limited by label so other projects are not touched. To see usage:

```bash
docker system df
```

Be careful with broader cleanup. `docker system prune -a` removes every image not used by a running container. `docker system prune --volumes` can delete data. Never run either on a machine that hosts anything you cannot lose, and never run a prune with a name pattern that might match other projects' containers.

**Operating system updates.**

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo reboot            # when the kernel was updated
```

All services have `restart: unless-stopped`, so they should return after the reboot, except any you stopped on purpose. (A reboot was not tested by the author.) For automatic security patches, install `unattended-upgrades`.

**Upgrading Postgres.** Do not simply change `postgres:17-alpine` to a newer major version. The data folder is not compatible between major versions and Postgres will refuse to start. The safe route is: take a backup, start a new Postgres at the new version with an empty volume, restore the dump into it, and switch over. Minor updates within 17 are safe: pull the image again and recreate the container.

**Updating Caddy.** `caddy:2` follows the 2.x line. `docker compose pull caddy && docker compose up -d caddy` takes the latest.

## Know when it is down

Right now you find out something broke when a user tells you. The cheapest fix: sign up for any free uptime monitor and point it at `https://todo.lazuar.dev/api/health`. That URL returns `200` only if the API **and** the database work (chapter 01), and `503` otherwise, so it is a real health signal.

## Troubleshooting by symptom

| Symptom | First thing to check |
| :--- | :--- |
| Site does not load at all | `dig +short todo.lazuar.dev` (DNS), then `docker compose ps` (is Caddy up?), then `sudo ufw status` |
| Browser says the certificate is invalid | `docker compose logs caddy` |
| `502 Bad Gateway` from Caddy | Backend or frontend is down: `docker compose ps`, `docker compose logs backend` |
| Page loads, list is empty or shows an error | Browser dev tools, Network tab: what status does `/api/todos` return? Then `docker compose logs backend` |
| Backend restarts in a loop | `docker compose logs backend`. Look for the first error line. Usually the database |
| `/api/health` returns `503` | The backend is up but cannot reach Postgres. `docker compose ps` (is `db` healthy?), `docker compose logs db` |
| Deployed but still the old version | Is `TAG` pinned in `.env`? Did `docker compose pull` succeed? Did the CI deploy job actually run? |
| Everything worked yesterday | Disk full (`df -h`), certificate renewal failed, or an unattended reboot happened. `uptime` and `docker compose ps` |
| Data is gone after a deploy | Someone ran `docker compose down -v`, or the volume name changed because the Compose project name changed. Restore from a backup |

## A short security checklist

- [ ] SSH: key-only, root login disabled, a non-root `deploy` user.
- [ ] Firewall allows only 22, 80, 443.
- [ ] The database and backend publish no ports.
- [ ] `.env` is `chmod 600` and never committed. Run `git log --all -- deploy/.env` once to be sure.
- [ ] The server's GHCR token is read-only.
- [ ] The CI SSH key is used for nothing else, and the host key is pinned.
- [ ] Backups exist, are stored off the server, and a restore has been tested.
- [ ] Containers run as non-root users (verified in chapter 04).
- [ ] The workflow's `GITHUB_TOKEN` has only the permissions it needs.

## Where to go next

- **Tests in CI.** Add a job that runs the type checks and the smoke test against a throwaway Compose stack, and make `build` depend on it.
- **Staging environment.** A second server or a second Compose project, with its own domain, deployed from a branch.
- **GitHub Environments.** Put the deploy job in a protected `production` environment so a person must approve each deployment.
- **Monitoring and logs.** Ship container logs somewhere searchable instead of reading them with `docker compose logs`.
- **Migrations.** Replace the one-line `CREATE TABLE IF NOT EXISTS` with a real migration tool as soon as the schema needs to change.

## Field notes: what went wrong while testing this walkthrough

These are real surprises from the deployment tests, kept because you will meet them too.

| What happened | Why | Where it is explained |
| :--- | :--- | :--- |
| Assumed new GHCR packages start private. They were public | A package pushed by a public repo's workflow was public. The assumption was never checked | [05](05-registry.md) step 5 |
| First crash test left the container down | `docker kill` counts as a manual stop, so `unless-stopped` obeys it | This chapter, "Crash recovery" |
| Laptop could not resolve the new name for a long time | Negative DNS caching. Public resolvers had the record already | [06](06-server.md) step 2 |
| A green deploy changed nothing | The new build was byte-identical, so Compose left the containers alone. Nothing in the log said so | [08](08-auto-deploy.md), "Proving the new version is really running" |
| A safe-looking script stopped after `diff` | `diff` exits 1 when files differ, and `set -e` treats that as failure | [10](10-shared-server.md) step 5a |
| `git pull` on the server refused to run | A file copied by hand with `scp` also existed in the new commit | [08](08-auto-deploy.md) step 7 |
| The "restricted key" test seemed to fail | The test silently used a different key from the SSH agent | [08](08-auto-deploy.md) step 4 |
| First CI deploy would have failed | The forced command runs the script before the `git pull` that would bring it | [08](08-auto-deploy.md) step 7 |
