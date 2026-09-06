# Backgammon

A championship-feel backgammon web application: play against a club-strength
computer and see its reasoning, invite one other person by link and play in
real time, join admin-created leagues with a rated scoreboard, in five
languages. Live target: https://backgammon.automated.ink

Design: [docs/superpowers/specs/2026-09-03-backgammon-platform-design.md](docs/superpowers/specs/2026-09-03-backgammon-platform-design.md).
Foundation plan: [docs/superpowers/plans/2026-09-03-foundation.md](docs/superpowers/plans/2026-09-03-foundation.md).

## Status

The **foundation** exists (a protected repository, CI, a GitHub-App PR flow, a
Docker image, and a placeholder page with a health endpoint, deployed over the
host's forced-command SSH pipeline) and the **engine** crates exist: `bg-core`
implements the rules, legal plays, notation, cube and match state, and
replayable records; `bg-bot` the club-strength bot, cube decisions and
analysis output (see [Engine](#engine)). Nothing plays backgammon in the
browser yet: the bindings are `(planned)`.

Delivery order (spec section 9); each piece gets its own spec, plan, and PRs:

1. Foundation — this repository state
2. Engine — in progress: `bg-core` (rules, plays, notation, game and match state, records, test vectors) and `bg-bot` (evaluator, match equity table, club bot with three levels, rollouts, cube decisions, analysis output, decision vectors) are done; WASM and native bindings with parity tests `(planned)`
3. Play `(planned)` — board, three themes, bot games, analysis drawer, post-game review
4. Multiplayer `(planned)` — invite links, seat claiming, realtime process, chat, optional clocks
5. Members `(planned)` — magic-link login, profiles, leagues, Glicko-2, scoreboard
6. Languages `(planned)` — fa/tr/de/fr translations, RTL, rules guide

What the placeholder does today: `GET /` renders a page containing
`id="board-mount"`; `GET /health` returns `200 {"status":"ok"}`. Security
headers are set in `web/next.config.ts`; `X-Powered-By` is disabled. The
Content-Security-Policy is sent as `Content-Security-Policy-Report-Only`:
enforcing it needs per-request nonces for Next's inline hydration scripts in
a Next proxy/middleware `(planned)` — e.g. a future `web/proxy.ts`; no such
file exists yet.

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
│   ├── bg-core/                     rules engine crate (see Engine below)
│   │   ├── src/                     player, point, board, position, dice, moves, notation, game, match_play, record, error
│   │   ├── tests/                   oracle, rules_golden, notation, game_flow, replay, vectors
│   │   └── examples/gen_vectors.rs  writes engine/vectors/plays.json
│   ├── bg-bot/                      bot crate (see Engine below)
│   │   ├── src/                     evaluator, met, met_data, race, features, heuristic, search, rollout, cube, analysis, bot
│   │   ├── tests/                   met, race, features, evaluator, search, rollout, analysis, vectors, perf (#[ignore])
│   │   ├── examples/gen_decisions.rs  writes engine/vectors/decisions.json
│   │   └── MET-NOTICE.txt           notice of the embedded Kazaross-XG2 match equity table
│   └── vectors/                     generated test vectors shared with the bindings (README inside)
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
cd engine && cargo test                    # Rust (~40 s in debug; bg-core's oracle property tests dominate; the full decision-vector drift test runs in release only)
cd engine && cargo test --release -p bg-bot --test perf --test vectors -- --include-ignored --show-output   # perf (mean of 10 club decisions < 700 ms natively) + full drift test, as CI runs them
```

Full local gate (CI additionally runs `pnpm test -- --coverage` and Playwright e2e):

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build \
 && (cd engine && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test \
     && cargo test --release -p bg-bot --test perf --test vectors -- --include-ignored \
     && cargo build --target wasm32-unknown-unknown -p bg-core -p bg-bot) \
 && docker build -t backgammon:local .
```

Notes:

- `pnpm typecheck` runs `next typegen && tsc --noEmit`; `web/next-env.d.ts` is generated and gitignored.
- CI runs `pnpm test -- --coverage`. A coverage threshold is `(planned)`; none is enforced yet.
- Image smoke test: `docker run -d --rm --name bg-smoke -p 3999:3000 backgammon:local`, then `curl -fsS http://127.0.0.1:3999/health`; `docker rm -f bg-smoke` afterwards.

## Engine

Rust workspace in `engine/` (toolchain pinned by `engine/rust-toolchain.toml`;
edition 2024; workspace lints `clippy::all = deny`, `pedantic = warn`, and
`-D warnings` in CI, so pedantic lints are errors too). Design: spec section
4; plan: [docs/superpowers/plans/2026-09-03-engine.md](docs/superpowers/plans/2026-09-03-engine.md).

Crates:

- `bg-core` — rules engine: `Board` (absolute), `Position` (relative),
  `Dice`/`DiceRng`, `Move`/`Play` with `legal_plays`/`apply`/`is_legal`,
  notation (`Display`/`parse_play`), `Cube`/`Rules`/`GameState` (cube
  actions incl. beavers, Jacoby, results), `MatchState` (Crawford,
  post-Crawford, scoring), `Turn`/`Record` with `replay` (seeds are bounded
  by `record::MAX_SEED` = 2^53 − 1 so they survive `JSON.parse`). Builds for
  `wasm32-unknown-unknown`: no `std::time`, no OS randomness, no threads, no
  `unsafe`, no `unwrap()` outside tests.
- `bg-bot` — the bot: `Evaluator` trait and `Probs`, the Kazaross-XG2 match
  equity table (`met`, `met_post_crawford`, `MatchContext`, `equity_for`),
  race formulas (Keith count) and contact features, the `ClubEvaluator`,
  `rank_plays` with `Level`s, truncated rollouts, cube decisions
  (`CubeAnalysis`), `MoveAnalysis` with error categories, and the `Bot`
  facade (`choose_play`, `cube_action`, `analyze_play`, `analyze_cube`). See
  [Bot](#bot-bg-bot). Same target constraints as `bg-core` (builds for
  `wasm32-unknown-unknown`; no `getrandom` in its dependency tree).
- `bg-wasm` `(planned)` — wasm-bindgen binding for the browser; `bg-node`
  `(planned)` — napi-rs binding for the realtime process. Both expose the same
  JSON API and are held to the shared vectors by parity tests.

Conventions (binding across crates and bindings; full text in the plan's
"Domain conventions"):

- Players `white`/`black`. Absolute point numbering is White's: White moves
  24 → 1 and bears off from 1–6, Black moves 1 → 24. `Board` arrays have 26
  slots per side: index 0 = bar, 1–24 = points, 25 = off.
- The rules and the bot work on the relative `Position` of the player on
  roll: `mine[p]`/`theirs[p]` for `p` in 1–24 are that player's own point
  numbers (1 = ace point), 0 = off, 25 = bar; `theirs[p]` are the opponent's
  checkers standing on my point `p`.
- `Dice { hi, lo }` with `hi >= lo`; 21 distinct rolls. Randomness only via
  `DiceRng::from_seed(u64)` (ChaCha8), so a game is reproducible from its
  seed and record on every target.
- A `Play` is 0–4 `Move`s; `legal_plays` returns one canonical play per
  resulting position (moves sorted by `from` descending, then `to`
  descending), sorted. Notation is relative to the mover: `24/18 13/10`,
  `bar/22* 6/2`, `8/4(2) 6/2(2)`, `6/off 5/off`; the empty play is `""`.
- Cross-binding data is JSON with `camelCase` keys; the shapes (`Board`,
  `Dice`, `Move`, `Play` with its `notation` field, `Cube`, `GameState`,
  `MatchState`, `Turn`, `Record`) are listed in the plan and asserted by
  `bg-core/tests/game_flow.rs`, `replay.rs` and `notation.rs`. The bot adds
  `MatchContext`, `Probs`, `Candidate` (whose `rollout` carries `trials`,
  `equity`, `stdErr` and, beyond the plan's example, `probs`),
  `MoveAnalysis`, and `CubeAnalysis` (with a `canDouble` field beyond the
  plan's five keys); `CubeChoice` is `noDouble | double | take | drop`.

### Bot (`bg-bot`)

Design: spec section 4.2–4.5; the judgement calls below are recorded in the
plan and in the module docs of the files named.

Levels (`Level`, wire strings `beginner`, `intermediate`, `club`) change
search depth and noise only; rules and evaluator are identical:

| Level | Search | Noise | Rollouts |
|---|---|---|---|
| `beginner` | 1-ply | Gaussian, σ = 0.05 equity, from a seeded ChaCha8 stream | none |
| `intermediate` | 1-ply | none | none |
| `club` | 1-ply, then 2-ply refinement of the top 5 | none | 100 truncated rollouts (depth 8 plies) per top-5 candidate, attached as information (`trials`, `equity`, `stdErr`); the order stays the 2-ply order unless a rollout gap exceeds twice the combined standard error (`bg_bot::search::ranking_gap`) |

Analysis (`Bot::analyze_play`, `analyze_cube`) always uses the club
parameters, whatever level the bot plays at. A played move outside the
rolled-out head is refined with the same 2-ply search and rollout before it
is graded, and the error size is the same comparator the ranking uses, so a
played move and the best play are always compared on one scale.

What the probabilities are, and are not: `Probs { win, winG, winBg, loseG,
loseBg }` are cumulative outcome probabilities for the side on roll from a
**hand-tuned static evaluator** (`src/heuristic.rs`: a logistic on a linear
score over pip, blot, shot, point, prime, anchor and home-board features for
contact positions, where each shot is priced by the pips the hit would cost
and the strength of the board it must re-enter against; contact gammon
chances also depend on how far the loser's checkers are from home; a
Keith-count curve with an explicit on-roll credit for races; a
rolls-to-finish model for bear-offs), refined by shallow search. Rollout
numbers are sample means over 100 truncated, seeded trials (`trials` and
`stdErr` are reported so they can be labelled as estimates) and change the
ranking only when decisive. None of this is a neural-network or
full-rollout strength evaluation: the absolute levels are approximate and the
ranking is what the bot plays by. Equities are on the scale of `equity_for`:
cubeless money equity in a money game, and in a match the "equivalent to money
game" normalisation of match winning chances where a single game at the
current cube is ±1, so the same error thresholds apply everywhere.

Cube decisions (`src/cube.rs`) use the **dead-cube model** (Janowski cube-life
index x = 0): no double, double/take and double/drop are compared as if the
game were then played cubeless at the resulting cube value, so the model
doubles a little early and takes a little late compared with a live-cube
model. In a **money-game race** that arithmetic would double any lead, so the
action there follows Tom Keith's count instead (double when the bumped lead
is at most 4, redouble at most 3, take when it is at least 2; the three
equities are still reported); match-play races and all contact positions
keep the MET model. Cube errors are graded against the recommended action.
The `takePoint` is the gammonless dead-cube take point (0.25 in a money
game; MET-derived in a match). In the Crawford game or when the opponent
owns the cube the action is `noDouble` with `canDouble: false`.

Error categories (`bg_bot::analysis::thresholds`, asserted by tests, following
XG's published legend): `best` ≤ 0.0005 equity lost, `fine` < 0.020, `error`
0.020–0.080, `blunder` ≥ 0.080.

Match equity table: the Kazaross-XG2 table distributed with GNU Backgammon
(pre-Crawford 25 × 25 and post-Crawford column), embedded in
`engine/bg-bot/src/met_data.rs`. Only the data file is used, under its own
permissive notice, which is reproduced verbatim in
`engine/bg-bot/MET-NOTICE.txt` and as the module doc of `met_data.rs`; no GPL
code from GNU Backgammon is ported.

Performance: `bg-bot/tests/perf.rs` (ignored by default) times 10 club
decisions from seeded middlegame positions and asserts a mean under 700 ms
natively (measured about 170 ms on an Apple-silicon laptop; the browser
target is budgeted at roughly three times the native time). CI runs it in
release with
`cargo test --release -p bg-bot --test perf --test vectors -- --include-ignored --show-output`,
which also runs the release-only full decision-vector drift test, prints the
per-decision timings, and then greps the log for both tests' `ok` lines so a
renamed or removed test fails the step instead of passing with nothing run.

Tests (`cd engine && cargo test`): `tests/oracle.rs` checks `legal_plays`
against an independent brute-force generator with proptest and freezes the
opening-position play counts; `rules_golden.rs` covers bear-off, bar entry,
larger-die, cube, Crawford and Jacoby edge cases with rule citations;
`notation.rs` round-trips notation and JSON; `game_flow.rs` and `replay.rs`
cover game and match flow and seed + record determinism; `vectors.rs` asserts
that `engine/vectors/plays.json` equals the generator's output and matches
the engine. In `bg-bot`: `met.rs` (table values, symmetry, MWC helpers),
`race.rs` and `features.rs` (Keith count, race curve anchors, shot table),
`evaluator.rs` (sanity ranges and the flip-symmetry invariant), `search.rs`
and `rollout.rs` (level parameters, determinism per seed), `analysis.rs`
(categories, hit-versus-double-shot ranking, cube actions), `vectors.rs`
(`decisions.json` drift and consistency) and the ignored `perf.rs`.

Test vectors: `engine/vectors/plays.json` (opening position × 21 rolls plus
40 seeded random positions × 3 rolls → legal play notations) is generated,
never hand-edited. Regenerate with

```bash
cd engine && cargo run -p bg-core --example gen_vectors -- plays vectors/plays.json
```

and review the diff. `engine/vectors/decisions.json` (30 bot decisions: 15
opening rolls across the three levels, then club-level middlegame, race and
bear-off positions under money and match contexts, each with the chosen play
and every candidate's ranking equity rounded to six decimals) is generated by

```bash
cd engine && cargo run --release -p bg-bot --example gen_decisions -- decisions vectors/decisions.json
```

and guarded by `bg-bot/tests/vectors.rs` (a cheap subset in the debug
profile, the full byte-for-byte comparison in release; see above).
`engine/vectors/README.md` documents both formats and the layout of the
entries.

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
  `cargo clippy --all-targets -- -D warnings`, `cargo test`, the release-mode
  bot timing test `cargo test --release -p bg-bot -- --ignored perf`, wasm32
  build of `bg-core` and `bg-bot`) and job `web` (lint, typecheck, unit tests
  with coverage, `next build`, Playwright e2e). The engine job's `cargo test`
  includes the vector drift checks (`bg-core/tests/vectors.rs`,
  `bg-bot/tests/vectors.rs`). Parity tests and the screenshot matrix from the
  spec are `(planned)`.
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
