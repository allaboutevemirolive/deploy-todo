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
