# 08. Automatic Deployment

> **Status:** ⚠️ Not verified here (it needs a real server and a real GitHub repository). The YAML passes `actionlint`, and the commands the job runs on the server are the same ones you ran by hand in chapters 04 and 06. Read "Common problems" before your first run.

## Goal

After the images are pushed, GitHub connects to your server, updates it, and checks the live site. The whole delivery becomes: `git push`, wait, done.

## The idea

Chapter 07 ends with new images in GHCR. The server does not know that. Something has to tell it. There are two common designs:

| | **A. Push (this chapter)** | **B. Pull (Watchtower)** |
| :--- | :--- | :--- |
| Who triggers the update | The CI job, over SSH | A program on the server that polls the registry |
| Speed | Immediate | Up to the polling interval (minutes) |
| Visible failures | Yes, the Actions run goes red | No, you must read the server's logs |
| Needs an SSH key in GitHub | Yes | No |
| Updates compose/Caddy config too | Yes (`git pull`) | No, images only |
| Easy to explain | Yes: it is the commands you typed | It is a background process doing something clever |

We use **A**. It is explicit, it fails loudly in the Actions tab, and every step is a command you already know. Design B is described at the end.

## Steps

### 1. Make a dedicated SSH key for CI

On your **laptop**, in a temporary folder (not inside the repository):

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-deploy" -f ./deploy_key
```

This creates two files: `deploy_key` (private, goes to GitHub) and `deploy_key.pub` (public, goes to the server). Use a key that is used for **nothing else**. If it leaks, you revoke just this one.

### 2. Authorise it on the server

```bash
ssh deploy@203.0.113.10
echo 'ssh-ed25519 AAAA...your deploy_key.pub contents... github-actions-deploy' >> ~/.ssh/authorized_keys
```

### 3. Record the server's identity

SSH normally asks "do you trust this host?" the first time. A CI job cannot answer, and blindly accepting it would make it possible for an attacker to impersonate your server. Instead we give GitHub the server's real key ahead of time:

```bash
ssh-keyscan -t ed25519 203.0.113.10
```

```
203.0.113.10 ssh-ed25519 AAAA...
```

> **Verify it before trusting it.** Run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` **on the server** and compare the fingerprint with `ssh-keygen -lf` of what you just scanned. If they match, you know the key is really your server's.

### 4. Give GitHub the secrets and variables

Repository, **Settings**, **Secrets and variables**, **Actions**.

**Secrets** tab (hidden after saving):

| Name | Value |
| :--- | :--- |
| `SSH_PRIVATE_KEY` | The entire contents of `deploy_key`, including the `BEGIN` and `END` lines |
| `SSH_KNOWN_HOSTS` | The line printed by `ssh-keyscan` in step 3 |

**Variables** tab (visible, not sensitive):

| Name | Value |
| :--- | :--- |
| `DEPLOY_HOST` | `203.0.113.10` (or your domain) |
| `DEPLOY_USER` | `deploy` |
| `SITE_URL` | `https://todo.lazuar.dev` |

Then delete the private key from your laptop (`rm deploy_key`) unless you have a reason to keep it. GitHub has a copy, and you can always generate another.

### 5. The deploy job

It is the second job in the workflow you read in chapter 07:

```yaml
  # 2. Tell the server to pull the new images (skipped until configured)
  # ------------------------------------------------------------------
  deploy:
    needs: build
    # Until you set the DEPLOY_HOST variable, the pipeline stops after the
    # build, so you can add the server later.
    if: vars.DEPLOY_HOST != ''
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      DEPLOY_TARGET: ${{ vars.DEPLOY_USER }}@${{ vars.DEPLOY_HOST }}
    steps:
      - uses: actions/checkout@v7

      - name: Configure SSH
        env:
          SSH_PRIVATE_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
          SSH_KNOWN_HOSTS: ${{ secrets.SSH_KNOWN_HOSTS }}
        run: |
          install -m 700 -d ~/.ssh
          printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          printf '%s\n' "$SSH_KNOWN_HOSTS" > ~/.ssh/known_hosts

      - name: Deploy on the server
        run: |
          ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=yes "$DEPLOY_TARGET" 'bash -s' <<'REMOTE'
          set -euo pipefail
          cd ~/deploy-todo
          git pull --ff-only
          cd deploy
          docker compose pull
          docker compose up -d --remove-orphans
          docker image prune -f
          docker compose ps
          REMOTE

      - name: Smoke test the live site
        run: ./scripts/smoke.sh "${{ vars.SITE_URL }}"
```

Walk through it:

