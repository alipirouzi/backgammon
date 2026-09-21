// Wire protocol of the realtime server (web/src/realtime/protocol.ts, plan
// Task 2): every client message is validated with zod before it reaches a
// GameSession; unknown types, missing ids, oversize chat and malformed JSON
// are refused with a message the server turns into `rejected invalid`, and
// the id is recovered whenever the frame carried one so the client can match
// the rejection to its request.

import { describe, expect, it } from "vitest";

import type { MatchState, Record as GameRecord } from "../../src/engine/types";
import { toWireRecord, wireRecordSchema } from "../../src/realtime/protocol-engine";
import {
  MAX_CHAT_LENGTH,
  MAX_MESSAGE_ID_LENGTH,
  REJECT_CODES,
  type ClientMsg,
  type ServerMsg,
  invalidMessage,
  parseClientMsg,
  serverMsgSchema,
} from "../../src/realtime/protocol";

const parseOk = (value: unknown): ClientMsg => {
  const result = parseClientMsg(JSON.stringify(value));
  if (!result.ok) {
    throw new Error(`expected a valid message, got: ${result.error}`);
  }
  return result.msg;
};

const parseErr = (text: string): { error: string; id: string | null } => {
  const result = parseClientMsg(text);
  if (result.ok) {
    throw new Error(`expected a rejection, got ${JSON.stringify(result.msg)}`);
  }
  return { error: result.error, id: result.id };
};

describe("parseClientMsg accepts the plan's client union", () => {
  it.each([
    { id: "1", type: "join" },
    { id: "2", type: "roll" },
    { id: "3", type: "double" },
    { id: "4", type: "take" },
    { id: "5", type: "drop" },
    { id: "6", type: "move", play: "24/18 13/10" },
    { id: "7", type: "move", play: "" },
    { id: "8", type: "resign", kind: "single" },
    { id: "9", type: "resign", kind: "gammon" },
    { id: "10", type: "resign", kind: "backgammon" },
    { id: "11", type: "nextGame" },
    { id: "12", type: "chat", text: "hello" },
    { id: "13", type: "ping" },
    { id: "14", type: "acceptResign" },
    { id: "15", type: "declineResign" },
  ])("accepts %j", (msg) => {
    expect(parseOk(msg)).toEqual(msg);
  });

  it("strips fields the protocol does not know", () => {
    const parsed = parseOk({ id: "x", type: "roll", board: { white: [] }, dice: { hi: 6, lo: 6 } });
    expect(parsed).toEqual({ id: "x", type: "roll" });
  });

  it("trims chat text and keeps it up to the limit", () => {
    expect(parseOk({ id: "c", type: "chat", text: "  hi  " })).toEqual({ id: "c", type: "chat", text: "hi" });
    const longest = "x".repeat(MAX_CHAT_LENGTH);
    expect(parseOk({ id: "c", type: "chat", text: longest })).toEqual({ id: "c", type: "chat", text: longest });
  });
});

describe("parseClientMsg rejects what it must", () => {
  it("unknown type, keeping the id", () => {
    const { error, id } = parseErr(JSON.stringify({ id: "u1", type: "teleport" }));
    expect(id).toBe("u1");
    expect(error).toMatch(/type/);
  });

  it("missing or malformed id", () => {
    expect(parseErr(JSON.stringify({ type: "roll" })).id).toBeNull();
    expect(parseErr(JSON.stringify({ id: 7, type: "roll" })).id).toBeNull();
    expect(parseErr(JSON.stringify({ id: "", type: "roll" })).id).toBeNull();
    expect(parseErr(JSON.stringify({ id: "i".repeat(MAX_MESSAGE_ID_LENGTH + 1), type: "roll" })).error).toMatch(/id/);
  });

  it("chat that is empty, blank or too long", () => {
    expect(parseErr(JSON.stringify({ id: "c", type: "chat", text: "" })).error).toMatch(/text/);
    expect(parseErr(JSON.stringify({ id: "c", type: "chat", text: "   " })).error).toMatch(/text/);
    const tooLong = parseErr(JSON.stringify({ id: "c", type: "chat", text: "x".repeat(MAX_CHAT_LENGTH + 1) }));
    expect(tooLong.id).toBe("c");
    expect(tooLong.error).toMatch(/text/);
  });

  it("move without a string play, resign with an unknown kind", () => {
    expect(parseErr(JSON.stringify({ id: "m", type: "move" })).error).toMatch(/play/);
    expect(parseErr(JSON.stringify({ id: "m", type: "move", play: ["24/18"] })).error).toMatch(/play/);
    expect(parseErr(JSON.stringify({ id: "r", type: "resign", kind: "double" })).error).toMatch(/kind/);
    expect(parseErr(JSON.stringify({ id: "r", type: "resign" })).error).toMatch(/kind/);
  });

  it("frames that are not JSON objects", () => {
    expect(parseErr("not json").id).toBeNull();
    expect(parseErr("not json").error).toMatch(/JSON/);
    expect(parseErr("[1,2]").error).toMatch(/object/);
    expect(parseErr("null").error).toMatch(/object/);
    expect(parseErr('"roll"').error).toMatch(/object/);
  });

  it("builds the `rejected invalid` answer from a failure", () => {
    const failure = parseErr(JSON.stringify({ id: "u1", type: "teleport" }));
    const msg = invalidMessage(failure.id, failure.error);
    expect(msg).toEqual({ type: "rejected", id: "u1", code: "invalid", message: failure.error });
    expect(invalidMessage(null, "bad").id).toBe("");
  });
});

