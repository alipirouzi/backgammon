/**
 * Append helpers for the match record — the single source of truth of a bot
 * game. Every action becomes exactly one `Turn` shaped as `bg_core::Record`
 * expects (`engine/bg-core/src/record.rs`); the store then re-derives the
 * `MatchState` with the engine's `replay`, which verifies dice, players and
 * plays. Nothing here decides legality.
 */

import type {
  Cube,
  Dice,
  MatchContext,
  MatchState,
  Move,
  Play,
  Player,
  Record as GameRecord,
  ResultKind,
  Rules,
  Turn,
} from "@/engine/types";

import { DiceRng, MAX_SEED, assertSeed, type DieSource } from "./dice";

export { MAX_SEED };

/** `Rules::money()` for a single game (`length` 0), `Rules::match_play()` otherwise. */
export function defaultRules(length: number): Rules {
  return length === 0
    ? { jacoby: true, beavers: false, autoDoubles: false }
    : { jacoby: false, beavers: false, autoDoubles: false };
}

/** An empty record for a match (or, with `length` 0, a single game). */
export function newRecord(seed: number, length: number, rules: Rules = defaultRules(length)): GameRecord {
  assertSeed(seed);
  if (!Number.isInteger(length) || length < 0 || length > 255) {
    throw new RangeError(`invalid match length ${length}: must be an integer in 0..=255`);
  }
  return { seed, length, rules, turns: [] };
}

/** A new record with `turns` appended; the input is left untouched. */
export function appendTurn(record: GameRecord, ...turns: Turn[]): GameRecord {
  return { ...record, turns: [...record.turns, ...turns] };
}

function bare(player: Player, action: Turn["action"]): Turn {
  return { player, dice: null, action, play: null, resignPoints: null };
}

/** `player` rolled `dice`; for the opening roll `player` is its winner. */
export function rollTurn(player: Player, dice: Dice): Turn {
  return { ...bare(player, "roll"), dice };
}

/** `player` played `notation` (the engine's own, relative to `player`; `""` = no legal move) with `dice`. */
export function moveTurn(player: Player, dice: Dice, notation: string): Turn {
  return { ...bare(player, "move"), dice, play: notation };
}

export function doubleTurn(player: Player): Turn {
  return bare(player, "double");
}

export function takeTurn(player: Player): Turn {
  return bare(player, "take");
}

export function dropTurn(player: Player): Turn {
  return bare(player, "drop");
}

/** `player` resigned, conceding `points` (see `resignPoints`). */
export function resignTurn(player: Player, points: number): Turn {
  return { ...bare(player, "resign"), resignPoints: points };
}

/**
 * The opening roll exactly as `GameState::opening_roll` draws it: White's
 * die first, then Black's; a tie is drawn again (auto-doubles only touch the
 * cube, which the engine applies during replay); the higher die's owner is
 * on roll and the turn is logged in their name.
 */
export function openingRollTurn(rng: DieSource): Turn {
  for (;;) {
    const white = rng.rollOne();
    const black = rng.rollOne();
    if (white === black) {
      continue;
    }
    const winner: Player = white > black ? "white" : "black";
    return rollTurn(winner, { hi: Math.max(white, black), lo: Math.min(white, black) });
  }
}

/**
 * Tie re-draws tolerated while matching an opening roll. Ties are re-drawn
 * until the dice differ, so a valid record never needs more than a handful;
 * the bound keeps a corrupt record from being searched for ever.
 */
const MAX_OPENING_TIES = 64;

const sameDice = (a: Dice, b: Dice): boolean => a.hi === b.hi && a.lo === b.lo;

/**
 * The dice stream positioned just after the last roll of `record`, for
 * resuming a stored game: `replay` verifies logged dice but never says where
 * the stream stands, so the record is walked the way the engine consumed it.
 * Every roll turn consumed one pair; an opening roll additionally consumed
 * one pair per tie (`GameState::opening_roll`). A tie is never logged as an
 * opening roll and a regular roll always equals the pair drawn for it, so
 * a drawn pair that is a tie yet differs from the logged dice can only be an
 * opening re-roll. Throws when the logged dice cannot follow from the seed
 * (the engine's `replay` would reject the record too).
 */