- **`if: vars.DEPLOY_HOST != ''`.** Until you create that variable the job is skipped. This is why the pipeline already worked as build-only in chapter 07.
- **`needs: build`.** It starts only after both images were pushed successfully.
- **Configure SSH.** Writes the key and the known-hosts file into `~/.ssh` on the runner, with the strict permissions SSH insists on. The secrets are passed through `env:` rather than written into the script text. That keeps secret values out of the command line.
- **`StrictHostKeyChecking=yes`.** If the server's key does not match `SSH_KNOWN_HOSTS`, the connection is refused instead of silently trusted.
- **The script after `<<'REMOTE'`** runs on the server, not on GitHub:
  - `set -euo pipefail` stops at the first error, so a failed `pull` never leads to a half-updated `up`.
  - `git pull --ff-only` updates the compose file and Caddyfile. `--ff-only` refuses to create merge commits on the server.
  - `docker compose pull` downloads the new images.
  - `docker compose up -d --remove-orphans` recreates only the containers whose image changed. Postgres is untouched, so there is no database downtime.
  - `docker image prune -f` deletes dangling old layers so the disk does not fill up.
- **Smoke test.** The last step runs `scripts/smoke.sh` from the GitHub runner against the **public** address. That tests the whole path a visitor takes: DNS, TLS, Caddy, backend, database. If it fails, the run goes red and you know before your users do.

### 6. Deploy

Push a small change to `backend/` or `frontend/`, or press **Run workflow**. Watch the **Actions** tab. When `deploy` is green, open the site.

## Check it worked

On the server:

```bash
cd ~/deploy-todo/deploy
docker compose ps
docker compose images
```

The `IMAGE` column should show the new image, and `CREATED` should be recent. Or just look at the Actions run: the smoke-test step prints `All smoke checks passed against https://todo.lazuar.dev`.

## How it works

```
  CI runner                                   server
  ---------                                   ------
  ssh deploy@host 'bash -s'  ------------->   git pull
        (script sent on stdin)                docker compose pull       <--- from GHCR
                                              docker compose up -d
  smoke.sh https://todo.lazuar.dev  ------->  (public site)
```

Everything the server does is something you did by hand in chapter 06. Automation did not add new ideas, only repetition.

## Alternative: Watchtower (design B)

Watchtower is a container that checks the registry every few minutes and restarts containers whose image changed. Nothing in CI needs SSH access to the server.

Things to know before choosing it:

- The original `containrrr/watchtower` project is **archived** (last updated December 2025). A maintained fork exists as `nickfedor/watchtower`. Check that it is still maintained when you read this.
- It would update *every* container unless you limit it with `--label-enable` and add the label `com.centurylinklabs.watchtower.enable=true` to only your app services. Otherwise Postgres and Caddy could be upgraded unattended.
- It needs registry credentials to pull private images.
- Failures are silent. Nothing goes red anywhere. You find out by reading its logs, or when a user complains.
- It cannot apply changes to the compose file or Caddyfile.

If you want it, the idea in Compose is:

```yaml
  watchtower:
    image: nickfedor/watchtower:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --interval 300 --cleanup --label-enable
```

and a label on `backend` and `frontend`. Mounting `docker.sock` gives a container control over Docker, which is root-equivalent. This is an extra reason to prefer design A for a small project.

This chapter's author did not test design B.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `deploy` job is skipped | The `DEPLOY_HOST` variable is missing or empty. It must be a **Variable**, not a Secret. |
| `Permission denied (publickey)` | The public key is not in `~/.ssh/authorized_keys` of the right user, or `SSH_PRIVATE_KEY` was pasted without its `BEGIN`/`END` lines. |
| `Host key verification failed` | `SSH_KNOWN_HOSTS` is missing or for a different address. Use the same value for `DEPLOY_HOST` as you scanned. |
| `error in libcrypto` | The private key lost its trailing newline or gained extra characters. Re-paste it exactly. |
| `git pull` fails: `Your local changes would be overwritten` | Someone edited a tracked file in `~/deploy-todo` on the server. `git status`, undo the edit, and make changes in the repository instead. |
| `pull access denied` during `docker compose pull` | The server's `docker login` (chapter 06 step 8) expired or the token was revoked. Log in again. |
| The smoke test fails but the site works in a browser | DNS or the certificate may not be ready for the runner yet, or `SITE_URL` has a typo or a trailing path. |
| `deploy` is green but the old version is running | Check `TAG` in the server's `.env`. If it is pinned to a commit SHA from a rollback, it deliberately ignores `latest` ([chapter 09](09-operations.md)). |

## Recap

- CI pushes images; then it tells the server to pull them. Two separate jobs, joined by `needs:`.
- The server is trusted by a pinned host key, and CI is trusted by a dedicated key used for nothing else.
- Secrets live in GitHub Secrets. Non-sensitive settings live in Variables.
- The last step tests the real public site, so a green run means the site works.

Next: [09. Operating the Deployment](09-operations.md)
