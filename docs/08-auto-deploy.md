# 08. Automatic Deployment

> **Status:** ✅ Verified on 2026-10-23 on real GitHub Actions and a real VPS: a push to `main` built both images, connected to the server over SSH, deployed, and passed a smoke test that checked the live version. ⚠️ The Watchtower alternative at the end was not tested.

## Goal

After the images are pushed, GitHub connects to your server, updates it, and checks that the live site runs the commit you just pushed. The whole delivery becomes: `git push`, wait, done.

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

We use **A**. Design B is described at the end.

## The risk of design A, and how we shrink it

Design A stores an SSH key in GitHub. Whoever can run your workflow can use that key. If the key opens a normal shell, then a mistake in a workflow, or a compromised action, becomes **a shell on your server**. On a server hosting anything else, that is a bad trade.

So we do not give CI a shell. We give it a key that can run **exactly one program**, and nothing else:

```
restrict,command="/home/ubuntu/deploy-todo/deploy/deploy.sh" ssh-ed25519 AAAA... deploy-todo-ci
```

- `command="..."` is a **forced command**. Whatever the client asks to run, the server runs this program instead. (Verified: asking it to run `whoami` ran the deploy script and ignored `whoami`.)
- `restrict` switches off everything else an SSH key can do: no terminal, no port forwarding, no agent forwarding, no X11.

If this key leaks, an attacker can trigger a redeploy of this one project. They cannot read files, run commands or reach the other applications.

## The server-side script

`deploy/deploy.sh`

```bash
#!/usr/bin/env bash
# Runs ON THE SERVER. CI calls it over SSH; you can also run it by hand.
#
#   ~/deploy-todo/deploy/deploy.sh
#
# It does what you would type yourself: update the files, pull the new images,
# restart what changed.

# Everything lives inside main() and the script ends with `exit`. Bash reads a
# script while running it, and `git pull` below may rewrite THIS file. Reading
# a whole function first means a changed file cannot confuse the run.
main() {
  set -euo pipefail

  cd "$(dirname "$0")/.."        # repository root
  git pull --ff-only             # new compose / Caddy files, and this script

  cd deploy
  docker compose pull
  docker compose up -d --remove-orphans

  # Remove old, untagged images of THIS project only. A plain `image prune`
  # would also touch dangling images that belong to other projects on the host.
  docker image prune -f \
    --filter "label=org.opencontainers.image.source=https://github.com/allaboutevemirolive/deploy-todo"

  docker compose ps
}

main "$@"
exit $?
```

It does what you would type yourself. Two details are lessons, not decoration:

- **Everything is inside `main()`, and the script ends with `exit`.** Bash reads a script *while* it runs it. `git pull` can rewrite this very file mid-run, and bash would then continue reading from a different version at a stale position. Reading a whole function first avoids the problem.
- **`image prune` is limited by label.** A plain `docker image prune` removes dangling images from *every* project on the host. On a shared server that is someone else's data. The filter limits it to images carrying this project's `source` label (the label we set in the Dockerfiles in chapter 04).

## Steps

### 1. Make a dedicated SSH key for CI

On your **laptop**, in a temporary folder (not inside the repository):

```bash
ssh-keygen -t ed25519 -N "" -C "deploy-todo-ci" -f ./key
```

This creates `key` (private, goes to GitHub) and `key.pub` (public, goes to the server). Use it for nothing else. If it leaks you revoke only this one.

### 2. Authorise it on the server, restricted

On the **server**, back up the file first, then add one line: the restrictions, then your public key.

```bash
cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.before-deploy-todo-ci
echo 'restrict,command="/home/ubuntu/deploy-todo/deploy/deploy.sh" ssh-ed25519 AAAA...contents of key.pub... deploy-todo-ci' >> ~/.ssh/authorized_keys
```

Use the path where **your** clone lives. The script must already exist there (see "Bootstrapping" below).

### 3. Record the server's identity

SSH normally asks "do you trust this host?" the first time. A CI job cannot answer, and blindly accepting would let an attacker impersonate your server. Give GitHub the real key ahead of time:

```bash
ssh-keyscan -t ed25519 your-server.example.com | tee known_hosts
```

```
your-server.example.com ssh-ed25519 AAAA...
```

**Verify it before trusting it.** Compare two fingerprints. They must match exactly:

```bash
ssh-keyscan -t ed25519 your-server.example.com 2>/dev/null | ssh-keygen -lf -     # on your laptop
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub                                  # on the server
```

```
256 SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG your-server.example.com (ED25519)
256 SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG root@your-server (ED25519)
```

### 4. Test the restricted key by hand, before involving GitHub

From your laptop, ask the server to run `whoami` using **only** the new key:

