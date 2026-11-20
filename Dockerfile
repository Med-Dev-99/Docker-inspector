# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Docker Inspector - web mode image.
# The desktop (Electron) shell is not part of the image: the container runs the
# same backend + UI and you open it in a browser at http://localhost:7780.
# ---------------------------------------------------------------------------

# ---- 1. Build the UI -------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# Electron is a devDependency used only for the desktop app; never download its ~100 MB binary here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
RUN npx vite build

# ---- 2. Production dependencies only (just `ws`) ---------------------------
FROM node:22-alpine AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- 3. Runtime -------------------------------------------------------------
FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.title="Docker Inspector" \
      org.opencontainers.image.description="Inspect, monitor and manage Docker containers, images, volumes and networks" \
      org.opencontainers.image.source="https://github.com/Med-Dev-99/Docker-inspector" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    DI_HOST=0.0.0.0 \
    DI_PORT=7780 \
    DI_NO_OPEN=1 \
    DI_CONTAINER=1

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server

# Run unprivileged. To reach /var/run/docker.sock the process must be in the socket's group:
# docker-compose.yml does this with `group_add: [<docker gid>]`.
USER node
EXPOSE 7780

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${DI_PORT}/" || exit 1

CMD ["node", "server/standalone.js"]
