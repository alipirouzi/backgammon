// Invite creation and seat claiming (web/src/server/invites.ts, plan Task 1)
// with Prisma mocked: what gets written for a new invite, the swap when the
// creator picks Black, input validation, and the claim outcomes ("notFound",
// "taken", claimed) including the atomic guard `seatSecretHash IS NULL`.
// The real race is exercised in server-invites.integration.test.ts.

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_SEED } from "../src/game/dice";
import { defaultRules } from "../src/game/record";
import { INVITE_TOKEN_LENGTH, InviteInvalid, claimSeat, createInvite, getInvite, initialRecord, serverSeed, type InviteDb } from "../src/server/invites";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const db = {
  game: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  gameSeat: { updateMany: vi.fn() },
  $transaction: vi.fn(),
};
const asDb = (): InviteDb => db as unknown as InviteDb;

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

beforeEach(() => {
  db.game.create.mockReset();
  db.game.findUnique.mockReset();
  db.game.updateMany.mockReset();
  db.gameSeat.updateMany.mockReset();
  db.$transaction.mockReset();
  db.game.create.mockImplementation(async (args: { data: unknown }) => ({ id: "game_1", ...(args.data as object) }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  db.game.updateMany.mockResolvedValue({ count: 1 });
});

describe("serverSeed / initialRecord", () => {
  it("draws seeds within the engine's 2^53 - 1 bound", () => {
    for (let i = 0; i < 200; i++) {
      const seed = serverSeed();
      expect(Number.isSafeInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(MAX_SEED);
    }
  });

  it("uses the whole range, not only the low 32 bits", () => {
    const seeds = Array.from({ length: 64 }, serverSeed);
    expect(seeds.some((s) => s >= 2 ** 32)).toBe(true);
  });

  it("builds an empty record with the bot-game rules for the format", () => {
    expect(initialRecord(42, 0)).toEqual({ seed: 42, length: 0, rules: defaultRules(0), turns: [] });
    expect(initialRecord(7, 5)).toEqual({ seed: 7, length: 5, rules: { jacoby: false, beavers: false, autoDoubles: false }, turns: [] });
  });
});

describe("createInvite", () => {
  it("creates a 'created' game with the creator seated (White) and the other seat open", async () => {
    const invite = await createInvite({ format: "match", matchLength: 5, creatorSide: "white", creatorName: "  Player One " }, { db: asDb() });

    expect(invite.gameId).toBe("game_1");
    expect(invite.seat).toBe(0);
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(invite.token).toHaveLength(INVITE_TOKEN_LENGTH);
    expect(Buffer.from(invite.secret, "base64url")).toHaveLength(32);

    expect(db.game.create).toHaveBeenCalledTimes(1);
    const { data } = db.game.create.mock.calls[0][0] as { data: { [key: string]: unknown } };
    const seed = Number(data.seed as bigint);
    expect(Number.isSafeInteger(seed)).toBe(true);
    expect(data).not.toHaveProperty("result");
    expect(data).not.toHaveProperty("finishedAt");
    expect(data).toMatchObject({
      token: invite.token,
      format: "match",
      matchLength: 5,
      botLevel: null,
      status: "created",
      moveLog: initialRecord(seed, 5),
      seats: {
        create: [
          { seat: 0, userId: null, guestName: "Player One", seatSecretHash: sha256(invite.secret) },
          { seat: 1, userId: null, guestName: null, seatSecretHash: null },
        ],
      },
    });
  });

  it("seats the creator as Black when asked, leaving White open", async () => {
    const invite = await createInvite({ format: "single", matchLength: 0, creatorSide: "black", creatorName: "Player Two" }, { db: asDb() });
    expect(invite.seat).toBe(1);
    const { data } = db.game.create.mock.calls[0][0] as { data: { format: string; matchLength: number; moveLog: { length: number }; seats: { create: unknown[] } } };
    expect(data.format).toBe("single");
    expect(data.matchLength).toBe(0);
    expect(data.moveLog.length).toBe(0);
    expect(data.seats.create).toEqual([
      { seat: 0, userId: null, guestName: null, seatSecretHash: null },
      { seat: 1, userId: null, guestName: "Player Two", seatSecretHash: sha256(invite.secret) },
    ]);
  });

  it("gives every invite its own token, seed and secret", async () => {
    const a = await createInvite({ format: "single", matchLength: 0, creatorSide: "white", creatorName: "A" }, { db: asDb() });
    const b = await createInvite({ format: "single", matchLength: 0, creatorSide: "white", creatorName: "B" }, { db: asDb() });
    expect(a.token).not.toBe(b.token);
    expect(a.secret).not.toBe(b.secret);
    const seeds = db.game.create.mock.calls.map((call) => (call[0] as { data: { seed: bigint } }).data.seed);
    expect(seeds[0]).not.toBe(seeds[1]);
  });

  it.each([
    ["not an object", 42],
    ["an unknown format", { format: "money", matchLength: 0, creatorSide: "white", creatorName: "A" }],
    ["a match without a length", { format: "match", matchLength: 0, creatorSide: "white", creatorName: "A" }],
    ["a match longer than 25", { format: "match", matchLength: 26, creatorSide: "white", creatorName: "A" }],
    ["a fractional length", { format: "match", matchLength: 2.5, creatorSide: "white", creatorName: "A" }],
    ["a single game with a length", { format: "single", matchLength: 3, creatorSide: "white", creatorName: "A" }],
    ["an unknown side", { format: "single", matchLength: 0, creatorSide: "red", creatorName: "A" }],
    ["an empty name", { format: "single", matchLength: 0, creatorSide: "white", creatorName: "   " }],
    ["a name over 40 characters", { format: "single", matchLength: 0, creatorSide: "white", creatorName: "x".repeat(41) }],
    ["a missing name", { format: "single", matchLength: 0, creatorSide: "white" }],
  ])("rejects %s with InviteInvalid and writes nothing", async (_label, input) => {
    await expect(createInvite(input, { db: asDb() })).rejects.toBeInstanceOf(InviteInvalid);
    expect(db.game.create).not.toHaveBeenCalled();
  });

  it("InviteInvalid is an Error with a stable name", () => {
    const error = new InviteInvalid("bad");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("InviteInvalid");
    expect(error.message).toBe("bad");
  });
});

describe("claimSeat", () => {
  const openGame = { id: "game_1", status: "created", seats: [{ seat: 0, seatSecretHash: "h" }, { seat: 1, seatSecretHash: null }] };

  it("is notFound for an unknown token without touching the seats", async () => {
    db.game.findUnique.mockResolvedValue(null);
    await expect(claimSeat({ token: TOKEN, name: "Guest" }, { db: asDb() })).resolves.toBe("notFound");
    expect(db.game.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { token: TOKEN } }));
    expect(db.gameSeat.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["too short", "abc"],
    ["too long", `${TOKEN}A`],
    ["not base64url", "AAAAAAAAAAAAAAAAAAAA+/"],
    ["not a string", 42],
  ])("is notFound for a malformed token (%s) without a database query", async (_label, token) => {
    await expect(claimSeat({ token, name: "Guest" }, { db: asDb() })).resolves.toBe("notFound");
    expect(db.game.findUnique).not.toHaveBeenCalled();
  });

  it("claims the open seat atomically and activates the game", async () => {
    db.game.findUnique.mockResolvedValue(openGame);
    db.gameSeat.updateMany.mockResolvedValue({ count: 1 });

    const result = await claimSeat({ token: TOKEN, name: " Guest Two " }, { db: asDb() });

    expect(result).not.toBeTypeOf("string");
    if (typeof result === "string") {
      throw new Error("unreachable");
    }
    expect(result.gameId).toBe("game_1");
    expect(result.seat).toBe(1);
    expect(Buffer.from(result.secret, "base64url")).toHaveLength(32);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.gameSeat.updateMany).toHaveBeenCalledWith({
      where: { gameId: "game_1", seat: 1, seatSecretHash: null },
      data: { seatSecretHash: sha256(result.secret), guestName: "Guest Two" },
    });
    expect(db.game.updateMany).toHaveBeenCalledWith({ where: { id: "game_1", status: "created" }, data: { status: "active" } });
  });

  it("claims White when the creator took Black", async () => {
    db.game.findUnique.mockResolvedValue({ ...openGame, seats: [{ seat: 0, seatSecretHash: null }, { seat: 1, seatSecretHash: "h" }] });
    db.gameSeat.updateMany.mockResolvedValue({ count: 1 });
    const result = await claimSeat({ token: TOKEN, name: "Guest" }, { db: asDb() });
    expect(result).toMatchObject({ seat: 0 });
    expect(db.gameSeat.updateMany.mock.calls[0][0]).toMatchObject({ where: { seat: 0, seatSecretHash: null } });
  });

  it("is taken, and the claim rolled back, when the game stopped being 'created' meanwhile (the sweep abandoned it)", async () => {
    db.game.findUnique.mockResolvedValue({ id: "game_1", status: "created", seats: [{ seat: 0, seatSecretHash: "h0" }, { seat: 1, seatSecretHash: null }] });
    db.gameSeat.updateMany.mockResolvedValue({ count: 1 });
    db.game.updateMany.mockResolvedValue({ count: 0 });
    // The interactive transaction rejects with whatever the callback throws: that is the rollback.
    const outcomes: ("committed" | "rolled back")[] = [];
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        const result = await fn(db);
        outcomes.push("committed");
        return result;
      } catch (error) {
        outcomes.push("rolled back");
        throw error;
      }
    });
    await expect(claimSeat({ token: TOKEN, name: "Guest" }, { db: asDb() })).resolves.toBe("taken");
    expect(outcomes).toEqual(["rolled back"]);
    expect(db.game.updateMany).toHaveBeenCalledWith({ where: { id: "game_1", status: "created" }, data: { status: "active" } });
  });

  it("lets a database failure inside the transaction propagate", async () => {
    db.game.findUnique.mockResolvedValue({ id: "game_1", status: "created", seats: [{ seat: 0, seatSecretHash: "h0" }, { seat: 1, seatSecretHash: null }] });
    db.gameSeat.updateMany.mockRejectedValue(new Error("connection lost"));
    await expect(claimSeat({ token: TOKEN, name: "Guest" }, { db: asDb() })).rejects.toThrow("connection lost");
  });

  it("is taken when the guarded update matches no row (a concurrent claim won)", async () => {
    db.game.findUnique.mockResolvedValue(openGame);
    db.gameSeat.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimSeat({ token: TOKEN, name: "Guest" }, { db: asDb() })).resolves.toBe("taken");
    expect(db.game.updateMany).not.toHaveBeenCalled();
  });

  it.each(["active", "finished", "abandoned"])("is taken once the game is %s", async (status) => {
    db.game.findUnique.mockResolvedValue({ ...openGame, status, seats: [{ seat: 0, seatSecretHash: "h" }, { seat: 1, seatSecretHash: "h" }] });
    await expect(claimSeat({ token: TOKEN, name: "Guest" }, { db: asDb() })).resolves.toBe("taken");
    expect(db.gameSeat.updateMany).not.toHaveBeenCalled();
  });

  it("is taken when a 'created' game has no open seat left", async () => {
    db.game.findUnique.mockResolvedValue({ ...openGame, seats: [{ seat: 0, seatSecretHash: "h" }, { seat: 1, seatSecretHash: "h" }] });
    await expect(claimSeat({ token: TOKEN, name: "Guest" }, { db: asDb() })).resolves.toBe("taken");
    expect(db.gameSeat.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty name", { token: TOKEN, name: "  " }],
    ["a name over 40 characters", { token: TOKEN, name: "x".repeat(41) }],
    ["a missing name", { token: TOKEN }],
    ["not an object", null],
  ])("rejects %s with InviteInvalid before any query", async (_label, input) => {
    await expect(claimSeat(input, { db: asDb() })).rejects.toBeInstanceOf(InviteInvalid);
    expect(db.game.findUnique).not.toHaveBeenCalled();
  });
});

