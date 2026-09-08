// @vitest-environment jsdom
// The Table layout (web/src/components/table/*) over a real game store driven
// by a scripted MockEngine: player cards (score, pips, cube), the action bar's
// disabled states, the status line, the finish banner, and the theme switch.

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { ActionBar } from "../../src/components/table/ActionBar";
import { PlayerCard } from "../../src/components/table/PlayerCard";
import { StatusLine, lastBotEvent, statusFor } from "../../src/components/table/StatusLine";
import { TableLayout } from "../../src/components/table/TableLayout";
import { ThemeSwitch } from "../../src/components/theme/ThemeSwitch";
import { THEME_BOOTSTRAP_SCRIPT } from "../../src/components/theme/useTheme";
import { MockEngine } from "../../src/engine/client";
import type { Board, ChosenPlay, GameState, MatchState, Play, Turn } from "../../src/engine/types";
import { DiceRng } from "../../src/game/dice";
import { openingRollTurn, rollTurn } from "../../src/game/record";
import { createGameStore, type GameStore, type GameStoreState } from "../../src/game/store";

// --- fixtures (same shapes as tests/store.test.ts) -------------------------

const OPENING: Board = {
  white: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
  black: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0],
};
const MONEY_RULES = { jacoby: true, beavers: false, autoDoubles: false };

function game(overrides: Partial<GameState> = {}): GameState {
  return { board: OPENING, onRoll: "white", dice: null, cube: { value: 1, owner: null }, phase: "toRoll", result: null, rules: MONEY_RULES, ...overrides };
}

function match(g: Partial<GameState> = {}, overrides: Partial<Omit<MatchState, "game">> = {}): MatchState {
  return { length: 0, score: { white: 0, black: 0 }, crawford: false, postCrawford: false, game: game(g), ...overrides };
}

const play = (notation: string, ...moves: [number, number, boolean?][]): Play => ({
  moves: moves.map(([from, to, hit = false]) => ({ from, to, hit })),
  notation,
});
const PROBS = { win: 0.5, winG: 0.1, winBg: 0.01, loseG: 0.1, loseBg: 0.01 };
const chosen = (p: Play, ...others: Play[]): ChosenPlay => ({
  play: p,
  candidates: [p, ...others].map((c, i) => ({ play: c, equity: 0.12 - i * 0.1, probs: PROBS, rollout: null })),
});

/** Seed 42: White wins the opening roll with 5-1. */
const SEED = 42;
const PLAYS = [play("13/8 6/5", [13, 8], [6, 5]), play("13/8 24/23", [13, 8], [24, 23]), play("24/19 19/18", [24, 19], [19, 18])];
const AFTER_13_8: Board = { ...OPENING, white: OPENING.white.map((n, i) => (i === 13 ? 4 : i === 8 ? 4 : n)) };
const AFTER_13_8_6_5: Board = { ...AFTER_13_8, white: AFTER_13_8.white.map((n, i) => (i === 6 ? 4 : i === 5 ? 1 : n)) };

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear"> {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

beforeAll(() => {
  expect(openingRollTurn(new DiceRng(SEED))).toEqual(rollTurn("white", { hi: 5, lo: 1 }));
  const existing = (window as { localStorage?: Partial<Storage> }).localStorage;
  if (typeof existing?.clear !== "function") {
    Object.defineProperty(window, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true });
  }
});

let engine: MockEngine;
let store: ReturnType<typeof createGameStore>;
const state = (): GameStore => store.getState();

