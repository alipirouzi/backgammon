# syntax=docker/dockerfile:1.7
# Built in CI (the host cannot build), shipped as a tarball over SSH.

# --- bg-wasm: the engine compiled to WebAssembly (engine/bg-wasm/pkg) ---------
# The web workspace depends on `bg-wasm`, a generated pnpm workspace package, so
# it has to exist before `pnpm install`. bg-node (the native addon) is not built
# into the image; it ships with the realtime process later.
FROM rust:1.98-slim-bookworm AS wasm
# Versions and digests are the ones pinned in .github/workflows/ci.yml (env
# WASM_PACK_*, WASM_BINDGEN_*, BINARYEN_*; see the comments there). wasm-bindgen-cli
# and binaryen (wasm-opt) are installed here so that `wasm-pack build --mode
# no-install` never downloads an unverified binary at build time. Bumping a
# version requires recomputing its digest there and here.
ARG WASM_PACK_VERSION=0.15.0
ARG WASM_PACK_SHA256=c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a
ARG WASM_BINDGEN_VERSION=0.2.127
ARG WASM_BINDGEN_SHA256=61d4a7dc85acfa0d2354ccc0b8361928c7e52a746d17f28ebaa795ed3dc1614a
ARG BINARYEN_VERSION=version_117
ARG BINARYEN_SHA256=3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    test "$(uname -m)" = "x86_64"; \
    name="wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl"; \
    curl -fsSL --retry 3 -o "/tmp/${name}.tar.gz" \
      "https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${name}.tar.gz"; \
    echo "${WASM_PACK_SHA256}  /tmp/${name}.tar.gz" | sha256sum -c -; \
    tar -xzf "/tmp/${name}.tar.gz" -C /usr/local/bin --strip-components=1 "${name}/wasm-pack"; \
    name="wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl"; \
    curl -fsSL --retry 3 -o "/tmp/${name}.tar.gz" \
      "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/${name}.tar.gz"; \
    echo "${WASM_BINDGEN_SHA256}  /tmp/${name}.tar.gz" | sha256sum -c -; \
    tar -xzf "/tmp/${name}.tar.gz" -C /usr/local/bin --strip-components=1 "${name}/wasm-bindgen"; \
    name="binaryen-${BINARYEN_VERSION}-x86_64-linux"; \
    curl -fsSL --retry 3 -o "/tmp/${name}.tar.gz" \
      "https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/${name}.tar.gz"; \
    echo "${BINARYEN_SHA256}  /tmp/${name}.tar.gz" | sha256sum -c -; \
    tar -xzf "/tmp/${name}.tar.gz" -C /usr/local/bin --strip-components=2 "binaryen-${BINARYEN_VERSION}/bin/wasm-opt"; \
    rm /tmp/*.tar.gz; \
    wasm-pack --version; \
    wasm-bindgen --version; \
    wasm-opt --version
RUN rustup target add wasm32-unknown-unknown
WORKDIR /repo
# engine/rust-toolchain.toml pins 1.98.0 (the image's toolchain) and asks for
# rustfmt + clippy, which rustup adds on the first cargo invocation.
COPY engine engine
# --mode no-install: use the verified wasm-bindgen and wasm-opt on PATH; never download.
RUN wasm-pack build engine/bg-wasm --target bundler --release --out-dir pkg --out-name bg_wasm --mode no-install

# All Node stages share one Debian base: Prisma's query engine is generated for
# the build stage's platform ("native" plus the explicit debian-openssl-3.0.x
# target in web/prisma/schema.prisma) and must match the runtime stage.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
# Every workspace package must be present for --frozen-lockfile: the generated
# bg-wasm package from the Rust stage, and bg-node's manifest (the addon itself
# is not built here).
COPY engine/bg-node/package.json engine/bg-node/
COPY --from=wasm /repo/engine/bg-wasm/pkg engine/bg-wasm/pkg
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY web web
ENV NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=2048
RUN pnpm --filter web build

# --- prisma-cli: the CLI that runs `prisma migrate deploy` at container start --
# Installed flat with npm into its own directory: in the pnpm workspace the CLI
# and its dependency tree live as symlinks in the virtual store, which does not
# copy cleanly into the runtime image. Version pinned to web/package.json's.
FROM node:22-bookworm-slim AS prisma-cli
ARG PRISMA_VERSION=6.19.3
WORKDIR /opt/prisma-cli
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
# The install also downloads the schema engine for this platform (used by
# migrate deploy); `--version` proves it is present before the image is built.
RUN npm install --no-audit --no-fund --omit=dev "prisma@${PRISMA_VERSION}" \
 && node node_modules/prisma/build/index.js --version

FROM node:22-bookworm-slim AS runtime
# CHECKPOINT_DISABLE / PRISMA_HIDE_UPDATE_MESSAGE: the Prisma CLI must not phone
# home or look for updates when the entrypoint runs the migrations.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 HOME=/home/app
# openssl: Prisma's engines link against libssl3, which the slim image lacks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system app \
 && useradd --system --gid app --home-dir /home/app --create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build --chown=app:app /repo/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/web/.next/static ./web/.next/static
COPY --from=build --chown=app:app /repo/web/public ./web/public
# The engine for the server side (src/engine/node.ts, used by /api/games to
# replay posted records) is imported by file URL at runtime, which Next's
# output tracing cannot follow, so the built package is copied where node.ts
# looks for it: node_modules/bg-wasm above the server's working directory.
COPY --from=wasm --chown=app:app /repo/engine/bg-wasm/pkg ./web/node_modules/bg-wasm
# Schema + migrations for `prisma migrate deploy`, and the CLI that runs it.
COPY --from=build --chown=app:app /repo/web/prisma ./web/prisma
COPY --from=prisma-cli --chown=app:app /opt/prisma-cli/node_modules ./prisma-cli/node_modules
COPY --chown=app:app --chmod=755 web/scripts/docker-entrypoint.sh ./docker-entrypoint.sh
# Deploy descriptors travel inside the image; the host-side forced command
# extracts them, so the repo owns compose and Caddy config without needing scp.
COPY deploy/docker-compose.prod.yml /deploy/docker-compose.yml
COPY deploy/backgammon.caddy /deploy/backgammon.caddy
USER app
EXPOSE 3000
# No wget/curl in the slim image; node's fetch does the probe.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# The entrypoint applies the migrations (DATABASE_URL required), then execs the
# CMD. In a pnpm workspace Next standalone nests the app under web/, so
# server.js is at web/server.js.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "web/server.js"]
