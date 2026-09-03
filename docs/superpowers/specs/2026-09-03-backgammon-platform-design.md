# Backgammon Platform — Design

**Date:** 2026-09-03
**Status:** approved in brainstorming, awaiting written-spec review
**Live target:** https://backgammon.automated.ink
**Repository:** https://github.com/alipirouzi/backgammon

## 1. Purpose

A polished, championship-feel backgammon web application where a person can:

- play against the computer at club strength and see the computer's reasoning
  (candidate moves with equities and win/gammon estimates) in a panel;
- invite one other person by link, Google-Meet style, and play in real time;
- sign up (passwordless), belong to admin-created leagues, and appear on a rated
  scoreboard;
- use the app in English, Persian (RTL), Turkish, German, and French, with a
  rules guide per language.

The engine is designed so a world-class neural-network evaluator can be added
later without touching anything else.

## 2. Decisions taken in brainstorming

| Topic | Decision |
|---|---|
| Bot strength | Club player now; evaluator interface ready for a neural net later |
| Analysis panel | Bot's reasoning in bot games; coach for the human's moves; full post-game review for any finished game |
| Invite links | Anyone with the link; first claimant locks the seat; only that seat holder may reconnect |
| Formats | Single game (Jacoby) or match to N points (cube, Crawford); chosen at game creation |
| Leagues | Only the admin (Ali) creates leagues |
| Visual direction | Three board themes selectable per player and remembered; default is **Tournament Heritage** |
| Match screen | **Table** layout: player cards flank the board; analysis drawer below with Moves and Chat tabs |
| Chat | In-game text chat, stored with the game |
| Accounts | Magic link by email only (Resend), via Auth.js |
| PR authorship | GitHub App owned by Ali, so Ali can approve PRs Claude opens |
| Shared Caddy | Host Caddyfile imports per-site snippets; clinic repo gets a small PR |
| Engine language | **Rust**, compiled to WASM for the browser and native (napi-rs) for the server |
| Web stack | Next.js, Prisma + PostgreSQL, Auth.js, next-intl, Tailwind |

Assumptions stated and accepted:

- Rating: Glicko-2, member-vs-member games only.
- Match clocks: optional, off by default.
- Spectators: out of scope (future).
- RTL: interface chrome mirrors; the board never mirrors.
- Digits: Latin digits in all locales for equities and pip counts.
- Deploy identity: restricted deploy user with SSH forced command (calendar-app
  pattern), not root.

## 3. Architecture

### 3.1 Repository layout (monorepo)

```
backgammon/
├── engine/                    Rust workspace
│   ├── bg-core/               board, dice, legal moves, cube, match rules, Evaluator trait
│   ├── bg-bot/                club heuristic evaluator, lookahead, truncated rollouts
│   ├── bg-wasm/               wasm-bindgen binding for the browser
│   └── bg-node/               napi-rs binding for the Node server
├── web/                       Next.js app (UI, themes, i18n, auth, members, leagues)
├── realtime/                  Node WebSocket process for live games (uses bg-node)
├── deploy/                    docker-compose.prod.yml, backgammon.caddy, deploy script
├── docs/superpowers/          specs and plans
└── .github/workflows/         ci.yml, deploy.yml
```

One Docker image contains `web` and `realtime`. The compose stack is
`app` + `realtime` + `postgres`. No additional runtime process for the engine.

### 3.2 Where compute runs

- **Bot games:** entirely in the browser via WASM. Legal moves, bot choice,
  candidate list, rollouts. The server receives only the finished record
  (seed + move log) and re-verifies it natively before it counts.
- **Human games:** the `realtime` process owns the authoritative position,
  seeds and rolls dice, validates every move with the native engine, and
  broadcasts snapshots. Browsers render only. Post-game review runs in the
  browser via WASM.
- **Rationale:** the host is a 2-vCPU, 3.8 GB Hetzner VM shared with two other
  apps. Search must not run on it.

### 3.3 Data flow

```
Bot game:    browser ──WASM engine──▶ moves/analysis ──▶ POST finished record ──▶ server verifies (native) ──▶ DB
Human game:  browser A ─┐
                        ├─ WebSocket ─▶ realtime (native engine, authoritative) ─▶ DB (on finish)
             browser B ─┘
Review:      browser ◀── game record ── DB ; analysis computed locally via WASM
```

## 4. Engine (Rust)

