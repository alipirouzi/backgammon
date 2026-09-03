# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A protected repository with CI, a GitHub-App PR flow, and a placeholder page deployed to https://backgammon.automated.ink through the same forced-command SSH pipeline the other apps on the host use.

**Architecture:** pnpm workspace with `web/` (Next.js, standalone output) and a Cargo workspace under `engine/` (stub crate only, so the Rust CI job is real from day one). One Docker image; compose stack `app` + `postgres` on the shared `edge` network; Caddy on the host imports per-site snippets; the repo ships its own snippet and compose file inside the image and the host-side forced command extracts them.

**Tech Stack:** Node 22 LTS in CI/Docker, pnpm 9, Next.js (latest stable), TypeScript strict, Vitest, Playwright; Rust stable pinned by `rust-toolchain.toml`, edition 2024; GitHub Actions; Docker Compose v2; Caddy 2.

**Spec:** `docs/superpowers/specs/2026-09-03-backgammon-platform-design.md` (sections 3.1, 6.x, 7, 9 item 1)

## Global Constraints

- Default branch is `master`. Nothing merges without a PR approved by `@alipirouzi`. No bypass actors.
- Work branches are named `claude/<topic>`; pushing one triggers `.github/workflows/open-pr.yml`, which opens the PR as the GitHub App.
- No credentials in the repo. Host secrets live in `/opt/backgammon/.env`. Repo secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` (environment `production`), `GH_APP_ID`, `GH_APP_PRIVATE_KEY` (repo).
- Agents do not commit and do not push. The orchestrator commits.
- Host facts (verified 2026-09-03): Hetzner `159.69.19.71`, 2 vCPU, 3.8 GB RAM, disk 71 % used. Caddy compose at `/opt/caddy` on external network `edge`. Existing user `deploy` (uid 1001, group `docker`) with one forced-command key per app. Docker 29, Compose v5.
- Container names: `backgammon-app` (port 3000), `backgammon-postgres`. Image tag on host: `backgammon:current`.
- Health endpoint: `GET /health` → `200 {"status":"ok"}`. Landing page contains `id="board-mount"`.
- README.md must describe what exists at the end of this plan, nothing aspirational without a `(planned)` marker.

---

## File structure

```
backgammon/
├── .github/
│   ├── CODEOWNERS                       * @alipirouzi
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       ├── ci.yml                       jobs: engine, web
│       ├── open-pr.yml                  on push claude/** → PR as GitHub App
│       └── deploy.yml                   on CI success on master → build, ship, verify
├── engine/
│   ├── Cargo.toml                       workspace
│   ├── rust-toolchain.toml
│   └── bg-core/
│       ├── Cargo.toml
│       └── src/lib.rs                   Point/Player types + one test (stub)
├── web/
│   ├── package.json                     scripts: dev build start lint typecheck test test:e2e
│   ├── next.config.ts                   output: 'standalone'
│   ├── src/app/layout.tsx
│   ├── src/app/page.tsx                 placeholder with #board-mount
│   ├── src/app/health/route.ts          GET → {status:"ok"}
│   ├── src/app/globals.css
│   ├── tests/health.test.ts             Vitest
│   ├── e2e/landing.spec.ts              Playwright
│   ├── playwright.config.ts
│   └── vitest.config.ts
├── deploy/
│   ├── docker-compose.prod.yml
│   ├── backgammon.caddy
│   └── backgammon-deploy.sh             installed on host as /usr/local/bin/backgammon-deploy
├── Dockerfile
├── package.json                         workspace root
├── pnpm-workspace.yaml
├── .editorconfig  .gitignore  .nvmrc  LICENSE  README.md
└── docs/superpowers/{specs,plans}/
```

---

### Task 1: Branch ruleset and CODEOWNERS

**Files:**
- Create: `.github/CODEOWNERS`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Host action: GitHub API (orchestrator runs this; it needs the `repo` scope token already in `gh`)

**Interfaces:**
- Produces: required status check contexts `engine` and `web` (Task 4 must name its jobs exactly so).

- [ ] **Step 1: CODEOWNERS**

```
# Every path. Only this reviewer's approval satisfies "require code owner review".
* @alipirouzi
```

- [ ] **Step 2: PR template**

```markdown
## What

## Why

## How verified
- [ ] `pnpm -r test` green locally
- [ ] `cargo test` green locally
- [ ] Live check after deploy (link to run)
```

- [ ] **Step 3: Create the ruleset** (orchestrator)

```bash
gh api repos/alipirouzi/backgammon/rulesets -X POST --input - <<'JSON'
{
  "name": "master-protection",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash", "merge"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [ { "context": "engine" }, { "context": "web" } ] } }
  ]
}
JSON
```

- [ ] **Step 4: Verify**

Run: `gh api repos/alipirouzi/backgammon/rulesets --jq '.[].name'` → `master-protection`.
Run: `git push origin master` with a trivial commit must be rejected with `GH013: Repository rule violations`. (Do this once with an empty commit on a throwaway local branch pushed to `master`; do not leave the commit.)

---

### Task 2: Workspace root, web placeholder, tests

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.editorconfig`, `LICENSE` (MIT, `Copyright (c) 2026 Ali Pirouzi`)
- Create: `web/**` as listed in the file structure
- Modify: `.gitignore` (add `web/.next/`, `web/test-results/`, `web/playwright-report/`, `engine/target/`, `*.tsbuildinfo`)

**Interfaces:**
- Produces: `GET /health` → `200` JSON `{"status":"ok"}`; landing page `<main id="board-mount">`; scripts `pnpm --filter web build|start|lint|typecheck|test|test:e2e`.
- Consumes: nothing.

- [ ] **Step 1: Root workspace files**

`package.json`
```json
{
  "name": "backgammon",
  "private": true,
  "packageManager": "pnpm@9.15.9",
  "engines": { "node": ">=22" },
  "scripts": {
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  }
}
```

`pnpm-workspace.yaml`
```yaml
packages:
  - web
```

`.nvmrc`
```
22
```

`.editorconfig`
```
root = true
[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
[*.rs]
indent_size = 4
```

- [ ] **Step 2: Scaffold Next.js**

Run from repo root:
```bash
pnpm dlx create-next-app@latest web --ts --app --src-dir --eslint --tailwind --no-import-alias --use-pnpm --turbopack --yes
```
Then delete the generated `web/src/app/page.tsx` content and `web/public/*.svg`; keep the toolchain files.

- [ ] **Step 3: Write the failing unit test**

`web/vitest.config.ts`
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["src/**"] },
  },
});
```

`web/tests/health.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { GET } from "../src/app/health/route";

describe("GET /health", () => {
  it("returns status ok with 200", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
```

Add to `web/package.json` devDependencies: `vitest`, `@vitest/coverage-v8`, `@playwright/test`; scripts:
```json
"typecheck": "tsc --noEmit",
"test": "vitest run",
"test:e2e": "playwright test"
```

- [ ] **Step 4: Run it to see it fail**

Run: `pnpm --filter web test`
Expected: FAIL, cannot resolve `../src/app/health/route`.

- [ ] **Step 5: Implement health route, landing page, layout, config**

`web/src/app/health/route.ts`
```ts
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
```

`web/src/app/layout.tsx`
```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Backgammon",
  description: "An ancient game, a modern take.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`web/src/app/page.tsx`
```tsx
export default function Home() {
  return (
    <main id="board-mount" className="landing">
      <p className="landing__eyebrow">backgammon.automated.ink</p>
      <h1 className="landing__title">Backgammon</h1>
      <p className="landing__sub">An ancient game, a modern take. The table is being set.</p>
    </main>
  );
}
```

`web/src/app/globals.css` (replace generated content)
```css
:root {
  --color-surface: #15100c;
  --color-text: #efe4cf;
  --color-accent: #d9b75a;
  --font-display: Georgia, "Times New Roman", serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--color-surface); color: var(--color-text); font-family: var(--font-display); }
.landing { min-height: 100svh; display: grid; place-content: center; text-align: center; padding: 2rem; gap: 0.75rem; }
.landing__eyebrow { letter-spacing: 0.18em; text-transform: uppercase; font-size: 0.75rem; opacity: 0.7; margin: 0; }
.landing__title { font-size: clamp(2.5rem, 2rem + 4vw, 5rem); margin: 0; color: var(--color-accent); font-weight: 400; }
.landing__sub { margin: 0; opacity: 0.85; }
```

`web/next.config.ts`
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 6: Run unit test, lint, typecheck, build**

Run: `pnpm --filter web test && pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web build`
Expected: all PASS; build prints `output: standalone`.

- [ ] **Step 7: Playwright e2e**

`web/playwright.config.ts`
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:3000" },
  webServer: {
    command: "pnpm start -- -p 3000 -H 127.0.0.1",
    url: "http://127.0.0.1:3000/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
```

`web/e2e/landing.spec.ts`
```ts
import { expect, test } from "@playwright/test";

test("health endpoint answers ok", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("landing page renders the board mount", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#board-mount")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Backgammon");
});
```

Run: `pnpm --filter web exec playwright install chromium && pnpm --filter web build && pnpm --filter web test:e2e`
Expected: 2 passed.

---

### Task 3: Engine stub crate

**Files:**
- Create: `engine/Cargo.toml`, `engine/rust-toolchain.toml`, `engine/bg-core/Cargo.toml`, `engine/bg-core/src/lib.rs`

**Interfaces:**
- Produces: `bg_core::Player` enum and `bg_core::Point` newtype with validated constructor `Point::new(u8) -> Option<Point>`. Later pieces extend this crate.

- [ ] **Step 1: Workspace and toolchain**

`engine/Cargo.toml`
```toml
[workspace]
resolver = "3"
members = ["bg-core"]

[workspace.package]
edition = "2024"
license = "MIT"
repository = "https://github.com/alipirouzi/backgammon"

[workspace.lints.clippy]
all = "deny"
pedantic = "warn"
```

`engine/rust-toolchain.toml`
```toml
[toolchain]
channel = "1.98.0"
components = ["rustfmt", "clippy"]
targets = ["wasm32-unknown-unknown"]
```

`engine/bg-core/Cargo.toml`
```toml
[package]
name = "bg-core"
version = "0.1.0"
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Backgammon rules engine: board, dice, legal moves, cube, match play"

[lints]
workspace = true
```

- [ ] **Step 2: Failing test**

`engine/bg-core/src/lib.rs`
```rust
//! Backgammon rules engine. Foundation stub: the types below are the seed of
//! the position model and exist so the Rust toolchain, lints and tests are
//! exercised in CI from the first commit.

/// The two sides. `White` moves from point 24 toward point 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Player {
    White,
    Black,
}

impl Player {
    /// The opposing side.
    #[must_use]
    pub const fn opponent(self) -> Self {
        match self {
            Self::White => Self::Black,
            Self::Black => Self::White,
        }
    }
}

/// A board point numbered 1..=24 from White's perspective.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Point(u8);

impl Point {
    /// Returns `None` for anything outside 1..=24.
    #[must_use]
    pub const fn new(n: u8) -> Option<Self> {
        if n >= 1 && n <= 24 { Some(Self(n)) } else { None }
    }

    /// The 1-based point number.
    #[must_use]
    pub const fn number(self) -> u8 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opponent_is_involutive() {
        assert_eq!(Player::White.opponent(), Player::Black);
        assert_eq!(Player::White.opponent().opponent(), Player::White);
    }

    #[test]
    fn point_rejects_out_of_range() {
        assert!(Point::new(0).is_none());
        assert!(Point::new(25).is_none());
        assert_eq!(Point::new(1).map(Point::number), Some(1));
        assert_eq!(Point::new(24).map(Point::number), Some(24));
    }
}
```

- [ ] **Step 3: Run**

Run: `cd engine && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: 2 tests pass, no clippy warnings. Also `cargo build --target wasm32-unknown-unknown -p bg-core` must succeed.

---

### Task 4: CI and PR workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/open-pr.yml`

**Interfaces:**
- Produces: job ids `engine` and `web` (required checks from Task 1); workflow named `CI` (Task 5 triggers on it).
- Consumes: scripts from Task 2, crate from Task 3, repo secrets `GH_APP_ID`, `GH_APP_PRIVATE_KEY` (user-provided).

- [ ] **Step 1: ci.yml**

```yaml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:
    branches: [master]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  engine:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: engine
    steps:
      - uses: actions/checkout@v5
      - uses: dtolnay/rust-toolchain@stable
        with:
          toolchain: 1.98.0
          components: rustfmt, clippy
          targets: wasm32-unknown-unknown
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: engine
      - run: cargo fmt --check
      - run: cargo clippy --all-targets -- -D warnings
      - run: cargo test
      - run: cargo build --target wasm32-unknown-unknown -p bg-core

  web:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
        working-directory: .
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test -- --coverage
      - run: pnpm build
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: web/playwright-report/
```

- [ ] **Step 2: open-pr.yml**

```yaml
name: Open PR

# Any push to a claude/** branch opens a pull request authored by the GitHub
# App, so the repository owner (who never authors these PRs) can approve it.
# Idempotent: does nothing if an open PR for the branch already exists.

on:
  push:
    branches: ["claude/**"]

permissions: {}

jobs:
  open-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v2
        id: app
        with:
          app-id: ${{ secrets.GH_APP_ID }}
          private-key: ${{ secrets.GH_APP_PRIVATE_KEY }}
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Create pull request if missing
        env:
          GH_TOKEN: ${{ steps.app.outputs.token }}
          BRANCH: ${{ github.ref_name }}
        run: |
          set -euo pipefail
          existing=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$BRANCH" --state open --json number --jq 'length')
          if [ "$existing" != "0" ]; then echo "PR already open for $BRANCH"; exit 0; fi
          title=$(git log -1 --format=%s)
          body_file=.github/pr-body.md
          if [ -f "$body_file" ]; then
            gh pr create --repo "$GITHUB_REPOSITORY" --base master --head "$BRANCH" --title "$title" --body-file "$body_file"
          else
            gh pr create --repo "$GITHUB_REPOSITORY" --base master --head "$BRANCH" --title "$title" --body "Opened automatically for \`$BRANCH\`."
          fi
```

Convention: a branch may carry `.github/pr-body.md` describing the PR; it is removed before merge is not required, but it must not reach master. Add `.github/pr-body.md` to `.gitignore`? No: it must be committed on the branch to be read. Instead the merge is a squash and the file is deleted in the last commit of the branch. Document this in README.

- [ ] **Step 3: Verify syntax**

Run: `pnpm dlx @action-validator/cli .github/workflows/ci.yml .github/workflows/open-pr.yml` (or `actionlint` if installed).
Expected: no errors.

---

### Task 5: Dockerfile, compose, Caddy snippet, host deploy script, deploy workflow

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `deploy/docker-compose.prod.yml`, `deploy/backgammon.caddy`, `deploy/backgammon-deploy.sh`, `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: image `backgammon:current` exposing 3000 with `/deploy/docker-compose.yml` and `/deploy/backgammon.caddy` baked at `/deploy/` so the host script can extract them.
- Consumes: `web` standalone build (Task 2). Environment `production` secrets `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.

- [ ] **Step 1: Dockerfile**

```dockerfile
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
CMD ["node", "web/server.js"]
```

Note: with a pnpm workspace, Next standalone places `server.js` under `web/` inside the standalone dir. Verify the path after the first build (`ls web/.next/standalone`) and adjust `CMD` if it is at the root instead.

`.dockerignore`
```
**/node_modules
**/.next
**/target
**/test-results
**/playwright-report
.git
.superpowers
docs
```

- [ ] **Step 2: Compose**

`deploy/docker-compose.prod.yml`
```yaml
# Production compose for backgammon.automated.ink (Hetzner, /opt/backgammon).
# Secrets only in /opt/backgammon/.env on the host (POSTGRES_PASSWORD).
# Extracted from the image by /usr/local/bin/backgammon-deploy on every deploy.
services:
  app:
    image: backgammon:current
    container_name: backgammon-app
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://backgammon:${POSTGRES_PASSWORD}@postgres:5432/backgammon
    depends_on:
      postgres:
        condition: service_healthy
    networks: [edge, internal]

  postgres:
    image: postgres:16-alpine
    container_name: backgammon-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: backgammon
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: backgammon
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U backgammon -d backgammon"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks: [internal]

