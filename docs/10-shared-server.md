# 10. Deploying Next to Other Apps (a Shared Reverse Proxy)

> **Status:** ✅ Verified on 2026-10-23 on a real, busy VPS (Ubuntu 26.04, 17 other containers, a shared Caddy already serving six other domains). Everything in this chapter was done there, and the output shown is real.

## Goal

Chapter 06 assumed a clean server where our own Caddy takes ports 80 and 443. Real servers are often not clean. If another reverse proxy already owns those ports, a second Caddy cannot start, and it could not get a certificate anyway. This chapter shows how to deploy the same application **behind the existing proxy** without disturbing anything else on the machine.

You will:

1. Start the app without its own Caddy, attached to the network the shared proxy uses.
2. Add one site block to the shared proxy.
3. Change a production proxy safely: back up, validate, reload gracefully, prove nothing else broke.

## When does this apply?

Check what already listens on the web ports:

```bash
ss -tlnp | grep -E ':(80|443) '
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
```

```
LISTEN 0  4096  0.0.0.0:80   0.0.0.0:*
LISTEN 0  4096  0.0.0.0:443  0.0.0.0:*
gateway-1   caddy:2-alpine   0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp ...
```

If you see something there, use this chapter. If both ports are free, use chapter 06 as written.

## The picture

```
                      internet
                         |
                  ports 80 / 443
                         v
              +----------------------+
              |  shared Caddy        |   owns the ports, owns the certificates,
              |  (another project)   |   one site block per application
              +----------------------+
                 |       |       |           network "edge"
   ..other sites..       |       |
                         |       |
            /api/* ------+       +------ everything else
                         v               v
                  todo-backend      todo-frontend        <-- our containers,
                         |                                   joined to the shared network
                         v
                        db        <-- private network of our project only
```

## Steps

### 1. Find out what the shared proxy uses

You need three facts: which Docker network it is on, which file configures it, and how that file is mounted.

```bash
docker inspect gateway-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker inspect gateway-1 --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

```
edge gateway_default
bind /srv/gateway/Caddyfile -> /etc/caddy/Caddyfile
```

Here the shared proxy is on the network **`edge`**, and its configuration is the file `/srv/gateway/Caddyfile`, bind-mounted into the container. Your other applications already join `edge`; that is how the proxy reaches them by name.

### 2. Start the app without its own Caddy

`deploy/docker-compose.shared-gateway.yml`

```yaml
# Use this when ANOTHER reverse proxy (for example a shared Caddy) already owns
# ports 80 and 443 on the server. Our own Caddy is switched off, and the
# frontend and backend are attached to the network the shared proxy uses.
#
#   docker compose -f docker-compose.yml -f docker-compose.shared-gateway.yml up -d
#
# The shared proxy then needs one site block that points at the aliases below.
# See gateway-snippet.Caddyfile. If the shared proxy's network is not called
# "edge", set EDGE_NETWORK in .env.
#
# The aliases are deliberately specific ("todo-backend", not "backend"): a
# network shared with other applications has ONE namespace for container names,
# and a generic name could collide with someone else's service. The database
# stays on this project's private network only.

services:
  caddy:
    profiles: ["standalone"] # not started unless you ask for it
  backend:
    networks:
      default: {}
      edge:
        aliases: [todo-backend]
  frontend:
    networks:
      default: {}
      edge:
        aliases: [todo-frontend]

networks:
  edge:
    name: ${EDGE_NETWORK:-edge}
    external: true
```

It is an **override**: Compose merges it onto `docker-compose.yml`.

- `profiles: ["standalone"]` on `caddy` means "only start this if someone asks for the `standalone` profile". By default our own Caddy does not start, so there is no clash on ports 80 and 443.
- `backend` and `frontend` join two networks: their own private `default`, and the shared one, here called `edge`.
- **The aliases are specific on purpose.** `todo-backend`, not `backend`. A network shared with other applications has a **single namespace for container names**. If another project also had a service called `backend` on that network, the proxy would send traffic to the wrong one, and nobody would see an error. Prefix everything.
- The database is **not** on the shared network. Only the private network of this project can reach it.
- `external: true` means "this network already exists, do not create it".

Rather than typing `-f ... -f ...` every time, record the choice once in the server's `deploy/.env`. If the shared network is not called `edge`, add its name from step 1 as well:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.shared-gateway.yml
EDGE_NETWORK=name-from-step-1
```

