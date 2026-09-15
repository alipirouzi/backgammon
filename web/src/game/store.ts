/**
 * The game store (Zustand): one bot game or match played by a person as
 * White against the engine's bot as Black.
 *
 * Single source of truth is the `Record`: every action appends exactly the
 * `Turn`s it implies and the `MatchState` is re-derived by the engine's
 * `replay`, which verifies dice, players and plays. The store never decides
 * legality — legal plays, the bot's moves and cube decisions all come from
 * the engine. Dice are drawn from `DiceRng` (the engine's generator, ported)
 * because `replay` verifies logged dice but never fills them in; a wrong
 * roll would be rejected by `replay` and surface in `ui.lastError`.
 *
 * Every action resolves after the bot has answered (roll → move, or a cube
 * decision), under one `ui.busy` flag; nothing here throws to React.
 * `confirmPlay` additionally grades the person's play (club-strength
 * `analyzePlay`) *after* the bot's reply, with `busy` already released: the
 * worker is sequential, so a grade ahead of the reply would hold the
 * computer up for as long as the analysis takes.
 *
 * `newGame` may arrive while a previous game's bot chain is still awaiting
 * the engine (the store outlives the route). It always wins: a generation
 * counter is bumped and every step of the older chain checks it after each
 * engine call, so a late result is dropped instead of being written over
 * the new game. Opening an id whose record is stored resumes that record
 * (finished games are shown finished, never restarted).
 */

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { ThemeId } from "@/components/board/types";
import { createEngine, type Engine } from "@/engine/client";
import type {
  Board,
  ChosenPlay,
  Dice,
  GameResult,
  Level,
  MatchContext,
  MatchState,
  Move,
  MoveAnalysis,
  Play,
  Player,
  Record as GameRecord,
  ResultKind,
  Turn,
} from "@/engine/types";

import { DiceRng } from "./dice";
import {
  DEFAULT_THEME,
  defaultStorage,
  loadLocalGame,
  loadLocalGameLevel,
  loadTheme,
  localGameId,
  saveLocalGame,
  saveLocalGameLevel,
  saveTheme,
  type StorageLike,
} from "./local-games";
import {
  appendTurn,
  botSeed,
  concededPoints,
  diceStreamAfter,
  doubleTurn,
  dropTurn,
  matchContextFor,
  moveTurn,
  newRecord,
  openingRollTurn,
  opponent,
  partialPlay,
  randomSeed,
  resignTurn,
  resultKindFor,
  rollTurn,
  takeTurn,
} from "./record";
import {
  automaticActionDue,
  canConfirm,
  canDouble,
  canDrop,
  canResign,
  canRoll,
  canTake,
  completedPlay,
  cubeAvailableTo,
  displayedBoard,
  humanPlayer,
  legalSources,
  legalTargetsFrom,
  moveOnBoard,
  playerToAct,
} from "./selectors";

export type Seat = "human" | "bot";

export type GameFormat = "single" | { matchTo: number };

export interface NewGameOptions {
  /** Ignored when a record for `seed` is already stored: that record is the game the id names. */
  format: GameFormat;
  /**
   * The computer's level for a new game, recorded under `bg.games.<id>.level`.
   * A stored record is resumed at the level it was started at; this option
   * only applies (and is then recorded) when the record carries none.
   */
  level: Level;
  /** Dice seed (`0..=2^53-1`); a fresh random one when omitted. */
  seed?: number;
}

export interface GameUi {
  /** Relative source of the lifted checker (`25` = bar), or `null`. */
  selectedFrom: number | null;
  /** Relative destinations for `selectedFrom` (`0` = off). */
  legalTargets: number[];
  /** Moves entered this turn, in entry order, not yet confirmed. */
  pendingMoves: Move[];
  /** `match.game.board` with `pendingMoves` applied (engine `applyPlay`), or `null` when none pending. */
  pendingBoard: Board | null;
  /** Legal plays for the current roll (engine `legalPlays`); `null` until loaded. */
  legalPlays: Play[] | null;
  /** An engine call is in flight (including the bot's whole turn). */
  busy: boolean;
  /** The last failure, for the status line; cleared by the next successful action. */
  lastError: string | null;
}

