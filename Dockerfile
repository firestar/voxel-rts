# Single-image build for voxel-rts: nginx + ai-server + session-server.
#
# Stage 1 builds the SPA with Node so we don't need npm in the runtime
# layer. Stage 2 is a small alpine image that installs nginx and Node
# (the backends are plain Node scripts), copies the built `dist/` and
# the two .cjs servers, then runs all three under a tiny shell
# entrypoint that forwards SIGTERM.
#
# Build:  docker build -t voxel-rts .
# Run:    docker run --rm -p 8080:8080 voxel-rts
# Open:   http://localhost:8080/

# ---------- build stage ------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /src

# Install deps first so layer caching skips re-install on source-only
# changes.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy the rest and run the production build (vite build).
COPY tsconfig.json ./
COPY index.html ./
COPY vite.config.ts ./
COPY src ./src
RUN npx vite build

# ---------- runtime stage ----------------------------------------------------
FROM alpine:3.20 AS runtime
RUN apk add --no-cache nginx nodejs tini && \
    mkdir -p /run/nginx /srv/app /srv/voxel-rts

# Built SPA assets — served by nginx from /srv/app.
COPY --from=build /src/dist /srv/app
# Backend servers live next to nginx; entrypoint launches both.
COPY ai-server.cjs       /srv/voxel-rts/ai-server.cjs
COPY session-server.cjs  /srv/voxel-rts/session-server.cjs
COPY game-server.cjs     /srv/voxel-rts/game-server.cjs
COPY worldgen.cjs        /srv/voxel-rts/worldgen.cjs
COPY docker/nginx.conf   /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080

# tini reaps any orphaned children (Node + nginx are short-lived
# processes during shutdown).
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
