/**
 * Invite links and seat claiming for remote games (plan Task 1; spec §5.3).
 * `createInvite` writes a `created` game with its seed, an empty record and
 * two seats — the creator's already claimed (hash stored, name set), the
 * other open — and returns the invite token plus the creator's secret for
 * the seat cookie. `claimSeat` gives the open seat to the first claimant:
 * `UPDATE GameSeat … WHERE seatSecretHash IS NULL` is the guard, so of two
 * concurrent claims exactly one updates a row and the other sees `"taken"`;
 * the game turns `active` in the same transaction, itself guarded on the
 * row still being `created` — a claim racing the realtime sweep that just
 * abandoned a day-old invite rolls back (the seat stays open, the result
 * is `"taken"`) instead of resurrecting the game. The token stays on the
 * row afterwards so `/g/<token>` can still find the game for a visitor who
 * holds a seat cookie (`getInvite`).
 *
 * Server-only (imports `./db` and `node:crypto`).
 */

import { randomBytes, randomInt } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

import type { Player, Record as GameRecord } from "@/engine/types";
import { defaultRules, newRecord } from "@/game/record";
import { createSeatSecret, type SeatIndex } from "@/realtime/auth";

import { getDb } from "./db";
import { MAX_GUEST_NAME } from "./validate";

/** Longest match offered by invite (plan: "match to 1–25"). */
export const MAX_INVITE_MATCH_LENGTH = 25;
/** 16 random bytes, base64url. */
export const INVITE_TOKEN_LENGTH = 22;
const TOKEN_BYTES = 16;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/** The request cannot be served: malformed format, side, name or token. */
export class InviteInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteInvalid";
  }
}

export interface InviteOptions {
  format: "single" | "match";
  /** `0` for a single game, `1..25` for a match. */
  matchLength: number;
  /** The creator's colour; the invitee gets the other seat. */
  creatorSide: Player;
  /** 1–40 characters, trimmed. */
  creatorName: string;
}

export interface CreatedInvite {
  gameId: string;
  token: string;
  seat: SeatIndex;
  /** The creator's seat secret — goes into the seat cookie, never stored in clear. */
  secret: string;
}

export interface ClaimedSeat {
  gameId: string;
  seat: SeatIndex;
  secret: string;
}

/** `"taken"`: the game is no longer open (both seats claimed, or over); `"notFound"`: no such invite. */
export type ClaimResult = ClaimedSeat | "taken" | "notFound";

/** What `/g/<token>` needs to render the claim page. */
export interface InviteInfo {
  gameId: string;
  status: "created" | "active" | "finished" | "abandoned";
  format: "single" | "match";
  matchLength: number;
  /** The seat still to be claimed, or `null` when none. */
  openSeat: SeatIndex | null;
  /** Guest names by seat; `null` while a seat is open. */
  names: [string | null, string | null];
}

/** What this module needs of Prisma; `$transaction` in its interactive form. */
export type InviteDb = Pick<PrismaClient, "game" | "gameSeat" | "$transaction">;

export interface InviteDeps {
  db?: InviteDb;
}

const trimmedName = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length >= 1 && s.length <= MAX_GUEST_NAME, { message: `name must be 1..${String(MAX_GUEST_NAME)} characters` });

const inviteOptions = z
  .object({
    format: z.enum(["single", "match"]),
    matchLength: z.number().int().min(0).max(MAX_INVITE_MATCH_LENGTH),
    creatorSide: z.enum(["white", "black"]),
    creatorName: trimmedName,
  })
  .refine((o) => (o.format === "single" ? o.matchLength === 0 : o.matchLength >= 1), {
    message: "matchLength must be 0 for a single game and 1..25 for a match",
  });

const claimInput = z.object({
  token: z.unknown(),
  name: trimmedName,
});

const seatOf = (side: Player): SeatIndex => (side === "white" ? 0 : 1);

/**
 * A seed in `0..=2^53 - 1` from the CSPRNG. `randomInt` spans at most 2^48
 * per call, so the 53 bits come from two draws: 21 high bits and 32 low.
 */
export function serverSeed(): number {
  return randomInt(0, 2 ** 21) * 2 ** 32 + randomInt(0, 2 ** 32);
}