describe("getInvite", () => {
  it("describes the game behind a token for the claim page", async () => {
    db.game.findUnique.mockResolvedValue({
      id: "game_1",
      status: "created",
      format: "match",
      matchLength: 3,
      seats: [
        { seat: 0, guestName: "Host", seatSecretHash: "h" },
        { seat: 1, guestName: null, seatSecretHash: null },
      ],
    });
    await expect(getInvite(TOKEN, { db: asDb() })).resolves.toEqual({
      gameId: "game_1",
      status: "created",
      format: "match",
      matchLength: 3,
      openSeat: 1,
      names: ["Host", null],
    });
  });

  it("is null for an unknown or malformed token", async () => {
    db.game.findUnique.mockResolvedValue(null);
    await expect(getInvite(TOKEN, { db: asDb() })).resolves.toBeNull();
    await expect(getInvite("nope", { db: asDb() })).resolves.toBeNull();
    expect(db.game.findUnique).toHaveBeenCalledTimes(1);
  });

  it("has no open seat once both are claimed", async () => {
    db.game.findUnique.mockResolvedValue({
      id: "game_1",
      status: "active",
      format: "single",
      matchLength: 0,
      seats: [
        { seat: 0, guestName: "Host", seatSecretHash: "h" },
        { seat: 1, guestName: "Guest", seatSecretHash: "h" },
      ],
    });
    await expect(getInvite(TOKEN, { db: asDb() })).resolves.toMatchObject({ status: "active", openSeat: null, names: ["Host", "Guest"] });
  });
});
