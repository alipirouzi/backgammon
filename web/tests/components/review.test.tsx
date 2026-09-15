// @vitest-environment jsdom
// Post-game review (web/src/components/review/*, web/src/app/review/[gameId]):
// the game loader (local storage or the games API, with a mocked fetch), the
// per-side summary, the player over a scripted MockEngine — positions from
// `replay` on record prefixes, lazy `analyzePlay` per move turn with the
// in-play seed, ←/→/Home/End, the slider, the move list, the live region,
// the retry after a failed analysis — the route's client component and the
// "Review this game" link on the table's finish banner.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { MockEngine } from "../../src/engine/client";
import type { Board, Candidate, GameState, MatchContext, MatchState, MoveAnalysis, Play, Probs, Record as GameRecord, Turn } from "../../src/engine/types";
import type { StorageLike } from "../../src/game/local-games";
import { GAMES_KEY_PREFIX } from "../../src/game/local-games";
import { doubleTurn, moveTurn, resignTurn, rollTurn, takeTurn } from "../../src/game/record";
import { analysisSeedFor, createGameStore, type AnalysisByTurn } from "../../src/game/store";
import { TableLayout } from "../../src/components/table/TableLayout";
import { ReviewPlayer } from "../../src/components/review/ReviewPlayer";
import { ReviewSummary, summarize } from "../../src/components/review/ReviewSummary";
import { gameApiPath, loadReviewGame, reviewHref } from "../../src/components/review/game-source";
import { isGradableTurn, nextJob, stopCaption } from "../../src/components/review/model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/review/local-42" }));

// Imported after the mock (vi.mock is hoisted, the import is not).
import { ReviewGame } from "../../src/app/review/[gameId]/ReviewGame";

// --- fixtures (same shapes as tests/store.test.ts) -------------------------

const OPENING: Board = {
  white: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
  black: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0],
};
const MONEY_RULES = { jacoby: true, beavers: false, autoDoubles: false };
const MONEY_CTX: MatchContext = { length: 0, myAway: 0, theirAway: 0, crawford: false, postCrawford: false, cube: 1, cubeOwnerIsMe: null };
const SEED = 42;

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
const analysisOf = (candidates: Candidate[], playedIndex: number): MoveAnalysis => {
  const errorSize = candidates[0].equity - candidates[playedIndex].equity;
  return { candidates, playedIndex, errorSize, category: errorSize === 0 ? "best" : errorSize < 0.02 ? "fine" : errorSize < 0.08 ? "error" : "blunder" };
};

/**
 * A seven-turn money game: White wins the opening roll 5-1 and plays
 * 24/23 23/18, the computer doubles, White takes, the computer rolls 3-3 and
 * plays, White rolls 6-2 with no legal move (a forfeited turn, not gradable),
 * then resigns a single game at the cube (2 points).
 */
const TURNS: Turn[] = [
  rollTurn("white", { hi: 5, lo: 1 }),
  moveTurn("white", { hi: 5, lo: 1 }, "24/23 23/18"),
  doubleTurn("black"),
  takeTurn("white"),
  rollTurn("black", { hi: 3, lo: 3 }),
  moveTurn("black", { hi: 3, lo: 3 }, "13/10(2) 10/7* 10/7"),
  rollTurn("white", { hi: 6, lo: 2 }),
  moveTurn("white", { hi: 6, lo: 2 }, ""),
  resignTurn("white", 2),
];
const RECORD: GameRecord = { seed: SEED, length: 0, rules: MONEY_RULES, turns: TURNS };
const MOVE_TURNS = [1, 5]; // gradable move turns of RECORD (7 is a forfeit)

/** The `MatchState` a replay of the first `n` turns of RECORD yields (boards are not tracked: the mock keeps the opening). */
function stateAfter(record: GameRecord): MatchState {
  const n = record.turns.length;
  const last = record.turns[n - 1];
  const cube = n >= 4 ? { value: 2, owner: "white" as const } : { value: 1, owner: null };
  if (n === 0) {
    return match({ onRoll: null, phase: "openingRoll" });
  }
  if (n === TURNS.length) {
    return match({ onRoll: null, phase: "finished", cube, result: { winner: "black", kind: "single", points: 2 } }, { score: { white: 0, black: 2 } });
  }
  switch (last.action) {
    case "roll":
      return match({ onRoll: last.player, dice: last.dice, phase: "toMove", cube });
    case "move":
      return match({ onRoll: last.player === "white" ? "black" : "white", phase: "toRoll", cube });
    case "double":
      return match({ onRoll: last.player, phase: "doubled", cube });
    case "take":
      return match({ onRoll: "black", phase: "toRoll", cube });
    default:
      return match({ phase: "toRoll", cube });
  }
}