volumes:
  postgres-data:

networks:
  edge:
    external: true
  internal: {}
```

- [ ] **Step 3: Caddy snippet**

`deploy/backgammon.caddy`
```
backgammon.automated.ink {
	encode zstd gzip
	reverse_proxy backgammon-app:3000
}
```

- [ ] **Step 4: Host deploy script**

`deploy/backgammon-deploy.sh` (installed by the orchestrator as `/usr/local/bin/backgammon-deploy`, mode 755, owner root)
```bash
#!/usr/bin/env bash
# Forced SSH command for the backgammon deploy key. stdin = gzip'd docker image.
set -euo pipefail

APP_DIR=/opt/backgammon
SITES_DIR=/opt/caddy/sites
IMAGE=backgammon:current

gunzip | docker load >/dev/null

# Pull compose + caddy snippet out of the freshly loaded image.
cid=$(docker create "$IMAGE")
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$cid:/deploy/docker-compose.yml" "$APP_DIR/docker-compose.yml"
docker cp "$cid:/deploy/backgammon.caddy" "$SITES_DIR/backgammon.caddy"

docker compose -f "$APP_DIR/docker-compose.yml" up -d --remove-orphans
docker exec caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
docker image prune -f >/dev/null
echo "deploy: ok"
```

- [ ] **Step 5: deploy.yml**

```yaml
name: Deploy

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [master]

