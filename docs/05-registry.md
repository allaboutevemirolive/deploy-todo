# 05. The Container Registry (GHCR)

> **Status:** ✅ Verified on 2026-10-23: the CI push to GHCR from a public repository, the tags, an anonymous pull from a real server, and cross-building for `linux/amd64`. ⚠️ Pushing by hand with your own token (steps 1 to 3) and the **private**-image path were not run; they follow GitHub's documentation. Treat them as a first run.

## Goal

Put the two images somewhere your server can download them from, first by hand so you understand it, then (in chapter 07) automatically.

## Ideas first

Your laptop has the images. Your server does not. A **registry** is the middle man: you **push** an image to it from one machine and **pull** it from another.

GitHub's registry is GHCR (`ghcr.io`). An image name has this shape:

```
ghcr.io / allaboutevemirolive / deploy-todo / backend : latest
   |              |                 |           |        |
registry     your account       repository   service    tag
```

- **Everything must be lowercase.** GHCR rejects uppercase letters.
- A **tag** labels one version of an image. `latest` is just a tag, a moving label, not magic. It means whatever was pushed with that tag most recently.
- We push two tags for every build: `latest` (the newest) and the **git commit SHA** (a permanent label for exactly that build). `latest` is convenient. The SHA is what lets you go back.

## The trap: your Mac and your server have different CPUs

```bash
uname -m
```

```
arm64
```

An Apple-silicon Mac is `arm64`. Most VPS plans are `amd64` (also called `x86_64`). An image built for one will not start on the other; you get `exec format error`. By default Docker builds for the machine you are on, so a plain `docker build` on an M-series Mac produces an image your server cannot run.

Always say what you want. This was run and verified on an Apple-silicon Mac:

```bash
docker buildx build --platform linux/amd64 -t deploy-todo-amd64-check:backend --load ./backend
docker image inspect deploy-todo-amd64-check:backend --format 'cross build arch: {{.Architecture}}'
docker run --rm --platform linux/amd64 --entrypoint node deploy-todo-amd64-check:backend \
  -p "process.arch + ' ' + process.version"
```

```
cross build arch: amd64
x64 v24.22.1
```

(In chapter 07 the build happens on GitHub's `amd64` machines, so the problem disappears. It is still worth knowing, because it is the first thing that bites when you push from a Mac.)

## Steps

### 1. Create an access token

A registry needs to know who you are. Docker does not use your GitHub password; it uses a token.

1. GitHub, then **Settings**, **Developer settings**, **Personal access tokens**, **Tokens (classic)**, **Generate new token (classic)**.
2. Name it `ghcr-push`. Give it a short expiry.
3. Tick **`write:packages`**. That automatically includes `read:packages`. Nothing else is needed.
4. Copy the token now. GitHub never shows it again.

> **Use two tokens, not one.** This one can write. The server will get a *separate* token with `read:packages` only ([chapter 06](06-server.md)). If the server is ever compromised, the attacker can download your images but cannot overwrite them.

### 2. Log in

```bash
export GH_USER=allaboutevemirolive
export CR_PAT=ghp_xxxxxxxxxxxxxxxx      # your token
echo "$CR_PAT" | docker login ghcr.io -u "$GH_USER" --password-stdin
```

```
Login Succeeded
```

`--password-stdin` keeps the token out of your shell history and out of the process list. Never write `docker login -p TOKEN`.

### 3. Build and push

```bash
export SHA=$(git rev-parse HEAD)
export IMG=ghcr.io/allaboutevemirolive/deploy-todo

docker buildx build --platform linux/amd64 --push \
  -t $IMG/backend:latest -t $IMG/backend:$SHA ./backend

docker buildx build --platform linux/amd64 --push \
  -t $IMG/frontend:latest -t $IMG/frontend:$SHA ./frontend
```

`--push` uploads straight to the registry instead of saving the image on your laptop. The image is for the server, not for this machine, so there is no reason to keep a local copy.

### 4. Check it arrived

On GitHub open your profile, then **Packages**. You should see `deploy-todo/backend` and `deploy-todo/frontend`, each with the tags you pushed.

Or from the command line, ask the registry directly (verified for the CI-pushed images, which showed `Platform: linux/amd64`):

```bash
docker buildx imagetools inspect $IMG/backend:latest
```

Look for `Platform: linux/amd64` in the output.

### 5. Understand visibility

Who may pull an image depends on the package's **visibility**.

**What was observed.** After the workflow in a **public** repository pushed the two images for the first time, an anonymous request to the registry succeeded: the packages were public from the start. Do not assume this for your own account. Check, as shown next. GitHub's defaults for packages created another way, for example pushed by hand from a laptop, may differ.

Check visibility without logging in:

```bash
T=$(curl -s "https://ghcr.io/token?scope=repository:allaboutevemirolive/deploy-todo/backend:pull" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s -H "Authorization: Bearer $T" https://ghcr.io/v2/allaboutevemirolive/deploy-todo/backend/tags/list
```

```
{"name":"allaboutevemirolive/deploy-todo/backend","tags":["latest","81e48b0f70bc53fa8a52b084885b3a13432f72c6"]}
```

A tag list means the package is public. (A private package should refuse the request instead. That response was not captured here.)

You have two paths:

| | **Public** | **Private** |
| :--- | :--- | :--- |
| Who can pull | Anyone | Only holders of a token with `read:packages` |
| Server needs `docker login` | No | Yes (chapter 06, step 8) |
| Good for | Open-source demos, this walkthrough | Proprietary code |
| Status | ✅ Verified: a real server pulled both images with an **empty** Docker config, so no login was involved | ⚠️ Not run |

To switch a package: its GitHub page, **Package settings**, **Danger Zone**, **Change visibility**. Visibility is **per package**, so switch `backend` and `frontend` separately.

Public is fine for this project: the images hold no secrets, because configuration is supplied at run time (chapter 01), and the frontend bundle is public by nature. For anything proprietary, go private.

**What to expect on the private path** (not run by the author): without a login, `docker compose pull` fails with `denied` or `unauthorized`. After `docker login ghcr.io` with a `read:packages` token it should succeed.

### 6. Link the package to the repository

Both Dockerfiles contain this line:

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/allaboutevemirolive/deploy-todo"
```

When GHCR sees that label it connects the package to the repository. Then the workflow in that repository is allowed to push to the package using its automatic token ([chapter 07](07-ci.md)). Without the link you would hit a `403 permission_denied: write_package` the first time CI tries to push an image that you first pushed by hand.

If CI ever fails with that error, check it manually: package page, **Package settings**, **Manage Actions access**, and make sure the repository is listed with the **Write** role.

## How it works

```
  laptop ----docker push----> ghcr.io <----docker pull---- server
                             (stores layers)
```

Registries store layers, not whole images. When you push a new version where only the application layer changed, only that layer travels. The unchanged layers are already there. This is why the second push is so much faster than the first.

## Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `unauthorized` or `denied` on push | The token lacks `write:packages`, has expired, or you are logged in as a different user. Run the login again. |
| `invalid reference format` | Uppercase letters in the image name. Make it all lowercase. |
| `exec format error` when the image starts on the server | Built for `arm64`, server is `amd64`. Add `--platform linux/amd64`. |
| `403` in CI after a manual push | The package is not linked to the repo. See step 6. |

## Recap

- A registry is how images travel from where they are built to where they run.
- Push two tags: `latest` for convenience and the commit SHA for rollback.
- Use `write:packages` on your computer and a separate `read:packages` token on the server.
- Build for the server's CPU architecture, not yours.

Next: [06. The Server](06-server.md)
