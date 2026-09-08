// @vitest-environment jsdom
// The /play/[gameId] client component (web/src/app/play/[gameId]/PlayGame.tsx)
// over a MockEngine-backed store: it starts the game once per id, retries a
// failed automatic step by itself a bounded number of times, and leaves a
// finished game of a match on show until "Next game".

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockEngine } from "../src/engine/client";
import type { Board, ChosenPlay, GameState, MatchState, Play } from "../src/engine/types";
import { DiceRng } from "../src/game/dice";
import { openingRollTurn } from "../src/game/record";
import { createGameStore } from "../src/game/store";

const holder = vi.hoisted(() => ({ store: null as unknown }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/game/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/game/store")>();
  return { ...actual, getGameStore: () => holder.store as ReturnType<typeof actual.createGameStore> };
});

// Imported after the mocks are declared (vi.mock is hoisted, the import is not).
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

const play = (notation: string, ...moves: [number, number][]): Play => ({
  moves: moves.map(([from, to]) => ({ from, to, hit: false })),
  notation,
});
const PROBS = { win: 0.5, winG: 0.1, winBg: 0.01, loseG: 0.1, loseBg: 0.01 };
const chosen = (p: Play): ChosenPlay => ({ play: p, candidates: [{ play: p, equity: 0, probs: PROBS, rollout: null }] });

function firstSeedWonBy(player: "white" | "black"): number {
  for (let seed = 1; seed < 1000; seed++) {
    if (openingRollTurn(new DiceRng(seed)).player === player) {
      return seed;
    }
  }
  throw new Error("no seed found");
}

const BOT_SEED = firstSeedWonBy("black");
const OPENING_TURN = openingRollTurn(new DiceRng(BOT_SEED));

let engine: MockEngine;
let store: ReturnType<typeof createGameStore>;

const tick = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  engine = new MockEngine();
  store = createGameStore(engine, { storage: null });
  holder.store = store;
  // The bot wins the opening roll and is to move; after its move White is to roll.
  engine.always("replay", (record) =>
    record.turns.length === 1 ? match({ onRoll: "black", phase: "toMove", dice: OPENING_TURN.dice }) : match({ onRoll: "white", phase: "toRoll" }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<PlayGame>", () => {
  it("starts the game for the id once, with the page's options", async () => {
    engine.always("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10])));
    const view = render(<PlayGame gameId={`local-${String(BOT_SEED)}`} seed={BOT_SEED} format="single" level="club" />);
    await tick(0);
    expect(store.getState().gameId).toBe(`local-${String(BOT_SEED)}`);
    expect(store.getState().botLevel).toBe("club");
    expect(engine.callsTo("replay")[0][0].seed).toBe(BOT_SEED);
    view.rerender(<PlayGame gameId={`local-${String(BOT_SEED)}`} seed={BOT_SEED} format="single" level="club" />);
    await tick(5_000);
    expect(engine.callsTo("replay")).toHaveLength(2);
    expect(store.getState().ui.lastError).toBeNull();
  });

  it("retries a failed bot turn by itself and carries on once the engine answers", async () => {
    engine.script("choosePlay", new Error("engine: choosePlay timed out after 10000 ms"));
    engine.always("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10])));
    render(<PlayGame gameId={`local-${String(BOT_SEED)}`} seed={BOT_SEED} format="single" level="beginner" />);
    await tick(0);
    expect(store.getState().ui.lastError).toMatch(/timed out/);
    expect(store.getState().record?.turns).toHaveLength(1);

    await tick(1_400);
    expect(engine.callsTo("choosePlay")).toHaveLength(1);
    await tick(200);
    expect(engine.callsTo("choosePlay")).toHaveLength(2);
    expect(store.getState().ui.lastError).toBeNull();
    expect(store.getState().record?.turns).toHaveLength(2);
    expect(store.getState().match?.game.onRoll).toBe("white");
  });

  it("gives up after two automatic retries and leaves the error for a manual Retry", async () => {
    engine.always("choosePlay", new Error("engine worker failed"));
    render(<PlayGame gameId={`local-${String(BOT_SEED)}`} seed={BOT_SEED} format="single" level="beginner" />);
    await tick(0);
    await tick(1_500); // first retry
    await tick(3_000); // second retry, after a longer pause
    await tick(60_000);
    expect(engine.callsTo("choosePlay")).toHaveLength(3);
    expect(store.getState().ui.lastError).toMatch(/worker failed/);
    expect(store.getState().ui.busy).toBe(false);

    // A manual retry (the store action a Retry control calls) is still available and counts afresh.
    engine.always("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10])));
    await act(() => store.getState().retryBotTurn());
    expect(store.getState().ui.lastError).toBeNull();
    expect(store.getState().record?.turns).toHaveLength(2);
  });

  it("does not start the next game of a match while the finished one is on show", async () => {
    engine.always("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10])));
    render(<PlayGame gameId={`local-${String(BOT_SEED)}`} seed={BOT_SEED} format={{ matchTo: 5 }} level="beginner" />);
    await tick(0);
    const before = engine.calls.length;
    act(() => {
      store.setState({
        match: match({ onRoll: null, phase: "openingRoll" }, { length: 5, score: { white: 1, black: 0 } }),
        lastGameResult: { winner: "white", kind: "single", points: 1 },
        awaitingNextGame: true,
      });
    });
    await tick(10_000);
    expect(engine.calls).toHaveLength(before);
    expect(store.getState().awaitingNextGame).toBe(true);

    await act(() => store.getState().nextGame());
    expect(store.getState().awaitingNextGame).toBe(false);
    expect(engine.calls.length).toBeGreaterThan(before);
  });
});