export function diceStreamAfter(record: GameRecord): DiceRng {
  const rng = new DiceRng(record.seed);
  record.turns.forEach((turn, index) => {
    if (turn.action !== "roll") {
      return;
    }
    const logged = turn.dice;
    if (!logged) {
      throw new Error(`turn ${index}: roll turn has no dice`);
    }
    for (let ties = 0; ; ties++) {
      const drawn = rng.roll();
      if (sameDice(drawn, logged)) {
        return;
      }
      if (drawn.hi !== drawn.lo || ties >= MAX_OPENING_TIES) {
        throw new Error(
          `turn ${index}: logged dice ${logged.hi}-${logged.lo} but the seed gives ${drawn.hi}-${drawn.lo}; the stored record does not follow its seed`,
        );
      }
    }
  });
  return rng;
}

const KIND_MULTIPLIER: { readonly [K in ResultKind]: number } = { single: 1, gammon: 2, backgammon: 3 };

/** `kind` × `cubeValue`, with no rule applied (see `concededPoints` for what a resignation must log). */
export function resignPoints(kind: ResultKind, cubeValue: number): number {
  return KIND_MULTIPLIER[kind] * cubeValue;
}

/**
 * The points the engine awards for a resignation as `kind` in `game` —
 * `GameState::finish` in `engine/bg-core/src/game.rs`: under the Jacoby rule
 * a gammon or backgammon counts as a single game while the cube is still
 * centred (no double was offered), then the multiplier applies to the cube.
 * `replay` rejects a resign turn whose logged points differ from this.
 */
export function concededPoints(kind: ResultKind, game: { rules: Pick<Rules, "jacoby">; cube: Cube }): number {
  const effective: ResultKind = game.rules.jacoby && game.cube.owner === null ? "single" : kind;
  return resignPoints(effective, game.cube.value);
}

/** The kind whose multiplier × `cubeValue` equals `points`, or `null`. */
export function resultKindFor(points: number, cubeValue: number): ResultKind | null {
  const kinds: ResultKind[] = ["single", "gammon", "backgammon"];
  return kinds.find((k) => KIND_MULTIPLIER[k] * cubeValue === points) ?? null;
}

export function opponent(player: Player): Player {
  return player === "white" ? "black" : "white";
}

/** `bg_bot::MatchContext` from `player`'s side of `match`. */
export function matchContextFor(match: MatchState, player: Player): MatchContext {
  const other = opponent(player);
  const away = (p: Player): number => (match.length === 0 ? 0 : Math.max(0, match.length - match.score[p]));
  const owner = match.game.cube.owner;
  return {
    length: match.length,
    myAway: away(player),
    theirAway: away(other),
    crawford: match.crawford,
    postCrawford: match.postCrawford,
    cube: match.game.cube.value,
    cubeOwnerIsMe: owner === null ? null : owner === player,
  };
}

/** A fresh 53-bit seed from the platform CSPRNG (`crypto.getRandomValues`). */
export function randomSeed(): number {
  const words = new Uint32Array(2);
  globalThis.crypto.getRandomValues(words);
  return (words[0] & 0x1f_ffff) * 2 ** 32 + words[1];
}

/**
 * The seed handed to `choosePlay` for the bot's next decision: derived from
 * the record so a game replays identically for the same `seed`, distinct per
 * turn, and within the engine's safe-integer bound.
 */
export function botSeed(record: GameRecord): number {
  const step = 1_000_003;
  return (record.seed + step * (record.turns.length + 1)) % (MAX_SEED + 1);
}

const sameSquare = (a: Move, b: Move): boolean => a.from === b.from && a.to === b.to;

/**
 * The moves of `play` not yet in `pending`, matched by `from`/`to` as a
 * multiset (order and hit flags are ignored: a person may enter the moves
 * of a play in any order). Returns `null` when `pending` is not a
 * sub-multiset of `play.moves`.
 */
function unmatched(pending: readonly Move[], play: Play): Move[] | null {
  const rest = [...play.moves];
  for (const move of pending) {
    const i = rest.findIndex((m) => sameSquare(m, move));
    if (i === -1) {
      return null;
    }
    rest.splice(i, 1);
  }
  return rest;
}

/** `true` when every pending move belongs to `play` (see `unmatched`). */
export function movesMatchPlay(pending: readonly Move[], play: Play): boolean {
  return unmatched(pending, play) !== null;
}

/** The moves of `play` still to be entered after `pending` (empty when none match). */
export function remainingMoves(pending: readonly Move[], play: Play): Move[] {
  return unmatched(pending, play) ?? [];
}

/**
 * A `Play` argument for `applyPlay` carrying only the moves: the engine
 * accepts a play object without `notation` (`engine/bg-wasm/src/api.rs`),
 * and a partial play has no engine notation to give.
 */
export function partialPlay(moves: readonly Move[]): Play {
  return { moves: [...moves] } as Play;
}