const WHITE_CANDIDATES = [play("24/23 13/8", [24, 23], [13, 8]), play("24/23 23/18", [24, 23], [23, 18]), play("24/18", [24, 18]), play("13/8 6/5", [13, 8], [6, 5])].map(
  (p, i) => candidate(p, 0.1 - i * 0.035, true),
);
const BLACK_CANDIDATES = [play("13/10(2) 10/7* 10/7", [13, 10], [13, 10], [10, 7, true], [10, 7]), play("8/5(2) 6/3(2)", [8, 5], [8, 5], [6, 3], [6, 3])].map((p, i) =>
  candidate(p, 0.2 - i * 0.01, true),
);

/** Scripts `replay` and `analyzePlay` so the mock answers every prefix of RECORD and both gradable plays. */
function scriptEngine(engine: MockEngine): void {
  engine.always("replay", stateAfter);
  engine.always("analyzePlay", (_board, onRoll, _dice, _ctx, played) => {
    const candidates = onRoll === "white" ? WHITE_CANDIDATES : BLACK_CANDIDATES;
    const index = candidates.findIndex((c) => c.play.notation === played);
    return index === -1 ? new Error(`unknown play ${played}`) : analysisOf(candidates, index);
  });
}

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

const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

afterEach(cleanup);

// --- game source ------------------------------------------------------------

describe("loadReviewGame", () => {
  const fetchNever = vi.fn<typeof fetch>(() => Promise.reject(new Error("fetch must not be called")));

  it("reads a local game from bg.games.<id> without touching the network", async () => {
    const storage = new MemoryStorage();
    storage.setItem(`${GAMES_KEY_PREFIX}local-42`, JSON.stringify(RECORD));
    const loaded = await loadReviewGame("local-42", { storage, fetchFn: fetchNever });
    expect(loaded).toEqual({ status: "ok", game: { id: "local-42", source: "local", record: RECORD, level: null } });
    expect(fetchNever).not.toHaveBeenCalled();
  });

  it("reports a local id with nothing stored as not found", async () => {
    await expect(loadReviewGame("local-7", { storage: new MemoryStorage(), fetchFn: fetchNever })).resolves.toEqual({ status: "not-found", source: "local" });
    await expect(loadReviewGame("local-7", { storage: null, fetchFn: fetchNever })).resolves.toEqual({ status: "not-found", source: "local" });
  });

  it("fetches any other id from the games API and reads the record and the computer's level", async () => {
    const body = { id: "ckgame1", record: RECORD, result: { winner: "black", kind: "single", points: 2, score: { white: 0, black: 2 } }, seats: { white: { kind: "guest", name: "Guest" }, black: { kind: "bot", level: "club" } } };
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
    const loaded = await loadReviewGame("ckgame1", { storage: new MemoryStorage(), fetchFn });
    expect(loaded).toEqual({ status: "ok", game: { id: "ckgame1", source: "server", record: RECORD, level: "club" } });
    expect(fetchFn).toHaveBeenCalledWith(gameApiPath("ckgame1"), expect.objectContaining({ headers: expect.objectContaining({ accept: "application/json" }) as object }));
  });

  it("maps a 404 to not found and other failures to an error with a message", async () => {
    const notFound = vi.fn<typeof fetch>(() => Promise.resolve(new Response("", { status: 404 })));
    await expect(loadReviewGame("ckgone", { fetchFn: notFound })).resolves.toEqual({ status: "not-found", source: "server" });
    const failing = vi.fn<typeof fetch>(() => Promise.resolve(new Response("boom", { status: 500 })));
    await expect(loadReviewGame("ckbad", { fetchFn: failing })).resolves.toMatchObject({ status: "error", message: expect.stringContaining("500") as string });
    const malformed = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ record: { seed: 1 } }), { status: 200 })));
    await expect(loadReviewGame("ckodd", { fetchFn: malformed })).resolves.toMatchObject({ status: "error", message: expect.stringMatching(/record/) as string });
    const offline = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadReviewGame("ckoff", { fetchFn: offline })).resolves.toMatchObject({ status: "error", message: expect.stringContaining("Failed to fetch") as string });
  });

  it("builds the review link with the computer's level when known", () => {
    expect(reviewHref("local-42")).toBe("/review/local-42");
    expect(reviewHref("local-42", "club")).toBe("/review/local-42?level=club");
    expect(gameApiPath("a/b")).toBe("/api/games/a%2Fb");
  });
});