permissions:
  contents: read

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  deploy:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
      - name: Build image
        run: docker build -t backgammon:current .
      - name: Configure SSH
        env:
          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          printf '%s\n' "$DEPLOY_KNOWN_HOSTS" >> ~/.ssh/known_hosts
      - name: Ship image and roll out
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
        run: |
          docker save backgammon:current | gzip \
            | ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
                "deploy@$DEPLOY_HOST" deploy
      - name: Verify live site
        run: |
          for i in $(seq 1 36); do
            if curl -fsS https://backgammon.automated.ink/health | grep -q '"ok"' \
               && curl -fsS https://backgammon.automated.ink/ | grep -q 'board-mount'; then
              echo "Live and healthy"; exit 0
            fi
            sleep 5
          done
          echo "Deployment did not become healthy within 3 minutes"; exit 1
```

- [ ] **Step 6: Local image build and smoke test**

Run from repo root:
```bash
docker build -t backgammon:local . \
 && docker run -d --rm --name bg-smoke -p 3999:3000 backgammon:local \
 && sleep 4 && curl -fsS http://127.0.0.1:3999/health && curl -fsS http://127.0.0.1:3999/ | grep -c board-mount \
 && docker create --name bg-extract backgammon:local && docker cp bg-extract:/deploy/backgammon.caddy - | tar -tf - ; docker rm bg-extract; docker rm -f bg-smoke
