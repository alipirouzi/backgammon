// Invite → claim against a real PostgreSQL with the generated Prisma client,
// including the race the mocked tests cannot show: two concurrent claims of
// the same invite, exactly one of which wins (`UPDATE … WHERE seatSecretHash
// IS NULL`). Runs only when DATABASE_URL is set; skipped otherwise.
//
//   docker compose -f web/docker-compose.dev.yml up -d --wait
//   export DATABASE_URL=postgresql://backgammon:dev@127.0.0.1:5439/backgammon
//   pnpm --filter web prisma:migrate:deploy
//   pnpm --filter web test tests/server-invites.integration.test.ts
//
// Every row it creates is deleted again in `afterAll`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultRules } from "../src/game/record";
import { hashSeatSecret, verifySeat } from "../src/realtime/auth";
import { disconnectDb, getDb } from "../src/server/db";
import { claimSeat, createInvite, getInvite, type ClaimedSeat } from "../src/server/invites";

const enabled = Boolean(process.env.DATABASE_URL);

// Under CI a skip would hide a missing database: the `web` job provides one.
if (!enabled && process.env.CI) {
  throw new Error("server-invites.integration: DATABASE_URL is not set; CI must provide a PostgreSQL service (see .github/workflows/ci.yml)");
}

const isClaimed = (result: ClaimedSeat | "taken" | "notFound"): result is ClaimedSeat => typeof result !== "string";

describe.skipIf(!enabled)("invites against PostgreSQL (DATABASE_URL set)", () => {
  const created: string[] = [];

  beforeAll(async () => {
    // Fail with a clear message when the migrations have not been applied.
    await getDb().chatMessage.count();
  });

  afterAll(async () => {
    if (created.length > 0) {
      await getDb().game.deleteMany({ where: { id: { in: created } } });
    }
    await disconnectDb();
  });

  it("stores a created game with one claimed and one open seat", async () => {
    const invite = await createInvite({ format: "match", matchLength: 3, creatorSide: "white", creatorName: "Host" });
    created.push(invite.gameId);

    const row = await getDb().game.findUniqueOrThrow({ where: { id: invite.gameId }, include: { seats: { orderBy: { seat: "asc" } } } });
    expect(row).toMatchObject({ token: invite.token, format: "match", matchLength: 3, status: "created", botLevel: null, result: null, finishedAt: null });
    expect(Number.isSafeInteger(Number(row.seed))).toBe(true);
    expect(row.moveLog).toEqual({ seed: Number(row.seed), length: 3, rules: defaultRules(3), turns: [] });
    expect(row.seats.map((s) => [s.seat, s.guestName, s.seatSecretHash])).toEqual([
      [0, "Host", hashSeatSecret(invite.secret)],
      [1, null, null],
    ]);
    await expect(verifySeat(getDb(), invite.gameId, 0, invite.secret)).resolves.toBe(true);
    await expect(getInvite(invite.token)).resolves.toEqual({ gameId: invite.gameId, status: "created", format: "match", matchLength: 3, openSeat: 1, names: ["Host", null] });
  });

  it("lets exactly one of two concurrent claims win, then the game is active", async () => {
    const invite = await createInvite({ format: "single", matchLength: 0, creatorSide: "black", creatorName: "Host" });
    created.push(invite.gameId);
    expect(invite.seat).toBe(1);

    const results = await Promise.all([claimSeat({ token: invite.token, name: "Guest A" }), claimSeat({ token: invite.token, name: "Guest B" })]);
    const winners = results.filter(isClaimed);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r === "taken")).toHaveLength(1);
    const [winner] = winners;
    expect(winner).toMatchObject({ gameId: invite.gameId, seat: 0 });

    const row = await getDb().game.findUniqueOrThrow({ where: { id: invite.gameId }, include: { seats: { orderBy: { seat: "asc" } } } });
    expect(row.status).toBe("active");
    expect(row.seats.map((s) => s.seatSecretHash)).toEqual([hashSeatSecret(winner.secret), hashSeatSecret(invite.secret)]);
    expect(["Guest A", "Guest B"]).toContain(row.seats[0].guestName);

    // Both seats verify with their own secret only.
    await expect(verifySeat(getDb(), invite.gameId, 0, winner.secret)).resolves.toBe(true);
    await expect(verifySeat(getDb(), invite.gameId, 1, invite.secret)).resolves.toBe(true);
    await expect(verifySeat(getDb(), invite.gameId, 0, invite.secret)).resolves.toBe(false);
    await expect(verifySeat(getDb(), invite.gameId, 1, winner.secret)).resolves.toBe(false);

    // A third visitor is told the game is taken; the token still resolves for the cookie check.
    await expect(claimSeat({ token: invite.token, name: "Guest C" })).resolves.toBe("taken");
    await expect(getInvite(invite.token)).resolves.toMatchObject({ gameId: invite.gameId, status: "active", openSeat: null });
  });

  it("is notFound for a token nobody issued", async () => {
    await expect(claimSeat({ token: "AAAAAAAAAAAAAAAAAAAAAA", name: "Guest" })).resolves.toBe("notFound");
    await expect(getInvite("AAAAAAAAAAAAAAAAAAAAAA")).resolves.toBeNull();
  });

  it("cascades chat messages with the game", async () => {
    const invite = await createInvite({ format: "single", matchLength: 0, creatorSide: "white", creatorName: "Host" });
    await getDb().chatMessage.create({ data: { gameId: invite.gameId, seat: 0, text: "hello" } });
    expect(await getDb().chatMessage.count({ where: { gameId: invite.gameId } })).toBe(1);
    await getDb().game.delete({ where: { id: invite.gameId } });
    expect(await getDb().chatMessage.count({ where: { gameId: invite.gameId } })).toBe(0);
  });
});
