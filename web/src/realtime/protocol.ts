/**
 * The realtime wire protocol (plan piece 4, "Domain conventions": Protocol;
 * spec §5.4, §8): JSON text frames, validated with zod on both ends.
 *
 * Client → server: every message carries a client-generated `id`. The
 * server acknowledges every accepted message with `ack { id }` — except
 * `ping`, whose answer is `pong` — and refuses one with `rejected { id,
 * code, message }`. `join` is answered with `snapshot` followed by its
 * `ack`; game actions (`roll`, `move`, `double`, `take`, `drop`, `nextGame`,
 * `acceptResign`) are followed by a `state` broadcast to both seats, `chat`
 * by a `chat` broadcast. A frame that does not parse is refused with code
 * `invalid`, keeping the `id` whenever the frame carried a usable one.
 *
 * Resignation is an offer, not a unilateral act: `resign { kind }` from the
 * player on roll is acked once the offer is registered (nothing is
 * conceded yet) and broadcast as `resignOffered { offer }` with the points
 * the rules would award; the opponent answers `acceptResign` (the game
 * ends, `state` + `gameOver` follow) or `declineResign` (`resignCleared
 * { reason: "declined" }`); any game action by the offerer withdraws it
 * (`resignCleared { reason: "withdrawn" }` precedes that action's `state`).
 *
 * Message ids double as idempotency keys: the server remembers each seat's
 * recent ids with their answers and repeats the stored answer for a resent
 * id without acting again (a `chat` resent after a lost `ack` is not stored
 * twice). Ids must therefore be unique per seat across reconnects *and*
 * page reloads — a client should use `crypto.randomUUID()`, never a
 * counter that restarts at 1.
 *
 * The record inside `snapshot` and `state` is a `WireRecord`
 * (protocol-engine.ts): the seed is present only once the game is over.
 *
 * Server → client messages are typed here too (`ServerMsg`) with a schema
 * the browser transport parses frames with (Task 6). Shared with the
 * browser: no Node imports.
 */

import { z } from "zod";

import { gameResultSchema, matchStateSchema, resultKindSchema, wireRecordSchema } from "./protocol-engine";

/** Seat 0 is White, seat 1 is Black. */
export type SeatIndex = 0 | 1;

export const seatIndexSchema = z.union([z.literal(0), z.literal(1)]) satisfies z.ZodType<SeatIndex>;

/** Longest chat line accepted, in characters after trimming. */
export const MAX_CHAT_LENGTH = 500;
/** Longest client message id accepted. */
export const MAX_MESSAGE_ID_LENGTH = 64;
/** Longest play notation accepted (`"bar/22* bar/22* bar/22* bar/22*"` is 31). */
export const MAX_PLAY_LENGTH = 64;

export const REJECT_CODES = ["notYourTurn", "illegal", "wrongPhase", "invalid", "rateLimited", "gameOver"] as const;

export type RejectCode = (typeof REJECT_CODES)[number];

const idSchema = z.string().min(1).max(MAX_MESSAGE_ID_LENGTH);

const withId = <T extends string>(type: T) => z.object({ id: idSchema, type: z.literal(type) });

export const clientMsgSchema = z.discriminatedUnion("type", [
  withId("join"),
  withId("roll"),
  withId("double"),
  withId("take"),
  withId("drop"),
  withId("move").extend({ play: z.string().max(MAX_PLAY_LENGTH) }),
  withId("resign").extend({ kind: z.enum(["single", "gammon", "backgammon"]) }),
  withId("nextGame"),
  withId("acceptResign"),
  withId("declineResign"),
  withId("chat").extend({ text: z.string().trim().min(1).max(MAX_CHAT_LENGTH) }),
  withId("ping"),
]);

export type ClientMsg = z.infer<typeof clientMsgSchema>;

export type ClientMsgType = ClientMsg["type"];

/** The client messages `judge` rules on: the moves of the game and a resignation offer. */
export type GameActionMsg = Extract<ClientMsg, { type: "roll" | "move" | "double" | "take" | "drop" | "resign" }>;

/** The opponent's answer to a resignation offer. */
export type ResignAnswerMsg = Extract<ClientMsg, { type: "acceptResign" | "declineResign" }>;

// ---------------------------------------------------------------------------
// Server → client

export const seatInfoSchema = z.object({ seat: seatIndexSchema, name: z.string().nullable() });

