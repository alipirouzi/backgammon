# Multiplayer Implementation Plan (piece 4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.
>
> **Plan format:** interface contracts, message formats, invariants, test oracles and acceptance commands per task. THE CODE ON DISK WINS where it differs from this plan's assumptions about PR D/E (read `web/src/game/store.ts`, `selectors.ts`, `record.ts`, `local-games.ts`, `persist.ts`, `web/src/server/**`, `web/prisma/schema.prisma`, `web/src/engine/node.ts`).

**Goal:** A person creates a game with an invite link, sends it to one other person, and the two play a single game or a match in real time from two browsers, with in-game chat. The first visitor claims the seat and only that visitor can reconnect. The server owns the position, rolls the dice from a stored seed, validates every action with the engine, persists every turn, and stores the finished game like a bot game so the review page works for it.

**Architecture:** A second Node process `realtime` (same Docker image, different command) serves WebSockets at `/ws` behind Caddy. It keeps one authoritative `GameSession` per active game in memory, backed by Postgres (`Game.moveLog` updated after every accepted action) so a restart resumes every game from its record. The rules engine runs in the realtime process through the **wasm package in Node** (`web/src/engine/node.ts`), not the native addon: identical results by parity tests, no native build in the image. The browser reuses the existing board, table, drawer and store; the store gains a `RemoteGame` transport that sends actions and applies server snapshots instead of calling the engine.

**Tech Stack:** Node 22, `ws` 8, Fastify NOT used (plain `http` + `ws` keeps the process tiny), zod for message validation, Prisma (shared schema), HMAC-SHA256 seat cookies via `node:crypto`, Vitest, Playwright with two browser contexts.

**Spec:** §5.3 (creation and seat claiming), §5.4 (realtime protocol), §5.5 (Game, GameSeat, ChatMessage), §8 (errors), §6.7 (Caddy `/ws`).

## Global Constraints