// --- model ------------------------------------------------------------------

describe("review model", () => {
  it("grades only move turns that made a play", () => {
    expect(TURNS.map(isGradableTurn)).toEqual([false, true, false, false, false, true, false, false, false]);
  });

  it("captions every stop, the final position included", () => {
    expect(stopCaption(RECORD, 0, "white")).toBe("You win the opening roll 5-1");
    expect(stopCaption(RECORD, 1, "white")).toBe("You play 24/23 23/18 with 5-1");
    expect(stopCaption(RECORD, 2, "white")).toBe("The computer doubles");
    expect(stopCaption(RECORD, 3, "white")).toBe("You take");
    expect(stopCaption(RECORD, 4, "white")).toBe("The computer rolls 3-3");
    expect(stopCaption(RECORD, 5, "white")).toBe("The computer plays 13/10(2) 10/7* 10/7 with 3-3");
    expect(stopCaption(RECORD, 7, "white")).toBe("You have no legal move with 6-2");
    expect(stopCaption(RECORD, 8, "white")).toBe("You resign (2 points)");
    expect(stopCaption(RECORD, 9, "white")).toBe("Final position");
  });

  it("summarises errors, blunders and equity lost per side over the graded plays", () => {
    const analyses: AnalysisByTurn = { 1: analysisOf(WHITE_CANDIDATES, 1), 5: analysisOf(BLACK_CANDIDATES, 0) };
    const summary = summarize(RECORD, analyses);
    expect(summary.plays).toBe(2);
    expect(summary.graded).toBe(2);
    expect(summary.white).toEqual({ plays: 1, graded: 1, errors: 1, blunders: 0, lost: expect.closeTo(0.035, 6) as number });
    expect(summary.black).toEqual({ plays: 1, graded: 1, errors: 0, blunders: 0, lost: 0 });
    const partial = summarize(RECORD, { 5: analysisOf(BLACK_CANDIDATES, 1) });
    expect(partial.graded).toBe(1);
    expect(partial.black).toMatchObject({ errors: 0, blunders: 0, lost: expect.closeTo(0.01, 6) as number });
    const blundered = summarize(RECORD, { 1: analysisOf(WHITE_CANDIDATES, 3) });
    expect(blundered.white).toMatchObject({ errors: 0, blunders: 1, lost: expect.closeTo(0.105, 6) as number });
  });

  it("schedules the stop on show, the final position and both neighbours before the grade on show, then the rest in record order", () => {
    const state = stateAfter(RECORD);
    const empty = { positionErrors: {}, analyses: {}, analysisErrors: {} };
    expect(nextJob(RECORD, 1, { ...empty, positions: {} })).toEqual({ kind: "position", index: 1 });
    expect(nextJob(RECORD, 1, { ...empty, positions: { 1: state } })).toEqual({ kind: "position", index: 9 });
    expect(nextJob(RECORD, 1, { ...empty, positions: { 1: state, 9: state } })).toEqual({ kind: "position", index: 2 });
    expect(nextJob(RECORD, 1, { ...empty, positions: { 1: state, 2: state, 9: state } })).toEqual({ kind: "position", index: 0 });
    expect(nextJob(RECORD, 1, { ...empty, positions: { 0: state, 1: state, 2: state, 9: state } })).toEqual({ kind: "analysis", index: 1 });
    const graded = { ...empty, analyses: { 1: analysisOf(WHITE_CANDIDATES, 1) }, positions: { 0: state, 1: state, 2: state, 9: state } };
    expect(nextJob(RECORD, 1, graded)).toEqual({ kind: "position", index: 5 });
    expect(nextJob(RECORD, 1, { ...graded, positions: { ...graded.positions, 5: state } })).toEqual({ kind: "analysis", index: 5 });
    expect(nextJob(RECORD, 1, { ...graded, positions: { ...graded.positions, 5: state }, analysisErrors: { 5: "failed" } })).toBeNull();
  });
});

