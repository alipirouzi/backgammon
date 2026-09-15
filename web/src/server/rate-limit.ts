/**
 * A small in-memory sliding-window rate limiter for route handlers (plan
 * Task 10: 30 `POST /api/games` per minute per address). One process, one
 * table: enough for a single app container behind Caddy; a second replica
 * would need a shared store. Keys whose window has passed are dropped on
 * the next hit, and the table is bounded (`maxKeys`, least recently hit key
 * evicted first) so no stream of fresh keys can grow it without limit.
 *
 * The key is the client's address normalised (`clientKey`): IPv4 as is, IPv6
 * by its /64 prefix — a residential IPv6 client can pick any address in its
 * /64 per request, so keying by the full address would hand out a fresh
 * budget every time.
 */

import { isIPv4, isIPv6 } from "node:net";

export interface RateLimiterOptions {
  /** Hits allowed per `windowMs` per key. */
  limit: number;
  windowMs: number;
  /** Most keys tracked at once; past it the least recently hit key is forgotten. `DEFAULT_MAX_KEYS` when omitted. */
  maxKeys?: number;
  /** Clock in milliseconds (injectable for tests). */
  now?: () => number;
}

export type RateLimitDecision = { allowed: true; remaining: number } | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  /** Records one hit for `key` and says whether it was within the limit. */
  hit(key: string): RateLimitDecision;
  /** Number of keys currently tracked (tests). */
  size(): number;
}

/** Default bound on tracked keys: a few hundred kilobytes at most, far above any honest client count. */
export const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter({ limit, windowMs, maxKeys = DEFAULT_MAX_KEYS, now = Date.now }: RateLimiterOptions): RateLimiter {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`rate limit must be a positive integer, got ${String(limit)}`);
  }
  if (!(windowMs > 0)) {
    throw new RangeError(`rate limit window must be positive, got ${String(windowMs)}`);
  }
  if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
    throw new RangeError(`rate limit key bound must be a positive integer, got ${String(maxKeys)}`);
  }
  /**
   * Per key, the timestamps of the hits still inside the window, oldest
   * first. A key is re-inserted on every hit, so the map's own order runs
   * from the least recently hit key to the most recent — the eviction order.
   */
  const hits = new Map<string, number[]>();
  /** When the table was last swept of expired keys. */
  let sweptAt = now();

  const sweep = (t: number): void => {
    if (t - sweptAt < windowMs) {
      return;
    }
    sweptAt = t;
    const horizon = t - windowMs;
    for (const [key, stamps] of hits) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= horizon) {
        hits.delete(key);
      }
    }
  };

  /** Stores `stamps` for `key` as the most recently hit entry and keeps the table within `maxKeys`. */
  const remember = (key: string, stamps: number[]): void => {
    hits.delete(key);
    hits.set(key, stamps);
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next();
      if (oldest.done) {
        break;
      }
      hits.delete(oldest.value);
    }
  };

  return {
    hit(key) {
      const t = now();
      sweep(t);
      const horizon = t - windowMs;
      const recent = (hits.get(key) ?? []).filter((stamp) => stamp > horizon);
      if (recent.length >= limit) {
        remember(key, recent);
        return { allowed: false, retryAfterMs: recent[0] + windowMs - t };
      }
      remember(key, [...recent, t]);
      return { allowed: true, remaining: limit - recent.length - 1 };
    },
    size: () => hits.size,
  };
}

const MAX_KEY_LENGTH = 64;

/** A dotted IPv4 tail inside an IPv6 address (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`). */
const IPV4_TAIL = /(\d{1,3}(?:\.\d{1,3}){3})$/;

/** The dotted IPv4 address behind an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, in any spelling), or `null`. */
function mappedIPv4(hextets: readonly string[]): string | null {
  if (!hextets.slice(0, 5).every((h) => h === "0") || hextets[5] !== "ffff") {
    return null;
  }
  const hi = Number.parseInt(hextets[6], 16);
  const lo = Number.parseInt(hextets[7], 16);
  return `${String(hi >> 8)}.${String(hi & 0xff)}.${String(lo >> 8)}.${String(lo & 0xff)}`;
}

/** The eight hextets of a valid IPv6 address (no `::`, no leading zeros), or `null` when it does not parse. */
function hextetsOf(address: string): string[] | null {
  let text = address;
  const tail = IPV4_TAIL.exec(text);
  if (tail !== null) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const headParts = head.length === 0 ? [] : head.split(":");
  const restParts = rest === undefined || rest.length === 0 ? [] : rest.split(":");
  const missing = 8 - headParts.length - restParts.length;
  if (missing < 0 || (rest === undefined && missing !== 0)) {
    return null;
  }
  const parts = [...headParts, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...restParts];
  return parts.length === 8 ? parts.map((p) => Number.parseInt(p, 16).toString(16)) : null;
}

/**
 * The address `raw` normalised for keying: an IPv4 address as is (an
 * IPv4-mapped IPv6 address becomes its IPv4), an IPv6 address as its /64
 * prefix (`2001:db8:0:0::/64`; a zone id is dropped), `null` when `raw` is
 * not an address at all.
 */
export function normaliseAddress(raw: string): string | null {
  const address = raw.split("%")[0].toLowerCase();
  if (isIPv4(address)) {
    return address;
  }
  if (!isIPv6(address)) {
    return null;
  }
  const hextets = hextetsOf(address);
  if (hextets === null) {
    return null;
  }
  return mappedIPv4(hextets) ?? `${hextets.slice(0, 4).join(":")}::/64`;
}

/**
 * The key a request is limited under: the last `X-Forwarded-For` entry,
 * normalised (`normaliseAddress`). Caddy (deploy/backgammon.caddy) replaces
 * whatever the client sent with the address it saw, so in production the
 * header holds one entry; behind a proxy that appends instead, the last
 * entry is still the one the proxy added while the first is whatever the
 * client claimed — which is why the first is never used. An entry that is
 * not an address is used as it is, capped in length; without the header
 * every request shares one key ("unknown").
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for") ?? "";
  const last = forwarded.split(",").pop()?.trim() ?? "";
  if (last.length === 0) {
    return "unknown";
  }
  return normaliseAddress(last) ?? last.slice(0, MAX_KEY_LENGTH);
}