describe("server messages", () => {
  const rules = { jacoby: true, beavers: false, autoDoubles: false };
  const full: GameRecord = {
    seed: 42,
    length: 0,
    rules,
    turns: [{ player: "white", dice: { hi: 5, lo: 1 }, action: "roll", play: null, resignPoints: null }],
  };
  /** What a live game puts on the wire: the record without its seed. */
  const record = toWireRecord(full, false);
  const zeros = (): number[] => new Array<number>(26).fill(0);
  const match: MatchState = {
    length: 0,
    score: { white: 0, black: 0 },
    crawford: false,
    postCrawford: false,
    game: {
      board: { white: zeros(), black: zeros() },
      onRoll: "white",
      dice: { hi: 5, lo: 1 },
      cube: { value: 1, owner: null },
      phase: "toMove",
      result: null,
      rules,
    },
  };
  const offer = { seat: 1 as const, kind: "single" as const, points: 1 };

  it("lists every reject code of the plan", () => {
    expect([...REJECT_CODES]).toEqual(["notYourTurn", "illegal", "wrongPhase", "invalid", "rateLimited", "gameOver"]);
  });

  it("a live record leaves the seed out; a finished one carries it", () => {
    expect(record).toEqual({ length: 0, rules, turns: full.turns });
    expect("seed" in record).toBe(false);
    expect(toWireRecord(full, true)).toEqual(full);
    expect(wireRecordSchema.parse(record)).toEqual(record);
    expect(wireRecordSchema.parse(full)).toEqual(full);
    expect(wireRecordSchema.safeParse({ ...full, seed: -1 }).success).toBe(false);
  });

  it.each<ServerMsg>([
    {
      type: "snapshot",
      game: {
        id: "g1",
        seat: 0,
        status: "active",
        record,
        match,
        seats: [
          { seat: 0, name: "Alpha" },
          { seat: 1, name: null },
        ],
        awaitingNextGame: false,
        nextGame: { votes: [false, false], startsAt: null },
        resignOffer: null,
        presence: [true, false],
        chat: [{ seat: 0, name: "Alpha", text: "hi", at: 1 }],
      },
    },
    {
      type: "snapshot",
      game: {
        id: "g1",
        seat: 1,
        status: "finished",
        record: full,
        match,
        seats: [
          { seat: 0, name: "Alpha" },
          { seat: 1, name: "Beta" },
        ],
        awaitingNextGame: true,
        nextGame: { votes: [true, false], startsAt: 1_700_000_030_000 },
        resignOffer: offer,
        presence: [true, true],
        chat: [],
      },
    },
    { type: "state", record, match, awaitingNextGame: false, lastTurnIndex: 0 },
    { type: "state", record: full, match, awaitingNextGame: false, lastTurnIndex: 0 },
    { type: "ack", id: "1" },
    { type: "rejected", id: "1", code: "notYourTurn", message: "Black is to act" },
    { type: "chat", line: { seat: 1, name: "Beta", text: "gg", at: 2 } },
    { type: "presence", presence: [true, true] },
    { type: "gameOver", result: { winner: "white", kind: "gammon", points: 4 }, matchOver: true },
    { type: "resignOffered", offer },
    { type: "resignCleared", offer, reason: "declined" },
    { type: "resignCleared", offer, reason: "withdrawn" },
    { type: "pong" },
  ])("round-trips %s through the schema", (msg) => {
    expect(serverMsgSchema.parse(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });

  it("refuses a state whose record does not follow the engine's shape", () => {
    const bad = { type: "state", record: { ...record, seed: -1 }, match, awaitingNextGame: false, lastTurnIndex: 0 };
    expect(serverMsgSchema.safeParse(bad).success).toBe(false);
    const badBoard = { ...match, game: { ...match.game, board: { white: [0, 1], black: zeros() } } };
    expect(serverMsgSchema.safeParse({ type: "state", record, match: badBoard, awaitingNextGame: false, lastTurnIndex: 0 }).success).toBe(false);
  });

  it("refuses a snapshot without the session status", () => {
    const snap = { type: "snapshot", game: { id: "g1", seat: 0, record, match, seats: [], awaitingNextGame: false, nextGame: { votes: [false, false], startsAt: null }, resignOffer: null, presence: [false, false], chat: [] } };
    expect(serverMsgSchema.safeParse(snap).success).toBe(false);
    expect(serverMsgSchema.safeParse({ ...snap, game: { ...snap.game, status: "abandoned" } }).success).toBe(true);
  });
});
