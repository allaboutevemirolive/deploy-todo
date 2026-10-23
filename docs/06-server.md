# 06. The Server

> **Status:** ⚠️ Not verified here. This chapter needs a real VPS and a real domain, which were not available while writing. The commands follow the official Ubuntu, Docker and Caddy documentation. The pieces that can be tested without a server (the compose file, the Caddyfile, the images, the password format) were tested in chapter 04. Treat your first run as the test.

## Goal

A fresh Ubuntu server running your application over HTTPS at `https://todo.lazuar.dev`, started with a single `docker compose up -d`.

The values used below are examples. Replace them:

| Example | Meaning |
| :--- | :--- |
| `203.0.113.10` | Your server's public IP address (this is a reserved documentation address, not a real one) |
| `todo.lazuar.dev` | Your domain name |
| `deploy` | The unprivileged Linux user that will run the app |

## Steps

### 1. Create the server

At your VPS provider, create a server with **Ubuntu 24.04 LTS** and at least 1 GB of RAM. Add your SSH public key during creation if the provider offers it. Note the public IP address.

### 2. Point the domain at it

In your DNS provider (for example Cloudflare) add one record:

| Type | Name | Content | Proxy |
| :--- | :--- | :--- | :--- |
| A | `todo` | `203.0.113.10` | **DNS only** (grey cloud) |

Leave the proxy **off** for now. Caddy proves to Let's Encrypt that you own the domain by answering a request on port 80. Getting that to work *through* Cloudflare's proxy is possible, but it is an extra thing that can go wrong on your first attempt.

Check that the name resolves (this can take a few minutes):

```bash
dig +short todo.lazuar.dev
```

```
203.0.113.10
```

Do not continue until it prints your server's IP. Everything after this depends on it.

### 3. Log in and create an unprivileged user

```bash
ssh root@203.0.113.10
```

Running everything as `root` is a bad habit. Create a normal user with `sudo` rights and give it your SSH key:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

Because the account has no password, `sudo` would ask for one it does not have. Allow `sudo` without a password for this user:

```bash
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
```

**Before you log out, open a second terminal and prove the new login works:**

```bash
ssh deploy@203.0.113.10
```

Only when that succeeds, harden SSH from the `deploy` session. Disabling root login and password login removes the two most attacked doors:

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sshd -t && sudo systemctl reload ssh
```

`sshd -t` checks the configuration first, so a typo cannot lock you out. Keep your existing session open and confirm in a third terminal that `ssh deploy@203.0.113.10` still works.

### 4. Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable
sudo ufw status
```

Port 22 is SSH. 80 and 443 are web traffic (Caddy needs 80 to get certificates). `443/udp` is HTTP/3. Allow SSH **before** enabling the firewall or you cut yourself off.

> **A Docker warning worth knowing:** Docker edits the firewall rules itself, and ports it publishes bypass UFW. UFW will not protect a container port you publish by accident. That is why our Compose file publishes only Caddy's ports, and why the database has no `ports:` entry at all.

### 5. Install Docker

This is the official method from Docker's documentation for Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

Log out and back in so the new group applies, then check:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

> Members of the `docker` group can effectively become root on the machine. That is acceptable for a single-purpose server whose only user is you and your CI key. It is not something to hand out casually.

### 6. Get the deployment files

The repository is public, so the server can clone it. The `deploy/` folder is the single source of truth for the Compose file and the Caddyfile.

```bash
git clone https://github.com/allaboutevemirolive/deploy-todo.git ~/deploy-todo
cd ~/deploy-todo/deploy
```