/** What the bot saw when it chose its last move — for the analysis drawer. */
export interface BotAnalysis {
  /** Index of the bot's move turn in `record.turns`. */
  turnIndex: number;
  player: Player;
  dice: Dice;
  chosen: ChosenPlay;
}

/**
 * The engine's club-strength verdict on the person's last confirmed play
 * (`analyzePlay`, run once the bot has answered the move; `null` from the
 * moment the move is committed until the grade lands). `analysis` is `null`
 * with `error` set when the analysis itself failed; the game goes on
 * regardless — the failure is shown in the drawer, never in `ui.lastError`.
 */
export interface HumanAnalysis {
  /** Index of the person's move turn in `record.turns`. */
  turnIndex: number;
  player: Player;
  dice: Dice;
  /** The notation played (relative to `player`). */
  played: string;
  analysis: MoveAnalysis | null;
  error: string | null;
}

export interface GameAnalysis {
  forBot: BotAnalysis | null;
  forHuman: HumanAnalysis | null;
  /** The analysis drawer is on (spec §5.2: on by default in bot games); persisted under `bg.analysis`. */
  visible: boolean;
}

/** Club-strength `MoveAnalysis` per move turn, keyed by the turn's index in `record.turns`. */
export type AnalysisByTurn = Readonly<{ [turnIndex: number]: MoveAnalysis }>;

/** The store's data (what selectors read). */
export interface GameStoreState {
  /** `local-<seed>` for a bot game, `null` before `newGame`. */
  gameId: string | null;
  /** Absolute match state from the engine's `replay`. */
  match: MatchState | null;
  /** Seed + turns, one `Turn` per action. */
  record: GameRecord | null;
  seatOf: { white: Seat; black: Seat };
  botLevel: Level;
  theme: ThemeId;
  ui: GameUi;
  analysis: GameAnalysis;
  /**
   * Every club-strength analysis computed for this game so far, by turn
   * index: the person's confirmed plays as they are graded, plus whatever a
   * review adds with `rememberAnalysis`. Reset by `newGame`. The bot's own
   * `choosePlay` output is *not* here (at beginner/intermediate it is 1-ply,
   * noisy and not comparable); it stays in `analysis.forBot`.
   */
  analysisByTurn: AnalysisByTurn;
  /**
   * Result of the last finished game: taken from `game.result` while the
   * finished game is shown, or derived from the score change when `replay`
   * has already started the next game of a match.
   */
  lastGameResult: GameResult | null;
  /**
   * A game of a match has just finished: `lastGameResult` is on show with
   * the new score, and the next game (already `openingRoll` in `match`) does
   * not draw its opening roll until `nextGame()`.
   */
  awaitingNextGame: boolean;
}

export interface GameStoreActions {
  newGame(opts: NewGameOptions): Promise<void>;
  roll(): Promise<void>;
  /**
   * Click on a point in engine `Move` coordinates relative to the human:
   * `1..24`, `25` for the bar (`Board.onBarClick`), `0` for off
   * (`Board.onOffClick`). For White these equal the board's absolute points.
   */
  selectPoint(p: number): Promise<void>;
  undoPending(): void;
  confirmPlay(): Promise<void>;
  double(): Promise<void>;
  take(): Promise<void>;
  drop(): Promise<void>;
  resign(kind: ResultKind): Promise<void>;
  /** Runs whatever needs no decision from the person (`automaticActionDue`): a no-op otherwise. */
  botTurn(): Promise<void>;
  /**
   * After an engine failure: clears `ui.lastError` and runs whatever is due
   * again — the bot's stalled turn, the opening roll, or the legal plays
   * that failed to load. Also a no-op while busy.
   */
  retryBotTurn(): Promise<void>;
  /** Starts the next game of a match once its predecessor's result has been shown (`awaitingNextGame`). */
  nextGame(): Promise<void>;
  setTheme(t: ThemeId): void;
  /** Shows or hides the analysis drawer; persisted under `bg.analysis`. */
  setAnalysisVisible(visible: boolean): void;
  /** Adds a lazily computed analysis (the review page) to `analysisByTurn`; an existing entry is kept. */
  rememberAnalysis(turnIndex: number, analysis: MoveAnalysis): void;
}

