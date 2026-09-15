// Posting a finished bot game once (web/src/game/persist.ts): the record goes
// to POST /api/games with the human as White guest and the computer's level as
// Black; the server id is remembered under `bg.games.<id>.posted` so a reload
// never posts twice; a 400 is remembered as rejected (the record will not
// become valid), while a network failure or 5xx is not remembered and so is
// retried on the next load. Concurrent calls for one id share one request.

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Record as GameRecord } from "../src/engine/types";
import { GAMES_KEY_PREFIX, type StorageLike } from "../src/game/local-games";
import {
  DEFAULT_GUEST_NAME,
  POSTED_SUFFIX,
  loadPostedMarker,
  postFinishedGame,
  postedKey,
  savePostedMarker,
} from "../src/game/persist";

const record = JSON.parse(readFileSync(new URL("./fixtures/finished-record.json", import.meta.url), "utf8")) as GameRecord;

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
  key = (i: number) => [...this.map.keys()][i] ?? null;
  get length() {
    return this.map.size;
  }
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let counter = 0;
const freshId = () => `local-${String(++counter)}`;

describe("posted marker", () => {
  it("lives under bg.games.<id>.posted", () => {
    expect(postedKey("local-42")).toBe(`${GAMES_KEY_PREFIX}local-42${POSTED_SUFFIX}`);
  });

  it("round-trips a server id and a rejection, and reads null when absent or malformed", () => {
    const storage = new MemoryStorage();
    expect(loadPostedMarker("local-1", storage)).toBeNull();
    expect(savePostedMarker("local-1", { serverId: "cm01" }, storage)).toBe(true);
    expect(loadPostedMarker("local-1", storage)).toEqual({ serverId: "cm01" });
    savePostedMarker("local-2", { rejected: "the game is not finished" }, storage);
    expect(loadPostedMarker("local-2", storage)).toEqual({ rejected: "the game is not finished" });
    storage.setItem(postedKey("local-3"), "{oops");
    expect(loadPostedMarker("local-3", storage)).toBeNull();
    storage.setItem(postedKey("local-4"), JSON.stringify({ something: 1 }));
    expect(loadPostedMarker("local-4", storage)).toBeNull();
  });

  it("tolerates a missing storage", () => {
    expect(loadPostedMarker("local-1", null)).toBeNull();
    expect(savePostedMarker("local-1", { serverId: "x" }, null)).toBe(false);
  });
});

describe("postFinishedGame", () => {
  let storage: MemoryStorage;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    storage = new MemoryStorage();
    fetchMock = vi.fn<typeof fetch>();
  });

  it("posts the record with White as guest and Black as the computer, then remembers the id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "cm0000000000000000000001" }));
    const id = freshId();
    const outcome = await postFinishedGame({ id, record, level: "club", fetch: fetchMock, storage });
    expect(outcome).toEqual({ status: "posted", serverId: "cm0000000000000000000001" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/games");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      record,
      seats: { white: { kind: "guest", name: DEFAULT_GUEST_NAME }, black: { kind: "bot", level: "club" } },
    });
    expect(loadPostedMarker(id, storage)).toEqual({ serverId: "cm0000000000000000000001" });
  });

  it("does not post again once the id is remembered", async () => {
    const id = freshId();
    savePostedMarker(id, { serverId: "cm0" }, storage);
    const outcome = await postFinishedGame({ id, record, level: "beginner", fetch: fetchMock, storage });
    expect(outcome).toEqual({ status: "already", marker: { serverId: "cm0" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("remembers a 400 as rejected and does not retry it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "the game is not finished" }));
    const id = freshId();
    expect(await postFinishedGame({ id, record, level: "beginner", fetch: fetchMock, storage })).toEqual({
      status: "rejected",
      error: "the game is not finished",
    });
    expect(loadPostedMarker(id, storage)).toEqual({ rejected: "the game is not finished" });
    expect(await postFinishedGame({ id, record, level: "beginner", fetch: fetchMock, storage })).toEqual({
      status: "already",
      marker: { rejected: "the game is not finished" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch")), "Failed to fetch"],
    // A 5xx body is generic by design (spec §8), so the status is the useful part.
    ["a 500", () => Promise.resolve(jsonResponse(500, { error: "the game could not be saved" })), "server error (HTTP 500)"],
    ["a 503 without JSON", () => Promise.resolve(new Response("upstream down", { status: 503 })), "server error (HTTP 503)"],
    ["a 429", () => Promise.resolve(new Response("busy", { status: 429 })), "HTTP 429"],
    ["a 429 with a reason", () => Promise.resolve(jsonResponse(429, { error: "too many games posted from this address" })), "too many games posted from this address"],
    ["a 201 without an id", () => Promise.resolve(jsonResponse(201, { ok: true })), "the server did not return a game id"],
  ])("reports %s as failed, remembers nothing and retries next time", async (_name, impl, message) => {
    fetchMock.mockImplementationOnce(impl).mockResolvedValueOnce(jsonResponse(201, { id: "cm1" }));
    const id = freshId();
    expect(await postFinishedGame({ id, record, level: "beginner", fetch: fetchMock, storage })).toEqual({
      status: "failed",
      error: message,
    });
    expect(loadPostedMarker(id, storage)).toBeNull();
    expect(await postFinishedGame({ id, record, level: "beginner", fetch: fetchMock, storage })).toEqual({
      status: "posted",
      serverId: "cm1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent calls for the same id", async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    const id = freshId();
    const a = postFinishedGame({ id, record, level: "beginner", fetch: fetchMock, storage });
    const b = postFinishedGame({ id, record, level: "beginner", fetch: fetchMock, storage });
    release(jsonResponse(201, { id: "cm2" }));
    expect(await Promise.all([a, b])).toEqual([
      { status: "posted", serverId: "cm2" },
      { status: "posted", serverId: "cm2" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports failed when no fetch is available (server rendering)", async () => {
    expect(await postFinishedGame({ id: freshId(), record, level: "beginner", fetch: null, storage })).toEqual({
      status: "failed",
      error: "fetch is not available",
    });
  });

  it("uses a trimmed guest name when one is given, else the default", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "cm3" }));
    await postFinishedGame({ id: freshId(), record, level: "beginner", guestName: "  Ada  ", fetch: fetchMock, storage });
    await postFinishedGame({ id: freshId(), record, level: "beginner", guestName: "   ", fetch: fetchMock, storage });
    const names = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { seats: { white: { name: string } } }).seats.white.name);
    expect(names).toEqual(["Ada", DEFAULT_GUEST_NAME]);
  });
});
