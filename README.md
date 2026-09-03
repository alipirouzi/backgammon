# Backgammon

A championship-feel backgammon web application: play against a club-strength
computer and see its reasoning, invite one other person by link and play in
real time, join admin-created leagues with a rated scoreboard, in five
languages. Live target: https://backgammon.automated.ink

Design: [docs/superpowers/specs/2026-09-03-backgammon-platform-design.md](docs/superpowers/specs/2026-09-03-backgammon-platform-design.md).
Foundation plan: [docs/superpowers/plans/2026-09-03-foundation.md](docs/superpowers/plans/2026-09-03-foundation.md).

## Status

Only the **foundation** exists: a protected repository, CI, a GitHub-App PR
flow, a
Docker image, and a placeholder page with a health endpoint, deployed over the
host's forced-command SSH pipeline. Nothing plays backgammon yet.

Delivery order (spec section 9); each piece gets its own spec, plan, and PRs:

1. Foundation — this repository state
2. Engine `(planned)` — Rust crates, club bot, analysis output, WASM and native bindings, parity tests
3. Play `(planned)` — board, three themes, bot games, analysis drawer, post-game review
4. Multiplayer `(planned)` — invite links, seat claiming, realtime process, chat, optional clocks
5. Members `(planned)` — magic-link login, profiles, leagues, Glicko-2, scoreboard
6. Languages `(planned)` — fa/tr/de/fr translations, RTL, rules guide

What the placeholder does today: `GET /` renders a page containing
`id="board-mount"`; `GET /health` returns `200 {"status":"ok"}`. Security
headers are set in `web/next.config.ts`; `X-Powered-By` is disabled. The
Content-Security-Policy is sent as `Content-Security-Policy-Report-Only`:
enforcing it needs per-request nonces for Next's inline hydration scripts
(`web/proxy.ts`), which is `(planned)`.

## Repository layout

```
backgammon/
├── .github/
│   ├── CODEOWNERS                   * @alipirouzi
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       ├── ci.yml                   jobs: engine, web
│       ├── open-pr.yml              push to claude/** -> PR opened as the GitHub App
│       └── deploy.yml               CI success on master -> build image, ship, verify
├── engine/                          Cargo workspace (Rust 1.98, edition 2024)
│   ├── Cargo.toml  Cargo.lock  rust-toolchain.toml
│   └── bg-core/                     stub crate: Player, Point + tests
├── web/                             Next.js app (pnpm workspace member)
│   ├── src/app/page.tsx             placeholder with #board-mount
│   ├── src/app/health/route.ts      GET -> {"status":"ok"}
│   ├── tests/                       Vitest unit tests
│   └── e2e/                         Playwright tests
├── deploy/
│   ├── docker-compose.prod.yml      app + postgres on the host
│   ├── backgammon.caddy             per-site Caddy snippet
│   └── backgammon-deploy.sh         host forced command (/usr/local/bin/backgammon-deploy)
├── Dockerfile                       multi-stage; Next standalone output
├── package.json  pnpm-workspace.yaml  .nvmrc  .editorconfig  .gitignore  LICENSE
└── docs/superpowers/{specs,plans}/
```

## Prerequisites