```
Expected: `{"status":"ok"}`, `1`, and the tar listing shows `backgammon.caddy`.

---

### Task 6: Host preparation (orchestrator, over SSH as root)

**Files (host):**
- Create: `/opt/caddy/sites/{time,paraphe,backgammon}.caddy`, `/opt/backgammon/.env`, `/usr/local/bin/backgammon-deploy`
- Modify: `/opt/caddy/Caddyfile`, `/opt/caddy/docker-compose.yml`, `/home/deploy/.ssh/authorized_keys`

- [ ] **Step 1: Caddy sites directory**

```bash
cd /opt/caddy && cp Caddyfile "Caddyfile.bak-$(date +%F)" && mkdir -p sites
# time.caddy and paraphe.caddy: copy their current blocks verbatim from Caddyfile.
# backgammon.caddy: identical to deploy/backgammon.caddy (placeholder until the first deploy overwrites it).
printf 'import /etc/caddy/sites/*.caddy\n' > Caddyfile
# add volume "./sites:/etc/caddy/sites:ro" to the caddy service, then:
docker compose up -d                      # recreates caddy: a few seconds of downtime for all sites
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
chown -R root:deploy sites && chmod 775 sites && chmod 664 sites/*.caddy
curl -fsSI https://time.automated.ink/ | head -1; curl -fsSI https://paraphe.automated.ink/login | head -1
```
Expected: `caddy validate` prints `Valid configuration`; both curls return 200.

- [ ] **Step 2: App directory and env**

```bash
install -d -o root -g deploy -m 775 /opt/backgammon
umask 077; printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" > /opt/backgammon/.env
chown root:deploy /opt/backgammon/.env && chmod 640 /opt/backgammon/.env
```
The password is never printed or copied off the host.

- [ ] **Step 3: Forced command and key**

Locally: `ssh-keygen -t ed25519 -N '' -C backgammon-deploy -f <scratch>/backgammon_deploy_key` (never `cat` the private key).
Host:
```bash
install -o root -g root -m 755 backgammon-deploy.sh /usr/local/bin/backgammon-deploy
printf 'command="/usr/local/bin/backgammon-deploy",restrict %s\n' "$PUB" >> /home/deploy/.ssh/authorized_keys
```
GitHub: `gh api -X PUT repos/alipirouzi/backgammon/environments/production` with `deployment_branch_policy` custom → branch `master`; then `gh secret set DEPLOY_SSH_KEY --env production < key`, `DEPLOY_KNOWN_HOSTS` from `ssh-keyscan -t ed25519 159.69.19.71`, `DEPLOY_HOST=159.69.19.71`.

- [ ] **Step 4: Verify the forced command contains the key**

```bash
echo | ssh -i <key> -o IdentitiesOnly=yes deploy@159.69.19.71 'cat /etc/shadow'; echo "exit=$?"
```
Expected: the deploy script runs instead (gzip complains about empty input), non-zero exit, no shadow contents.

---

### Task 7: Clinic repo PR — ship a Caddy snippet, not the whole Caddyfile

**Repo:** `/Users/ali/Projects/with kavosh/clinic-consent-app` (branch from up-to-date `main`; branch name `chore/caddy-sites-import`)

**Files:**
- Create: `deploy/paraphe.caddy` (only the `paraphe.automated.ink { ... }` block, verbatim from `deploy/Caddyfile`)
- Delete: `deploy/Caddyfile`
- Modify: `.github/workflows/deploy.yml` line 44 → `scp deploy/paraphe.caddy hetzner:/opt/caddy/sites/paraphe.caddy`
- Modify: `README.md` CI/CD section: replace "syncs `deploy/docker-compose.prod.yml` + `deploy/Caddyfile`" with "syncs `deploy/docker-compose.prod.yml` + `deploy/paraphe.caddy` (the host Caddyfile imports `/etc/caddy/sites/*.caddy`; each app owns its own snippet)".

- [ ] **Step 1:** `git fetch && git checkout main && git pull --ff-only && git checkout -b chore/caddy-sites-import`
- [ ] **Step 2:** Make the four changes above. Ensure `grep -rn "deploy/Caddyfile" .` returns nothing outside git history.
- [ ] **Step 3:** Commit `chore(deploy): ship a per-site Caddy snippet instead of the shared Caddyfile`, push with `-u`, open a PR against `main` with `gh pr create` explaining: the host Caddyfile now imports per-site snippets so multiple apps can deploy without overwriting each other; no behaviour change for paraphe. Do NOT merge.

---

### Task 8: README, final assembly, PR

**Files:**
- Create: `README.md`
- Create on branch only: `.github/pr-body.md`

- [ ] **Step 1: README.md** covering: what the project is (link to spec), status (foundation only; everything else `(planned)` with the six-piece order), repo layout, prerequisites (Node 22, pnpm 9, Rust 1.98 via rustup, Docker), how to run (`pnpm install`, `pnpm --filter web dev`), how to test (`pnpm test`, `pnpm --filter web test:e2e`, `cd engine && cargo test`), CI/CD and branch workflow (master protected: PR + code-owner approval + checks `engine`,`web`; `claude/**` branches auto-open PRs as the GitHub App; deploy on CI success on master via forced-command SSH; compose and Caddy snippet travel in the image), hosting layout on the Hetzner host (Caddy imports `/etc/caddy/sites/*.caddy`; `/opt/backgammon`), secrets locations, host budget note (disk 71 %, no verified backups).
- [ ] **Step 2:** From repo root run the full local gate: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build && (cd engine && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test) && docker build -t backgammon:local .`
- [ ] **Step 3:** Orchestrator: branch `claude/foundation`, commit, push; the Open PR workflow creates the PR (requires the GitHub App secrets to exist). If the secrets are not yet present, the workflow fails and is re-run after the user adds them.

---

## Self-review

- Spec 6.1 repo → Task 1/8. 6.2 ruleset → Task 1. 6.3 App → Task 4 (+ user registration step, outside the repo). 6.4 CI → Task 4. 6.5 deploy → Task 5. 6.6 deploy identity → Task 6 (deviation: existing `deploy` user with a third forced-command key instead of a new user; same isolation, matches host convention — recorded in README). 6.7 Caddy → Tasks 5, 6, 7. 6.8 secrets → Tasks 5, 6. 6.9 budget → README. 7 testing → Tasks 2, 3, 5. 9 item 1 placeholder → Task 2.
- Names cross-checked: jobs `engine`/`web` (Tasks 1, 4); image `backgammon:current` (Tasks 5, 6); `/deploy/*` paths (Task 5 Dockerfile ↔ deploy script); `#board-mount` (Tasks 2, 5 verify).
