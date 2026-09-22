// The route handlers behind POST /api/games and GET /api/games/[id]
// (web/src/app/api/games/route.ts, web/src/app/api/games/[id]/route.ts)
// with the games service mocked: status codes, bodies, the error mapping
// (RecordInvalid / GameNotFinished → 400, anything else → 500 with a generic
// message), the per-IP rate limit and the 404. The service itself is covered
// by tests/api-games.test.ts and the integration test.

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Record as GameRecord } from "../src/engine/types";
import { DatabaseNotConfigured } from "../src/server/db";

vi.mock("@/server/games", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/games")>();
  return { ...actual, verifyAndStore: vi.fn(), getGame: vi.fn() };
});

import { MAX_BODY_BYTES, POST, RATE_LIMIT_PER_MINUTE } from "../src/app/api/games/route";
import { GET } from "../src/app/api/games/[id]/route";
import { GameNotFinished, RecordInvalid, getGame, verifyAndStore, type StoredGame } from "../src/server/games";

const record = JSON.parse(readFileSync(new URL("./fixtures/finished-record.json", import.meta.url), "utf8")) as GameRecord;
const seats = { white: { kind: "guest", name: "Player One" }, black: { kind: "bot", level: "beginner" } };

const verifyAndStoreMock = vi.mocked(verifyAndStore);
const getGameMock = vi.mocked(getGame);

let ipCounter = 0;
/** A fresh documentation-range address per test so the rate limit never leaks between tests. */
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${String(ipCounter)}`;
}

function post(body: unknown, init: { ip?: string; raw?: string; headers?: HeadersInit } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("x-forwarded-for", init.ip ?? nextIp());
  return new Request("http://backgammon.test/api/games", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(body),
  });
}

const get = (id: string) => GET(new Request(`http://backgammon.test/api/games/${id}`), { params: Promise.resolve({ id }) });

