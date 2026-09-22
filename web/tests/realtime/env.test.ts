// The realtime process's environment (web/src/realtime/env.ts): the
// required variables are checked up front and named together in one error,
// ALLOWED_ORIGINS is a comma-separated list of bare http(s) origins —
// required in production, `http://localhost:3000` by default elsewhere — a
// handshake without Origin is allowed outside production only, PORT and HOST
// have defaults, and a PORT that is not a TCP port fails fast.

import { describe, expect, it } from "vitest";

import { DEFAULT_ALLOWED_ORIGINS, DEFAULT_HOST, DEFAULT_PORT, RealtimeEnvError, parseRealtimeEnv } from "../../src/realtime/env";

const REQUIRED = {
  DATABASE_URL: "postgresql://user:pw@127.0.0.1:5439/db",
  SEAT_SECRET: "0123456789abcdef0123456789abcdef",
};

const PROD = { ...REQUIRED, NODE_ENV: "production", ALLOWED_ORIGINS: "https://backgammon.example" };

describe("parseRealtimeEnv", () => {
  it("returns the required variables and the development defaults", () => {
    expect(parseRealtimeEnv(REQUIRED)).toEqual({
      databaseUrl: REQUIRED.DATABASE_URL,
      seatSecret: REQUIRED.SEAT_SECRET,
      allowedOrigins: ["http://localhost:3000"],
      allowMissingOrigin: true,
      port: DEFAULT_PORT,
      host: DEFAULT_HOST,
    });
    expect(DEFAULT_ALLOWED_ORIGINS).toEqual(["http://localhost:3000"]);
    expect(DEFAULT_PORT).toBe(4000);
    expect(DEFAULT_HOST).toBe("0.0.0.0");
  });

  it("names every missing required variable in one error, without echoing any value", () => {
    expect(() => parseRealtimeEnv({})).toThrow(RealtimeEnvError);
    expect(() => parseRealtimeEnv({})).toThrow("missing required environment variable(s): DATABASE_URL, SEAT_SECRET");
    expect(() => parseRealtimeEnv({ DATABASE_URL: REQUIRED.DATABASE_URL })).toThrow(/SEAT_SECRET/);
    expect(() => parseRealtimeEnv({ DATABASE_URL: REQUIRED.DATABASE_URL })).not.toThrow(/DATABASE_URL/);
    // Blank counts as missing.
    expect(() => parseRealtimeEnv({ ...REQUIRED, SEAT_SECRET: "   " })).toThrow(/SEAT_SECRET/);
  });

  it("requires ALLOWED_ORIGINS in production and defaults it outside", () => {
    expect(() => parseRealtimeEnv({ NODE_ENV: "production" })).toThrow("DATABASE_URL, SEAT_SECRET, ALLOWED_ORIGINS");
    expect(() => parseRealtimeEnv({ ...REQUIRED, NODE_ENV: "production" })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => parseRealtimeEnv({ ...REQUIRED, NODE_ENV: "production", ALLOWED_ORIGINS: " , " })).toThrow(/ALLOWED_ORIGINS/);
    expect(parseRealtimeEnv(PROD).allowedOrigins).toEqual(["https://backgammon.example"]);
    expect(parseRealtimeEnv({ ...REQUIRED, NODE_ENV: "development" }).allowedOrigins).toEqual(["http://localhost:3000"]);
    expect(parseRealtimeEnv({ ...REQUIRED, NODE_ENV: "test" }).allowedOrigins).toEqual(["http://localhost:3000"]);
  });

  it("parses ALLOWED_ORIGINS as a comma-separated list of normalised origins", () => {
    const env = { ...REQUIRED, ALLOWED_ORIGINS: " HTTPS://Backgammon.Example/ ,http://localhost:3000, http://127.0.0.1:3000," };
    expect(parseRealtimeEnv(env).allowedOrigins).toEqual(["https://backgammon.example", "http://localhost:3000", "http://127.0.0.1:3000"]);
    // Set explicitly, the list replaces the default rather than adding to it.
    expect(parseRealtimeEnv({ ...REQUIRED, ALLOWED_ORIGINS: "https://backgammon.example" }).allowedOrigins).toEqual(["https://backgammon.example"]);
  });

  it("rejects an entry that is not a bare http(s) origin, naming the variable", () => {
    for (const bad of ["backgammon.example", "https://backgammon.example/play", "ws://backgammon.example", "https://user:pw@backgammon.example", "null", "https://backgammon.example?x=1"]) {
      const env = { ...REQUIRED, ALLOWED_ORIGINS: `https://ok.example, ${bad}` };
      expect(() => parseRealtimeEnv(env), bad).toThrow(RealtimeEnvError);
      expect(() => parseRealtimeEnv(env), bad).toThrow(/ALLOWED_ORIGINS/);
    }
  });

  it("allows a handshake without Origin unless NODE_ENV is production", () => {
    expect(parseRealtimeEnv(PROD).allowMissingOrigin).toBe(false);
    expect(parseRealtimeEnv({ ...REQUIRED, NODE_ENV: "development" }).allowMissingOrigin).toBe(true);
    expect(parseRealtimeEnv({ ...REQUIRED, NODE_ENV: "test" }).allowMissingOrigin).toBe(true);
    expect(parseRealtimeEnv(REQUIRED).allowMissingOrigin).toBe(true);
  });

  it("reads PORT and HOST when set", () => {
    expect(parseRealtimeEnv({ ...REQUIRED, PORT: "4100", HOST: "127.0.0.1" })).toMatchObject({ port: 4100, host: "127.0.0.1" });
  });

  it("rejects a PORT that is not a TCP port", () => {
    for (const bad of ["0", "-1", "65536", "80a", "4000.5", " "]) {
      expect(() => parseRealtimeEnv({ ...REQUIRED, PORT: bad }), bad).toThrow(RealtimeEnvError);
      expect(() => parseRealtimeEnv({ ...REQUIRED, PORT: bad }), bad).toThrow(/PORT/);
    }
  });
});