- Two PRs: **F** server and protocol (Tasks 1–5, branch `claude/mp-server`), **G** client, chat, e2e, deploy (Tasks 6–10, branch `claude/mp-client`). Clocks are **PR H** (Task 11), separate and last; everything before it works without clocks.
- Host prerequisites (orchestrator, before PR G merges): extend `/usr/local/bin/backgammon-deploy` allowlist `ALLOWED_SERVICES` to `app`, `postgres`, `realtime`; the Caddy snippet gains `handle /ws* { reverse_proxy backgammon-realtime:4000 }` (the deploy script's structural check allows nested braces; no quotes). Add `SEAT_SECRET` to `/opt/backgammon/.env` (32 random bytes hex, generated on the host, never printed).
- Required CI checks stay `engine` and `web`. The `web` job's Postgres service already exists.
- No secrets in code. `SEAT_SECRET` and `DATABASE_URL` are required at realtime start (fail fast).
- Bot games are untouched: `local-<seed>` ids keep the browser-only path. Remote games use server ids (`cuid`) and the URL `/g/<token>` for the invite, `/play/<gameId>` for both seats once claimed.

---

## Domain conventions (binding)

**Ids and tokens.** `Game.id` cuid. Invite token: 16 random bytes, base64url (22 chars), stored in `Game.token` (unique), valid until both seats are claimed; afterwards the URL `/g/<token>` shows "This game is already in progress" unless the visitor holds a seat cookie for that game.

**Seats.** Seat 0 = White = creator, seat 1 = Black = invitee (creator can choose to be Black at creation; then seats swap). Each seat has a `seatSecret` (32 random bytes) whose SHA-256 is stored in `GameSeat.seatSecretHash`. The browser receives the secret in an `HttpOnly; Secure; SameSite=Lax; Path=/` cookie `bg_seat_<gameId>=<seat>.<secret>` (max-age 30 days). The server authenticates a WebSocket by reading that cookie during the upgrade and comparing hashes with constant-time equality. Guests give a display name (1–40 chars, trimmed) when claiming; stored in `GameSeat.guestName`.

**Game rules for remote games.** `Rules` as for bot games (money: Jacoby on; match: off), format chosen by the creator (single or match to 1–25), cube allowed per engine rules, no beavers, no automatic doubles. Dice come from the record seed via replay, exactly as bot games: the server appends the roll turn with the dice it derived (using `web/src/game/dice.ts`'s `DiceRng` port) and re-verifies with `replay`.

**Protocol** (JSON text frames; every client→server message has a client-generated `id` for acknowledgement). *Revised 2026-09-21 after the PR F review — this block supersedes the earlier wording; `web/src/realtime/protocol.ts` is the executable form:*

```ts
// client → server. `id` doubles as an idempotency key: the server remembers a seat's last 50 ids with their
// answers and repeats the stored ack/rejected for a resend without acting again — so ids must be unique per
// seat across reconnects AND page reloads (crypto.randomUUID(), never a counter that restarts at 1).
type ClientMsg =
 | { id: string; type: 'join' }                                 // after upgrade; server answers snapshot then ack (never replayed from memory)
 | { id: string; type: 'roll' } | { id: string; type: 'double' } | { id: string; type: 'take' } | { id: string; type: 'drop' }
 | { id: string; type: 'move'; play: string }                   // notation relative to the mover
 | { id: string; type: 'resign'; kind: 'single'|'gammon'|'backgammon' }   // an OFFER from the player on roll: nothing is conceded yet
 | { id: string; type: 'acceptResign' } | { id: string; type: 'declineResign' }   // the opponent's answer to the offer
 | { id: string; type: 'nextGame' }                             // between games of a match; either seat may send; the game starts when both have sent or after 30 s
 | { id: string; type: 'chat'; text: string }                   // 1–500 chars
 | { id: string; type: 'ping' }                                 // answered with pong, no ack
// server → client
type WireRecord = Omit<Record, 'seed'> & { seed?: number }      // the seed is ABSENT while status is created/active (the dice stream follows from it) and present once finished/abandoned
type ResignOffer = { seat: 0|1; kind: 'single'|'gammon'|'backgammon'; points: number }   // points priced by the server's rules (cube, Jacoby), never by the client
type ServerMsg =
 | { type: 'snapshot'; game: { id; seat: 0|1; status: 'created'|'active'|'finished'|'abandoned'; record: WireRecord; match: MatchState; seats: SeatInfo[];
                              awaitingNextGame: boolean; nextGame: { votes: [boolean, boolean]; startsAt: number | null }; resignOffer: ResignOffer | null;
                              presence: [boolean, boolean]; chat: ChatLine[] } }   // finished/abandoned sessions are read-only (chat still works); votes, deadline and offer live in server memory only
 | { type: 'state'; record: WireRecord; match: MatchState; awaitingNextGame: boolean; lastTurnIndex: number }   // after every accepted action, to both seats
 | { type: 'ack'; id: string }
 | { type: 'rejected'; id: string; code: 'notYourTurn'|'illegal'|'wrongPhase'|'invalid'|'rateLimited'|'gameOver'; message: string }
 | { type: 'chat'; line: ChatLine }                             // ChatLine = { seat, name, text, at }
 | { type: 'presence'; presence: [boolean, boolean] }
 | { type: 'gameOver'; result: GameResult; matchOver: boolean }
 | { type: 'resignOffered'; offer: ResignOffer }                // broadcast after `resign` is acked
 | { type: 'resignCleared'; offer: ResignOffer; reason: 'declined' | 'withdrawn' }   // `declined` on declineResign; `withdrawn` precedes the state of any accepted game action by the offerer
 | { type: 'pong' }
```
Resignation flow: `resign { kind }` → ack to the offerer + `resignOffered` to both; `acceptResign` → ack, `state`, `gameOver` (the resign turn is appended with the offered points); `declineResign` → ack + `resignCleared declined`; a repeated `resign` replaces the offer. Validation: zod schemas for every message; unknown types → `rejected invalid`; more than 20 messages per 10 s **per seat** (all its sockets together) → `rateLimited`; at most 4 open sockets per seat — a fifth closes the oldest with code 4001 "too many connections"; frames over 8 KiB closed with code 1009. Upgrade: 403 when the `Origin` header is not on `ALLOWED_ORIGINS` (a handshake without `Origin` is accepted outside `NODE_ENV=production` only), then 401 without a valid seat cookie. Between the games of a match the next game starts when both have voted or 30 s after the first vote; should the store refuse that opening roll the server retries after 5 s, 10 s and 20 s and, those spent, again on the next frame from either seat (snapshot `nextGame.startsAt` says when).

**Authority.** The server never trusts client positions. `move` is checked with `legal_plays` for the current dice; cube actions with `can_double` semantics from the engine's `MatchState` phase; every accepted action is appended to the record, re-verified by `replay`, persisted (`Game.moveLog`, `status`), and broadcast as `state`. On finish the server writes `result`, `finishedAt`, `status finished` (the same row shape the review page reads).

**Persistence additions.** `Game.status` gains `created | active | finished | abandoned` semantics for remote games; new model `ChatMessage { id, gameId, seat, text, createdAt }` with index `(gameId, createdAt)`. `GameSeat.userId` stays null (members are piece 5).

**Idle and abandonment (no clock).** Presence is tracked per seat. If a game has no action for 24 h it becomes `abandoned` (a periodic sweep in the realtime process, every 10 min); an abandoned game is read-only and shows "This game was abandoned". Either player may abandon explicitly via a "Leave game" action which resigns the current game if the opponent has acted in the last 5 min, otherwise marks abandoned without a result (no rating effect; ratings are piece 5).

**Routes.** `/play/new` gains "Invite a friend" (format, side, your name) → `POST /api/games/invite` → `{ gameId, inviteUrl }` and sets the creator's seat cookie → redirects to `/play/<gameId>` which shows the invite panel (copyable link, waiting state) until the opponent joins. `/g/<token>`: claim page (name field) → `POST /api/games/<id>/claim` → cookie → redirect `/play/<gameId>`. Existing `/play/[gameId]` detects remote ids (non-`local-`) and mounts the remote transport. `/review/<gameId>` works for finished remote games through the existing server loader.

---

## File structure

```
web/src/realtime/
├── server.ts             http + ws server, upgrade auth, routing, graceful shutdown (SIGTERM), /healthz
├── session.ts            GameSession: in-memory authoritative state, action handlers, broadcast, persistence hooks
├── sessions.ts           registry: load-or-create per gameId from Postgres, eviction after finish/idle, sweep
├── protocol.ts           zod schemas for ClientMsg/ServerMsg (shared with the browser via web/src/realtime/protocol.ts import)
├── auth.ts               seat cookie parse/verify, HMAC helpers (also used by the API routes)
├── limits.ts             per-socket message rate limit, frame size
└── main.ts               entry: env validation, prisma, listen on PORT (4000)
web/src/server/invites.ts createInvite, claimSeat (used by API routes)
web/src/app/api/games/invite/route.ts, web/src/app/api/games/[id]/claim/route.ts, web/src/app/g/[token]/page.tsx
web/src/game/remote.ts    RemoteGame transport (WebSocket client, reconnect with backoff, message queue) feeding the store
web/src/game/store.ts     mode: 'local' | 'remote'; remote actions delegate to the transport; snapshots/state apply to match/record
web/src/components/invite/ InvitePanel.tsx (link, copy, waiting), ClaimForm.tsx
web/src/components/chat/  ChatTab.tsx (the Chat tab of the drawer), chat.css
web/prisma/migrations/<ts>_chat_and_invites/
web/scripts/realtime-entrypoint.sh (migrations are applied by the app entrypoint; realtime only waits for the DB)
deploy/docker-compose.prod.yml  + service realtime (image backgammon:current, command node web/realtime.js, env DATABASE_URL SEAT_SECRET, networks edge+internal, healthcheck /healthz)
deploy/backgammon.caddy        + handle /ws* { reverse_proxy backgammon-realtime:4000 }
Dockerfile                      builds web/src/realtime with esbuild (or tsc) into web/realtime.js alongside the standalone output
web/tests/realtime/*.test.ts, web/e2e/multiplayer.spec.ts (two contexts), web/e2e/helpers/remote.ts
```

---

# PR F — realtime server and protocol

### Task 1: Schema, seat auth, invites
Files: `web/prisma/schema.prisma` (+ChatMessage, Game.status values, indexes), migration, `web/src/realtime/auth.ts`, `web/src/server/invites.ts`, tests. Contracts: `createSeatSecret(): { secret, hash }`, `seatCookieName(gameId)`, `parseSeatCookie(header, gameId) → { seat, secret } | null`, `verifySeat(db, gameId, seat, secret) → boolean` (constant-time), `createInvite({ format, matchLength, creatorSide, creatorName }) → { gameId, token, seat, secret }`, `claimSeat({ token, name }) → { gameId, seat, secret } | 'taken' | 'notFound'` (atomic: `UPDATE ... WHERE seatSecretHash IS NULL` guards the race). Golden tests: second claimant gets `taken`; wrong secret fails; cookie parsing tolerant of other cookies.

### Task 2: Protocol schemas and GameSession
Files: `web/src/realtime/protocol.ts`, `session.ts`, tests with the real wasm engine (Node loader). `GameSession.handle(seat, msg) → { reply: ServerMsg[], broadcast: ServerMsg[] }` pure with respect to sockets; persistence via an injected `store` interface (`saveTurns(gameId, record, status, result?)`, `saveChat`). Oracle: drive two seats through a full seeded game and a 3-point match (using the same move-picking helper as the e2e), assert the resulting record replays to the same `MatchState` and matches what a bot-game store would produce for the same actions; reject matrix: move out of turn, illegal notation, double when not allowed, chat too long, unknown type.

### Task 3: Sessions registry, persistence, sweep
Files: `sessions.ts`, tests with Prisma mocked + integration test against the dev DB (skipped without `DATABASE_URL`). Load from DB by replaying `moveLog`; evict finished sessions after 60 s; abandonment sweep; single-flight per gameId.

### Task 4: WebSocket server
Files: `server.ts`, `limits.ts`, `main.ts`, tests using `ws` clients against an in-process server on an ephemeral port: upgrade rejected without a valid seat cookie (401), join → snapshot, action → ack + state to both, presence on connect/disconnect, ping/pong, rate limit, oversize frame close, graceful shutdown closes with 1001. `/healthz` → 200 when DB reachable.

### Task 5: Build, image, compose, gate (PR F)
Files: `web/package.json` (scripts `realtime:build` via esbuild bundle to `web/realtime.js` with `bg-wasm` external and copied, `realtime:start`), `Dockerfile` (build and copy `web/realtime.js` + its runtime files into the image; the same image serves both commands), `deploy/docker-compose.prod.yml` (+realtime service with healthcheck `wget -qO- http://127.0.0.1:4000/healthz`), `deploy/backgammon.caddy` (+/ws handle), README. Gate: unit + integration tests, Docker build, a local compose with app + realtime + postgres: two `ws` clients (Node script in the scratchpad) play a few moves through the container. The host allowlist change is the orchestrator's (Global Constraints).

# PR G — client, chat, e2e

### Task 6: Remote transport and store mode
Files: `web/src/game/remote.ts`, `store.ts` (mode), tests with a fake WebSocket. Reconnect with exponential backoff (1 s → 30 s), resend of the pending action on reconnect only if not acked, snapshot replaces local state, `ui.busy` while awaiting ack, `rejected` → `ui.lastError` with the server message, `presence` → player card "away" state.

### Task 7: Invite flow UI
Files: `app/play/new` (Invite a friend), `components/invite/*`, `app/g/[token]/page.tsx`, API routes for invite and claim, tests. Copy-link button with clipboard API and fallback; QR not needed.

### Task 8: Table integration and chat
Files: `TableLayout.tsx` (remote: names from seats, presence, "Leave game", invite panel while waiting; analysis drawer default OFF in human games per spec §5.2), `components/chat/*` (Chat tab enabled for remote games; unread badge; Enter to send; messages escaped; 500-char limit), tests.

### Task 9: Two-browser e2e and gate (PR G)
Files: `web/e2e/multiplayer.spec.ts`: context A creates an invite (seeded via a test-only header `X-Test-Seed` accepted only when `NODE_ENV !== 'production'`), context B claims, both play a single game to completion using the shared move helper, chat both ways, a third context gets "already in progress", reload of B resumes with the cookie; review page opens for the finished game. Playwright `webServer` starts both `next start` and the realtime process (array form). CI: the web job runs the realtime process against the service DB. Gate + Docker compose smoke with two ws clients + README.

### Task 10: Deploy (orchestrator)
Host: allowlist edit, `SEAT_SECRET` in `.env`, verify snippet passes `check_caddy_snippet` locally by sourcing the script. Merge → deploy → verify: `wss://backgammon.automated.ink/ws` upgrade returns 403 without an `Origin` header and 401 with `Origin: https://backgammon.automated.ink` but no cookie; a real two-browser game on the live site.

# PR H — optional clocks (Task 11)
Bronstein clock per game: reserve minutes + per-move seconds chosen at creation; server-side timing with `Date` only in the realtime process; `state` carries `clock: { remainingMs: [a, b], turnStartedAt }`; expiry forfeits the game (single) or the match per spec §5.4; player cards show the clock; e2e with a 5-second reserve.

## Self-review
Spec §5.3 creation and seat claim → Tasks 1, 7. §5.4 protocol, authority, disconnect handling → Tasks 2, 4, 6 (forfeit-on-clock deferred to H exactly as the spec conditions it on a clock). §5.5 ChatMessage, GameSeat → Task 1, 8. §6.7 `/ws` → Task 5. §8 errors → Tasks 2, 6. Deviation from spec §3.1/§4.6: the realtime process uses the wasm package instead of the native addon (identical results by parity tests; no native build in the image) — bg-node remains built and tested in CI for later.
