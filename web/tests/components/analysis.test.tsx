// @vitest-environment jsdom
// The analysis drawer (web/src/components/analysis/*): the probability bar,
// grade badges, the candidate table, the move list, and the drawer itself
// over a real game store driven by a scripted MockEngine — the collapsed
// verdicts after a graded human play and a bot reply, the live-region
// announcement, the tabs (keyboard), the persisted on/off switch.

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import { AnalysisDrawer, SHEET_ATTRIBUTE } from "../../src/components/analysis/AnalysisDrawer";
import { CandidateList } from "../../src/components/analysis/CandidateList";
import { GradeBadge } from "../../src/components/analysis/GradeBadge";
import { MoveList } from "../../src/components/analysis/MoveList";
import { ProbBar } from "../../src/components/analysis/ProbBar";
import { botVerdict, formatEquity, formatPercent, gradeAnnouncement, humanVerdict } from "../../src/components/analysis/format";
import { MockEngine } from "../../src/engine/client";
import type { Board, Candidate, ChosenPlay, GameState, MatchState, MoveAnalysis, Play, Probs } from "../../src/engine/types";
import type { StorageLike } from "../../src/game/local-games";
import { moveTurn, rollTurn } from "../../src/game/record";
import { ANALYSIS_KEY, createGameStore, type GameStore } from "../../src/game/store";

// --- fixtures (same shapes as tests/store.test.ts) -------------------------

const OPENING: Board = {
  white: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
  black: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0],
};
const MONEY_RULES = { jacoby: true, beavers: false, autoDoubles: false };
const SEED = 42; // White wins the opening roll with 5-1

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
const PROBS: Probs = { win: 0.623, winG: 0.18, winBg: 0.012, loseG: 0.082, loseBg: 0.004 };
const candidate = (p: Play, equity: number, rollout = false): Candidate => ({
  play: p,
  equity,
  probs: PROBS,
  rollout: rollout ? { trials: 100, equity, stdErr: 0.011, probs: PROBS } : null,
});
const PLAYS = [play("13/8 6/5", [13, 8], [6, 5]), play("13/8 24/23", [13, 8], [24, 23]), play("24/19 19/18", [24, 19], [19, 18])];
const AFTER_13_8: Board = { ...OPENING, white: OPENING.white.map((n, i) => (i === 13 ? 4 : i === 8 ? 4 : n)) };
const AFTER_13_8_6_5: Board = { ...AFTER_13_8, white: AFTER_13_8.white.map((n, i) => (i === 6 ? 4 : i === 5 ? 1 : n)) };

/** Eight candidates 0.02 apart, the first five rolled out; `playedIndex` 6 lies beyond the default five rows. */
function eightCandidates(): Candidate[] {
  return Array.from({ length: 8 }, (_, i) => candidate(play(`24/${String(20 - i)}`, [24, 20 - i]), 0.1 - i * 0.02, i < 5));
}
const analysisOf = (candidates: Candidate[], playedIndex: number): MoveAnalysis => {
  const errorSize = candidates[0].equity - candidates[playedIndex].equity;
  return { candidates, playedIndex, errorSize, category: errorSize === 0 ? "best" : errorSize < 0.02 ? "fine" : errorSize < 0.08 ? "error" : "blunder" };
};
const chosen = (p: Play, ...others: Play[]): ChosenPlay => ({
  play: p,
  candidates: [p, ...others].map((c, i) => candidate(c, 0.021 - i * 0.1)),
});