/** A seat as the table shows it: `name` is `null` while the seat is unclaimed. */
export type SeatInfo = z.infer<typeof seatInfoSchema>;

export const chatLineSchema = z.object({
  seat: seatIndexSchema,
  name: z.string(),
  text: z.string(),
  /** Milliseconds since the epoch, server clock. */
  at: z.number(),
});

export type ChatLine = z.infer<typeof chatLineSchema>;

const presenceSchema = z.tuple([z.boolean(), z.boolean()]);

export const gameStatusSchema = z.enum(["created", "active", "finished", "abandoned"]);

/** A pending resignation: `seat` offers to concede `kind`, which the rules price at `points`. */
export const resignOfferSchema = z.object({ seat: seatIndexSchema, kind: resultKindSchema, points: z.int().min(1) });

export type ResignOffer = z.infer<typeof resignOfferSchema>;

/** Between the games of a match: who has voted `nextGame`, and when the game starts on its own (`null` until someone votes). */
export const nextGameSchema = z.object({ votes: presenceSchema, startsAt: z.number().nullable() });

export type NextGameInfo = z.infer<typeof nextGameSchema>;

export const serverMsgSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    game: z.object({
      id: z.string(),
      /** The seat the receiving socket holds. */
      seat: seatIndexSchema,
      /** `finished` and `abandoned` sessions are read-only (chat still works). */
      status: gameStatusSchema,
      record: wireRecordSchema,
      match: matchStateSchema,
      seats: z.array(seatInfoSchema),
      awaitingNextGame: z.boolean(),
      /** Votes, offer and deadline live in the server's memory only: a restart forgets them. */
      nextGame: nextGameSchema,
      resignOffer: resignOfferSchema.nullable(),
      presence: presenceSchema,
      chat: z.array(chatLineSchema),
    }),
  }),
  z.object({
    type: z.literal("state"),
    record: wireRecordSchema,
    match: matchStateSchema,
    awaitingNextGame: z.boolean(),
    /** Index in `record.turns` of the last turn the action appended. */
    lastTurnIndex: z.int().min(0),
  }),
  z.object({ type: z.literal("ack"), id: z.string() }),
  z.object({ type: z.literal("rejected"), id: z.string(), code: z.enum(REJECT_CODES), message: z.string() }),
  z.object({ type: z.literal("chat"), line: chatLineSchema }),
  z.object({ type: z.literal("presence"), presence: presenceSchema }),
  z.object({ type: z.literal("gameOver"), result: gameResultSchema, matchOver: z.boolean() }),
  z.object({ type: z.literal("resignOffered"), offer: resignOfferSchema }),
  z.object({ type: z.literal("resignCleared"), offer: resignOfferSchema, reason: z.enum(["declined", "withdrawn"]) }),
  z.object({ type: z.literal("pong") }),
]);

export type ServerMsg = z.infer<typeof serverMsgSchema>;

export type ServerMsgOf<T extends ServerMsg["type"]> = Extract<ServerMsg, { type: T }>;

// ---------------------------------------------------------------------------
// Parsing client frames

export type ParseClientResult = { ok: true; msg: ClientMsg } | { ok: false; error: string; id: string | null };

/** The `id` of a raw frame when it is a usable string, else `null`. */
function idOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= MAX_MESSAGE_ID_LENGTH ? id : null;
}

/** One line naming the first offending field, e.g. `text: Too big: expected string to have <=500 characters`. */
function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "invalid message";
  }
  const path = issue.path.map(String).join(".");
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Parses one text frame into a `ClientMsg`. Malformed JSON, non-objects,
 * unknown types and out-of-range fields are reported as `{ ok: false }`
 * with a one-line reason and the frame's `id` when it had one; unknown
 * fields are dropped.
 */
export function parseClientMsg(text: string): ParseClientResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "frame is not valid JSON", id: null };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "frame must be a JSON object", id: null };
  }
  const parsed = clientMsgSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: describeIssue(parsed.error), id: idOf(raw) };
  }
  return { ok: true, msg: parsed.data };
}

/** The `rejected invalid` answer to a frame that did not parse (`id` is `""` when the frame had none). */
export function invalidMessage(id: string | null, error: string): ServerMsgOf<"rejected"> {
  return { type: "rejected", id: id ?? "", code: "invalid", message: error };
}

/** A `rejected` answer to `msg`. */
export function rejectedMessage(id: string, code: RejectCode, message: string): ServerMsgOf<"rejected"> {
  return { type: "rejected", id, code, message };
}
