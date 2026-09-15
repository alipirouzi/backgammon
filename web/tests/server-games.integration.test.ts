// Round trip through a real PostgreSQL: verifyAndStore → getGame with the
// generated Prisma client. Runs only when DATABASE_URL is set (and bg-wasm
// is built); skipped otherwise, so the default `pnpm test` needs no database.
//
//   docker compose -f web/docker-compose.dev.yml up -d --wait     # postgres:16-alpine on 127.0.0.1:5439
//   export DATABASE_URL=postgresql://backgammon:dev@127.0.0.1:5439/backgammon
//   pnpm --filter web prisma:migrate:deploy      # applies prisma/migrations (`pnpm --filter web typecheck` generates the client)
//   pnpm --filter web test tests/server-games.integration.test.ts
//
// Every row it creates is deleted again in `afterAll`.

import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEngineNode, locateBgWasmPkg } from "../src/engine/node";
import type { Record as GameRecord } from "../src/engine/types";
import { disconnectDb, getDb } from "../src/server/db";
import { GameNotFinished, getGame, verifyAndStore, type SeatsInput } from "../src/server/games";

function fixture(name: string): GameRecord {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as GameRecord;
}

const single = fixture("finished-record.json");
const match = fixture("finished-match-record.json");
const SEATS: SeatsInput = { white: { kind: "guest", name: "Player One" }, black: { kind: "bot", level: "intermediate" } };

const enabled = Boolean(process.env.DATABASE_URL) && locateBgWasmPkg() !== null;

// Under CI (set by GitHub Actions) a skip would hide a missing database or
// an unbuilt engine: the `web` job provides both (a postgres service
// container and `wasm-pack build` before `pnpm install`), so fail instead.
if (!enabled && process.env.CI) {
  throw new Error(
    "server-games.integration: DATABASE_URL is not set or engine/bg-wasm/pkg is not built; CI must provide a PostgreSQL service and build bg-wasm first (see .github/workflows/ci.yml)",
  );
}

describe.skipIf(!enabled)("games service against PostgreSQL (DATABASE_URL set)", () => {
  const created: string[] = [];

  beforeAll(async () => {
    // Fail with a clear message when the migrations have not been applied.
    await getDb().game.count();
  });

  afterAll(async () => {
    if (created.length > 0) {
      await getDb().game.deleteMany({ where: { id: { in: created } } });
    }
    await disconnectDb();
  });

  it("stores a finished single game and reads it back identically", async () => {
    const engine = await loadEngineNode();
    const final = engine.replay(single);

    const { id } = await verifyAndStore(single, SEATS);
    created.push(id);
    expect(id).toMatch(/^c[a-z0-9]{20,}$/);

    const game = await getGame(id);
    expect(game).not.toBeNull();
    expect(game).toMatchObject({
      id,
      format: "single",
      matchLength: 0,
      botLevel: "intermediate",
      status: "finished",
      seed: 42,
      record: single,
      result: { ...final.game.result, score: final.score },
      seats: SEATS,
    });
    expect(game?.finishedAt).toBeInstanceOf(Date);
    expect(game?.createdAt).toBeInstanceOf(Date);

    // Seats are rows of their own, cascaded from the game.
    const seats = await getDb().gameSeat.findMany({ where: { gameId: id }, orderBy: { seat: "asc" } });
    expect(seats.map((s) => [s.seat, s.guestName, s.userId])).toEqual([
      [0, "Player One", null],
      [1, null, null],
    ]);
  });

  it("stores a finished match as its own row (the same seed twice is two games)", async () => {
    const seats: SeatsInput = { white: { kind: "guest", name: "Player Two" }, black: { kind: "bot", level: "club" } };
    const a = await verifyAndStore(match, seats);
    const b = await verifyAndStore(match, seats);
    created.push(a.id, b.id);
    expect(a.id).not.toBe(b.id);

    const game = await getGame(a.id);
    expect(game).toMatchObject({ format: "match", matchLength: 5, seed: 7, botLevel: "club", seats });
    expect(game?.result?.score[game.result.winner]).toBeGreaterThanOrEqual(5);
  });

  it("does not write anything for an unfinished game", async () => {
    const before = await getDb().game.count();
    await expect(verifyAndStore({ ...single, turns: single.turns.slice(0, 30) }, SEATS)).rejects.toBeInstanceOf(GameNotFinished);
    expect(await getDb().game.count()).toBe(before);
  });

  it("getGame is null for an unknown id", async () => {
    await expect(getGame("does-not-exist")).resolves.toBeNull();
  });
});