beforeEach(() => {
  engine = new MockEngine();
  store = createGameStore(engine, { storage: null });
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(cleanup);

/** Opening for seed 42 replayed to "White to move with 5-1", legal plays loaded. */
async function startWhiteToMove(): Promise<void> {
  engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
  engine.script("legalPlays", PLAYS);
  await act(() => state().newGame({ format: "single", level: "beginner", seed: SEED }));
  expect(state().ui.lastError).toBeNull();
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });
const card = (name: string) => screen.getByRole("region", { name });

// --- TableLayout -----------------------------------------------------------

describe("<TableLayout>", () => {
  it("shows both player cards with pip counts and the score, and the computer on the left", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);

    const computer = card("Computer");
    const you = card("You");
    expect(within(computer).getByText("167")).toBeInTheDocument();
    expect(within(you).getByText("167")).toBeInTheDocument();
    expect(computer.compareDocumentPosition(you) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(computer).toHaveAttribute("data-player", "black");
    expect(you).toHaveAttribute("data-player", "white");
    expect(you).toHaveAttribute("data-on-roll", "true");
    expect(computer).not.toHaveAttribute("data-on-roll");
    // Clock is reserved but hidden until clocks exist.
    expect(within(you).getByText("Clock", { selector: "dt" }).closest("[hidden]")).not.toBeNull();
  });

  it("wires the action bar to the store with the right disabled states while White is to move", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);

    expect(button("Roll")).toBeDisabled();
    expect(button("Undo")).toBeDisabled();
    expect(button("Confirm")).toBeDisabled();
    expect(button("Double")).toBeDisabled();
    expect(button("Take")).toBeDisabled();
    expect(button("Drop")).toBeDisabled();
    expect(button("Resign")).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Your roll: 5-1");
  });

  it("enters moves on the board, enables Undo then Confirm, and shows the computer's reply", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);

    await userEvent.click(button(/^Point 13/));
    expect(button(/^Point 8/)).toHaveAttribute("data-legal", "true");
    engine.script("applyPlay", AFTER_13_8);
    await userEvent.click(button(/^Point 8/));
    expect(button("Undo")).toBeEnabled();
    expect(button("Confirm")).toBeDisabled();
    // The lifted checker appears moved: the store renders the pending board.
    expect(button(/^Point 8/)).toHaveAccessibleName("Point 8, 4 white checkers");

    await userEvent.click(button("Undo"));
    expect(button("Undo")).toBeDisabled();
    expect(button(/^Point 8/)).toHaveAccessibleName("Point 8, 3 white checkers");

    engine.script("applyPlay", AFTER_13_8, AFTER_13_8_6_5);
    await userEvent.click(button(/^Point 13/));
    await userEvent.click(button(/^Point 8/));
    await userEvent.click(button(/^Point 6/));
    await userEvent.click(button(/^Point 5/));
    expect(button("Confirm")).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("confirm");

    // Confirm → replay (bot to move) → choosePlay → replay (White to roll).
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "black", phase: "toMove", dice: { hi: 6, lo: 3 } }));
    engine.script("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10]), play("24/15", [24, 18], [18, 15])));
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "white", phase: "toRoll" }));
    await userEvent.click(button("Confirm"));

    expect(state().ui.lastError).toBeNull();
    expect(state().record?.turns.map((t) => t.action)).toEqual(["roll", "move", "move"]); // the mocked replay skipped the bot's toRoll phase
    expect(button("Roll")).toBeEnabled();
    expect(button("Double")).toBeEnabled();
    expect(button("Confirm")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/Your turn/);
    expect(screen.getByText(/Computer played 24\/18 13\/10 with 6-3/)).toBeInTheDocument();
    // The collapsed analysis line reports the bot's choice.
    expect(screen.getByRole("complementary", { name: "Analysis" })).toHaveTextContent(/24\/18 13\/10/);
  });

  it("offers Take and Drop when the computer doubles, and shows the cube on its owner's card", async () => {
    engine.script("replay", match({ onRoll: "black", phase: "doubled", cube: { value: 1, owner: null } }));
    await act(() => state().newGame({ format: "single", level: "beginner", seed: SEED }));
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);

    expect(button("Take")).toBeEnabled();
    expect(button("Drop")).toBeEnabled();
    expect(button("Roll")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("The computer doubles to 2");

    engine.script("replay", match({ onRoll: "black", phase: "toRoll", cube: { value: 2, owner: "white" } }));
    engine.script("replay", match({ onRoll: "black", phase: "toMove", dice: { hi: 4, lo: 2 }, cube: { value: 2, owner: "white" } }));
    engine.script("choosePlay", chosen(play("24/20 13/11", [24, 20], [13, 11])));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll", cube: { value: 2, owner: "white" } }));
    await userEvent.click(button("Take"));

    expect(state().ui.lastError).toBeNull();
    expect(within(card("You")).getByText("Cube", { selector: "dt" }).nextElementSibling).toHaveTextContent("2");
    expect(within(card("Computer")).queryByText("Cube", { selector: "dt" })).toBeNull();
    // White owns the cube now, so Double stays available to White on roll.
    expect(button("Double")).toBeEnabled();
  });

  it("resigns through the kind chooser with the points at the current cube", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);

    const resign = button("Resign");
    expect(resign).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(resign);
    expect(resign).toHaveAttribute("aria-expanded", "true");
    // Money game, cube centred: under the Jacoby rule a conceded gammon is a single point, and that is what the record logs.
    engine.script("replay", match({ onRoll: null, phase: "finished", result: { winner: "black", kind: "single", points: 1 } }));
    await userEvent.click(button(/Gammon/));

    expect(state().record?.turns.at(-1)).toMatchObject({ action: "resign", player: "white", resignPoints: 1 });
    expect(screen.getByRole("heading", { name: /The computer wins 1 point/ })).toBeInTheDocument();
  });

  it("shows the finish banner with the result and a Play again action", async () => {
    engine.script("replay", match({ onRoll: null, phase: "finished", result: { winner: "white", kind: "single", points: 1 } }));
    await act(() => state().newGame({ format: "single", level: "beginner", seed: SEED }));
    const onPlayAgain = vi.fn();
    render(<TableLayout store={store} onPlayAgain={onPlayAgain} />);

    expect(screen.getByRole("heading", { name: "You win 1 point" })).toBeInTheDocument();
    expect(button("Roll")).toBeDisabled();
    expect(button("Resign")).toBeDisabled();
    await userEvent.click(button("Play again"));
    expect(onPlayAgain).toHaveBeenCalledTimes(1);
  });

  it("renders the opening position and a setting-up status before the game exists", () => {
    const { container } = render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    expect(container.querySelectorAll('[data-testid^="checker-"]')).toHaveLength(30);
    expect(screen.getByRole("status")).toHaveTextContent("Setting up the table");
    expect(button("Roll")).toBeDisabled();
  });

  it("keeps keyboard focus on the table when Undo disables itself", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    engine.script("applyPlay", AFTER_13_8);
    await userEvent.click(button(/^Point 13/));
    await userEvent.click(button(/^Point 8/));
    const undo = button("Undo");
    undo.focus();
    await userEvent.keyboard("{Enter}");
    expect(undo).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(undo);
    expect(screen.getByRole("status")).toHaveFocus();
  });

  it("clears a lifted checker on Escape", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    await userEvent.click(button(/^Point 13/));
    expect(button(/^Point 13/)).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("status")).toHaveTextContent("choose a destination");
    await userEvent.keyboard("{Escape}");
    expect(button(/^Point 13/)).not.toHaveAttribute("data-selected");
    expect(screen.getByRole("status")).toHaveTextContent("pick a checker");
  });

  it("moves focus into the resign chooser, closes it on Escape and returns focus to Resign", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    const resign = button("Resign");
    await userEvent.click(resign);
    expect(button(/Single game/)).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(resign).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Single game/ })).toBeNull();
    expect(resign).toHaveFocus();
  });

  it("takes the board out of the tab order behind the finish banner and focuses the result", async () => {
    engine.script("replay", match({ onRoll: null, phase: "finished", result: { winner: "white", kind: "single", points: 1 } }));
    await act(() => state().newGame({ format: "single", level: "beginner", seed: SEED }));
    const { container } = render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    expect(container.querySelector(".table__board")).toHaveAttribute("inert");
    expect(screen.getByRole("heading", { name: "You win 1 point" })).toHaveFocus();
  });

  it("keeps the board live and the drawer toggle a plain disabled control during play", async () => {
    await startWhiteToMove();
    const { container } = render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    expect(container.querySelector(".table__board")).not.toHaveAttribute("inert");
    const toggle = screen.getByRole("button", { name: /^Open/ });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toHaveAttribute("aria-disabled");
  });

  it("labels resignation with the points the rules award: a gammon at a centred cube is a single under Jacoby", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    await userEvent.click(button("Resign"));
    expect(button(/Single game/)).toHaveTextContent("1 point");
    expect(button(/Gammon/)).toHaveTextContent("1 point");
    expect(button(/Backgammon/)).toHaveTextContent("1 point");
  });

  it("shows the finished game of a match with the score and waits for Next game", async () => {
    const toThree = { length: 3 };
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }, toThree));
    engine.script("legalPlays", PLAYS);
    await act(() => state().newGame({ format: { matchTo: 3 }, level: "beginner", seed: SEED }));
    const { container } = render(<TableLayout store={store} onPlayAgain={vi.fn()} />);

    // White resigns; the engine has already rolled the match over to the next game's opening roll.
    engine.script("replay", match({ onRoll: null, phase: "openingRoll", dice: null }, { ...toThree, score: { white: 0, black: 1 } }));
    await userEvent.click(button("Resign"));
    await userEvent.click(button(/Single game/));

    expect(state().awaitingNextGame).toBe(true);
    expect(screen.getByRole("heading", { name: "The computer wins 1 point" })).toBeInTheDocument();
    expect(screen.getByText("Score 0–1 in a match to 3")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The computer wins 1 point");
    expect(screen.getByRole("status")).not.toHaveTextContent(/Rolling/);
    expect(container.querySelector(".table__board")).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "Play again" })).toBeNull();

    // Next game: the store draws the opening roll and White is to move again.
    engine.script("replay", match({ phase: "toMove", dice: { hi: 3, lo: 1 } }, { ...toThree, score: { white: 0, black: 1 } }));
    engine.script("legalPlays", PLAYS);
    await userEvent.click(button("Next game"));
    expect(state().ui.lastError).toBeNull();
    expect(state().awaitingNextGame).toBe(false);
    expect(screen.queryByRole("button", { name: "Next game" })).toBeNull();
    expect(container.querySelector(".table__board")).not.toHaveAttribute("inert");
    expect(screen.getByRole("status")).toHaveTextContent("Your roll: 3-1");
  });

  it("offers Retry after an engine failure and keeps the error until it succeeds", async () => {
    await startWhiteToMove();
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    engine.script("applyPlay", AFTER_13_8, AFTER_13_8_6_5);
    await userEvent.click(button(/^Point 13/));
    await userEvent.click(button(/^Point 8/));
    await userEvent.click(button(/^Point 6/));
    await userEvent.click(button(/^Point 5/));
    engine.script("replay", new Error("engine: replay timed out"));
    await userEvent.click(button("Confirm"));

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-tone", "error");
    expect(status).toHaveTextContent("replay timed out");
    const retry = button("Retry");
    expect(retry).toBeEnabled();

    await userEvent.click(retry);
    expect(state().ui.lastError).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("status")).not.toHaveAttribute("data-tone", "error");
  });

  it("surfaces engine failures in the status line", async () => {
    engine.script("replay", new Error("parse error: turn 0: logged dice 5-1 but the seed gives 3-1"));
    await act(() => state().newGame({ format: "single", level: "beginner", seed: SEED }));
    render(<TableLayout store={store} onPlayAgain={vi.fn()} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/logged dice 5-1/);
    expect(status).toHaveAttribute("data-tone", "error");
  });
});