/** The record a remote game starts from: no turns yet (the session appends the opening roll), bot-game rules for the format. */
export function initialRecord(seed: number, matchLength: number): GameRecord {
  return newRecord(seed, matchLength, defaultRules(matchLength));
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function parseOr<T>(result: z.ZodSafeParseResult<T>): T {
  if (!result.success) {
    throw new InviteInvalid(result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}

/** Thrown inside the claim transaction to roll it back when the game is no longer `created`. */
class ClaimConflict extends Error {
  constructor() {
    super("the game is no longer open");
    this.name = "ClaimConflict";
  }
}

function seatRow(seat: SeatIndex, occupant: { name: string; hash: string } | null): Prisma.GameSeatCreateWithoutGameInput {
  return {
    seat,
    userId: null,
    guestName: occupant?.name ?? null,
    seatSecretHash: occupant?.hash ?? null,
  };
}

/**
 * Creates a `created` game with the creator seated and the other seat open.
 * Throws `InviteInvalid` on bad input; anything else is a database failure.
 */
export async function createInvite(input: unknown, deps: InviteDeps = {}): Promise<CreatedInvite> {
  const options = parseOr(inviteOptions.safeParse(input));
  const db = deps.db ?? getDb();
  const seat = seatOf(options.creatorSide);
  const { secret, hash } = createSeatSecret();
  const token = newToken();
  const seed = serverSeed();
  const creator = { name: options.creatorName, hash };
  const seats: [Prisma.GameSeatCreateWithoutGameInput, Prisma.GameSeatCreateWithoutGameInput] =
    seat === 0 ? [seatRow(0, creator), seatRow(1, null)] : [seatRow(0, null), seatRow(1, creator)];

  const created = await db.game.create({
    data: {
      token,
      format: options.format,
      matchLength: options.matchLength,
      botLevel: null,
      seed: BigInt(seed),
      status: "created",
      moveLog: initialRecord(seed, options.matchLength) as unknown as Prisma.InputJsonValue,
      seats: { create: seats },
    },
    select: { id: true },
  });
  return { gameId: created.id, token, seat, secret };
}

/**
 * Claims the open seat of the invite `token` for a guest called `name`.
 * Throws `InviteInvalid` for a bad name; a malformed or unknown token is
 * `"notFound"` (no query for a malformed one); a game that is not `created`
 * any more, or whose open seat was taken meanwhile, is `"taken"`.
 */
export async function claimSeat(input: unknown, deps: InviteDeps = {}): Promise<ClaimResult> {
  const { token, name } = parseOr(claimInput.safeParse(input));
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
    return "notFound";
  }
  const db = deps.db ?? getDb();
  const game = await db.game.findUnique({
    where: { token },
    select: { id: true, status: true, seats: { select: { seat: true, seatSecretHash: true } } },
  });
  if (game === null) {
    return "notFound";
  }
  const open = game.seats.find((s) => s.seatSecretHash === null);
  if (game.status !== "created" || open === undefined || (open.seat !== 0 && open.seat !== 1)) {
    return "taken";
  }
  const seat: SeatIndex = open.seat;
  const { secret, hash } = createSeatSecret();
  try {
    return await db.$transaction(async (tx) => {
      const { count } = await tx.gameSeat.updateMany({
        where: { gameId: game.id, seat, seatSecretHash: null },
        data: { seatSecretHash: hash, guestName: name },
      });
      if (count === 0) {
        return "taken";
      }
      // Guarded on `created`: the sweep may have abandoned the game since it was read above.
      const activated = await tx.game.updateMany({ where: { id: game.id, status: "created" }, data: { status: "active" } });
      if (activated.count === 0) {
        throw new ClaimConflict();
      }
      return { gameId: game.id, seat, secret };
    });
  } catch (error) {
    if (error instanceof ClaimConflict) {
      return "taken";
    }
    throw error;
  }
}

/** The game behind an invite token, or `null` when the token is malformed or unknown. */
export async function getInvite(token: string, deps: InviteDeps = {}): Promise<InviteInfo | null> {
  if (!TOKEN_SHAPE.test(token)) {
    return null;
  }
  const db = deps.db ?? getDb();
  const game = await db.game.findUnique({
    where: { token },
    select: {
      id: true,
      status: true,
      format: true,
      matchLength: true,
      seats: { select: { seat: true, guestName: true, seatSecretHash: true }, orderBy: { seat: "asc" } },
    },
  });
  if (game === null) {
    return null;
  }
  const bySeat = (seat: SeatIndex) => game.seats.find((s) => s.seat === seat);
  const open = ([0, 1] as const).find((seat) => bySeat(seat)?.seatSecretHash === null) ?? null;
  return {
    gameId: game.id,
    status: game.status,
    format: game.format,
    matchLength: game.matchLength,
    openSeat: open,
    names: [bySeat(0)?.guestName ?? null, bySeat(1)?.guestName ?? null],
  };
}
