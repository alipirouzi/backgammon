/**
 * Seat authentication for remote games (plan: domain conventions "Seats";
 * spec §5.3). Each seat has a 32-byte random secret; only its SHA-256 is
 * stored (`GameSeat.seatSecretHash`). The browser holds the secret in the
 * cookie `bg_seat_<gameId>=<seat>.<secret>` (HttpOnly, Secure, SameSite=Lax,
 * Path=/, 30 days). The realtime server reads that cookie during the
 * WebSocket upgrade and the API routes set it after `createInvite` /
 * `claimSeat`; verification hashes the presented secret and compares the
 * digests with `timingSafeEqual`.
 *
 * Shared by the Next.js API routes and the realtime process (both Node);
 * never import from browser code (`node:crypto`).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Prisma } from "@prisma/client";

/** Seat 0 = White, 1 = Black. */
export type SeatIndex = 0 | 1;

export interface SeatSecret {
  /** 32 random bytes, base64url (cookie-safe). */
  secret: string;
  /** SHA-256 of `secret`, hex — what `GameSeat.seatSecretHash` stores. */
  hash: string;
}

export interface ParsedSeatCookie {
  seat: SeatIndex;
  secret: string;
}

/** What `verifySeat` needs of the database. */
export type SeatDb = { gameSeat: Pick<Prisma.TransactionClient["gameSeat"], "findUnique"> };

export const SEAT_COOKIE_PREFIX = "bg_seat_";
export const SEAT_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SECRET_BYTES = 32;
/** Bytes of a SHA-256 digest; a stored hash of any other size can never match. */
const HASH_BYTES = 32;

/** Game ids are cuids (`[a-z0-9]`); anything else could smuggle cookie or header syntax. */
const SAFE_GAME_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Secrets are base64url; `verifySeat` never sees `;`, `=` or quotes. */
const SAFE_SECRET = /^[A-Za-z0-9_-]{16,128}$/;
const COOKIE_VALUE = /^([01])\.([A-Za-z0-9_-]{16,128})$/;

export function hashSeatSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A fresh seat secret and the hash to store for it. */
export function createSeatSecret(): SeatSecret {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { secret, hash: hashSeatSecret(secret) };
}

function assertGameId(gameId: string): void {
  if (!SAFE_GAME_ID.test(gameId)) {
    throw new RangeError("seat cookie: game id must be 1–64 characters of [A-Za-z0-9_-]");
  }
}

/** `bg_seat_<gameId>`; throws on a game id that is not cookie-safe. */
export function seatCookieName(gameId: string): string {
  assertGameId(gameId);
  return `${SEAT_COOKIE_PREFIX}${gameId}`;
}

/** The `Set-Cookie` header value that hands `secret` for `seat` of `gameId` to the browser. */
export function buildSeatCookie(gameId: string, seat: SeatIndex, secret: string): string {
  const name = seatCookieName(gameId);
  if (!SAFE_SECRET.test(secret)) {
    throw new RangeError("seat cookie: secret must be base64url");
  }
  return `${name}=${String(seat)}.${secret}; Path=/; Max-Age=${String(SEAT_COOKIE_MAX_AGE_SECONDS)}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * The seat cookie for `gameId` out of a `Cookie` header, or `null` when
 * absent or malformed. Other cookies and loose spacing are tolerated; the
 * name must match exactly (no prefix match on the game id); the first
 * matching cookie wins when the header repeats it.
 */
export function parseSeatCookie(cookieHeader: string | null | undefined, gameId: string): ParsedSeatCookie | null {
  if (!cookieHeader || !SAFE_GAME_ID.test(gameId)) {
    return null;
  }
  const wanted = `${SEAT_COOKIE_PREFIX}${gameId}`;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() !== wanted) {
      continue;
    }
    const match = COOKIE_VALUE.exec(part.slice(eq + 1).trim());
    return match === null ? null : { seat: match[1] === "0" ? 0 : 1, secret: match[2] };
  }
  return null;
}

/**
 * `true` when `secret` is the one issued for `seat` of `gameId`: the stored
 * hash exists and equals SHA-256(secret), compared in constant time. An
 * unknown or unclaimed seat, or a stored hash of the wrong size, is `false`.
 */
export async function verifySeat(db: SeatDb, gameId: string, seat: SeatIndex, secret: string): Promise<boolean> {
  if (!SAFE_SECRET.test(secret)) {
    return false;
  }
  const row = await db.gameSeat.findUnique({
    where: { gameId_seat: { gameId, seat } },
    select: { seatSecretHash: true },
  });
  if (row === null || row.seatSecretHash === null) {
    return false;
  }
  const stored = Buffer.from(row.seatSecretHash, "hex");
  const presented = Buffer.from(hashSeatSecret(secret), "hex");
  if (stored.length !== HASH_BYTES || presented.length !== HASH_BYTES) {
    return false;
  }
  return timingSafeEqual(stored, presented);
}