// --- ReviewSummary ----------------------------------------------------------

describe("<ReviewSummary>", () => {
  it("shows the result, both sides' counts and the grading progress", () => {
    render(<ReviewSummary record={RECORD} analyses={{ 1: analysisOf(WHITE_CANDIDATES, 3) }} human="white" level="club" final={stateAfter(RECORD)} />);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("The computer wins 2 points");
    const you = screen.getByRole("group", { name: "You" });
    expect(within(you).getByText("Blunders").nextElementSibling).toHaveTextContent("1");
    expect(within(you).getByText("Errors").nextElementSibling).toHaveTextContent("0");
    expect(within(you).getByText("Equity lost").nextElementSibling).toHaveTextContent("0.105");
    const computer = screen.getByRole("group", { name: "Computer" });
    expect(within(computer).getByText("Equity lost").nextElementSibling).toHaveTextContent("—");
    expect(screen.getByText(/1 of 2 plays graded/)).toBeInTheDocument();
    expect(screen.getByText(/Club strength/)).toBeInTheDocument();
  });
});

// --- ReviewPlayer -----------------------------------------------------------

describe("<ReviewPlayer>", () => {
  let engine: MockEngine;

  beforeEach(() => {
    engine = new MockEngine();
    scriptEngine(engine);
  });

  const renderPlayer = (props: Partial<Parameters<typeof ReviewPlayer>[0]> = {}) =>
    render(<ReviewPlayer record={RECORD} engine={engine} human="white" level="beginner" {...props} />);

  it("opens on the opening roll with a slider over every stop and the board before the turn", async () => {
    const { container } = renderPlayer();
    const slider = screen.getByRole("slider", { name: "Turn" });
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", String(TURNS.length));
    expect(slider).toHaveValue("0");
    expect(screen.getByTestId("stop-caption")).toHaveTextContent("You win the opening roll 5-1");
    await waitFor(() => expect(engine.callsTo("replay").map((a) => a[0].turns.length)).toContain(0));
    // The board is a replay, not a control: it is inert (out of the tab order and the accessibility tree).
    const board = container.querySelector(".review-stage__board");
    expect(board).toHaveAttribute("inert");
    expect(board?.querySelector('button[aria-label^="Point 24, 2 white checkers"]')).not.toBeNull();
    expect(screen.getByText("Nothing to grade on this turn.")).toBeInTheDocument();
  });

  it("steps with the arrow keys, grades the move turn lazily with the in-play seed and announces the grade", async () => {
    const onAnalysed = vi.fn();
    const { container } = renderPlayer({ onAnalysed });
    const player = screen.getByTestId("review-player");
    fireEvent.keyDown(player, { key: "ArrowRight" });
    expect(screen.getByRole("slider", { name: "Turn" })).toHaveValue("1");
    expect(screen.getByTestId("stop-caption")).toHaveTextContent("You play 24/23 23/18 with 5-1");

    // The badge appears twice: in the analysis panel and on the move list's row.
    const badges = await screen.findAllByText("Error", { selector: ".grade__label" });
    expect(badges).toHaveLength(2);
    const analysed = engine.callsTo("analyzePlay");
    const forTurn1 = analysed.find(([, , , , played]) => played === "24/23 23/18");
    expect(forTurn1).toEqual([OPENING, "white", { hi: 5, lo: 1 }, MONEY_CTX, "24/23 23/18", analysisSeedFor(RECORD, 1)]);
    expect(screen.getByTestId("grade-announcement")).toHaveTextContent("Error: your 24/23 23/18 lost 0.035");
    const table = screen.getByRole("table", { name: /Candidates for your 5-1/ });
    expect(within(table).getByText("played")).toBeInTheDocument();
    expect(within(table).getAllByRole("img")[0]).toHaveAccessibleName(/Rollout of 100 games/);
    // Destinations of the played move are highlighted on the board before it.
    expect(container.querySelector('button[aria-label^="Point 18,"]')).toHaveAttribute("data-pending", "true");

    // Every other gradable play is graded in the background, once, and handed back.
    await waitFor(() => expect(onAnalysed).toHaveBeenCalledTimes(MOVE_TURNS.length));
    expect(onAnalysed.mock.calls.map(([index]) => index).sort()).toEqual(MOVE_TURNS);
    expect(engine.callsTo("analyzePlay")).toHaveLength(MOVE_TURNS.length);
    expect(screen.getByText(/2 of 2 plays graded/)).toBeInTheDocument();
  });

  it("does not re-grade a play handed over from the game store", async () => {
    const initial: AnalysisByTurn = { 1: analysisOf(WHITE_CANDIDATES, 0) };
    renderPlayer({ initialAnalyses: initial, initialIndex: 1 });
    expect(screen.getAllByText("Best", { selector: ".grade__label" })).toHaveLength(2);
    await waitFor(() => expect(engine.callsTo("analyzePlay")).toHaveLength(1));
    await flush();
    expect(engine.callsTo("analyzePlay").map((a) => a[4])).toEqual(["13/10(2) 10/7* 10/7"]);
  });

  it("jumps through the slider and the move list, Home and End, and leaves the slider's own arrow keys alone", async () => {
    renderPlayer();
    const slider = screen.getByRole("slider", { name: "Turn" });
    fireEvent.change(slider, { target: { value: "5" } });
    expect(screen.getByTestId("stop-caption")).toHaveTextContent("The computer plays 13/10(2) 10/7* 10/7 with 3-3");
    const list = screen.getByRole("list", { name: "Moves" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(TURNS.length + 1);
    expect(rows[5]).toHaveAttribute("aria-current", "step");
    await userEvent.click(rows[2]);
    expect(slider).toHaveValue("2");
    expect(screen.getByTestId("stop-caption")).toHaveTextContent("The computer doubles");
    expect(screen.getByText(/Cube decisions are not graded/)).toBeInTheDocument();

    const player = screen.getByTestId("review-player");
    fireEvent.keyDown(player, { key: "End" });
    expect(slider).toHaveValue(String(TURNS.length));
    expect(screen.getByTestId("stop-caption")).toHaveTextContent("Final position");
    await screen.findByText("The computer wins 2 points", { selector: "h2" });
    fireEvent.keyDown(player, { key: "Home" });
    expect(slider).toHaveValue("0");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider).toHaveValue("0");
    fireEvent.keyDown(player, { key: "ArrowLeft" });
    expect(slider).toHaveValue("0");
  });

  it("parks keyboard focus on the caption when a transport button disables under it", async () => {
    renderPlayer();
    const next = screen.getByRole("button", { name: "Next turn" });
    const previous = screen.getByRole("button", { name: "Previous turn" });
    const caption = screen.getByTestId("stop-caption");

    // Pointer: Next, then Previous back to stop 0 disables Previous under the pointer's focus.
    await userEvent.click(next);
    await userEvent.click(previous);
    expect(previous).toBeDisabled();
    expect(caption).toHaveFocus();

    // Keyboard: Enter on Next until the last stop disables it.
    next.focus();
    for (let i = 0; i < TURNS.length; i++) {
      await userEvent.keyboard("{Enter}");
    }
    expect(screen.getByRole("slider", { name: "Turn" })).toHaveValue(String(TURNS.length));
    expect(next).toBeDisabled();
    expect(caption).toHaveFocus();

    // A button that stays enabled keeps focus.
    await userEvent.click(previous);
    expect(previous).toHaveFocus();
  });

  it("shows a placeholder, never another stop's position, while a jumped-to stop is replayed", async () => {
    let release: (() => void) | null = null;
    engine.always("replay", (record) =>
      record.turns.length === 5
        ? new Promise<MatchState>((resolve) => {
            release = () => resolve(stateAfter(record));
          })
        : stateAfter(record),
    );
    const { container } = renderPlayer();
    await waitFor(() => expect(engine.callsTo("replay").map((a) => a[0].turns.length)).toContain(0));
    expect(container.querySelector('button[aria-label^="Point 24, 2 white checkers"]')).not.toBeNull();

    fireEvent.change(screen.getByRole("slider", { name: "Turn" }), { target: { value: "5" } });
    expect(screen.getByTestId("stop-caption")).toHaveTextContent("The computer plays 13/10(2) 10/7* 10/7 with 3-3");
    expect(screen.getByTestId("stage-placeholder")).toHaveTextContent("Replaying the position…");
    expect(container.querySelector(".review-stage__board")).toBeNull();

    await waitFor(() => expect(release).not.toBeNull());
    act(() => release?.());
    await waitFor(() => expect(screen.queryByTestId("stage-placeholder")).toBeNull());
    expect(container.querySelector(".review-stage__board")).toHaveAttribute("aria-busy", "false");
    expect(container.querySelector('button[aria-label^="Point 24, 2 white checkers"]')).not.toBeNull();
  });

  it("shows a failed analysis with a Retry control and does not retry by itself", async () => {
    engine.script("analyzePlay", new Error("engine: analyzePlay timed out"));
    renderPlayer({ initialIndex: 1 });
    expect(await screen.findByText(/Analysis unavailable: engine: analyzePlay timed out/)).toBeInTheDocument();
    // The background pass moves on to the other play and stops; the failed one is not hammered.
    await waitFor(() => expect(engine.callsTo("analyzePlay")).toHaveLength(2));
    await flush();
    expect(engine.callsTo("analyzePlay")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByText("Error", { selector: ".grade__label" })).toHaveLength(2);
    expect(engine.callsTo("analyzePlay")).toHaveLength(3);
  });
});

// --- ReviewGame (route client component) ------------------------------------

describe("<ReviewGame>", () => {
  let engine: MockEngine;

  beforeEach(() => {
    engine = new MockEngine();
    scriptEngine(engine);
  });

  it("renders the player for a stored local game with Play again and Back to table", async () => {
    const load = vi.fn(async () => ({ status: "ok" as const, game: { id: "local-42", source: "local" as const, record: RECORD, level: null } }));
    render(<ReviewGame gameId="local-42" level="club" deps={{ load, engine }} />);
    expect(await screen.findByTestId("review-player")).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith("local-42");
    expect(screen.getByRole("button", { name: "Play again" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Back to table" })).toHaveAttribute("href", "/play/local-42?format=single&level=club");
    expect(screen.getByText(/Club strength/)).toBeInTheDocument();
  });

  it("offers no table for a server game", async () => {
    const load = vi.fn(async () => ({ status: "ok" as const, game: { id: "ckgame1", source: "server" as const, record: RECORD, level: "intermediate" as const } }));
    render(<ReviewGame gameId="ckgame1" level={null} deps={{ load, engine }} />);
    expect(await screen.findByTestId("review-player")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back to table" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New game" })).toHaveAttribute("href", "/play/new");
  });

  it("explains a missing game and a failed load", async () => {
    const missing = vi.fn(async () => ({ status: "not-found" as const, source: "local" as const }));
    const { unmount } = render(<ReviewGame gameId="local-9" level={null} deps={{ load: missing, engine }} />);
    expect(await screen.findByRole("heading", { level: 2, name: "No such game" })).toBeInTheDocument();
    expect(screen.getByText(/this browser/)).toBeInTheDocument();
    unmount();
    const failing = vi.fn(async () => ({ status: "error" as const, message: "the games API answered 500" }));
    render(<ReviewGame gameId="ckgame2" level={null} deps={{ load: failing, engine }} />);
    expect(await screen.findByText(/the games API answered 500/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

// --- finish banner link -----------------------------------------------------

describe("TableLayout finish banner", () => {
  it("links the final banner to the review of this game, but not the between-games banner", () => {
    const engine = new MockEngine();
    const store = createGameStore(engine, { storage: null });
    store.setState({
      gameId: "local-42",
      botLevel: "club",
      record: RECORD,
      match: stateAfter(RECORD),
      lastGameResult: { winner: "black", kind: "single", points: 2 },
    });
    const { unmount } = render(<TableLayout store={store} onPlayAgain={() => undefined} />);
    expect(screen.getByRole("link", { name: "Review this game" })).toHaveAttribute("href", reviewHref("local-42", "club"));
    unmount();

    store.setState({
      match: match({ onRoll: null, phase: "openingRoll" }, { length: 3, score: { white: 1, black: 0 } }),
      lastGameResult: { winner: "white", kind: "single", points: 1 },
      awaitingNextGame: true,
    });
    render(<TableLayout store={store} onPlayAgain={() => undefined} />);
    expect(screen.getByRole("button", { name: "Next game" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review this game" })).not.toBeInTheDocument();
  });
});
