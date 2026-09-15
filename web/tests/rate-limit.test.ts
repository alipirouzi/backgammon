// The in-memory sliding-window limiter behind POST /api/games
// (web/src/server/rate-limit.ts): per key, at most `limit` hits per window,
// keys forgotten once their window has passed, the table bounded (least
// recently hit key evicted), and the client key taken from the last
// X-Forwarded-For entry (the one the trusted proxy appended), normalised —
// IPv4 as is, IPv6 by its /64 prefix.

import { describe, expect, it } from "vitest";

import { clientKey, createRateLimiter, DEFAULT_MAX_KEYS } from "../src/server/rate-limit";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createRateLimiter", () => {
  it("allows `limit` hits in a window and refuses the next one with the wait", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
    expect(limiter.hit("a")).toEqual({ allowed: true, remaining: 2 });
    expect(limiter.hit("a")).toEqual({ allowed: true, remaining: 1 });
    expect(limiter.hit("a")).toEqual({ allowed: true, remaining: 0 });
    c.advance(10_000);
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterMs: 50_000 });
  });

  it("keeps keys apart", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("b").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("slides: a hit is forgotten exactly one window after it happened", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: c.now });
    limiter.hit("a");
    c.advance(600);
    limiter.hit("a");
    expect(limiter.hit("a").allowed).toBe(false);
    c.advance(400); // first hit is now exactly one window old
    expect(limiter.hit("a")).toEqual({ allowed: true, remaining: 0 });
    c.advance(599);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("drops idle keys so the table does not grow without bound", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 1_000, now: c.now });
    for (let i = 0; i < 100; i++) {
      limiter.hit(`key-${String(i)}`);
    }
    expect(limiter.size()).toBe(100);
    c.advance(1_001);
    limiter.hit("fresh");
    expect(limiter.size()).toBe(1);
  });

  it("rejects a non-positive limit, window or key bound", () => {
    expect(() => createRateLimiter({ limit: 0, windowMs: 1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ limit: 1, windowMs: 1, maxKeys: 0 })).toThrow(RangeError);
  });

  it("bounds the table: past maxKeys the least recently hit key is evicted, not the first inserted", () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 3, now: clock().now });
    limiter.hit("a");
    limiter.hit("b");
    limiter.hit("c");
    limiter.hit("a"); // "a" is now the most recently hit key; "b" the least
    limiter.hit("d"); // one over the bound: "b" goes
    expect(limiter.size()).toBe(3);
    // "a" kept its two hits; "b" starts afresh.
    expect(limiter.hit("a")).toEqual({ allowed: true, remaining: 2 });
    expect(limiter.hit("b")).toEqual({ allowed: true, remaining: 4 });
    expect(limiter.size()).toBe(3);
  });

  it("is bounded by default", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
    for (let i = 0; i < DEFAULT_MAX_KEYS + 5; i++) {
      limiter.hit(`key-${String(i)}`);
    }
    expect(limiter.size()).toBe(DEFAULT_MAX_KEYS);
  });
});

describe("clientKey", () => {
  const headers = (xff: string | null) => new Headers(xff === null ? {} : { "x-forwarded-for": xff });

  it("uses the last X-Forwarded-For entry (appended by the trusted proxy), trimmed", () => {
    expect(clientKey(headers("203.0.113.9"))).toBe("203.0.113.9");
    expect(clientKey(headers("198.51.100.1, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientKey(headers(" 2001:db8::1 , 203.0.113.9 "))).toBe("203.0.113.9");
  });

  it("keys an IPv6 client by its /64 prefix, so one allocation gets one budget", () => {
    const first = clientKey(headers("2a01:4f8:1c1e:1234::1"));
    expect(first).toBe("2a01:4f8:1c1e:1234::/64");
    expect(clientKey(headers("2a01:4f8:1c1e:1234:abcd:ef01:2345:6789"))).toBe(first);
    expect(clientKey(headers("2A01:04F8:1C1E:1234:0000:0000:0000:0002"))).toBe(first);
    // The neighbouring /64 is another client.
    expect(clientKey(headers("2a01:4f8:1c1e:1235::1"))).toBe("2a01:4f8:1c1e:1235::/64");
    // A compressed run of zeros inside the prefix expands to the same four hextets.
    expect(clientKey(headers("2001:db8::1"))).toBe("2001:db8:0:0::/64");
    expect(clientKey(headers("2001:db8:0:0:0:0:0:2"))).toBe("2001:db8:0:0::/64");
    // A zone id is not part of the address.
    expect(clientKey(headers("fe80::1%eth0"))).toBe("fe80:0:0:0::/64");
  });

  it("keys an IPv4 client by its full address, also when it arrives IPv4-mapped", () => {
    expect(clientKey(headers("203.0.113.9"))).toBe("203.0.113.9");
    expect(clientKey(headers("::ffff:203.0.113.9"))).toBe("203.0.113.9");
    // The same mapped address in its hex and uncompressed spellings.
    expect(clientKey(headers("::ffff:cb00:7109"))).toBe("203.0.113.9");
    expect(clientKey(headers("0:0:0:0:0:ffff:203.0.113.9"))).toBe("203.0.113.9");
    expect(clientKey(headers("0000:0000:0000:0000:0000:ffff:cb00:710a"))).toBe("203.0.113.10");
    expect(clientKey(headers("203.0.113.10"))).not.toBe(clientKey(headers("203.0.113.9")));
  });

  it("falls back to a shared key without the header or with an empty one", () => {
    expect(clientKey(headers(null))).toBe("unknown");
    expect(clientKey(headers(""))).toBe("unknown");
    expect(clientKey(headers("a, "))).toBe("unknown");
  });

  it("caps an entry that is not an address so the key cannot be used to bloat the table", () => {
    expect(clientKey(headers("x".repeat(500))).length).toBeLessThanOrEqual(64);
    expect(clientKey(headers("not-an-address"))).toBe("not-an-address");
  });
});