```bash
ssh -i ./key -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile=./known_hosts \
    ubuntu@your-server.example.com whoami
```

If the restriction works, you do **not** get a user name back. You get the output of the deploy script instead (`Already up to date.`, the image pulls, `docker compose ps`), because the forced command ignores what you typed. That is the result that was observed.

> **Make sure the test really uses that key.** The first attempt at this test, while writing this chapter, used a shell variable that the shell did not split into separate arguments. `ssh` ignored the broken options, quietly authenticated with a *different* key from the author's agent, and happily printed the user name. It looked like a failed restriction and proved nothing. The two options `-o IdentitiesOnly=yes -o IdentityAgent=none` prevent that: they forbid ssh from trying any key except the one you named.

### 5. Give GitHub the secrets and variables

In the web interface: repository, **Settings**, **Secrets and variables**, **Actions**. Or with the GitHub CLI (this is what was done here):

```bash
gh secret set SSH_PRIVATE_KEY < ./key
gh secret set SSH_KNOWN_HOSTS < ./known_hosts       # the line printed by ssh-keyscan
gh variable set DEPLOY_HOST --body your-server.example.com
gh variable set DEPLOY_USER --body ubuntu
gh variable set SITE_URL    --body https://todo.lazuar.dev
```

| Kind | Name | Value |
| :--- | :--- | :--- |
| Secret | `SSH_PRIVATE_KEY` | The whole private key file, including the `BEGIN` and `END` lines |
| Secret | `SSH_KNOWN_HOSTS` | The line printed by `ssh-keyscan` |
| Variable | `DEPLOY_HOST` | The host name (it must match what you scanned) |
| Variable | `DEPLOY_USER` | `ubuntu` |
| Variable | `SITE_URL` | `https://todo.lazuar.dev` |

Then delete the private key from your laptop. GitHub has a copy, and you can always make another:

```bash
rm ./key
```

### 6. The deploy job

It is the second job of the workflow you read in chapter 07:

```yaml
  # ------------------------------------------------------------------
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

      # The server's authorized_keys entry for this key forces it to run
      # deploy/deploy.sh, whatever is typed here. The word after the host is
      # only a label for readers. See docs/08-auto-deploy.md.
      - name: Deploy on the server
        run: ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$DEPLOY_TARGET" deploy

      - name: Smoke test the live site
        run: ./scripts/smoke.sh "${{ vars.SITE_URL }}" "${{ github.sha }}"
```

- **`if: vars.DEPLOY_HOST != ''`.** Until you create that variable the job is skipped. That is why the pipeline worked as build-only in chapter 07.
- **`needs: build`.** It starts only after both images were pushed.
- **Configure SSH.** Writes the key and the known-hosts file into `~/.ssh` on the runner. Secrets reach the script through `env:`, not pasted into the script text.
- **`StrictHostKeyChecking=yes`.** If the server's key does not match `SSH_KNOWN_HOSTS`, the connection is refused (verified: with a wrong key, ssh stops with `REMOTE HOST IDENTIFICATION HAS CHANGED`).
- **The word `deploy`** after the host name is only a label for the reader. The forced command decides what runs.
- **The smoke test** runs from the GitHub runner against the public address and passes the commit SHA as the second argument. See the next section.

### 7. Bootstrapping: the script must exist before CI calls it

`deploy.sh` is part of the repository, but the forced command runs it **before** the `git pull` it contains. On a server cloned before the script existed, the first CI deploy would fail with "No such file". So the first time, pull by hand:

```bash
cd ~/deploy-todo && git pull --ff-only
ls -l deploy/deploy.sh          # must be executable (-rwxr-xr-x)
```

From then on every deploy updates the script itself.

> **A related trap, hit while writing this chapter:** if you hand-copy a file to the server (with `scp`) that the repository later also contains, the next `git pull` refuses to overwrite it ("untracked working tree files would be overwritten"). Delete the hand-copied file, then pull.

### 8. Deploy

Push a change to `backend/` or `frontend/`, or press **Run workflow**. Watch the **Actions** tab.

## Proving the new version is really running

A green deploy does not prove the new code is live. Here is a real example from this project. A second push changed no application code, so the second build produced an image whose content was **identical** to the first. `docker compose up -d` noticed this and correctly left the containers alone. The run was green, nothing had changed, and nothing in the log said so.

To close the gap, every image is stamped with the commit it was built from:

- The workflow passes `build-args: APP_VERSION=${{ github.sha }}`.
- The backend Dockerfile turns it into an environment variable, and `/api/health` reports it:

```bash
curl -s https://todo.lazuar.dev/api/health
```

```
{"status":"ok","version":"136bb338f46d96f02f00d190b8268fa3298123b8"}
```

