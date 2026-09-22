// Seat cookies and seat verification (web/src/realtime/auth.ts, plan Task 1):
// the secret a browser holds for its seat, the Set-Cookie value that carries
// it, tolerant parsing of the Cookie header, and constant-time verification
// against the SHA-256 hash stored in GameSeat.seatSecretHash (Prisma mocked).

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SEAT_COOKIE_MAX_AGE_SECONDS,
  buildSeatCookie,
  createSeatSecret,
  hashSeatSecret,
  parseSeatCookie,
  seatCookieName,
  verifySeat,
} from "../../src/realtime/auth";

const GAME = "clx0000000000000000000001";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("createSeatSecret", () => {
  it("returns a fresh 32-byte base64url secret and its SHA-256 hex hash", () => {
    const { secret, hash } = createSeatSecret();
    expect(secret).toMatch(BASE64URL);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(hash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(hash).toHaveLength(64);
    expect(hashSeatSecret(secret)).toBe(hash);
  });

  it("never repeats", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => createSeatSecret().secret));
    expect(secrets.size).toBe(50);
  });
});

describe("seatCookieName / buildSeatCookie", () => {
  it("names the cookie after the game", () => {
    expect(seatCookieName(GAME)).toBe(`bg_seat_${GAME}`);
  });

  it("builds an HttpOnly, Secure, SameSite=Lax, Path=/ cookie for 30 days", () => {
    const { secret } = createSeatSecret();
    expect(SEAT_COOKIE_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(buildSeatCookie(GAME, 1, secret)).toBe(
      `bg_seat_${GAME}=1.${secret}; Path=/; Max-Age=${SEAT_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("refuses a game id that could carry header syntax", () => {
    expect(() => seatCookieName("abc; Path=/evil")).toThrow(/game id/);
    expect(() => buildSeatCookie("a=b", 0, createSeatSecret().secret)).toThrow(/game id/);
    expect(() => buildSeatCookie(GAME, 0, "not;safe")).toThrow(/secret/);
  });
});

describe("parseSeatCookie", () => {
  const { secret } = createSeatSecret();

  it("finds the seat cookie among other cookies, whatever the spacing", () => {
    const header = `theme=dark;  bg_seat_${GAME}=1.${secret} ;other=x=y`;
    expect(parseSeatCookie(header, GAME)).toEqual({ seat: 1, secret });
  });

  it("matches the cookie name exactly (no prefix match on the game id)", () => {
    expect(parseSeatCookie(`bg_seat_${GAME}0=0.${secret}`, GAME)).toBeNull();
    expect(parseSeatCookie(`bg_seat_${GAME}=0.${secret}`, `${GAME}0`)).toBeNull();
    expect(parseSeatCookie(`xbg_seat_${GAME}=0.${secret}`, GAME)).toBeNull();
  });

  it.each([
    ["no header", undefined],
    ["empty header", ""],
    ["unrelated cookies", "a=1; b=2"],
    ["a seat that is not 0 or 1", `bg_seat_${GAME}=2.${secret}`],
    ["a missing secret", `bg_seat_${GAME}=1.`],
    ["a missing seat", `bg_seat_${GAME}=${secret}`],
    ["a secret with unsafe characters", `bg_seat_${GAME}=1.${secret}+=`],
    ["a secret with a quote", `bg_seat_${GAME}=1."${secret}"`],
  ])("returns null for %s", (_label, header) => {
    expect(parseSeatCookie(header, GAME)).toBeNull();
  });

  it("takes the first matching cookie when the header repeats it", () => {
    const other = createSeatSecret().secret;
    expect(parseSeatCookie(`bg_seat_${GAME}=0.${secret}; bg_seat_${GAME}=1.${other}`, GAME)).toEqual({ seat: 0, secret });
  });
});

describe("verifySeat", () => {
  const db = { gameSeat: { findUnique: vi.fn() } };
  const { secret, hash } = createSeatSecret();

  beforeEach(() => {
    db.gameSeat.findUnique.mockReset();
  });

  it("is true for the secret whose hash is stored", async () => {
    db.gameSeat.findUnique.mockResolvedValue({ seatSecretHash: hash });
    await expect(verifySeat(db, GAME, 0, secret)).resolves.toBe(true);
    expect(db.gameSeat.findUnique).toHaveBeenCalledWith({
      where: { gameId_seat: { gameId: GAME, seat: 0 } },
      select: { seatSecretHash: true },
    });
  });

  it("is false for a wrong secret", async () => {
    db.gameSeat.findUnique.mockResolvedValue({ seatSecretHash: hash });
    await expect(verifySeat(db, GAME, 0, createSeatSecret().secret)).resolves.toBe(false);
  });

  it("is false when the seat is unknown or unclaimed", async () => {
    db.gameSeat.findUnique.mockResolvedValue(null);
    await expect(verifySeat(db, GAME, 1, secret)).resolves.toBe(false);
    db.gameSeat.findUnique.mockResolvedValue({ seatSecretHash: null });
    await expect(verifySeat(db, GAME, 1, secret)).resolves.toBe(false);
  });

  it("is false (not an exception) when the stored hash is malformed", async () => {
    db.gameSeat.findUnique.mockResolvedValue({ seatSecretHash: "abc" });
    await expect(verifySeat(db, GAME, 0, secret)).resolves.toBe(false);
  });
});