Compose reads `COMPOSE_FILE` from `.env`, so plain `docker compose ...` commands in that folder (and `deploy.sh`) use the right files. Verify:

```bash
docker compose config --services
```

```
db backend frontend
```

`caddy` is absent, as intended. Now start it:

```bash
docker compose pull
docker compose up -d
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
```

```
SERVICE    IMAGE                                                     STATUS
backend    ghcr.io/allaboutevemirolive/deploy-todo/backend:latest    Up 3 minutes (healthy)
db         postgres:17-alpine                                        Up 3 minutes (healthy)
frontend   ghcr.io/allaboutevemirolive/deploy-todo/frontend:latest   Up 3 minutes
```

### 3. Check the proxy can reach us, before changing it

You can test the network path using the shared proxy's own container. This is harmless: it only makes two requests.

```bash
docker exec gateway-1 wget -qO- http://todo-backend:3000/api/health
docker exec gateway-1 wget -qO- http://todo-frontend:8080/ | head -c 120
```

```
{"status":"ok"}
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/
```

If this fails, the problem is the network or the aliases, and you have not touched production yet.

### 4. Make the DNS record exist first

Do this **before** editing the proxy. See chapter 06, step 2. If the proxy asks Let's Encrypt for a certificate before the name resolves, the attempt fails, and repeated failures can trigger a rate limit that locks you out for an hour.

### 5. Change the shared proxy safely

This is the delicate step: the file you edit serves other sites. The method below touches nothing until a dry run has passed, changes the file with one command, and can be undone with one command.

`deploy/gateway-snippet.Caddyfile`

```
# Add this site block to the shared Caddy that owns ports 80 and 443.
# Replace the host name with yours. It is the same routing as deploy/Caddyfile,
# but it addresses the aliases from docker-compose.shared-gateway.yml.

todo.lazuar.dev {
	encode zstd gzip

	handle /api/* {
		reverse_proxy todo-backend:3000
	}

	handle {
		reverse_proxy todo-frontend:8080
	}
}
```

It is the same routing as our own Caddyfile in chapter 04, but addressed to the aliases.

**a. Build a candidate and look at the difference.** Do not edit the live file yet.

```bash
LIVE=/srv/gateway/Caddyfile
CAND=/home/ubuntu/deploy-todo/Caddyfile.candidate
{ cat $LIVE; echo; cat /home/ubuntu/deploy-todo/deploy/gateway-snippet.Caddyfile; } > $CAND
diff $LIVE $CAND
```

The diff must show **only additions** at the end. Anything else means something is wrong.

> A trap that bit this very walkthrough: `diff` exits with status 1 when files differ. Inside a script with `set -e` that kills the script right after the diff, before the validation step you meant to run. Keep `diff` out of `set -e` sections.

**b. Validate the candidate using the running proxy's own environment.**

```bash
docker exec -i gateway-1 sh -c 'cat > /tmp/Caddyfile.candidate' < $CAND
docker exec gateway-1 caddy validate --config /tmp/Caddyfile.candidate --adapter caddyfile
docker exec gateway-1 rm -f /tmp/Caddyfile.candidate
```

```
Valid configuration
```

Validating inside the container matters: the Caddyfile refers to environment variables such as the other sites' domain names. Only the container knows their values, so a validation on your own machine would be meaningless.

**c. Record a "before" picture of the other sites.** This is how you will prove you broke nothing:

```bash
for d in site-a.example.com site-b.example.com site-c.example.com site-d.example.com site-e.example.com site-f.example.com; do
  printf '%-30s %s\n' "$d" "$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://$d/)"
done
```

```
site-a.example.com                 502
site-b.example.com                 404
site-c.example.com                   307
site-d.example.com               200
site-e.example.com                302
site-f.example.com           308
```

(One of these was already a `502` before we touched anything. A "before" picture is what stops you blaming yourself, or the wrong thing, later.)

**d. Back up, then apply in place.**

```bash
cp -p $LIVE $LIVE.before-deploy-todo      # follow the naming habit already in that folder
cat $CAND > $LIVE                          # write INTO the file; do not replace it
```

