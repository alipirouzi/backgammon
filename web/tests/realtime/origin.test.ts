// The Origin allowlist of the WebSocket upgrade (web/src/realtime/origin.ts):
// a browser origin must be on the list (`ALLOWED_ORIGINS`); anything else —
// a sibling subdomain, another scheme or port, the literal "null", garbage —
// is refused; a handshake without Origin is not a browser's and passes only
// where the policy allows it (outside production).

import { describe, expect, it } from "vitest";

import { isOriginAllowed, normalizeOrigin, type OriginPolicy } from "../../src/realtime/origin";

const production: OriginPolicy = { allowed: ["https://backgammon.example"], allowMissing: false };
const development: OriginPolicy = { allowed: ["http://localhost:3000"], allowMissing: true };

describe("normalizeOrigin", () => {
  it("reduces an http(s) URL to scheme://host[:port] and refuses the rest", () => {
    expect(normalizeOrigin("https://Backgammon.Example")).toBe("https://backgammon.example");
    expect(normalizeOrigin(" https://backgammon.example:443/ ")).toBe("https://backgammon.example");
    expect(normalizeOrigin("http://localhost:3000/play")).toBe("http://localhost:3000");
    for (const bad of ["null", "backgammon.example", "ws://backgammon.example", "file:///tmp", "", "https://"]) {
      expect(normalizeOrigin(bad), bad).toBeNull();
    }
  });
});

describe("isOriginAllowed", () => {
  it("accepts an origin on the list, however it is spelt", () => {
    expect(isOriginAllowed("https://backgammon.example", production)).toBe(true);
    expect(isOriginAllowed("https://backgammon.example/", production)).toBe(true);
    expect(isOriginAllowed("HTTPS://Backgammon.Example:443", production)).toBe(true);
    expect(isOriginAllowed("http://localhost:3000", development)).toBe(true);
  });

  it("refuses same-site siblings, other schemes and ports, 'null' and garbage", () => {
    for (const bad of ["https://time.backgammon.example", "https://evil.example", "http://backgammon.example", "https://backgammon.example:8443", "null", "not an origin", "https://backgammon.example.evil"]) {
      expect(isOriginAllowed(bad, production), bad).toBe(false);
    }
    // No wildcard for localhost: the port must match the list too.
    expect(isOriginAllowed("http://localhost:3001", development)).toBe(false);
    expect(isOriginAllowed("http://127.0.0.1:3000", development)).toBe(false);
    expect(isOriginAllowed("http://localhost:3000", production)).toBe(false);
  });

  it("lets a handshake without Origin through only where the policy allows it", () => {
    expect(isOriginAllowed(undefined, development)).toBe(true);
    expect(isOriginAllowed(undefined, production)).toBe(false);
  });
});
