// @vitest-environment jsdom
// PlayGame posts a finished bot game to /api/games exactly once
// (web/src/game/persist.ts wired in web/src/app/play/[gameId]/PlayGame.tsx):
// nothing is posted while the game runs, one POST when the match is over,
// none on a later render once `bg.games.<id>.posted` is set, and a note under
// the table when the server could not save it.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockEngine } from "../src/engine/client";
import type { Board, GameState, MatchState } from "../src/engine/types";
import { DiceRng } from "../src/game/dice";
import { saveLocalGame, saveLocalGameLevel, type StorageLike } from "../src/game/local-games";
import { loadPostedMarker, postedKey, savePostedMarker } from "../src/game/persist";
import { openingRollTurn } from "../src/game/record";
import { createGameStore } from "../src/game/store";

const holder = vi.hoisted(() => ({ store: null as unknown }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/game/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/game/store")>();
  return { ...actual, getGameStore: () => holder.store as ReturnType<typeof actual.createGameStore> };
});

import { PlayGame } from "../src/app/play/[gameId]/PlayGame";

const OPENING: Board = {
  white: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
  black: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0],
};
const MONEY_RULES = { jacoby: true, beavers: false, autoDoubles: false };

function match(g: Partial<GameState> = {}, overrides: Partial<Omit<MatchState, "game">> = {}): MatchState {
  return {
    length: 0,
    score: { white: 0, black: 0 },
    crawford: false,
    postCrawford: false,
    game: { board: OPENING, onRoll: "white", dice: null, cube: { value: 1, owner: null }, phase: "toRoll", result: null, rules: MONEY_RULES, ...g },
    ...overrides,
  };
}

const FINISHED = match({ onRoll: null, dice: null, phase: "finished", result: { winner: "white", kind: "single", points: 1 } }, { score: { white: 1, black: 0 } });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A seed White wins the opening roll with: White is then to move and nothing happens by itself. */
const SEED = 3;
let seedCounter = SEED;
const nextSeed = () => (seedCounter += 1000);

/** jsdom's `localStorage` is unavailable on the opaque test origin, so the page's default storage is stubbed. */
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

let store: ReturnType<typeof createGameStore>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let storage: MemoryStorage;

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  const engine = new MockEngine();
  // Any record replays to "White to roll" — the game never finishes by itself here.
  engine.always("replay", () => match());
  store = createGameStore(engine, { storage: null });
  holder.store = store;
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<PlayGame> persistence", () => {
  it("posts the record once when the game is over and remembers the server id", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "cm-server-1" }));
    const seed = nextSeed();
    const id = `local-${String(seed)}`;
    const view = render(<PlayGame gameId={id} seed={seed} format="single" level="club" />);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      store.setState({ match: FINISHED, lastGameResult: FINISHED.game.result });
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/games");
    const body = JSON.parse(String(init?.body)) as { record: { seed: number }; seats: { black: { level: string } } };
    expect(body.record.seed).toBe(seed);
    expect(body.seats.black.level).toBe("club");
    expect(loadPostedMarker(id)).toEqual({ serverId: "cm-server-1" });
    expect(screen.queryByText(/could not be saved/)).toBeNull();

    // A re-render (or a later visit) does not post again.
    view.rerender(<PlayGame gameId={id} seed={seed} format="single" level="club" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not post a game whose marker is already stored", async () => {
    const seed = nextSeed();
    const id = `local-${String(seed)}`;
    savePostedMarker(id, { serverId: "cm-earlier" });
    render(<PlayGame gameId={id} seed={seed} format="single" level="beginner" />);
    await flush();
    act(() => {
      store.setState({ match: FINISHED, lastGameResult: FINISHED.game.result });
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.getItem(postedKey(id))).toBe(JSON.stringify({ serverId: "cm-earlier" }));
  });

  it("tells the person when the server refused the record, and remembers the refusal", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "the game is not finished" }));
    const seed = nextSeed();
    const id = `local-${String(seed)}`;
    render(<PlayGame gameId={id} seed={seed} format="single" level="beginner" />);
    await flush();
    act(() => {
      store.setState({ match: FINISHED, lastGameResult: FINISHED.game.result });
    });
    await flush();
    const note = await screen.findByRole("note");
    expect(note.textContent).toBe("The server refused this game: the game is not finished. It stays on this device.");
    expect(note.getAttribute("data-outcome")).toBe("rejected");
    expect(loadPostedMarker(id)).toEqual({ rejected: "the game is not finished" });
  });

  it("tells the person a failed post will be retried, and remembers nothing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const seed = nextSeed();
    const id = `local-${String(seed)}`;
    render(<PlayGame gameId={id} seed={seed} format="single" level="beginner" />);
    await flush();
    act(() => {
      store.setState({ match: FINISHED, lastGameResult: FINISHED.game.result });
    });
    await flush();
    const note = await screen.findByRole("note");
    expect(note.textContent).toBe("This game could not be saved to the server: Failed to fetch. It stays on this device and will be sent again next time you open it.");
    expect(note.getAttribute("data-outcome")).toBe("failed");
    expect(loadPostedMarker(id)).toBeNull();
  });

  it("names the status when the server failed, instead of repeating its generic message", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "the game could not be saved" }));
    const seed = nextSeed();
    const id = `local-${String(seed)}`;
    render(<PlayGame gameId={id} seed={seed} format="single" level="beginner" />);
    await flush();
    act(() => {
      store.setState({ match: FINISHED, lastGameResult: FINISHED.game.result });
    });
    await flush();
    const note = await screen.findByRole("note");
    expect(note.textContent).toBe("This game could not be saved to the server: server error (HTTP 500). It stays on this device and will be sent again next time you open it.");
    expect(note.getAttribute("data-outcome")).toBe("failed");
  });

  it("posts the level the game was played at (stored beside the record), not the level in the URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: "cm-server-2" }));
    const seed = nextSeed();
    const id = `local-${String(seed)}`;
    // A club game started earlier: its record and level are in storage; the URL now says beginner.
    const record = { seed, length: 0, rules: MONEY_RULES, turns: [openingRollTurn(new DiceRng(seed))] };
    saveLocalGame(id, record, storage);
    saveLocalGameLevel(id, "club", storage);
    store = createGameStore(new MockEngine().always("replay", () => match()), { storage });
    holder.store = store;

    render(<PlayGame gameId={id} seed={seed} format="single" level="beginner" />);
    await flush();
    expect(store.getState().botLevel).toBe("club");
    act(() => {
      store.setState({ match: FINISHED, lastGameResult: FINISHED.game.result });
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as { seats: { black: { level: string } } };
    expect(body.seats.black.level).toBe("club");
  });
});
