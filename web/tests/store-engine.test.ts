// The game store against the real engine (bg-wasm through the Node loader
// wrapped as an async Engine): whole games are played to a finish with a
// scripted "human" who always takes the first legal source and target,
// doubles when allowed and resigns once, so the dice port, the opening roll,
// forced passes, the engine's notation, the cube and the bot chain are all
// verified by the engine's own `replay`. Skipped when engine/bg-wasm/pkg is
// not built (fails under CI like the parity suite).

import { describe, expect, it } from "vitest";

import type { Engine } from "../src/engine/client";
import { loadEngineNode, locateBgWasmPkg, type EngineSync } from "../src/engine/node";
import type { Record as GameRecord } from "../src/engine/types";
import { GAMES_KEY_PREFIX, type StorageLike } from "../src/game/local-games";
import {
  canConfirm,
  canDouble,
  canResign,
  canRoll,
  isAwaitingNextGame,
  isHumanTurn,
  legalSources,
  legalTargetsFrom,
  pipCounts,
} from "../src/game/selectors";
import { createGameStore, type GameStore } from "../src/game/store";

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

/** The synchronous Node engine behind the asynchronous `Engine` interface. */
function asAsyncEngine(sync: EngineSync): Engine {
  return {
    legalPlays: async (...a) => sync.legalPlays(...a),
    applyPlay: async (...a) => sync.applyPlay(...a),
    choosePlay: async (...a) => sync.choosePlay(...a),
    cubeAction: async (...a) => sync.cubeAction(...a),
    analyzePlay: async (...a) => sync.analyzePlay(...a),
    replay: async (...a) => sync.replay(...a),
    version: async () => sync.version(),
    terminate: () => {},
  };
}

const MAX_ACTIONS = 4000;

interface Decisions {
  /** Offer a double now (only consulted when `canDouble`). */
  double?: (st: GameStore, played: PlayLog) => boolean;
  /** Resign a single game now (only consulted when `canResign`). */
  resign?: (st: GameStore, played: PlayLog) => boolean;
}

interface PlayLog {
  actions: string[];
  /** Games decided so far (score changes seen). */
  games: number;
  /** Results shown while the store waited for "Next game" between the games of a match. */
  shownBetweenGames: string[];
}

/**
 * Plays the human's side until the game (money) or the match is over: first
 * legal source, first legal target, confirm; take every double. Returns what
 * was done. Between the games of a match the store shows the finished game's
 * result until "Next game"; `playOut` presses it, so one call covers a whole
 * match.
 */
async function playOut(store: ReturnType<typeof createGameStore>, decide: Decisions = {}): Promise<PlayLog> {
  const log: PlayLog = { actions: [], games: 0, shownBetweenGames: [] };
  const s = (): GameStore => store.getState();
  let lastScore = JSON.stringify(s().match?.score);
  for (let i = 0; i < MAX_ACTIONS; i++) {
    const st = s();
    if (st.ui.lastError) {
      throw new Error(`store error after ${log.actions.join(", ")}: ${st.ui.lastError}`);
    }
    const g = st.match?.game;
    if (!g) {
      throw new Error("no match");
    }
    const score = JSON.stringify(st.match!.score);
    if (score !== lastScore) {
      lastScore = score;
      log.games += 1;
      expect(st.lastGameResult).not.toBeNull();
    }
    if (g.phase === "finished") {
      return log;
    }
    if (isAwaitingNextGame(st)) {
      // The finished game's result is on show until the person asks for the next game.
      expect(g.phase).toBe("openingRoll");
      expect(st.lastGameResult).not.toBeNull();
      log.shownBetweenGames.push(`${st.lastGameResult!.winner} ${String(st.lastGameResult!.points)}`);
      log.actions.push("next");
      await st.nextGame();
      continue;
    }
    if (!isHumanTurn(st)) {
      throw new Error(`expected the human to act in phase ${g.phase} (onRoll ${g.onRoll})`);
    }
    if (g.phase === "doubled") {
      log.actions.push("take");
      await st.take();
      continue;
    }
    if (canResign(st) && decide.resign?.(st, log)) {
      log.actions.push("resign");
      await st.resign("single");
      continue;
    }
    if (canRoll(st)) {
      if (canDouble(st) && decide.double?.(st, log)) {
        log.actions.push("double");
        await st.double();
        continue;
      }
      log.actions.push("roll");
      await st.roll();
      continue;
    }
    if (g.phase === "toMove") {
      const sources = legalSources(st);
      if (sources.length === 0) {
        throw new Error(`no legal source while toMove with ${JSON.stringify(st.ui.pendingMoves)}`);
      }
      await st.selectPoint(sources[0]);
      const targets = s().ui.legalTargets;
      expect(targets.length).toBeGreaterThan(0);
      await st.selectPoint(targets[0]);
      log.actions.push(`${sources[0]}/${targets[0]}`);
      if (canConfirm(s())) {
        log.actions.push("confirm");
        await s().confirmPlay();
      }
      continue;
    }
    throw new Error(`unexpected phase ${g.phase}`);
  }
  throw new Error(`game did not finish within ${MAX_ACTIONS} actions`);
}

