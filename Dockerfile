# syntax=docker/dockerfile:1.7
# Built in CI (the host cannot build), shipped as a tarball over SSH.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY web web
ENV NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=2048
RUN pnpm --filter web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S app && adduser -S -G app app
COPY --from=build --chown=app:app /repo/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/web/.next/static ./web/.next/static
COPY --from=build --chown=app:app /repo/web/public ./web/public
# Deploy descriptors travel inside the image; the host-side forced command
# extracts them, so the repo owns compose and Caddy config without needing scp.
COPY deploy/docker-compose.prod.yml /deploy/docker-compose.yml
COPY deploy/backgammon.caddy /deploy/backgammon.caddy
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
# In a pnpm workspace Next standalone nests the app under web/, so server.js is at web/server.js.
CMD ["node", "web/server.js"]
