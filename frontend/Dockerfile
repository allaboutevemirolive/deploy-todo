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
# Which commit this image was built from. Visible with `docker inspect`.
ARG APP_VERSION=dev
LABEL org.opencontainers.image.revision=$APP_VERSION
EXPOSE 8080