describe("POST /api/games", () => {
  beforeEach(() => {
    verifyAndStoreMock.mockReset();
    verifyAndStoreMock.mockResolvedValue({ id: "cm0000000000000000000001" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores a valid payload and answers 201 with the id", async () => {
    const res = await POST(post({ record, seats }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: "cm0000000000000000000001" });
    expect(verifyAndStoreMock).toHaveBeenCalledTimes(1);
    expect(verifyAndStoreMock).toHaveBeenCalledWith(record, seats);
  });

  it("answers 400 to a body that is not JSON", async () => {
    const res = await POST(post(null, { raw: "{not json" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the request body is not valid JSON" });
    expect(verifyAndStoreMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an array", [1, 2]],
    ["a string", "record"],
    ["null", null],
    ["no record", { seats }],
    ["no seats", { record }],
  ])("answers 400 to %s without calling the service", async (_name, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the request body must be an object with `record` and `seats`" });
    expect(verifyAndStoreMock).not.toHaveBeenCalled();
  });

  it("maps RecordInvalid to 400 with the service's message", async () => {
    verifyAndStoreMock.mockRejectedValue(new RecordInvalid("the record does not replay: turn 3: illegal play"));
    const res = await POST(post({ record, seats }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the record does not replay: turn 3: illegal play" });
  });

  it("maps GameNotFinished to 400 with the service's message", async () => {
    verifyAndStoreMock.mockRejectedValue(new GameNotFinished("the game is not finished"));
    const res = await POST(post({ record, seats }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the game is not finished" });
  });

  it("answers 500 with a generic message when the database is not configured, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    verifyAndStoreMock.mockRejectedValue(new DatabaseNotConfigured());
    const res = await POST(post({ record, seats }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "the game could not be saved" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][1])).toContain("DATABASE_URL");
  });

  it("answers 500 with a generic message on any other failure (never the internal text)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    verifyAndStoreMock.mockRejectedValue(new Error("connect ECONNREFUSED postgres:5432"));
    const res = await POST(post({ record, seats }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("the game could not be saved");
    expect(body.error).not.toContain("ECONNREFUSED");
  });

  it("refuses a body that declares itself oversized with 413 before reading it", async () => {
    const res = await POST(post({ record, seats }, { headers: { "content-length": String(50 * 1024 * 1024) } }));
    expect(res.status).toBe(413);
    expect(verifyAndStoreMock).not.toHaveBeenCalled();
  });

  it("refuses a chunked body (no Content-Length) with 413 as soon as it passes the cap, without reading the rest", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const chunks = 1600; // 100 MiB on offer
    const pulled = { count: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled.count >= chunks) {
          controller.close();
          return;
        }
        pulled.count += 1;
        controller.enqueue(chunk);
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
      body,
      duplex: "half",
    };
    const request = new Request("http://backgammon.test/api/games", init);
    expect(request.headers.get("content-length")).toBeNull();

    const res = await POST(request);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: `the request body must be at most ${String(MAX_BODY_BYTES)} bytes` });
    // 2 MiB is 32 chunks: the stream was cut off there, not drained.
    expect(pulled.count).toBeLessThanOrEqual(40);
    expect(verifyAndStoreMock).not.toHaveBeenCalled();
  });

  it("measures the cap in bytes, not characters: 2,000,000 two-byte characters are 4,000,000 bytes", async () => {
    const text = `"${"é".repeat(2_000_000)}"`; // a valid JSON string, 4,000,002 bytes of UTF-8
    expect(text.length).toBeLessThan(MAX_BODY_BYTES);
    const res = await POST(post(null, { raw: text }));
    expect(res.status).toBe(413);
    expect(verifyAndStoreMock).not.toHaveBeenCalled();
  });

  it("accepts a body just under the cap and refuses one just over it", async () => {
    const pad = (bytes: number): string => JSON.stringify({ record, seats, pad: "" }).replace('"pad":""', `"pad":"${"x".repeat(bytes)}"`);
    const base = new TextEncoder().encode(pad(0)).byteLength;
    expect((await POST(post(null, { raw: pad(MAX_BODY_BYTES - base) }))).status).toBe(201);
    expect((await POST(post(null, { raw: pad(MAX_BODY_BYTES - base + 1) }))).status).toBe(413);
  });

  it("answers 400 to a request without a body", async () => {
    const request = new Request("http://backgammon.test/api/games", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "the request body is not valid JSON" });
  });

  it(`limits one address to ${String(RATE_LIMIT_PER_MINUTE)} posts per minute, then answers 429 with Retry-After`, async () => {
    const ip = nextIp();
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      expect((await POST(post({ record, seats }, { ip }))).status).toBe(201);
    }
    const res = await POST(post({ record, seats }, { ip }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "too many games posted from this address; try again in a minute" });
    expect(verifyAndStoreMock).toHaveBeenCalledTimes(RATE_LIMIT_PER_MINUTE);
    // Another address is unaffected.
    expect((await POST(post({ record, seats }))).status).toBe(201);
  });

  it("counts a refused (invalid) post against the limit too", async () => {
    const ip = nextIp();
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      await POST(post("junk", { ip }));
    }
    expect((await POST(post({ record, seats }, { ip }))).status).toBe(429);
  });
});

describe("GET /api/games/[id]", () => {
  const stored: StoredGame = {
    id: "cm0000000000000000000001",
    format: "single",
    matchLength: 0,
    botLevel: "beginner",
    status: "finished",
    seed: 42,
    record,
    result: { winner: "black", kind: "gammon", points: 4, score: { white: 0, black: 4 } },
    seats: { white: { kind: "guest", name: "Player One" }, black: { kind: "bot", level: "beginner" } },
    createdAt: new Date("2026-09-14T12:00:00Z"),
    finishedAt: new Date("2026-09-14T12:05:00Z"),
  };

  beforeEach(() => {
    getGameMock.mockReset();
  });

  it("answers exactly { record, result, seats } for a stored game", async () => {
    getGameMock.mockResolvedValue(stored);
    const res = await get(stored.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ record, result: stored.result, seats: stored.seats });
    expect(getGameMock).toHaveBeenCalledWith(stored.id);
  });

  it("leaves the seed out of the record of a remote game that is still live", async () => {
    for (const status of ["created", "active"] as const) {
      getGameMock.mockResolvedValue({ ...stored, status, botLevel: null, result: null, finishedAt: null });
      const body = (await (await get(stored.id)).json()) as { record: { seed?: number } };
      expect(body.record, status).not.toHaveProperty("seed");
      expect(body.record, status).toEqual({ length: record.length, rules: record.rules, turns: record.turns });
    }
    for (const status of ["finished", "abandoned"] as const) {
      getGameMock.mockResolvedValue({ ...stored, status });
      const body = (await (await get(stored.id)).json()) as { record: { seed?: number } };
      expect(body.record.seed, status).toBe(record.seed);
    }
  });

  it("answers 404 for an unknown id", async () => {
    getGameMock.mockResolvedValue(null);
    const res = await get("cm0000000000000000000002");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such game" });
  });

  it("answers 404 for an id that cannot be a game id without asking the database", async () => {
    const res = await get("../etc/passwd");
    expect(res.status).toBe(404);
    expect(getGameMock).not.toHaveBeenCalled();
  });

  it("answers 500 with a generic message when the lookup fails, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getGameMock.mockRejectedValue(new Error("stored game is malformed: seed exceeds 2^53 - 1"));
    const res = await get(stored.id);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "the game could not be read" });
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