### 4.1 Board and rules (`bg-core`)

- Position: per player, 24 points + bar + off (26 slots), plus cube state,
  match score, match length, Crawford flag, player on roll, dice.
- Movement rules: enter from bar first; play both dice when possible; if only
  one die can be played, the larger must be played when possible; doubles
  play four times; bearing off with exact die or higher die when no checker
  is on a higher point; hitting is legal and normal.
- Cube: double / take / drop / redouble; beavers off by default; automatic
  doubles off; Jacoby rule in single games; Crawford rule in matches.
- Scoring: single, gammon (×2), backgammon (×3), multiplied by cube value.
- Randomness: engine takes an explicit RNG (`ChaCha`-style seeded). Server
  seeds per game and stores the seed; any game is replayable from seed +
  move log.

### 4.2 `Evaluator` trait

```rust
pub trait Evaluator {
    /// Probabilities from the perspective of the player on roll:
    /// [win, win_gammon, win_backgammon, lose_gammon, lose_backgammon]
    fn evaluate(&self, pos: &Position) -> Probs5;
}
```

Equity is derived from `Probs5` + cube state + match score via a match equity
table (Kazaross-XG2 or equivalent published table, cited in code). Bot, coach,
and review only ever depend on this trait. The future neural evaluator is a
new `impl Evaluator`.

### 4.3 Club evaluator (`bg-bot`)

- Position classification: race, holding/contact, bearoff.
- Features: pip counts and race formulas (Keith count / Thorp for
  non-contact), blots and direct/indirect shots, points made, prime length,
  anchors, home-board strength, checkers back, checkers on bar.
- Separate hand-tuned weight sets per class.

### 4.4 Move selection and analysis

1. Generate all legal plays (deduplicated by resulting position).
2. Score each at 1-ply with the evaluator; keep top K (default 5).
3. Refine top K with 2-ply expected value over the 21 dice outcomes.
4. For the panel: run N truncated rollouts (default 100, depth-limited) on the
   top K to produce win/gammon/backgammon estimates. The UI shows the sample
   count so the numbers are labelled estimates.
5. Cube decisions use the same evaluator + match equity.

Output per decision: ranked candidates with equity; error size of the move
actually played; category (best / fine / error / blunder) using standard
thresholds (0.02 / 0.08 equity).

### 4.5 Difficulty levels

| Level | Search | Noise |
|---|---|---|
| Beginner | 1-ply | Gaussian noise added to equities |
| Intermediate | 1-ply | none |
| Club | 1-ply + 2-ply refinement + rollouts | none |

Levels change depth and noise only; rules are identical.

### 4.6 Bindings

- `bg-wasm`: wasm-bindgen, exposes `legalMoves`, `applyMove`, `botMove`,
  `analyze`, `cubeDecision`, serialising positions as compact JSON.
- `bg-node`: napi-rs, same surface. Parity tests assert both bindings return
  identical results to the Rust test suite for a fixed vector set.

## 5. Web application

### 5.1 Board and themes

- SVG board rendered from the engine position. Same markup for all themes;
  themes are sets of CSS custom properties (palette, radii, shadows, type).
- Themes: **Tournament Heritage** (default; walnut, green felt, oxblood/sand
  points, ivory/ebony checkers), **Broadcast Modern** (charcoal, grey points,
  flat checkers, yellow accent), **Editorial Light** (linen, sage/terracotta,
  matte checkers).
- Persistence: guests in `localStorage`; members on the profile (profile wins
  after login).
- Interaction: drag or click-to-select; legal destinations highlighted; undo
  within a turn before confirming. Animations use transform/opacity only.
- The board never mirrors in RTL locales.

### 5.2 Match screen (Table layout)

- Player cards on their respective sides: name, score, pip count, clock (if
  on), cube ownership.
- Analysis drawer below the board: collapsed shows a one-line verdict;
  expanded shows candidates with equities, win/gammon estimates, sample count.
  Tabs: Analysis · Moves · Chat.
- Visibility: analysis on in bot games; off by default in human games (toggle
  is per player and only affects their own view); always available in
  post-game review.
- Mobile: player cards become thin bars above/below the board; drawer remains
  a drawer.

### 5.3 Game creation and invite links

- Options: opponent (computer / invite), format (single game / match to N),
  bot level (if computer), clock (off / per-move seconds + reserve).