(If you make the repository private later, give the server a read-only *deploy key* instead. The CI chapter's SSH key is a different thing.)

### 7. Create the production environment file

```bash
cp .env.example .env
chmod 600 .env
```

Generate a strong database password:

```bash
openssl rand -hex 24
```

Put the result in `.env` as `POSTGRES_PASSWORD`, and check `SITE_ADDRESS`:

```bash
nano .env
```

```
SITE_ADDRESS=todo.lazuar.dev
POSTGRES_USER=todo
POSTGRES_PASSWORD=<the 48 hex characters you just generated>
POSTGRES_DB=todo
TAG=latest
```

> **Why `-hex` and not `-base64`?** The password is placed inside a URL (`postgres://user:PASSWORD@db:5432/todo`). Base64 output can contain `/`, `+` and `=`, which have special meaning in URLs and silently break the connection string. Hex uses only `0-9a-f`.

`chmod 600` means only your user can read the file. It contains the database password and must never be committed (the repository's `.gitignore` already excludes it).

### 8. Let the server pull private images

If you made the packages public in chapter 05 you can skip this step.

Create a **second** classic token at GitHub with **only `read:packages`**, then:

```bash
export GH_USER=allaboutevemirolive
export CR_PAT=ghp_xxxxxxxxxxxxxxxx      # the read-only token
echo "$CR_PAT" | docker login ghcr.io -u "$GH_USER" --password-stdin
unset CR_PAT
```

Docker stores the credential in `~/.docker/config.json`, so later `docker compose pull` calls work without logging in again.

### 9. Start the application

This assumes the images already exist in GHCR (chapter 05 by hand or chapter 07 by CI):

```bash
docker compose pull
docker compose up -d
```

## Check it worked

```bash
docker compose ps
```

All four services should be `Up`, with `db` and `backend` showing `(healthy)`.

Watch Caddy get the certificate:

```bash
docker compose logs --tail=50 caddy
```

Look for `certificate obtained successfully`, mentioning your domain.

From your own laptop:

```bash
curl -i https://todo.lazuar.dev/api/health
```

```
HTTP/2 200
...
{"status":"ok"}
```

Then run the whole smoke test against the live site, and open the address in a browser:

```bash
./scripts/smoke.sh https://todo.lazuar.dev
```

### Turning Cloudflare's proxy on (optional)

Once certificates exist you may switch the DNS record to **Proxied** (orange cloud) to get Cloudflare's CDN and protection. First, in Cloudflare open **SSL/TLS** and set the mode to **Full (strict)**. With any other mode you get an endless redirect loop. If the certificate renewal ever fails after enabling the proxy, switch it back to DNS only temporarily.

## How it works

```
  browser --https--> 203.0.113.10:443
                          |
                    Docker publishes 80/443
                          v
                       caddy container
                      /               \
          /api/* -> backend:3000    other -> frontend:8080
                         |
                    db:5432   (never published)
```

On the very first request for your domain Caddy contacts Let's Encrypt, proves control of the domain over port 80, receives a certificate and stores it in the `caddy_data` volume. It renews automatically. **Do not delete that volume casually.** Let's Encrypt limits how many certificates you can request per week, and starting over repeatedly can lock you out for days.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| Caddy log: `no valid A records` or the challenge fails | DNS does not point at the server yet, or has not propagated. Re-check `dig +short`. |
| Challenge fails and DNS is right | Port 80 is blocked. Check `sudo ufw status` and the provider's own firewall or security group. |
| Browser shows a certificate warning | Caddy is still obtaining it, or failed. `docker compose logs caddy`. |
| `502 Bad Gateway` | Caddy is up but the backend is not. `docker compose ps` and `docker compose logs backend`. |
| `pull access denied` or `unauthorized` | The server is not logged in to GHCR, the token is wrong, or the package is linked to a different owner. Redo step 8. |
| `permission denied while trying to connect to the Docker daemon` | You have not logged out and in since `usermod -aG docker`. |
| `exec format error` | The images were built for the wrong CPU. See chapter 05. |
| Backend log: `password authentication failed` | `POSTGRES_PASSWORD` was changed after the first start. See the note in chapter 04. |
| Locked out of SSH | You closed your only session before testing the new login. Use the provider's web console to repair `/etc/ssh/sshd_config`. |

## Recap

- DNS first. Nothing works until the name points at the server.
- A normal user, key-only SSH, a firewall and nothing exposed but 22, 80 and 443.
- The server needs only Docker, git and the `deploy/` folder. No Node, no nginx, no Postgres on the host.
- Secrets live in a `chmod 600` file on the server. They never enter Git or an image.

Next: [07. Continuous Integration](07-ci.md)