// --- statusFor / lastBotEvent ---------------------------------------------

describe("statusFor", () => {
  const base = (m: MatchState | null, ui: Partial<GameStoreState["ui"]> = {}): GameStoreState => ({
    gameId: "local-1",
    match: m,
    record: null,
    seatOf: { white: "human", black: "bot" },
    botLevel: "club",
    theme: "heritage",
    ui: { selectedFrom: null, legalTargets: [], pendingMoves: [], pendingBoard: null, legalPlays: null, busy: false, lastError: null, ...ui },
    analysis: { forBot: null, forHuman: null, visible: true },
    lastGameResult: null,
    awaitingNextGame: false,
  });

  it("describes every phase from the person's point of view", () => {
    expect(statusFor(base(null))).toEqual({ text: "Setting up the table…", tone: "busy" });
    expect(statusFor(base(match({ phase: "toRoll" }))).text).toBe("Your turn — roll, or double");
    expect(statusFor(base(match({ phase: "toRoll", cube: { value: 2, owner: "black" } }))).text).toBe("Your turn — roll");
    expect(statusFor(base(match({ phase: "toMove", dice: { hi: 6, lo: 6 } }), { legalPlays: PLAYS })).text).toBe("Your roll: 6-6 — pick a checker");
    expect(statusFor(base(match({ onRoll: "black", phase: "toRoll" })))).toEqual({ text: "Computer is thinking…", tone: "busy" });
    expect(statusFor(base(match({ onRoll: "white", phase: "doubled", cube: { value: 2, owner: "white" } }))).text).toBe("You doubled to 4 — waiting for the computer");
    expect(statusFor(base(match({ onRoll: null, phase: "finished", result: { winner: "black", kind: "backgammon", points: 6 } })))).toEqual({
      text: "The computer wins 6 points (backgammon)",
      tone: "result",
    });
    expect(statusFor(base(match(), { busy: true })).tone).toBe("busy");
    expect(statusFor(base(match(), { lastError: "engine: replay timed out" }))).toEqual({ text: "engine: replay timed out", tone: "error" });
  });

  it("reports the computer's last logged action until the person moves again", () => {
    const record = (turns: Turn[]) => ({ seed: 1, length: 0, rules: MONEY_RULES, turns });
    const s = base(match());
    const dice = { hi: 6, lo: 3 };
    expect(lastBotEvent({ ...s, record: record([rollTurn("black", dice), { player: "black", dice, action: "move", play: "24/18 13/10", resignPoints: null }]) })).toBe(
      "Computer played 24/18 13/10 with 6-3",
    );
    expect(lastBotEvent({ ...s, record: record([{ player: "black", dice, action: "move", play: "", resignPoints: null }, rollTurn("white", dice)]) })).toBe(
      "Computer could not move with 6-3",
    );
    expect(
      lastBotEvent({
        ...s,
        record: record([{ player: "black", dice, action: "move", play: "8/2 6/3", resignPoints: null }, { player: "white", dice, action: "move", play: "13/7 6/3", resignPoints: null }]),
      }),
    ).toBeNull();
    expect(lastBotEvent({ ...s, record: record([{ player: "black", dice: null, action: "take", play: null, resignPoints: null }]) })).toBe("Computer takes");
    expect(lastBotEvent({ ...s, record: null })).toBeNull();
  });
});