> **Why `cat >` and not `mv`?** The container has this **file** bind-mounted. A bind mount is attached to a specific file on disk. `mv` replaces the file with a new one, and the container keeps looking at the old, now-orphaned file, so a reload would silently change nothing. `cat >` writes into the same file, which the container sees immediately.

**e. Validate the live mount, then reload gracefully.**

```bash
docker exec gateway-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec gateway-1 caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile
docker inspect gateway-1 --format '{{.State.Status}}, started {{.State.StartedAt}}'
```

```
Valid configuration
...
running, started 2026-10-09T08:58:07Z
```

`reload` swaps the configuration without dropping existing connections. The `started` timestamp is from nine days earlier: **the proxy did not restart.** If validation had failed you would restore the backup (`cat $LIVE.before-deploy-todo > $LIVE`) and stop.

**f. Compare with the "before" picture.** Run the loop from step c again. Every status code was identical. Nothing else was affected.

### 6. Watch the certificate arrive

```bash
docker logs --since 3m gateway-1 2>&1 | grep todo.lazuar.dev | grep -iE 'challenge|authoriz|obtain'
```

```
... "served key authentication","identifier":"todo.lazuar.dev","challenge":"http-01","remote":"23.178.112.219:60549" ...
... "served key authentication","identifier":"todo.lazuar.dev","challenge":"http-01","remote":"18.143.64.14:27114" ...
... (three more of the same, from five different addresses) ...
... "authorization finalized","identifier":"todo.lazuar.dev","authz_status":"valid"
... "certificate obtained successfully","identifier":"todo.lazuar.dev","issuer":"acme-v02.api.letsencrypt.org-directory"
```

Two things worth noticing. Let's Encrypt checked from **five different places around the world** before issuing, which is why the DNS record must be correct everywhere, not just on your machine. And the whole thing took about **seven seconds** from reload to certificate.

## Check it worked

From the server:

```bash
./scripts/smoke.sh https://todo.lazuar.dev
echo | openssl s_client -connect todo.lazuar.dev:443 -servername todo.lazuar.dev 2>/dev/null | openssl x509 -noout -issuer -subject -dates
```

```
All smoke checks passed against https://todo.lazuar.dev
issuer=C=US, O=Let's Encrypt, CN=YE2
subject=CN=todo.lazuar.dev
notBefore=Oct 23 06:59:56 2026 GMT
notAfter=Jan 21 06:59:55 2027 GMT
```

## Undoing everything

Cleanly, in the opposite order:

```bash
cd ~/deploy-todo/deploy && docker compose down            # keep the data volume; add -v to delete it
cat /srv/gateway/Caddyfile.before-deploy-todo > /srv/gateway/Caddyfile
docker exec gateway-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Then delete the DNS record.

## How it works

The shared proxy does exactly what our own Caddy did in chapter 04: match the host name, send `/api/*` one way and everything else another. The only differences are *who owns the ports* and *how the proxy finds our containers*: by name, on a network both sides joined.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `address already in use` on port 80 or 443 when starting our stack | You started our own Caddy while another proxy owns the ports. Use the shared-gateway override (`COMPOSE_FILE` in `.env`). |
| The proxy answers `502` for our host | It cannot resolve `todo-backend` or `todo-frontend`: the containers are not on the shared network, or an alias is misspelled. Check step 3. |
| `network edge declared as external, but could not be found` | The network name differs on your server. Use the name from step 1 in `EDGE_NETWORK` in `.env`. |
| The reload "worked" but nothing changed | You replaced the Caddyfile with `mv` or an editor that swaps files. Write into the same file (step 5d). |
| Another application suddenly misbehaves | A container name collision on the shared network. Use unique aliases (step 2), and use `docker network inspect` to see who answers to which name. |
| `Valid configuration` on your machine but errors on the server | You validated outside the proxy's environment. Validate inside the container (step 5b). |

## Recap

- Check what owns ports 80 and 443 before you plan anything.
- On a shared network, names are shared too: use specific aliases, and keep the database on a private network.
- Change a production proxy like a surgeon: candidate file, dry-run validation inside the container, backup, in-place write, validate again, graceful reload, then compare before and after.
- The reload does not restart the proxy, and it took seven seconds to get a trusted certificate.

Back to [00. Introduction](00-introduction.md), or on to [09. Operating the Deployment](09-operations.md).
