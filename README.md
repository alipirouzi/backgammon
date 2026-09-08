# Backgammon

A championship-feel backgammon web application: play against a club-strength
computer and see its reasoning, invite one other person by link and play in
real time, join admin-created leagues with a rated scoreboard, in five
languages. Live target: https://backgammon.automated.ink

Design: [docs/superpowers/specs/2026-09-03-backgammon-platform-design.md](docs/superpowers/specs/2026-09-03-backgammon-platform-design.md).
Foundation plan: [docs/superpowers/plans/2026-09-03-foundation.md](docs/superpowers/plans/2026-09-03-foundation.md).

## Status

The **foundation** exists (a protected repository, CI, a GitHub-App PR flow, a
Docker image, and a health endpoint, deployed over the host's forced-command
SSH pipeline), the **engine** exists (`bg-core` implements the rules, legal
plays, notation, cube and match state, and replayable records; `bg-bot` the
club-strength bot, cube decisions and analysis output; `bg-wasm` (WebAssembly)
and `bg-node` (native Node.js addon) expose one JSON API over them, each held
to the shared test vectors by a parity test, and the Docker image builds
`bg-wasm` in a Rust stage — see [Engine](#engine) and
[Bindings](#bindings-bg-wasm-bg-node)), and you can **play against the
computer** in the browser: a landing page with a board-theme chooser, a
new-game form (single game or match to 3/5/7 at three levels), and the Table
screen — an SVG board in three themes, player cards, action bar, status line —
driven by the engine running in a Web Worker (see [Web app](#web-app)). The
analysis drawer, post-game review and server-side persistence of finished
games are `(planned)` (the second Play PR); multiplayer, members and
languages follow.

Delivery order (spec section 9); each piece gets its own spec, plan, and PRs:

1. Foundation — done
2. Engine — this repository state: `bg-core` (rules, plays, notation, game and match state, records, test vectors), `bg-bot` (evaluator, match equity table, club bot with three levels, rollouts, cube decisions, analysis output, decision vectors), `bg-wasm` and `bg-node` (JSON bindings with parity tests, wired into CI and the image build)
3. Play — board, three themes, bot games: this repository state (PR D); analysis drawer, post-game review, persistence of finished games `(planned)` (PR E)
4. Multiplayer `(planned)` — invite links, seat claiming, realtime process, chat, optional clocks
5. Members `(planned)` — magic-link login, profiles, leagues, Glicko-2, scoreboard
6. Languages `(planned)` — fa/tr/de/fr translations, RTL, rules guide

Routes today: `GET /` is the landing page (its `<main>` keeps
`id="board-mount"`, which the deploy pipeline checks); `GET /play/new` the
new-game form; `GET /play/local-<seed>` a bot game; `GET /health` returns
`200 {"status":"ok"}`. Security headers are set in `web/next.config.ts`;
`X-Powered-By` is disabled. The Content-Security-Policy is sent as
`Content-Security-Policy-Report-Only`: enforcing it needs per-request nonces
for Next's inline hydration scripts and for the root layout's inline theme
bootstrap (a Next proxy/middleware `(planned)` — e.g. a future
`web/proxy.ts`; no such file exists yet), and `script-src` must gain
`'wasm-unsafe-eval'` for `WebAssembly.instantiate` in the engine worker.

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
│   ├── bg-wasm/                     WebAssembly binding (see Bindings below)
│   │   ├── src/api.rs               the JSON marshalling layer shared by both bindings
│   │   ├── src/lib.rs               wasm-bindgen exports (wasm32 only)
│   │   ├── tests/vectors.rs         api.rs against engine/vectors
│   │   ├── README.md                crate docs; copied into pkg/ by wasm-pack
│   │   └── pkg/                     generated by wasm-pack (gitignored); pnpm workspace package `bg-wasm`
│   ├── bg-node/                     native Node.js binding, napi-rs (see Bindings below)
│   │   ├── Cargo.toml  build.rs  src/lib.rs  package.json
│   │   ├── __test__/parity.test.mjs node:test parity test against engine/vectors
│   │   └── *.node  index.js  index.d.ts   generated by @napi-rs/cli (gitignored)
│   └── vectors/                     generated test vectors shared with the bindings (README inside)
├── web/                             Next.js app (pnpm workspace member; depends on `bg-wasm`)
│   ├── src/app/                     layout.tsx (theme bootstrap + header), page.tsx (landing, #board-mount), health/route.ts,
│   │                                play/new/ (form), play/[gameId]/ (the table), play/game-options.ts (URL contract)
│   ├── src/engine/                  protocol.ts, worker.ts, sync.ts, client.ts (Engine, MockEngine), node.ts, types.ts
│   ├── src/game/                    store.ts (Zustand), selectors.ts, record.ts, dice.ts, local-games.ts
│   ├── src/components/              board/ (geometry, Board + parts, board.css), table/ (TableLayout, PlayerCard, ActionBar,
│   │                                StatusLine), theme/ (SiteHeader, ThemeSwitch, useTheme), landing/
│   ├── src/styles/                  tokens.css, themes.css (the three [data-theme] palettes)
│   ├── tests/                       Vitest: engine-parity, engine-client, engine-node, store, store-engine, record, dice,
│   │                                geometry, game-options, landing-theme, health, components/*.test.tsx (jsdom)
│   └── e2e/                         Playwright: landing.spec.ts, bot-game.spec.ts, themes.spec.ts (screenshot matrix)
├── deploy/
│   ├── docker-compose.prod.yml      app + postgres on the host
│   ├── backgammon.caddy             per-site Caddy snippet
│   └── backgammon-deploy.sh         host forced command (/usr/local/bin/backgammon-deploy)
├── Dockerfile                       multi-stage: Rust stage builds bg-wasm, then Next standalone output
├── .dockerignore                    keeps engine/ in the context, drops target/, pkg/ and bg-node artefacts
├── package.json  pnpm-workspace.yaml  .nvmrc  .editorconfig  .gitignore  LICENSE
└── docs/superpowers/{specs,plans}/
```

## Prerequisites

- Node 22 (`.nvmrc`) and pnpm 9 (`packageManager` in `package.json`; `corepack enable` provides it)
- Rust via rustup; `engine/rust-toolchain.toml` pins 1.98.0 with `rustfmt`, `clippy`, and the `wasm32-unknown-unknown` target; run `rustup toolchain install` inside `engine/` once (cargo's auto-install still works but rustup reports it as deprecated)
- wasm-pack 0.15.0 (`cargo install wasm-pack --version 0.15.0`, or the release tarball CI and the Dockerfile download: `wasm-pack-v0.15.0-<arch>.tar.gz` from `github.com/wasm-bindgen/wasm-pack/releases`). Locally it fetches wasm-bindgen-cli 0.2.127 and binaryen (`wasm-opt`) on first use, so the first build needs network access; CI and the Dockerfile install both from pinned, sha256-verified tarballs and build with `--mode no-install` instead.
- Docker (Compose v2) for the image build and smoke test

## Run

```bash
wasm-pack build engine/bg-wasm --target bundler --release --out-dir pkg --out-name bg_wasm   # first: engine/bg-wasm/pkg is a workspace package, pnpm install fails without it
pnpm install
pnpm --filter web dev          # http://localhost:3000
```

Playing locally: open http://localhost:3000, pick a board under "Choose your
board" (persisted in `localStorage` as `bg.theme`; the header switch on the
other pages does the same) and press "Play the computer", or go straight to
`/play/new`. The form offers the format (single game with money rules, or a
match to 3/5/7 with the Crawford rule; the URL accepts any `format=N` from 1
to 25) and the level (beginner, intermediate, club) and lands on
`/play/local-<seed>?format=<single|N>&level=<level>`.
You play White, at the bottom, bearing off bottom right: Roll, click a
checker, click a highlighted destination (Undo takes the last move back),
Confirm when the play is complete; Double/Take/Drop and Resign live in the
action bar; the computer's reply is played inside your action and reported
on the status line ("Computer played 8/5(2) 6/3(2) with 3-3"). In a match
each finished game stays on show — result, score, "Next game" — and the next
opening roll is drawn only when you press it; the final banner offers "Play
again" (a fresh seed, same format and level). If an engine call fails the
status line shows the error, the page retries the stalled step twice by
itself, then a Retry button takes over; the error stays until a retry
succeeds. Every roll comes from the seed: `/play/new?seed=42` pins the dice,
so a game can be replayed exactly, and a bare `/play/local-42` opens the
opening position with the defaults (single game, intermediate). The record
of a game is saved after every accepted turn under `localStorage`
`bg.games.local-<seed>`; reopening the URL resumes that record — an
unfinished game continues from its last turn (the dice stream is rebuilt
from the record; `format`/`level` in the URL are ignored for a stored id), a
finished one is shown finished. Only an id with nothing stored starts a new
game.

## Test

```bash
pnpm --filter bg-node build                # napi build --platform --release -> engine/bg-node/{bg-node.<platform>.node, index.js, index.d.ts}; root `pnpm test` needs it
pnpm test                                  # all workspace packages: web Vitest (web/tests/engine-parity.test.ts checks bg-wasm against engine/vectors and skips with a banner when engine/bg-wasm/pkg is not built) and bg-node's node:test parity test
pnpm --filter web exec playwright install chromium   # once, before the first e2e run
pnpm --filter web build && pnpm --filter web test:e2e   # Playwright against `next start` (started by playwright.config.ts): landing + /health, a whole bot game, the screenshot matrix
cd engine && cargo test                    # Rust (~40 s in debug; bg-core's oracle property tests dominate; the full decision-vector drift tests run in release only)
cd engine && cargo test --release -p bg-bot -p bg-wasm --test perf --test vectors -- --include-ignored --show-output   # as CI runs them: perf (mean of 10 club decisions < 700 ms natively), full drift test, and every decisions.json entry through bg-wasm's JSON layer (the debug `cargo test` runs a subset)
```

End-to-end (`web/e2e`, Playwright, Chromium only; `playwright.config.ts`
starts `pnpm start` on 127.0.0.1:3000 and waits for `/health`, so `pnpm
--filter web build` must have run):

- `landing.spec.ts` — `/health` answers `{"status":"ok"}`; `/` renders
  `#board-mount` and the `Backgammon` heading.
- `bot-game.spec.ts` — a whole game against the computer through the real
  UI: `/play/new?seed=42`, single game, beginner, then "first legal source,
  first legal target, Confirm" (Take whenever the computer doubles) until the
  finish banner ("You win …" / "The computer wins …") appears; capped at 400
  actions and 120 s. It synchronises on the status line
  (`[role=status][data-tone=info|busy|error|result]`) and fails fast on an
  `error` tone. With seed 42 it currently ends "The computer wins 4 points
  (gammon)" after about 135 actions in about 30 s.
- `themes.spec.ts` — the screenshot matrix: 3 themes × 3 widths (375, 768,
  1440) of `/play/local-42` at the opening position, each theme chosen the
  way a returning visitor's is (`localStorage` `bg.theme` before load), saved
  as `web/test-results/screens/<theme>-<width>.png`; asserts `<html
  data-theme>` and that the computed `--board-felt` differs across the three
  themes at every width. CI uploads the folder as the `screens` artifact on
  every run (`web/test-results/` is gitignored).

Full local gate (CI additionally runs `pnpm test -- --coverage`). Order
matters twice: `wasm-pack build` before `pnpm install`, and `pnpm --filter
bg-node build` before the root `pnpm test`:

```bash
(cd engine && cargo fmt --check && cargo clippy --all-targets -- -D warnings \
     && cargo clippy -p bg-wasm --target wasm32-unknown-unknown -- -D warnings && cargo test \
     && cargo test --release -p bg-bot -p bg-wasm --test perf --test vectors -- --include-ignored \
     && cargo build --target wasm32-unknown-unknown -p bg-core -p bg-bot -p bg-wasm) \
 && wasm-pack build engine/bg-wasm --target bundler --release --out-dir pkg --out-name bg_wasm \
 && pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck \
 && pnpm --filter bg-node build && pnpm --filter bg-node test && pnpm test && pnpm build \
 && pnpm --filter web test:e2e \
 && docker build --platform linux/amd64 -t backgammon:local .
```

Notes:

- `pnpm typecheck` runs `next typegen && tsc --noEmit`; `web/next-env.d.ts` is generated and gitignored.
- Root `pnpm test` and `pnpm build` are `pnpm -r`, so they include `bg-node` (`node --test` and `napi build --release`); `pnpm test` therefore fails with a module-not-found error until the addon has been built once.
- CI runs `pnpm test -- --coverage`. A coverage threshold is `(planned)`; none is enforced yet.
- `docker build --platform linux/amd64` matches `deploy.yml` (the host is amd64). On an Apple-silicon machine the Rust stage then runs emulated; the `wasm-pack build` step took about 50 s there.
- Image smoke test: `docker run -d --rm --name bg-smoke -p 3999:3000 backgammon:local`, then `curl -fsS http://127.0.0.1:3999/health` (expect `{"status":"ok"}`), `curl -fsS http://127.0.0.1:3999/ | grep -c 'id="board-mount"'` and `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3999/play/new` (expect `200`); `docker rm -f bg-smoke` afterwards.
- `pnpm --filter web test:e2e` runs `next start`, which warns that it "does not work with output: standalone"; for the e2e the plain server is fine (the image runs `node web/server.js` from the standalone output).

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
- `bg-wasm` — the JSON marshalling layer (`src/api.rs`: `*_json(&str, …)
  -> Result<String, String>` over `bg-core` and `bg-bot`) plus the
  wasm-bindgen exports for the browser, which exist only when compiling for
  `wasm32`; `wasm-pack` turns it into the pnpm workspace package `bg-wasm`
  (`engine/bg-wasm/pkg`, generated).
- `bg-node` — napi-rs native addon for the realtime process `(planned,
  piece 4)`; it wraps `bg_wasm::api` one-to-one, so the two bindings share
  one marshalling layer and cannot drift. Both are held to the shared
  vectors by parity tests; see [Bindings](#bindings-bg-wasm-bg-node).

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

Cube decisions (`src/cube.rs`) compute the three **dead-cube** equities
(Janowski cube-life index x = 0): no double, double/take and double/drop as
if the game were then played cubeless at the resulting cube value. On their
own those equities would double any positive advantage (including the
opening position), so the action is gated by a **doubling window** — a
threshold approximation of a live-cube model: an initial double needs a
cubeless win probability of at least 0.68 (a redouble 0.70) and must still
gain under the dead-cube arithmetic; the opponent takes while double/take
beats double/drop (gammonless: 25 % in a money game, the MET-derived take
point in a match); a position with at least 85 % wins and 25 % gammons is
too good to double when gammons are worth something at the score, as is any
position where playing on cubeless already beats cashing. The same window
gates match play, so a double is never recommended below 0.68 even at scores
(2-away/2-away) where the arithmetic alone would double earlier. In a
**money-game race** the action follows Tom Keith's count instead (double
when the bumped lead is at most 4, redouble at most 3, take when it is at
least 2; the three equities are still reported). Cube errors are graded
against the recommended action. The `takePoint` is the gammonless dead-cube
take point (0.25 in a money game; MET-derived in a match). In the Crawford
game or when the opponent owns the cube the action is `noDouble` with
`canDouble: false`.

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
`cargo test --release -p bg-bot -p bg-wasm --test perf --test vectors -- --include-ignored --show-output`,
which also runs the release-only full decision-vector drift test and
`bg-wasm`'s release-only replay of every `decisions.json` entry, prints the
per-decision timings, and then greps the log for the three tests' `ok` lines
so a renamed or removed test fails the step instead of passing with nothing
run.

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
(`decisions.json` drift and consistency) and the ignored `perf.rs`. In
`bg-wasm`: unit tests of the JSON layer (argument forms, error messages) and
`tests/vectors.rs` (both vector files through the string-in/string-out
path). `bg-node` has no Rust tests (`test = false`); its parity test runs
from Node.

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

### Bindings (`bg-wasm`, `bg-node`)

Design: spec section 4.6 (bindings and parity) and 3.2 (compute placement:
the bot runs in the browser as WebAssembly; the realtime process `(planned,
piece 4)` uses the native addon).

One API, two bindings. Every function takes JSON strings and returns a JSON
string; an engine error becomes a JavaScript exception whose message is the
Rust error text. The shapes are the engine's serde output (`camelCase`; see
[Engine](#engine) and `engine/vectors/README.md`).

| Function (`bg-wasm` name; `bg-node` uses camelCase, e.g. `legalPlays`) | Arguments | Returns |
|---|---|---|
| `opening_board()` | – | `Board` |
| `legal_plays(board, onRoll, dice)` | | `[Play]` in canonical order; `[{"moves":[],"notation":""}]` when no move is possible |
| `apply_play(board, onRoll, play)` | `play`: `Play` object or notation string | `Board` |
| `choose_play(board, onRoll, dice, matchCtx, level, seed)` | `level`: `beginner` \| `intermediate` \| `club` | `{ "play": Play, "candidates": [Candidate] }` |
| `cube_action(board, onRoll, matchCtx, level)` | | `CubeAnalysis` (incl. `canDouble`) |
| `analyze_play(board, onRoll, dice, matchCtx, played, seed)` | `played`: notation | `MoveAnalysis` |
| `replay(record)` | `Record` | `MatchState` |
| `version()` | – | plain string, not JSON: `bg-wasm 0.1.0` / `bg-node 0.1.0` |

`matchCtx` is `bg_bot::MatchContext`, e.g.
`{"length":0,"myAway":0,"theirAway":0,"crawford":false,"postCrawford":false,"cube":1,"cubeOwnerIsMe":null}`.
Leniencies, part of the contract and identical in both bindings: text
arguments (`onRoll`, `level`, a notation) may be a JSON string or the bare
text; `seed` is a `u64` as a JSON number or numeric string, at most
2^53 − 1 (`Number.MAX_SAFE_INTEGER`); `apply_play` checks a play
structurally (no dice are known there), `legal_plays` is the roll check.
Seeds come from the caller: neither binding has `getrandom` in its
dependency tree (CI asserts `cargo tree -p bg-wasm --target
wasm32-unknown-unknown` contains no `getrandom`), so a game is reproducible
from its seed and record in the browser, in Node and in Rust.

`bg-wasm` (`engine/bg-wasm`): `crate-type = ["cdylib", "rlib"]`;
`wasm-bindgen` is pinned `=0.2.127` and pulled only under
`cfg(target_arch = "wasm32")`, so the rlib (the `api` module) builds natively
for `bg-node` and `cargo test`. Build the package from the repository root:

```bash
wasm-pack build engine/bg-wasm --target bundler --release --out-dir pkg --out-name bg_wasm
```

Output `engine/bg-wasm/pkg/` (gitignored): `package.json` (name `bg-wasm`),
`bg_wasm.js`, `bg_wasm_bg.js`, `bg_wasm_bg.wasm` (about 300 kB after
`wasm-opt`), `bg_wasm.d.ts`, `bg_wasm_bg.wasm.d.ts`. `pnpm-workspace.yaml`
lists `engine/bg-wasm/pkg` as a workspace package and `web/package.json`
depends on `"bg-wasm": "workspace:*"`, so `pnpm install` fails with
`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` until the package has been built — CI and
the Dockerfile build it first. The bundler-target output is what Next
(Turbopack) loads natively: `web/src/engine/worker.ts` imports it inside a
Web Worker (Turbopack emits `turbopack-worker-*.js` and the `.wasm` into
`.next/static/chunks`), `web/src/engine/node.ts` loads the same package in
Node for tests and the future server-side replay, and the parity test
exercises it directly (see [Web app](#web-app)).

`bg-node` (`engine/bg-node`): napi-rs 3 (`napi`, `napi-derive`, `napi-build`),
`crate-type = ["cdylib"]`, built by `@napi-rs/cli` (`pnpm --filter bg-node
build` = `napi build --platform --release`) into
`engine/bg-node/bg-node.<platform>.node` with `index.js`/`index.d.ts`
(all gitignored; targets `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`,
`x86_64-apple-darwin`). CI builds and tests it on every push; it is **not**
part of the Docker image — it ships with the realtime process `(planned)`,
at which point the runtime image moves from `node:22-alpine` to
`node:22-bookworm-slim` (glibc for the addon) `(planned)`.

Parity tests, all against the committed `engine/vectors` (`plays.json`: 141
legal-play entries; `decisions.json`: 30 bot decisions with candidate
equities rounded to six decimals; criteria in `engine/vectors/README.md`):

- `engine/bg-wasm/tests/vectors.rs` — the JSON layer itself, in Rust
  (`cargo test -p bg-wasm`: all beginner and intermediate decisions plus
  every fourth club entry; the full run is `--release … --include-ignored`).
- `web/tests/engine-parity.test.ts` — the WebAssembly package under Vitest.
  Node 22+ loads the bundler-target ESM (`bg_wasm_bg.wasm` as a module
  import; Node 22 prints an `ExperimentalWarning` for it); if that import
  fails, or with `BG_WASM_LOADER=manual`, the test wires the glue by hand
  (`WebAssembly.instantiate`, `__wbg_set_wasm`, `__wbindgen_start`). When
  `pkg/` is absent the suite is skipped with a banner on stderr, so a local
  `pnpm test` passes before a wasm build; with `CI` set (GitHub Actions) the
  file fails instead, because `pnpm install --frozen-lockfile` tolerates a
  missing workspace package and the skip would otherwise hide an unbuilt
  binding. Also covers `version`, `opening_board`,
  `apply_play`, `cube_action`, `analyze_play`, `replay` and error
  propagation.
- `engine/bg-node/__test__/parity.test.mjs` — the native addon under
  `node --test`, the same checks.

Equity comparison in both JS tests rounds like Rust (`f64::round`, half away
from zero) to six decimals and normalises `-0`.

Build integration:

- CI (`ci.yml`, job `engine`): after the existing Rust steps, the
  `getrandom` check, `cargo clippy -p bg-wasm --target
  wasm32-unknown-unknown -- -D warnings`, an install of wasm-pack 0.15.0,
  wasm-bindgen-cli 0.2.127 and binaryen `version_117` (`wasm-opt`) from
  pinned release tarballs with `sha256sum -c` (versions and digests in the
  workflow's top-level `env`), `wasm-pack build --mode no-install` (so
  wasm-pack never downloads a binary itself), an assertion that
  `engine/bg-wasm/pkg/{package.json,bg_wasm.js}` exist, then `pnpm install
  --frozen-lockfile`, `pnpm --filter bg-node build` and `pnpm --filter
  bg-node test`. Job `web` installs Rust 1.98.0 + the wasm32 target
  (`dtolnay/rust-toolchain` pinned to a commit, `Swatinem/rust-cache`) and
  the same three tools, and builds `bg-wasm` **before** `pnpm install`, so the
  parity test runs in the existing `pnpm test -- --coverage` step. Job names
  are unchanged (the ruleset requires exactly `engine` and `web`).
- Docker: stage `wasm` (`rust:1.98-slim-bookworm`) installs `curl` and
  `ca-certificates`, downloads the same pinned wasm-pack, wasm-bindgen-cli
  and binaryen tarballs and verifies the same sha256 digests (the pins in
  `ci.yml` and the Dockerfile must be bumped together), adds the wasm32
  target, copies `engine/` and runs the same `wasm-pack build --mode
  no-install`; stage `deps`
  copies `engine/bg-node/package.json` (manifest only, so the workspace
  resolves) and `--from=wasm` the generated `engine/bg-wasm/pkg` before
  `pnpm install --frozen-lockfile`. `.dockerignore` keeps `engine/` in the
  context but excludes `**/target`, `engine/bg-wasm/pkg` and the bg-node
  artefacts, so the image always builds its own package. The three tool
  downloads need network access to GitHub in CI and in the image build; the
  runtime stage is unchanged (`node:22-alpine`, non-root `app`, `HEALTHCHECK`
  on `/health`).

## Web app

Design: spec section 5.1–5.3; plan:
[docs/superpowers/plans/2026-09-07-play.md](docs/superpowers/plans/2026-09-07-play.md)
(names, props, store shape and theme tokens there are binding). Next 16 App
Router (Turbopack), React 19, TypeScript strict, Zustand 5; Vitest 4 with
jsdom for component tests, Playwright for e2e.

- **Engine in the browser** (`web/src/engine`): `worker.ts` loads `bg-wasm`
  in a Web Worker so the UI thread never blocks; `protocol.ts` types the
  request/response pairs (`legalPlays`, `applyPlay`, `choosePlay`,
  `cubeAction`, `analyzePlay`, `replay`, `version`); `client.ts` exposes
  `createEngine(): Engine` (typed async methods, one in-flight queue, a 10 s
  per-request timeout, `terminate()`) plus a scripted `MockEngine` for tests;
  `sync.ts` is the marshalling shared with `node.ts`, which loads the same
  package in Node.
- **Game store** (`web/src/game/store.ts`, Zustand): holds the absolute
  `MatchState`, the growing `Record`, the seats, the bot level and the UI
  state (`selectedFrom`, `legalTargets`, `pendingMoves`, `busy`,
  `lastError`). It never decides legality itself — every question goes to the
  engine — and every engine rejection lands in `ui.lastError` rather than
  throwing into React. Dice: the browser owns the seed (`crypto` 53-bit, or
  `?seed=`); `dice.ts` ports the engine's `DiceRng` (ChaCha8 + rejection
  sampling) and every drawn roll is verified by the engine's `replay` on the
  next call, so the record stays the single source of truth for server-side
  re-verification later. The computer's whole reply (cube decision, roll,
  move, or its answer to a double) is played inside the person's action;
  forced passes and the opening roll run on their own. In a match the store
  starts the next game itself.
- **Board** (`web/src/components/board`): pure SVG from `geometry.ts`
  (`viewBox 0 0 1000 700`, frame 24, bar 60; White bears off bottom right,
  geometry never depends on CSS direction). Points, bar and trays are real
  `<button>`s in an overlay over the `aria-hidden` SVG (`Point 13, 5 white
  checkers`, ending in `, selected` / `, legal destination` while a checker
  is lifted; `data-legal="true"` marks exactly the clickable targets; Tab
  order bar, 24 … 1, trays; Escape puts a lifted checker back). Checkers
  carry `data-testid="checker-<player>-<point>-<index>"`. Motion is on
  `transform`/`opacity` only — the overlay buttons' hover tint and
  selection ring are opacity-faded pseudo-elements — and
  `prefers-reduced-motion` makes moves instant. Point numerals are SVG text
  and scale with the board; they are hidden on boards narrower than 35rem.
- **Themes** (`web/src/styles/themes.css`): `heritage` (default, also on
  bare `:root`), `broadcast`, `editorial` as custom-property sets on `[data-theme]`
  (`--board-frame`, `--board-felt`, `--point-a/b`, `--checker-*` including
  the `--checker-*-bar-edge` ring for hit checkers, `--die-*`, `--cube-*`,
  `--ui-bg/fg/accent`, the text-contrast pair `--ui-muted` /
  `--ui-accent-text` and the CTA pair `--ui-cta-bg/fg` (Editorial darkens
  its terracotta for text and buttons to reach WCAG AA), `--font-display`,
  `--radius-board`, `--shadow-checker`). `<html data-theme>` is the single source of truth; the
  root layout's inline script restores the stored choice before first paint,
  and the header switch, the landing chooser and the new-game form all
  persist it under `bg.theme`.
- **Table** (`web/src/components/table`): player cards (Computer left, You
  right; score, pip count, cube ownership; bars above/below the board under
  900 px), `ActionBar` (Roll · Undo · Confirm · Double · Take · Drop · Resign,
  real `disabled` states from the store's `can*` selectors; when a control
  disables itself on activation, focus parks on the status line; the resign
  chooser takes focus when opened, closes on Escape and prices each kind
  with `concededPointsFor` — a gammon at a centred cube under Jacoby is
  "1 point"), `StatusLine` (`[role=status][data-tone]`; the ticker — the
  computer's last action — is its own polite live region; a Retry button
  appears while `canRetry`), the finish overlay (between the games of a
  match: last result, score and "Next game" → `nextGame()`; at the end:
  "Play again"; the board underneath goes `inert` and focus moves to the
  result), and the collapsed
  analysis line where the drawer `(planned)` will open. `/play/[gameId]`
  carries a visually hidden `h1` naming the game.
- **Routes**: `/` landing (`#board-mount`, theme chooser, "Play the
  computer"), `/play/new` (`?seed=`, `?format=`, `?level=` preselect),
  `/play/local-<seed>?format=single|N&level=beginner|intermediate|club`
  (`N` = 1–25; see `web/src/app/play/game-options.ts`); any other game id
  is a 404 until multiplayer. `/review/[gameId]` and `/api/games` are
  `(planned)`.
- **Storage**: `bg.theme` (theme id) and `bg.games.<id>` (the record, saved
  after every accepted turn) in `localStorage`; opening an id with a stored
  record resumes it (unfinished games continue, finished ones are shown
  finished). Nothing is sent to the server yet.
- **Tests**: `pnpm --filter web test` (engine client/worker protocol, store
  against `MockEngine` and against the real wasm via the Node loader, dice
  parity with the engine's seed-42 vector, record helpers, geometry, URL
  options, `PlayGame` (start once per id, bounded automatic retries, the
  pause between the games of a match), and jsdom component tests for Board,
  Table and Landing; the wasm
  suites skip when `engine/bg-wasm/pkg` is absent — `engine-parity` prints a
  banner and, like `engine-node`, fails under `CI`; the dice-parity and
  store-vs-wasm suites skip silently, so CI's `pkg` existence assertion is
  what guards them), plus the Playwright suite above.

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
  step (perf, full decision-vector drift, and `bg-wasm`'s full
  `decisions.json` replay, each grepped for its `ok` line), wasm32 build of
  `bg-core` and `bg-bot`, then the binding steps: `getrandom` check, wasm32
  clippy of `bg-wasm`, pinned installs of wasm-pack, wasm-bindgen-cli and
  wasm-opt, `wasm-pack build --mode no-install`, the `pkg` existence
  assertion, `pnpm install --frozen-lockfile`, `bg-node` build and parity
  test) and job `web` (Rust toolchain + the same tools + `bg-wasm` build
  first, then `pnpm install`, lint, typecheck, unit tests with coverage —
  including the WASM parity test, which fails under `CI` when `pkg` is
  missing — `next build`, Playwright e2e). The engine job's `cargo test`
  includes the vector drift checks (`bg-core/tests/vectors.rs`,
  `bg-bot/tests/vectors.rs`, and the debug subset of
  `bg-wasm/tests/vectors.rs`). The Playwright run includes the screenshot
  matrix (`web/e2e/themes.spec.ts`); the `web` job uploads
  `web/test-results/screens/` as the `screens` artifact on every run and the
  Playwright HTML report as `playwright-report` when the e2e step fails.
  The e2e suite also plays a whole seeded beginner game (`bot-game.spec.ts`)
  and the first game of a match to 3 through "Next game" (`match.spec.ts`).
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