// --- StatusLine -----------------------------------------------------------

describe("<StatusLine>", () => {
  it("announces the computer's move through its own live region, kept mounted while empty", () => {
    const { rerender } = render(<StatusLine status={{ text: "Your turn — roll", tone: "info" }} ticker={null} />);
    const regions = document.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(2);
    const ticker = Array.from(regions).find((r) => r.getAttribute("role") !== "status");
    expect(ticker).toBeDefined();
    expect(ticker).toHaveTextContent("");
    rerender(<StatusLine status={{ text: "Your turn — roll", tone: "info" }} ticker="Computer played 24/18 13/10 with 6-3" />);
    expect(ticker).toHaveTextContent("Computer played 24/18 13/10 with 6-3");
    expect(screen.getByRole("status")).not.toContainElement(ticker as HTMLElement);
  });
});

// --- PlayerCard / ActionBar in isolation ------------------------------------

describe("<PlayerCard>", () => {
  it("shows the match score against its length and the cube when owned", () => {
    render(
      <PlayerCard player="black" name="Computer" caption="Club level" score={2} matchLength={5} pips={131} cube={{ value: 4, owner: "black" }} onRoll={false} side="left" />,
    );
    const region = card("Computer");
    expect(within(region).getByText("2")).toBeInTheDocument();
    expect(within(region).getByText("/5")).toBeInTheDocument();
    expect(within(region).getByText("131")).toBeInTheDocument();
    expect(within(region).getByText("Cube", { selector: "dt" }).nextElementSibling).toHaveTextContent("4");
  });
});