const pkgDir = locateBgWasmPkg();

describe.skipIf(pkgDir === null)("game store against the real engine", () => {
  it("plays a seeded money game to the end; the record replays and is stored", async () => {
    const sync = await loadEngineNode();
    const storage = new MemoryStorage();
    const store = createGameStore(asAsyncEngine(sync), { storage });
    await store.getState().newGame({ format: "single", level: "beginner", seed: 42 });
    expect(store.getState().ui.lastError).toBeNull();
    expect(store.getState().record?.turns[0]).toEqual({
      player: "white",
      dice: { hi: 5, lo: 1 },
      action: "roll",
      play: null,
      resignPoints: null,
    });

    const { actions, games } = await playOut(store);
    const st = store.getState();
    expect(st.match?.game.phase).toBe("finished");
    expect(games).toBe(1);
    expect(st.lastGameResult).toEqual(st.match?.game.result);
    expect(st.lastGameResult?.points).toBeGreaterThanOrEqual(1);
    expect(actions.length).toBeGreaterThan(10);

    // The stored record is exactly what the engine replays to the final state.
    const stored = JSON.parse(storage.getItem(`${GAMES_KEY_PREFIX}local-42`)!) as GameRecord;
    expect(stored).toEqual(st.record);
    expect(sync.replay(stored)).toEqual(st.match);
    const moves = stored.turns.filter((t) => t.action === "move");
    const rolls = stored.turns.filter((t) => t.action === "roll");
    expect(moves.length).toBe(rolls.length);
    expect(st.analysis.forBot?.chosen.candidates.length).toBeGreaterThan(0);
    const loser = st.lastGameResult!.winner === "white" ? "black" : "white";
    expect(pipCounts(st.match!.game.board)[st.lastGameResult!.winner]).toBe(0);
    expect(pipCounts(st.match!.game.board)[loser]).toBeGreaterThan(0);
  }, 60_000);

  it("plays a 5-point match — a resignation, doubles, the automatic next games — until it is over", async () => {
    const sync = await loadEngineNode();
    const store = createGameStore(asAsyncEngine(sync), { storage: null });
    await store.getState().newGame({ format: { matchTo: 5 }, level: "beginner", seed: 7 });

    const log = await playOut(store, {
      // Resign the first game early (1 point at cube 1), so the match goes on.
      resign: (_st, played) => played.games === 0 && played.actions.length >= 6 && !played.actions.includes("resign"),
      // From the second game on, double whenever allowed (the bot takes or drops).
      double: (_st, played) => played.games >= 1,
    });

    const st = store.getState();
    expect(st.match?.game.phase).toBe("finished");
    expect(Math.max(st.match!.score.white, st.match!.score.black)).toBeGreaterThanOrEqual(5);
    expect(log.games).toBeGreaterThanOrEqual(2);
    // Every game but the last was followed by a pause showing its result.
    expect(log.shownBetweenGames).toHaveLength(log.games - 1);
    expect(log.actions.filter((a) => a === "next")).toHaveLength(log.games - 1);
    expect(log.actions.filter((a) => a === "resign")).toHaveLength(1);
    expect(log.actions.filter((a) => a === "double").length).toBeGreaterThanOrEqual(1);
    expect(st.lastGameResult).toEqual(st.match?.game.result);
    // Every game's opening roll was logged by its winner; the record replays to the final state.
    const record = st.record!;
    expect(record.turns[0]).toMatchObject({ action: "roll" });
    expect(record.turns.filter((t) => t.action === "resign")).toHaveLength(1);
    expect(record.turns.filter((t) => t.action === "double").length).toBeGreaterThanOrEqual(1);
    expect(sync.replay(record)).toEqual(st.match);
  }, 120_000);

  it("a gammon resigned at a centred cube in a money game logs the single point the Jacoby rule awards", async () => {
    const sync = await loadEngineNode();
    const store = createGameStore(asAsyncEngine(sync), { storage: null });
    await store.getState().newGame({ format: "single", level: "beginner", seed: 42 });
    expect(canResign(store.getState())).toBe(true);
    await store.getState().resign("gammon");
    const st = store.getState();
    expect(st.ui.lastError).toBeNull();
    expect(st.match?.game.phase).toBe("finished");
    expect(st.match?.game.result).toEqual({ winner: "black", kind: "single", points: 1 });
    expect(st.record?.turns.at(-1)).toMatchObject({ action: "resign", resignPoints: 1 });
    expect(sync.replay(st.record!)).toEqual(st.match);
  });

  it("a backgammon resigned in a match logs the full three points", async () => {
    const sync = await loadEngineNode();
    const store = createGameStore(asAsyncEngine(sync), { storage: null });
    await store.getState().newGame({ format: { matchTo: 7 }, level: "beginner", seed: 42 });
    await store.getState().resign("backgammon");
    const st = store.getState();
    expect(st.ui.lastError).toBeNull();
    expect(st.lastGameResult).toEqual({ winner: "black", kind: "backgammon", points: 3 });
    expect(st.match?.score).toEqual({ white: 0, black: 3 });
    expect(isAwaitingNextGame(st)).toBe(true);
    expect(sync.replay(st.record!)).toEqual(st.match);
  });

  it("never offers a bear-off the engine would reject: 6/off only after 8/6 with 6-2", async () => {
    const sync = await loadEngineNode();
    const store = createGameStore(asAsyncEngine(sync), { storage: null });
    await store.getState().newGame({ format: "single", level: "beginner", seed: 42 });
    // White: one checker on 8, fourteen home; Black: five each on 19–21. White to move 6-2.
    const board = {
      white: Array.from({ length: 26 }, (_, i) => ({ 8: 1, 6: 4, 5: 3, 4: 3, 3: 2, 2: 1, 1: 1 })[i] ?? 0),
      black: Array.from({ length: 26 }, (_, i) => (i === 19 || i === 20 || i === 21 ? 5 : 0)),
    };
    const dice = { hi: 6, lo: 2 };
    const plays = sync.legalPlays(board, "white", dice);
    expect(plays.map((p) => p.notation)).toEqual(["8/6 6/off", "8/2 6/4", "8/2 5/3", "8/2 4/2", "8/2 3/1"]);
    const before = store.getState();
    store.setState({
      match: { ...before.match!, game: { ...before.match!.game, board, onRoll: "white", dice, phase: "toMove" } },
      ui: { ...before.ui, legalPlays: plays },
    });

    expect(legalTargetsFrom(store.getState(), 6)).toEqual([4]);
    expect(legalSources(store.getState())).toEqual([8, 6, 5, 4, 3]);
    await store.getState().selectPoint(8);
    await store.getState().selectPoint(6);
    expect(store.getState().ui.lastError).toBeNull();
    expect(legalTargetsFrom(store.getState(), 6)).toEqual([0]);
    await store.getState().selectPoint(6);
    await store.getState().selectPoint(0);
    const st = store.getState();
    expect(st.ui.lastError).toBeNull();
    expect(st.ui.pendingMoves).toEqual([
      { from: 8, to: 6, hit: false },
      { from: 6, to: 0, hit: false },
    ]);
    expect(canConfirm(st)).toBe(true);
  });

  it("resumes a stored in-progress game from its record and plays it to the end", async () => {
    const sync = await loadEngineNode();
    const storage = new MemoryStorage();
    const first = createGameStore(asAsyncEngine(sync), { storage });
    await first.getState().newGame({ format: { matchTo: 3 }, level: "beginner", seed: 11 });
    // A few turns in, with a doubled cube so the resumed match state is non-trivial.
    for (let i = 0; i < 4; i++) {
      const st = first.getState();
      if (canRoll(st)) {
        await (canDouble(st) && i === 2 ? st.double() : st.roll());
      } else if (st.match?.game.phase === "doubled") {
        await st.take();
      } else if (st.match?.game.phase === "toMove") {
        const src = legalSources(st)[0];
        await st.selectPoint(src);
        await st.selectPoint(first.getState().ui.legalTargets[0]);
        if (canConfirm(first.getState())) {
          await first.getState().confirmPlay();
        }
      } else if (isAwaitingNextGame(st)) {
        await st.nextGame();
      }
      expect(first.getState().ui.lastError).toBeNull();
    }
    const stored = JSON.parse(storage.getItem(`${GAMES_KEY_PREFIX}local-11`)!) as GameRecord;
    expect(stored.turns.length).toBeGreaterThanOrEqual(4);
    expect(stored).toEqual(first.getState().record);

    // Reopen the same id elsewhere: the record is picked up, not restarted, and the dice stay in step.
    const second = createGameStore(asAsyncEngine(sync), { storage });
    await second.getState().newGame({ format: { matchTo: 3 }, level: "beginner", seed: 11 });
    expect(second.getState().ui.lastError).toBeNull();
    expect(second.getState().record?.turns.slice(0, stored.turns.length)).toEqual(stored.turns);
    expect(second.getState().match?.score).toEqual(first.getState().match?.score);

    const log = await playOut(second);
    const st = second.getState();
    expect(st.match?.game.phase).toBe("finished");
    expect(Math.max(st.match!.score.white, st.match!.score.black)).toBeGreaterThanOrEqual(3);
    expect(log.actions.length).toBeGreaterThan(0);
    expect(sync.replay(st.record!)).toEqual(st.match);
    expect(JSON.parse(storage.getItem(`${GAMES_KEY_PREFIX}local-11`)!)).toEqual(st.record);

    // Reopening a finished game shows it as finished and leaves the stored record untouched.
    const third = createGameStore(asAsyncEngine(sync), { storage });
    await third.getState().newGame({ format: "single", level: "club", seed: 11 });
    expect(third.getState().ui.lastError).toBeNull();
    expect(third.getState().record).toEqual(st.record);
    expect(third.getState().match).toEqual(st.match);
    expect(third.getState().lastGameResult).toEqual(st.match?.game.result);
    expect(JSON.parse(storage.getItem(`${GAMES_KEY_PREFIX}local-11`)!)).toEqual(st.record);
  }, 120_000);
});