- Invite creates a game with one unclaimed seat and a 128-bit random token in
  the URL: `/g/<token>`.
- **Seat claim:** first visitor to open the link claims the seat and gets a
  signed, HttpOnly seat cookie (HMAC over game id + seat + nonce). Seat is
  then locked. Reconnects with the cookie resume; anyone else sees
  "This game is already in progress." Guests provide a display name only.
- Creator's own seat is bound the same way (cookie or user session).

### 5.4 Realtime protocol

- WebSocket at `/ws`, JSON messages.
- Client → server: `join`, `roll`, `move`, `double`, `take`, `drop`,
  `resign`, `chat`, `ping`.
- Server → client: `snapshot` (full state, on connect/reconnect), `state`
  (delta after each accepted action), `rejected` (with reason code),
  `chat`, `game_over`.
- Server owns the position, rolls dice from the stored seed, validates with
  `bg-node`, rejects illegal actions. Clients never decide.
- Disconnect: opponent sees "reconnecting"; game waits. With a clock on, the
  absent player's clock runs and they forfeit on expiry. Without a clock, no
  forfeit; either player may abandon after 24 h idle (game recorded as
  abandoned, no rating effect).

### 5.5 Persistence (Prisma + PostgreSQL 16)

Core tables:

- `User` (id, email, displayName, locale, theme, clockPref, role
  member|admin, createdAt)
- Auth.js tables (`Account`, `Session`, `VerificationToken`)
- `Game` (id, token, format, matchLength, clockConfig, botLevel?, seed,
  status created|active|finished|abandoned, result, moveLog JSON, createdAt,
  finishedAt)
- `GameSeat` (gameId, seat 0|1, userId?, guestName?, seatSecretHash)
- `ChatMessage` (gameId, seat, text, sentAt)
- `League` (id, name, matchLength, startsAt, endsAt, createdBy)
- `LeagueMember` (leagueId, userId, joinedAt)
- `RatingHistory` (userId, gameId, rating, rd, volatility, at)

Finished games are immutable. Bot-game records posted from the browser are
re-verified server-side (replay seed + move log through `bg-node`) before
being stored as finished.

### 5.6 Accounts and roles

- Auth.js with the Email provider (magic link) via Resend. No passwords.
- Roles: `member`, `admin`. Admin is assigned by matching `ADMIN_EMAIL`
  from the environment at first login; no UI to grant admin.
- Guest → member: a guest can claim their guest games into a new account only
  from the same browser while the seat cookies are valid.

### 5.7 Leagues and scoreboard

- League: name, match length, start/end, member list (admin-managed).
- A finished member-vs-member game counts for every league both players share
  whose window contains the game's finish time and whose match length equals
  the game's format.
- Standings: 2 points for a match win, 0 for a loss; tie-breakers in order:
  head-to-head, point differential, fewer matches played, rating. Computed,
  never stored by hand.
- Global rating: Glicko-2, updated at game finish, member-vs-member only.
  Bot and guest games never affect ratings but appear in personal history.
- Public scoreboard: members by rating with games played and last-5 form.

### 5.8 Internationalisation

- next-intl with locale in the URL path: `/en`, `/fa`, `/tr`, `/de`, `/fr`.
- English ships first; other locales are translation files only.
- `fa` sets `dir="rtl"` on the document; all chrome mirrors (player cards,
  drawer, navigation). Board excluded.
- Latin digits everywhere numbers carry game meaning.
- Rules guide per locale: setup, movement, hitting/entering, bearing off,
  cube, match play with Crawford, reading the analysis panel. Diagrams are
  rendered by the board component from positions in the content.

## 6. Repository, protection, CI/CD, deployment

### 6.1 Repository

- Default branch `master`. Local directory initialised and pointed at the
  existing GitHub repo. `.superpowers/` ignored.

### 6.2 Branch protection (ruleset on `master`)

- Pull request required; 1 approval; code-owner review required
  (`CODEOWNERS`: `* @alipirouzi`); dismiss stale approvals on push.
- Required status checks: every CI job.
- Block force pushes and deletions.
- **No bypass actors, including repository admins.**

### 6.3 GitHub App (PR authorship)

- Registered by Ali under his account. Permissions: Contents (write), Pull
  requests (write), Metadata (read). Installed on this repo only.
- App ID and private key stored as repo secrets; workflows mint short-lived
  installation tokens. Claude opens PRs as the app so Ali can approve.