- The smoke test takes the expected version as its second argument and **fails if the live version differs**:

```bash
./scripts/smoke.sh https://todo.lazuar.dev 136bb338f46d96f02f00d190b8268fa3298123b8
```

So a green run now means: the images built, the server pulled them, the containers restarted, and the site is serving *this commit*.

## Check it worked

The workflow run, from the GitHub CLI:

```
✓ build (backend)  in 17s
✓ build (frontend) in 17s
✓ deploy in 18s
  ✓ Configure SSH
  ✓ Deploy on the server
  ✓ Smoke test the live site
```

And the live version equals the commit you pushed (the `git rev-parse HEAD` on your laptop). On the server:

```bash
cd ~/deploy-todo/deploy && docker compose ps
```

## How it works

```
  CI runner                                   server
  ---------                                   ------
  ssh ... deploy  ------------------------>   forced command: deploy.sh
                                                 git pull --ff-only
                                                 docker compose pull       <--- from GHCR
                                                 docker compose up -d
                                                 docker image prune (ours)
  smoke.sh URL <commit sha>  --------------->  (public site; checks the version)
```

## Taking CI access away

Everything this chapter created can be removed in two minutes. (⚠️ These removal commands were **not run**, because the test setup was kept in place. Read each one before running it.)

```bash
# on the server: delete the one line, or restore the backup
grep -v 'deploy-todo-ci' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.new && cat ~/.ssh/authorized_keys.new > ~/.ssh/authorized_keys && rm ~/.ssh/authorized_keys.new

# on GitHub
gh secret delete SSH_PRIVATE_KEY
gh secret delete SSH_KNOWN_HOSTS
gh variable delete DEPLOY_HOST     # the deploy job is skipped again
```

## Alternative: Watchtower (design B)

Watchtower is a container that checks the registry every few minutes and restarts containers whose image changed. CI needs no SSH access.

> **Not tested by the author.** What follows is what to check before choosing it.

- The original `containrrr/watchtower` project is **archived** (last update December 2025). A maintained fork exists: `nickfedor/watchtower`. Check that it is still maintained when you read this.
- It updates *every* container unless limited with `--label-enable` plus the label `com.centurylinklabs.watchtower.enable=true` on only your application services. Otherwise Postgres and Caddy could be upgraded unattended.
- It needs registry credentials to pull private images.
- Failures are silent. Nothing goes red anywhere.
- It cannot apply changes to the compose file or Caddyfile, and it cannot verify the version.
- It needs `/var/run/docker.sock` mounted, which is root-equivalent access to the host.

Given the restricted key above, design A is both easier to observe and, on a shared server, safer.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `deploy` job is skipped | The `DEPLOY_HOST` variable is missing or empty. It must be a **Variable**, not a Secret. |
| `Permission denied (publickey)` | The public key is not in `~/.ssh/authorized_keys` of the right user, or `SSH_PRIVATE_KEY` lost its `BEGIN`/`END` lines when pasted. |
| `Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED` | `SSH_KNOWN_HOSTS` is missing, or for a different name than `DEPLOY_HOST`. Scan exactly the name you configured. |
| `error in libcrypto` | The private key lost its trailing newline or gained extra characters. Re-set the secret from the file. |
| The deploy step fails with `No such file` or exits at once | `deploy.sh` is missing or not executable on the server. See "Bootstrapping". |
| `git pull` fails: `untracked working tree files would be overwritten` | A hand-copied file collides with one the repository now has. Delete the hand-copied file. |
| `git pull` fails: `Your local changes would be overwritten` | Someone edited a tracked file on the server. `git status`, undo, and change things in the repository instead. |
| `pull access denied` during `docker compose pull` | Private images and the server's `docker login` is missing or expired ([chapter 05](05-registry.md)). |
| The smoke test says `wrong version running` | The server is on an older image. Check `TAG` in the server's `.env`: if pinned for a rollback it deliberately ignores `latest`. Otherwise read the deploy step's log. |
| The run is green but nothing changed | Expected if the images are byte-identical to what runs. The version check is what tells a real deploy from a no-op. |
| Smoke test fails but the site works in a browser | DNS or the certificate may not be ready for the runner yet, or `SITE_URL` has a typo or a trailing path. |

## Recap

- CI pushes images; a second job tells the server to pull them. The jobs are joined by `needs:`.
- The CI key runs exactly one program (`restrict` plus a forced command), so a leak cannot become a shell.
- The server is trusted by a pinned, **verified** host key.
- Each image knows which commit built it, and the smoke test fails on the wrong version.
- Everything created for CI can be removed in two minutes.

Next: [09. Operating the Deployment](09-operations.md)