- Node 22 (`.nvmrc`) and pnpm 9 (`packageManager` in `package.json`; `corepack enable` provides it)
- Rust via rustup; `engine/rust-toolchain.toml` pins 1.98.0 with `rustfmt`, `clippy`, and the `wasm32-unknown-unknown` target; run `rustup toolchain install` inside `engine/` once (cargo's auto-install still works but rustup reports it as deprecated)
- Docker (Compose v2) for the image build and smoke test

## Run

```bash
pnpm install
pnpm --filter web dev          # http://localhost:3000
```

## Test

```bash
pnpm test                                  # Vitest unit tests (all workspace packages)
pnpm --filter web exec playwright install chromium   # once, before the first e2e run
pnpm --filter web test:e2e                 # Playwright; builds are required first: pnpm --filter web build
cd engine && cargo test                    # Rust
```

Full local gate (CI additionally runs `pnpm test -- --coverage`, Playwright e2e, and the wasm32 build of `bg-core`):

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build \
 && (cd engine && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test) \
 && docker build -t backgammon:local .
```

Notes:

- `pnpm typecheck` runs `next typegen && tsc --noEmit`; `web/next-env.d.ts` is generated and gitignored.
- CI runs `pnpm test -- --coverage`. A coverage threshold is `(planned)`; none is enforced yet.
- Image smoke test: `docker run -d --rm --name bg-smoke -p 3999:3000 backgammon:local`, then `curl -fsS http://127.0.0.1:3999/health`; `docker rm -f bg-smoke` afterwards.

## CI/CD and branch workflow

- Default branch `master` is protected by a ruleset: pull request required, one
  approval, code-owner review (`CODEOWNERS`: `* @alipirouzi`), stale approvals
  dismissed on push, required status checks `engine` and `web`, no force
  pushes, no deletions, no bypass actors.
- Work branches are named `claude/<topic>`. Pushing one triggers
  `open-pr.yml`, which opens the pull request as the GitHub App (so the
  repository owner can approve it). The PR title and body are taken from the
  head commit's subject and body; refine them afterwards with `gh pr edit`,
  which keeps the App as author.
- `ci.yml` runs on every push and PR: job `engine` (`cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test`, wasm32 build of
  `bg-core`) and job `web` (lint, typecheck, unit tests with coverage, `next
  build`, Playwright e2e). Parity tests and the screenshot matrix from the spec
  are `(planned)`.
- `deploy.yml` runs when CI succeeds for a `push` to `master` of this
  repository (a fork's pull-request CI run also reports `head_branch ==
  master`, so the event type and head repository are checked as well), in the
  `production` environment: builds the image in CI (the host cannot build),
  then `docker save | gzip | ssh deploy@<host>`. The host-side forced command
  checks the tarball (exactly one image, tagged `backgammon:current`) before
  `docker load`, extracts `/deploy/docker-compose.yml` and
  `/deploy/backgammon.caddy` from the image and validates both (compose:
  normalised with `docker compose config`, only services `app`/`postgres`,
  images `backgammon:current`/`postgres:*-alpine`, volume `postgres-data`,
  networks `edge`/`internal`, no privileged/host-namespace/bind-mount/ports
  keys; Caddy: only the `backgammon.automated.ink` site block, and it must
  `caddy adapt`), and only then installs the compose file, runs `docker
  compose up -d`, swaps the snippet into `/opt/caddy/sites`, validates the
  full Caddyfile (restoring the previous snippet on failure), reloads Caddy
  and prunes old images. The workflow then polls `/health` and `/` for up to
  three minutes and fails if the site is not healthy. Concurrency group
  `deploy`, no cancel-in-progress. A deploy starts automatically once a PR is
  merged; the PR approval is the human gate, the `production` environment has
  no separate required reviewers by design.
- Compose file and Caddy snippet travel inside the image, so the repository
  owns them and no `scp` is needed.

### Deviation from the spec

Spec section 6.6 calls for a dedicated host user `deploy-backgammon`. The host
already has a `deploy` user (in the `docker` group) with one forced-command
SSH key per application, so this project follows that convention: a third
`authorized_keys` entry with `command="/usr/local/bin/backgammon-deploy",restrict`
for the existing `deploy` user. The key can only run the deploy script, and
the script validates everything it receives (image tag, compose file, Caddy
snippet) before touching the host, so holding the key does not grant more than
rolling out this application; it matches how the other applications on the
host deploy.

## Hosting layout (Hetzner host)

- Caddy runs from `/opt/caddy` on the external Docker network `edge`. Its
  `Caddyfile` is a single `import /etc/caddy/sites/*.caddy`; `/opt/caddy/sites`
  is mounted read-only into the container. Each application ships its own
  snippet; this repository ships `deploy/backgammon.caddy`
  (`backgammon.automated.ink` reverse-proxied to `backgammon-app:3000`). The
  realtime `/ws*` route from the spec is `(planned)`.
- `/opt/backgammon` holds `docker-compose.yml` (extracted from the image on
  every deploy) and `.env`. Containers: `backgammon-app` (port 3000, networks
  `edge` + `internal`) and `backgammon-postgres` (PostgreSQL 16, network
  `internal`, volume `postgres-data`). Image tag on the host: `backgammon:current`.
- The forced command lives at `/usr/local/bin/backgammon-deploy` (source:
  `deploy/backgammon-deploy.sh`). Its allowlists (services, images, volumes,
  networks, site address) are part of the script: bumping the postgres image
  or adding a service requires reinstalling the script on the host. The snippet
  check also rejects quotes, comments and heredocs, so a future directive that
  needs them (e.g. `header`) requires a script change as well.

## Secrets

No credentials are in the repository, the compose file, or the image.

- Host only, `/opt/backgammon/.env` (root:deploy, mode 640): `POSTGRES_PASSWORD`.
  `AUTH_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_EMAIL`, `SEAT_SECRET`
  are `(planned)` for later pieces.
- GitHub environment `production`: `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`.
- GitHub repository secrets: `GH_APP_ID`, `GH_APP_PRIVATE_KEY` for the GitHub
  App that authors pull requests (permissions: Contents and Pull requests read
  and write, Metadata read; installed on this repository only). Without them a
  push to `claude/**` fails in `open-pr.yml` and no PR is opened.

## Host budget

The host has 2 vCPU and 3.8 GB RAM shared with other applications. Disk was at
71 % when this foundation was laid; the deploy script prunes dangling images
after every rollout, but the trend should be watched. There are **no verified
backups** of the host or of `postgres-data`; a backup routine is `(planned)`
before any real user data is stored.

## License

MIT, see [LICENSE](LICENSE).