class MemoryStorage implements StorageLike {
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
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

afterEach(cleanup);

// --- format -----------------------------------------------------------------

describe("format", () => {
  it("renders equities signed with three decimals and percentages with one, in Latin digits", () => {
    expect(formatEquity(0.021)).toBe("+0.021");
    expect(formatEquity(-0.359)).toBe("-0.359");
    expect(formatEquity(0)).toBe("+0.000");
    expect(formatEquity(-0.0001)).toBe("+0.000");
    expect(formatPercent(0.6234)).toBe("62.3");
    expect(formatPercent(1.2)).toBe("100.0");
  });

  it("phrases the collapsed verdicts as specified", () => {
    const forBot = { turnIndex: 2, player: "black" as const, dice: { hi: 6, lo: 3 }, chosen: chosen(play("13/8 6/5"), ...Array.from({ length: 73 }, () => play("x"))) };
    expect(botVerdict(forBot)).toBe("Computer played 13/8 6/5 · +0.021 · 74 candidates");
    expect(botVerdict({ ...forBot, chosen: { play: play(""), candidates: [candidate(play(""), 0)] } })).toBe("Computer had no legal move with 6-3");
    const analysis = analysisOf(eightCandidates(), 2);
    const forHuman = { turnIndex: 1, player: "white" as const, dice: { hi: 5, lo: 1 }, played: "24/18 13/10", analysis: { ...analysis, errorSize: 0.035 }, error: null };
    expect(humanVerdict(forHuman)).toBe("your 24/18 13/10 lost 0.035");
    expect(gradeAnnouncement(forHuman)).toBe("Error: your 24/18 13/10 lost 0.035");
    expect(humanVerdict({ ...forHuman, analysis: analysisOf(eightCandidates(), 0) })).toBe("your 24/18 13/10 was the best play");
    expect(humanVerdict({ ...forHuman, analysis: null, error: "engine: analyzePlay timed out" })).toBe("your 24/18 13/10 — analysis unavailable (engine: analyzePlay timed out)");
  });
});

// --- ProbBar / GradeBadge ---------------------------------------------------

describe("<ProbBar>", () => {
  it("draws six segments whose widths are the outcome shares and describes them with one decimal", () => {
    const { container } = render(<ProbBar probs={PROBS} rollout={{ trials: 100, equity: 0.1, stdErr: 0.011, probs: PROBS }} />);
    const img = screen.getByRole("img");
    expect(img).toHaveAccessibleName("Win 62.3% (gammon 18.0%, backgammon 1.2%); lose 37.7% (gammon 8.2%, backgammon 0.4%). Rollout of 100 games, standard error ±0.011.");
    const widths = [...container.querySelectorAll(".prob__seg")].map((el) => [el.getAttribute("data-seg"), (el as HTMLElement).style.getPropertyValue("--w")]);
    expect(widths).toEqual([
      ["win-bg", "1.2"],
      ["win-g", "16.8"],
      ["win", "44.3"],
      ["lose", "29.5"],
      ["lose-g", "7.8"],
      ["lose-bg", "0.4"],
    ]);
    expect(container.querySelector(".prob__readout")).toHaveTextContent("62.3W18.0G1.2BG");
    expect(img).toHaveAttribute("data-source", "rollout");
  });

  it("labels a bar without a rollout as a one-ply estimate", () => {
    render(<ProbBar probs={PROBS} rollout={null} />);
    expect(screen.getByRole("img")).toHaveAccessibleName(/One-ply estimate\.$/);
    expect(screen.getByRole("img")).toHaveAttribute("data-source", "1-ply");
  });
});

describe("<GradeBadge>", () => {
  it("shows the grade and, unless best, the equity lost", () => {
    const { rerender } = render(<GradeBadge category="blunder" errorSize={0.084} />);
    expect(screen.getByText("Blunder").closest(".grade")).toHaveAttribute("data-grade", "blunder");
    expect(screen.getByText("-0.084")).toBeInTheDocument();
    rerender(<GradeBadge category="best" errorSize={0} />);
    expect(screen.getByText("Best")).toBeInTheDocument();
    expect(screen.queryByText(/-0/)).toBeNull();
  });
});

// --- CandidateList / MoveList -----------------------------------------------

describe("<CandidateList>", () => {
  it("lists the top five plus the played row, with equity, Δ, the bar and the sample, and expands to all", async () => {
    const candidates = eightCandidates();
    render(<CandidateList candidates={candidates} playedIndex={6} caption="Candidates for your 5-1" />);
    const table = screen.getByRole("table", { name: "Candidates for your 5-1" });
    const rows = () => within(table).getAllByRole("row").filter((r) => r.hasAttribute("data-rank"));
    expect(rows().map((r) => r.getAttribute("data-rank"))).toEqual(["1", "2", "3", "4", "5", "7"]);
    const played = rows()[5];
    expect(played).toHaveAttribute("data-played", "true");
    expect(within(played).getByText("played")).toBeInTheDocument();
    expect(within(played).getByText("24/14")).toBeInTheDocument();
    expect(within(played).getByText("-0.020")).toBeInTheDocument(); // equity 0.1 − 6 × 0.02
    expect(within(played).getByText("-0.120")).toBeInTheDocument(); // Δ to the best play
    expect(within(played).getByText("1-ply")).toBeInTheDocument();
    const best = rows()[0];
    expect(within(best).getByText("+0.100")).toBeInTheDocument();
    expect(within(best).getByText("—")).toBeInTheDocument();
    expect(within(best).getByText("n=100 ±0.011")).toBeInTheDocument();
    expect(within(best).getByRole("img")).toHaveAccessibleName(/Rollout of 100 games/);
    expect(within(table).getByText("… 1 candidate …")).toBeInTheDocument();

    const more = screen.getByRole("button", { name: "Show all 8 candidates" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(rows()).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show top 5" })).toHaveAttribute("aria-expanded", "true");
  });

  it("offers no expansion when every candidate fits", () => {
    render(<CandidateList candidates={eightCandidates().slice(0, 3)} playedIndex={0} caption="c" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("<MoveList>", () => {
  it("lists every logged turn with who, dice and action, and the grade of analysed plays", () => {
    const record = {
      seed: 1,
      length: 0,
      rules: MONEY_RULES,
      turns: [rollTurn("white", { hi: 5, lo: 1 }), moveTurn("white", { hi: 5, lo: 1 }, "13/8 6/5"), rollTurn("black", { hi: 6, lo: 3 }), moveTurn("black", { hi: 6, lo: 3 }, "")],
    };
    render(<MoveList record={record} analysisByTurn={{ 1: analysisOf(eightCandidates(), 1) }} human="white" />);
    const rows = within(screen.getByRole("table", { name: "Moves" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "1Youwins the opening roll 5-1",
      "2You5-113/8 6/5Error-0.020", // 0.020 lost is an error (thresholds 0.02 / 0.08)
      "3Computerrolls 6-3",
      "4Computer6-3no legal move",
    ]);
    expect(rows[3]).toHaveAttribute("aria-current", "true");
  });

  it("says so when there are no moves yet", () => {
    render(<MoveList record={null} analysisByTurn={{}} human="white" />);
    expect(screen.getByText("No moves yet.")).toBeInTheDocument();
  });
});

// --- AnalysisDrawer over the store ------------------------------------------

describe("<AnalysisDrawer>", () => {
  let engine: MockEngine;
  let storage: MemoryStorage;
  let store: ReturnType<typeof createGameStore>;
  const state = (): GameStore => store.getState();

  beforeEach(() => {
    engine = new MockEngine();
    storage = new MemoryStorage();
    store = createGameStore(engine, { storage });
  });

  /** White to move 5-1 at the opening with legal plays loaded. */
  async function startWhiteToMove(): Promise<void> {
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", PLAYS);
    await act(() => state().newGame({ format: "single", level: "beginner", seed: SEED }));
    expect(state().ui.lastError).toBeNull();
  }

  /** Enters and confirms 13/8 6/5 (graded `grade`); the bot answers 24/18 13/10 with 6-3. */
  async function confirm13_8_6_5(grade: MoveAnalysis | Error): Promise<void> {
    engine.script("applyPlay", AFTER_13_8, AFTER_13_8_6_5);
    await act(() => state().selectPoint(13));
    await act(() => state().selectPoint(8));
    await act(() => state().selectPoint(6));
    await act(() => state().selectPoint(5));
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "black", phase: "toMove", dice: { hi: 6, lo: 3 } }));
    engine.script("analyzePlay", grade);
    engine.script("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10]), play("24/15", [24, 18], [18, 15])));
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "white", phase: "toRoll" }));
    await act(() => state().confirmPlay());
    expect(state().ui.lastError).toBeNull();
  }

  const drawer = () => screen.getByRole("complementary", { name: "Analysis" });

  it("starts collapsed with a placeholder, then shows the grade of your play and the computer's verdict", async () => {
    await startWhiteToMove();
    render(<AnalysisDrawer store={store} />);
    expect(drawer()).toHaveTextContent("Candidates and grades appear here as the game goes on.");
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("grade-announcement")).toHaveTextContent("");

    await confirm13_8_6_5(analysisOf(PLAYS.map((p, i) => candidate(p, 0.1 - i * 0.035)), 0));

    // 13/8 6/5 is candidates[0] here: the best play.
    const you = screen.getByTestId("verdict-you");
    expect(you).toHaveTextContent("Best");
    expect(you).toHaveTextContent("your 13/8 6/5 was the best play");
    const computer = screen.getByTestId("verdict-computer");
    expect(computer).toHaveTextContent("Computer played 24/18 13/10 · +0.021 · 2 candidates");
    expect(screen.getByTestId("grade-announcement")).toHaveTextContent("Best: your 13/8 6/5 was the best play");
  });

  it("grades a lost play with its size, and reports a failed analysis without hiding the computer's move", async () => {
    await startWhiteToMove();
    render(<AnalysisDrawer store={store} />);
    const candidates = [candidate(PLAYS[1], 0.1, true), candidate(PLAYS[0], 0.065, true), candidate(PLAYS[2], 0.0, true)];
    await confirm13_8_6_5(analysisOf(candidates, 1)); // 13/8 6/5 lost 0.035

    const you = screen.getByTestId("verdict-you");
    expect(you).toHaveTextContent("Error");
    expect(you).toHaveTextContent("your 13/8 6/5 lost 0.035");
    expect(within(you).getByText("Error").closest(".grade")).toHaveAttribute("data-grade", "error");
    expect(screen.getByTestId("grade-announcement")).toHaveTextContent("Error: your 13/8 6/5 lost 0.035");

    // A second game: the analysis fails but the strip still carries the play and the computer's reply.
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", PLAYS);
    await act(() => state().newGame({ format: "single", level: "beginner", seed: SEED + 100 }));
    expect(state().match?.game.phase).toBe("toMove");
    await confirm13_8_6_5(new Error("engine: analyzePlay timed out after 10000 ms"));
    expect(screen.getByTestId("verdict-you")).toHaveTextContent("your 13/8 6/5 — analysis unavailable (engine: analyzePlay timed out after 10000 ms)");
    expect(screen.getByTestId("verdict-computer")).toHaveTextContent("Computer played 24/18 13/10");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens to tabs — Analysis with both candidate tables, Moves with the record, Chat planned — and closes on Escape", async () => {
    await startWhiteToMove();
    render(<AnalysisDrawer store={store} />);
    const candidates = [candidate(PLAYS[1], 0.1, true), candidate(PLAYS[0], 0.065, true), candidate(PLAYS[2], 0.0, true)];
    await confirm13_8_6_5(analysisOf(candidates, 1));

    const toggle = screen.getByRole("button", { name: "Open" });
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute("aria-expanded", "true");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Analysis", "Moves", "Chat (planned)"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveFocus();
    expect(tabs[2]).toBeDisabled();

    // Analysis tab: your decision first (played row marked), then the computer's.
    const yours = screen.getByRole("region", { name: "Your move" });
    expect(within(yours).getByRole("heading", { level: 3 })).toHaveTextContent("Error-0.035You played 13/8 6/5");
    expect(yours).toHaveTextContent("with 5-1 · lost 0.035 to 13/8 24/23 · club analysis: 2-ply + rollouts");
    const yourRows = within(within(yours).getByRole("table")).getAllByRole("row").filter((r) => r.hasAttribute("data-rank"));
    expect(yourRows[1]).toHaveAttribute("data-played", "true");
    expect(within(yourRows[1]).getByText("n=100 ±0.011")).toBeInTheDocument();
    const theirs = screen.getByRole("region", { name: "Computer's move" });
    expect(theirs).toHaveTextContent("Computer played 24/18 13/10");
    expect(theirs).toHaveTextContent("with 6-3 · 2 candidates · Beginner · 1-ply with noise");
    expect(within(within(theirs).getByRole("table")).getAllByRole("row").filter((r) => r.hasAttribute("data-rank"))[0]).toHaveAttribute("data-played", "true");

    // Arrow keys move between the enabled tabs (Chat is skipped) and switch the panel.
    await userEvent.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    const moves = within(screen.getByRole("tabpanel")).getByRole("table", { name: "Moves" });
    expect(within(moves).getAllByRole("row")).toHaveLength(4); // header + roll, your move, the computer's move
    expect(within(moves).getByText("Error")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(tabs[0]).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(tabs[1]).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
    expect(document.documentElement).not.toHaveAttribute(SHEET_ATTRIBUTE);
  });

  it("releases the page's scroll lock when the drawer unmounts while open", async () => {
    await startWhiteToMove();
    const { unmount } = render(<AnalysisDrawer store={store} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(document.documentElement).toHaveAttribute(SHEET_ATTRIBUTE, "true");
    unmount();
    expect(document.documentElement).not.toHaveAttribute(SHEET_ATTRIBUTE);
  });

  it("hides and shows the analysis with a persisted switch (bg.analysis); showing again returns to the collapsed strip", async () => {
    await startWhiteToMove();
    render(<AnalysisDrawer store={store} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    // The page behind the open sheet is marked so analysis.css can lock its scroll under 900px.
    expect(document.documentElement).toHaveAttribute(SHEET_ATTRIBUTE, "true");

    await userEvent.click(screen.getByRole("button", { name: "Hide analysis" }));
    expect(storage.getItem(ANALYSIS_KEY)).toBe("0");
    expect(drawer()).toHaveAttribute("data-visible", "false");
    expect(drawer()).toHaveTextContent("Analysis is off.");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Open|Close)$/ })).toBeNull();
    expect(document.documentElement).not.toHaveAttribute(SHEET_ATTRIBUTE);

    await userEvent.click(screen.getByRole("button", { name: "Show analysis" }));
    expect(storage.getItem(ANALYSIS_KEY)).toBe("1");
    expect(drawer()).toHaveAttribute("data-visible", "true");
    expect(screen.getByRole("button", { name: "Hide analysis" })).toBeInTheDocument();
    // Hiding collapsed the panel: showing again does not throw the full panel (a phone's sheet) open unasked.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Hide analysis" })).toHaveFocus();
    expect(document.documentElement).not.toHaveAttribute(SHEET_ATTRIBUTE);

    // A store created over the same storage starts hidden when that was the last choice.
    state().setAnalysisVisible(false);
    const again = createGameStore(new MockEngine(), { storage });
    cleanup();
    render(<AnalysisDrawer store={again} />);
    expect(screen.getByRole("complementary", { name: "Analysis" })).toHaveAttribute("data-visible", "false");
  });
});