const POINTS_AT_2 = { single: 2, gammon: 4, backgammon: 6 } as const;

describe("<ActionBar>", () => {
  it("disables everything while busy and keeps the resign chooser closed", async () => {
    const onResign = vi.fn();
    const can = { roll: true, undo: true, confirm: true, double: true, take: true, drop: true, resign: true };
    render(<ActionBar can={can} busy pointsFor={(kind) => POINTS_AT_2[kind]} onRoll={vi.fn()} onUndo={vi.fn()} onConfirm={vi.fn()} onDouble={vi.fn()} onTake={vi.fn()} onDrop={vi.fn()} onResign={onResign} />);
    for (const name of ["Roll", "Undo", "Confirm", "Double", "Take", "Drop", "Resign"]) {
      expect(button(name)).toBeDisabled();
    }
    expect(screen.queryByRole("button", { name: /Gammon/ })).toBeNull();
  });

  it("calls the handlers and labels resignation with the points at stake", async () => {
    const handlers = { onRoll: vi.fn(), onUndo: vi.fn(), onConfirm: vi.fn(), onDouble: vi.fn(), onTake: vi.fn(), onDrop: vi.fn(), onResign: vi.fn() };
    const can = { roll: true, undo: true, confirm: true, double: true, take: true, drop: true, resign: true };
    render(<ActionBar can={can} busy={false} pointsFor={(kind) => POINTS_AT_2[kind]} {...handlers} />);
    await userEvent.click(button("Roll"));
    await userEvent.click(button("Double"));
    expect(handlers.onRoll).toHaveBeenCalledTimes(1);
    expect(handlers.onDouble).toHaveBeenCalledTimes(1);
    await userEvent.click(button("Resign"));
    expect(button(/Single game/)).toHaveTextContent("2 points");
    expect(button(/Backgammon/)).toHaveTextContent("6 points");
    await userEvent.click(button(/Backgammon/));
    expect(handlers.onResign).toHaveBeenCalledWith("backgammon");
    expect(button("Resign")).toHaveAttribute("aria-expanded", "false");
  });
});

// --- Theme -----------------------------------------------------------------

describe("<ThemeSwitch>", () => {
  it("marks the active theme and applies + persists a new one on <html>", async () => {
    render(<ThemeSwitch />);
    expect(button(/Tournament Heritage/)).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button(/Broadcast Modern/));
    expect(document.documentElement.getAttribute("data-theme")).toBe("broadcast");
    expect(window.localStorage.getItem("bg.theme")).toBe("broadcast");
    expect(button(/Broadcast Modern/)).toHaveAttribute("aria-pressed", "true");
    expect(button(/Tournament Heritage/)).toHaveAttribute("aria-pressed", "false");
  });

  it("ships a bootstrap script that restores the stored theme before paint", () => {
    window.localStorage.setItem("bg.theme", '"editorial"');
    new Function(THEME_BOOTSTRAP_SCRIPT)();
    expect(document.documentElement.getAttribute("data-theme")).toBe("editorial");
    window.localStorage.setItem("bg.theme", "nonsense");
    document.documentElement.removeAttribute("data-theme");
    new Function(THEME_BOOTSTRAP_SCRIPT)();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});