export type GameStore = GameStoreState & GameStoreActions;

export interface GameStoreOptions {
  /** Where the theme and local games are kept; `null` disables persistence. Defaults to `localStorage`. */
  storage?: StorageLike | null;
}

const EMPTY_UI: GameUi = {
  selectedFrom: null,
  legalTargets: [],
  pendingMoves: [],
  pendingBoard: null,
  legalPlays: null,
  busy: false,
  lastError: null,
};

const EMPTY_ANALYSIS: GameAnalysis = { forBot: null, forHuman: null, visible: true };
const NO_ANALYSES: AnalysisByTurn = Object.freeze({});

/** `localStorage` key of the analysis drawer's visibility (`"1"` on, `"0"` off). */
export const ANALYSIS_KEY = "bg.analysis";

/** The persisted drawer visibility, or `null` when nothing (usable) is stored. */
export function loadAnalysisVisible(storage: StorageLike | null = defaultStorage()): boolean | null {
  try {
    const value = storage?.getItem(ANALYSIS_KEY) ?? null;
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

/** Persists the drawer visibility; returns `false` when storage is unavailable. */
export function saveAnalysisVisible(visible: boolean, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    storage?.setItem(ANALYSIS_KEY, visible ? "1" : "0");
    return storage !== null;
  } catch {
    return false;
  }
}

/**
 * The seed `analyzePlay` is given for the move turn at `turnIndex` of
 * `record`: `botSeed` of the record as it stood *before* that turn (the same
 * derivation as the bot's own decisions), so a later analysis of the same
 * turn — the review page, another session — reproduces the rollouts the
 * person saw during play. `turnIndex` may exceed the turns present.
 */
export function analysisSeedFor(record: GameRecord, turnIndex: number): number {
  return botSeed({ ...record, turns: record.turns.slice(0, turnIndex) });
}

/** What `analyzePlay` needs about a play, captured before the move is committed (the board changes with it). */
interface PlayToGrade {
  turnIndex: number;
  board: Board;
  player: Player;
  dice: Dice;
  matchCtx: MatchContext;
  played: string;
  seed: number;
}

/** Upper bound on consecutive automatic turns (bot actions, passes, new games) per user action. */
const MAX_AUTO_STEPS = 64;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Thrown inside a chain that `newGame` has overtaken; never reaches `ui.lastError`. */
class SupersededError extends Error {
  constructor() {
    super("superseded by a newer game");
    this.name = "SupersededError";
  }
}

/** The doubler's cube analysis, read as the taker's answer. */
function takerAccepts(action: string): boolean {
  switch (action) {
    case "doubleDrop":
    case "redoubleDrop":
    case "tooGood":
      return false;
    default:
      return true;
  }
}

const isDouble = (action: string): boolean => action.startsWith("double") || action.startsWith("redouble");

/**
 * The finished game's result when `replay` moved straight on to the next
 * game of a match: whoever's score grew won the points, and the kind is
 * the multiplier that produced them at the cube in force.
 */
function resultFromScore(before: MatchState, after: MatchState): GameResult | null {
  const players: Player[] = ["white", "black"];
  const winner = players.find((p) => after.score[p] > before.score[p]);
  if (winner === undefined) {
    return null;
  }
  const points = after.score[winner] - before.score[winner];
  const kind = resultKindFor(points, before.game.cube.value) ?? "single";
  return { winner, kind, points };
}

export function createGameStore(engine: Engine, options: GameStoreOptions = {}): StoreApi<GameStore> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;

  /** The dice stream in step with `record`; replaced only after a successful replay. */
  let rng: DiceRng | null = null;
  /** `pendingBoard` after 1, 2, … pending moves, so `undoPending` needs no engine call. */
  let pendingBoardStack: Board[] = [];
  /** Bumped by `newGame`; a chain whose generation is older drops every later result. */
  let generation = 0;

  return createStore<GameStore>()((set, get) => {
    const setUi = (patch: Partial<GameUi>): void => set((s) => ({ ui: { ...s.ui, ...patch } }));

    /** Throws unless `gen` is still the current game — call after every `await` on the engine, before touching state. */
    const ensureCurrent = (gen: number): void => {
      if (gen !== generation) {
        throw new SupersededError();
      }
    };

    /** Appends `turn`, re-derives the state and persists the record; throws on rejection. */
    const commit = async (gen: number, turn: Turn, draft: DiceRng | null): Promise<void> => {
      const { record, match, gameId } = get();
      if (!record) {
        throw new Error("no game in progress");
      }
      const next = appendTurn(record, turn);
      const state = await engine.replay(next);
      ensureCurrent(gen);
      if (draft) {
        rng = draft.clone();
      }
      const finished = state.game.phase === "finished" ? state.game.result : null;
      const rolledOver = match !== null && match.game.phase !== "openingRoll" && state.game.phase === "openingRoll";
      const lastGameResult = finished ?? (rolledOver ? resultFromScore(match, state) : null) ?? get().lastGameResult;
      pendingBoardStack = [];
      set({
        record: next,
        match: state,
        lastGameResult,
        awaitingNextGame: rolledOver,
        ui: { ...EMPTY_UI, busy: true, lastError: null },
      });
      if (gameId) {
        saveLocalGame(gameId, next, storage);
      }
    };

    /**
     * Grades the person's play with the engine's club analysis and records
     * it for the drawer (`analysis.forHuman`) and the review (`analysisByTurn`).
     * A failure is reported there, not in `ui.lastError`: the move is already
     * committed and the game must go on without its grade. Runs outside the
     * busy flag (see `confirmPlay`); a grade that lands after a newer game
     * took over is dropped. Never throws.
     */
    const gradePlay = async (gen: number, play: PlayToGrade): Promise<void> => {
      let analysis: MoveAnalysis | null = null;
      let error: string | null = null;
      try {
        analysis = await engine.analyzePlay(play.board, play.player, play.dice, play.matchCtx, play.played, play.seed);
      } catch (failure) {
        error = errorMessage(failure);
      }
      if (gen !== generation) {
        return;
      }
      const { turnIndex, player, dice, played } = play;
      set((prev) => ({
        analysis: { ...prev.analysis, forHuman: { turnIndex, player, dice, played, analysis, error } },
        analysisByTurn: analysis ? { ...prev.analysisByTurn, [turnIndex]: analysis } : prev.analysisByTurn,
      }));
    };

    /**
     * Plays out everything that needs no human decision: the bot's cube
     * decision, roll and move; the bot's answer to a double; forced passes;
     * the opening roll of a game. Stops when the human must act, when a
     * finished game of a match is on show (`awaitingNextGame`), or when the
     * match is over.
     */
    const advance = async (gen: number): Promise<void> => {
      for (let step = 0; step < MAX_AUTO_STEPS; step++) {
        ensureCurrent(gen);
        const s = get();
        const { match, record } = s;
        if (!match || !record) {
          return;
        }
        const g = match.game;
        if (g.phase === "finished") {
          return;
        }
        if (g.phase === "openingRoll") {
          if (s.awaitingNextGame) {
            return;
          }
          const draft = rng?.clone() ?? null;
          if (!draft) {
            throw new Error("no dice generator for this game");
          }
          await commit(gen, openingRollTurn(draft), draft);
          continue;
        }
        const actor = playerToAct(s);
        if (actor === null) {
          return;
        }
        if (s.seatOf[actor] === "human") {
          if (g.phase !== "toMove" || s.ui.legalPlays !== null) {
            return;
          }
          const plays = await engine.legalPlays(g.board, actor, g.dice!);
          ensureCurrent(gen);
          if (plays.length === 0 || (plays.length === 1 && plays[0].moves.length === 0)) {
            await commit(gen, moveTurn(actor, g.dice!, ""), null); // no legal move: the turn is forfeited
            continue;
          }
          setUi({ legalPlays: plays });
          return;
        }
        const level = s.botLevel;
        switch (g.phase) {
          case "toRoll": {
            if (cubeAvailableTo(s, actor)) {
              const analysis = await engine.cubeAction(g.board, actor, matchContextFor(match, actor), level);
              ensureCurrent(gen);
              if (isDouble(analysis.action)) {
                await commit(gen, doubleTurn(actor), null);
                break;
              }
            }
            const draft = rng?.clone() ?? null;
            if (!draft) {
              throw new Error("no dice generator for this game");
            }
            await commit(gen, rollTurn(actor, draft.roll()), draft);
            break;
          }
          case "toMove": {
            const dice = g.dice!;
            const chosen = await engine.choosePlay(g.board, actor, dice, matchContextFor(match, actor), level, botSeed(record));
            ensureCurrent(gen);
            set((prev) => ({
              analysis: { ...prev.analysis, forBot: { turnIndex: record.turns.length, player: actor, dice, chosen } },
            }));
            await commit(gen, moveTurn(actor, dice, chosen.play.notation), null);
            break;
          }
          case "doubled": {
            // Judge the double from the doubler's side: a position worth doubling
            // for them is one the bot should take unless it is a drop (or too good).
            const doubler = g.onRoll!;
            const analysis = await engine.cubeAction(g.board, doubler, matchContextFor(match, doubler), level);
            ensureCurrent(gen);
            await commit(gen, takerAccepts(analysis.action) ? takeTurn(actor) : dropTurn(actor), null);
            break;
          }
          default:
            return;
        }
      }
      throw new Error(`the game did not reach a decision within ${MAX_AUTO_STEPS} automatic turns`);
    };

    /**
     * Runs `action` under the busy flag; failures land in `ui.lastError`.
     * Dropped while another action runs — unless `preempt`, which starts a
     * new generation so the running chain's later results are discarded and
     * its bookkeeping (busy, error) no longer applies.
     */
    const run = async (action: (gen: number) => Promise<void>, preempt = false): Promise<void> => {
      if (!preempt && get().ui.busy) {
        return;
      }
      if (preempt) {
        generation += 1;
      }
      const gen = generation;
      setUi({ busy: true, lastError: null });
      try {
        await action(gen);
      } catch (error) {
        if (gen === generation && !(error instanceof SupersededError)) {
          setUi({ lastError: errorMessage(error) });
        }
      } finally {
        if (gen === generation) {
          setUi({ busy: false });
        }
      }
    };

    const humanTurn = (turn: Turn): Promise<void> =>
      run(async (gen) => {
        await commit(gen, turn, null);
        await advance(gen);
      });

    return {
      gameId: null,
      match: null,
      record: null,
      seatOf: { white: "human", black: "bot" },
      botLevel: "beginner",
      theme: loadTheme(storage) ?? DEFAULT_THEME,
      ui: EMPTY_UI,
      analysis: { ...EMPTY_ANALYSIS, visible: loadAnalysisVisible(storage) ?? EMPTY_ANALYSIS.visible },
      analysisByTurn: NO_ANALYSES,
      lastGameResult: null,
      awaitingNextGame: false,

      newGame: (opts) =>
        run(async (gen) => {
          const seed = opts.seed ?? randomSeed();
          const gameId = localGameId(seed);
          // A stored record is the game this id names: resume it rather than
          // start the seed over (and overwrite it with a one-turn record).
          const stored = loadLocalGame(gameId, storage);
          const resumed = stored !== null && stored.seed === seed && stored.turns.length > 0 ? stored : null;
          const length = opts.format === "single" ? 0 : opts.format.matchTo;
          const record = resumed ?? newRecord(seed, length);
          // A resumed game keeps the level it was started at; a record without
          // one (stored before levels were kept) takes the option's and records
          // it. Written before anything is awaited so even a failed replay
          // leaves the level on record.
          const level = (resumed ? loadLocalGameLevel(gameId, storage) : null) ?? opts.level;
          saveLocalGameLevel(gameId, level, storage);
          rng = null;
          pendingBoardStack = [];
          set({
            gameId,
            match: null,
            record,
            seatOf: { white: "human", black: "bot" },
            botLevel: level,
            analysis: { ...EMPTY_ANALYSIS, visible: get().analysis.visible },
            analysisByTurn: NO_ANALYSES,
            lastGameResult: null,
            awaitingNextGame: false,
            ui: { ...EMPTY_UI, busy: true },
          });
          if (resumed) {
            const stream = diceStreamAfter(resumed);
            const state = await engine.replay(resumed);
            ensureCurrent(gen);
            rng = stream;
            set({ match: state, lastGameResult: state.game.phase === "finished" ? state.game.result : null });
          } else {
            rng = new DiceRng(seed);
            const draft = rng.clone();
            await commit(gen, openingRollTurn(draft), draft);
          }
          await advance(gen);
        }, true),

      roll: () =>
        run(async (gen) => {
          const s = get();
          if (!canRoll({ ...s, ui: { ...s.ui, busy: false } })) {
            return;
          }
          const draft = rng?.clone() ?? null;
          if (!draft) {
            throw new Error("no dice generator for this game");
          }
          await commit(gen, rollTurn(s.match!.game.onRoll!, draft.roll()), draft);
          await advance(gen);
        }),

      selectPoint: async (p) => {
        const s = get();
        const g = s.match?.game;
        const human = humanPlayer(s);
        const board = displayedBoard(s);
        if (!g || human === null || board === null || s.ui.busy || g.phase !== "toMove" || g.onRoll !== human || !s.ui.legalPlays) {
          return;
        }
        const { selectedFrom, legalTargets, pendingMoves } = s.ui;
        if (selectedFrom !== null && p === selectedFrom) {
          setUi({ selectedFrom: null, legalTargets: [] });
          return;
        }
        if (selectedFrom !== null && legalTargets.includes(p)) {
          const nextPending = [...pendingMoves, moveOnBoard(board, human, selectedFrom, p)];
          await run(async (gen) => {
            const pendingBoard = await engine.applyPlay(g.board, human, partialPlay(nextPending));
            ensureCurrent(gen);
            pendingBoardStack = [...pendingBoardStack.slice(0, nextPending.length - 1), pendingBoard];
            setUi({ pendingMoves: nextPending, pendingBoard, selectedFrom: null, legalTargets: [] });
          });
          return;
        }
        if (legalSources(s).includes(p)) {
          setUi({ selectedFrom: p, legalTargets: legalTargetsFrom(s, p) });
        }
      },

      undoPending: () => {
        const s = get();
        if (s.ui.busy || s.ui.pendingMoves.length === 0) {
          return;
        }
        const pendingMoves = s.ui.pendingMoves.slice(0, -1);
        pendingBoardStack = pendingBoardStack.slice(0, pendingMoves.length);
        const pendingBoard = pendingBoardStack.at(-1) ?? null;
        setUi({ pendingMoves, pendingBoard, selectedFrom: null, legalTargets: [] });
      },

      confirmPlay: async () => {
        /** Set once the move is committed: what to grade, and the generation it belongs to. */
        const graded: { pending: { gen: number; play: PlayToGrade } | null } = { pending: null };
        await run(async (gen) => {
          const s = get();
          const unblocked = { ...s, ui: { ...s.ui, busy: false } };
          const play = completedPlay(unblocked);
          if (!canConfirm(unblocked) || play === null) {
            return;
          }
          const g = s.match!.game;
          const record = s.record!;
          const toGrade: PlayToGrade = {
            turnIndex: record.turns.length,
            board: g.board,
            player: g.onRoll!,
            dice: g.dice!,
            matchCtx: matchContextFor(s.match!, g.onRoll!),
            played: play.notation,
            seed: analysisSeedFor(record, record.turns.length),
          };
          await commit(gen, moveTurn(g.onRoll!, g.dice!, play.notation), null);
          // The previous grade was about a play that is no longer the last one.
          set((prev) => ({ analysis: { ...prev.analysis, forHuman: null } }));
          graded.pending = { gen, play: toGrade };
          await advance(gen);
        });
        // Graded once the computer has answered and the table is free again:
        // the worker is sequential, so a club-strength analysis ahead of the
        // bot's reply would hold the reply up for as long as it takes. The
        // seed was fixed before the commit, so the grade is the same either
        // way. A run overtaken by a newer game grades nothing — its analysis
        // would only sit in the queue ahead of the new game's opening.
        if (graded.pending !== null && graded.pending.gen === generation) {
          await gradePlay(graded.pending.gen, graded.pending.play);
        }
      },

      double: () => {
        const s = get();
        if (!canDouble(s)) {
          return Promise.resolve();
        }
        return humanTurn(doubleTurn(s.match!.game.onRoll!));
      },

      take: () => {
        const s = get();
        if (!canTake(s)) {
          return Promise.resolve();
        }
        return humanTurn(takeTurn(opponent(s.match!.game.onRoll!)));
      },

      drop: () => {
        const s = get();
        if (!canDrop(s)) {
          return Promise.resolve();
        }
        return humanTurn(dropTurn(opponent(s.match!.game.onRoll!)));
      },

      resign: (kind) => {
        const s = get();
        if (!canResign(s)) {
          return Promise.resolve();
        }
        const g = s.match!.game;
        // Log what the rules award (Jacoby: a gammon at a centred cube is a single), or replay rejects the turn.
        return humanTurn(resignTurn(g.onRoll!, concededPoints(kind, g)));
      },

      botTurn: () => (automaticActionDue(get()) ? run(advance) : Promise.resolve()),

      retryBotTurn: () => run(advance),

      nextGame: () => {
        const s = get();
        if (!s.awaitingNextGame || s.ui.busy) {
          return Promise.resolve();
        }
        set({ awaitingNextGame: false });
        return run(advance);
      },

      setTheme: (theme) => {
        set({ theme });
        saveTheme(theme, storage);
      },

      setAnalysisVisible: (visible) => {
        set((s) => ({ analysis: { ...s.analysis, visible } }));
        saveAnalysisVisible(visible, storage);
      },

      rememberAnalysis: (turnIndex, analysis) =>
        set((s) => (turnIndex in s.analysisByTurn ? {} : { analysisByTurn: { ...s.analysisByTurn, [turnIndex]: analysis } })),
    };
  });
}

// ---------------------------------------------------------------------------
// React binding

let singleton: StoreApi<GameStore> | null = null;

/** The app's store, created on first use over the worker-backed engine. */
export function getGameStore(): StoreApi<GameStore> {
  if (singleton === null) {
    singleton = createGameStore(createEngine());
  }
  return singleton;
}

/** `useGameStore(selector)` — a Zustand hook over `getGameStore()`. */
export function useGameStore<T>(selector: (state: GameStore) => T): T {
  return useStore(getGameStore(), selector);
}