### 6.4 CI (`ci.yml`, every PR and push)

- `engine`: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`;
  build `bg-wasm` and `bg-node`; parity tests.
- `web`: lint, typecheck, unit tests with coverage threshold, `next build`,
  Playwright e2e including screenshot matrix (3 themes × LTR/RTL × 3
  breakpoints).
- All jobs are required checks.

### 6.5 Deploy (`deploy.yml`, on CI success on `master`)

- Build the image in CI (host cannot build). `docker save | gzip | ssh` to
  the restricted deploy user, whose forced command loads the image, runs
  `docker compose up -d` in `/opt/backgammon`, reloads Caddy, prunes images.
- Post-deploy verification: `https://backgammon.automated.ink/health` returns
  200 and `/` contains the board mount, within 3 minutes, else the run fails.
- Concurrency group `deploy`, no cancel-in-progress.

### 6.6 Deploy identity

- Host user `deploy-backgammon`, in `docker` group, `authorized_keys` entry
  `command="/usr/local/bin/backgammon-deploy",restrict`. Verified during
  setup that arbitrary commands are ignored.

### 6.7 Caddy

- `/opt/caddy/Caddyfile` becomes:
  ```
  import /etc/caddy/sites/*.caddy
  ```
  with the sites directory mounted into the Caddy container.
- `sites/time.caddy` and `sites/paraphe.caddy` are created once by hand from
  the current blocks. `sites/backgammon.caddy` is shipped by this repo:
  ```
  backgammon.automated.ink {
      handle /ws* { reverse_proxy backgammon-realtime:4000 }
      reverse_proxy backgammon-app:3000
  }
  ```
- Clinic repo PR: its deploy writes `deploy/paraphe.caddy` to
  `/opt/caddy/sites/` instead of overwriting the whole Caddyfile. Ali
  approves.

### 6.8 Secrets

- Host only (`/opt/backgammon/.env`): `POSTGRES_PASSWORD`, `AUTH_SECRET`,
  `RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_EMAIL`, `SEAT_SECRET`.
- Repo secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`,
  `GH_APP_ID`, `GH_APP_PRIVATE_KEY`.
- No credentials in code or compose files.

### 6.9 Host budget

- Added: one Next.js process, one realtime process, one Postgres. Expected
  < 1 GB RAM total. Disk at 71 % with 11 GB free; deploy prunes old images;
  README notes the trend and the absence of verified backups.

## 7. Testing

- **Engine:** property tests (every generated play legal; every legal play
  generated, against a slow reference generator); golden tests for bear-off,
  bar entry, larger-die rule; cube/match-equity tables against published
  values; seed + move log replay determinism; WASM/native parity.
- **Web unit:** board model, seat claiming, Glicko-2 updates, league
  standings and tie-breakers, i18n message completeness.
- **E2E (Playwright):** bot game to completion; invite claimed by a second
  browser context and a third context rejected; magic-link login (mail
  provider faked in CI); league standings after a result; theme persistence;
  RTL and theme screenshot matrix.
- **Deploy:** live health check is part of the pipeline.

## 8. Error handling

- Realtime: reconnecting state and snapshot resume; illegal messages rejected
  with a reason code and logged server-side; no silent drops.
- Auth: expired or reused magic links and expired seat cookies produce plain
  localised explanations with a next step.
- Bot-game record verification failure: record rejected, user told the game
  could not be saved, event logged.
- No fallback that hides a failure.

## 9. Delivery order

Each piece gets its own spec, implementation plan, and PRs approved by Ali.

1. **Foundation:** repo init, ruleset, GitHub App, CODEOWNERS, CI skeleton,
   deploy user + forced command, Caddy import restructure, clinic PR,
   placeholder page live at the domain with health endpoint.
2. **Engine:** Rust crates, club bot, analysis output, WASM and native
   bindings, parity tests.
3. **Play:** board, three themes, bot games, analysis drawer, post-game
   review, record verification.
4. **Multiplayer:** invite links, seat claiming, realtime process, chat,
   optional clocks.
5. **Members:** magic link, profiles, leagues, Glicko-2, scoreboard.
6. **Languages:** fa/tr/de/fr translations, RTL, rules guide.

## 10. Out of scope (for now)

Spectators, tournaments beyond leagues, world-class neural evaluator
(interface is ready), native mobile apps, social login, voice or video.
