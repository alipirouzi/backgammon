//! Brute-force reference for legal-play generation.
//!
//! The oracle below is written from scratch: its move logic shares nothing
//! with `bg_core::moves` except the `Move`, `Play` and `Position` data types
//! (and `Dice`). It enumerates every die order, tries every source point at
//! every step with a naive single-checker legality function, keeps the
//! sequences that use the most dice (larger die first when only one die can
//! be played) and dedupes by resulting position. `legal_plays` must produce
//! exactly the same set of resulting positions on the opening position for
//! all 21 rolls and on hundreds of random positions.
//!
//! The engine side of the comparison uses the engine's own `apply` and
//! `is_legal`, which share their single-checker step with `legal_plays`. So
//! that the `Move` labels (`hit`, `to`) and the dice used are not vouched for
//! by the code under test alone, every returned play is also replayed move by
//! move through the oracle's step ([`oracle_replay`]), which must reach the
//! same position with the same `hit` flag on every move.

use std::collections::BTreeSet;

use bg_core::moves::{apply, is_legal, legal_plays};
use bg_core::{Board, Dice, Move, Play, Player, Position};
use proptest::prelude::*;
use rand_chacha::ChaCha8Rng;
use rand_core::{Rng, SeedableRng};

// ---------------------------------------------------------------------------
// Oracle (independent of moves.rs)
// ---------------------------------------------------------------------------

/// Oracle's own view of a single-checker move: `Some((next position, hit))`
/// when the checker on `from` may move by `die`, `None` otherwise. `hit` is
/// `true` when the move sent an opposing blot to the bar.
fn oracle_step(pos: &Position, from: usize, die: u8) -> Option<(Position, bool)> {
    let die = usize::from(die);
    if pos.mine[from] == 0 {
        return None;
    }
    // Bar first.
    if pos.mine[25] > 0 && from != 25 {
        return None;
    }
    let mut next = *pos;
    if from > die {
        // Ordinary move (from 25 = bar this lands on 19..=24).
        let to = from - die;
        let hit = match next.theirs[to] {
            0 => false,
            1 => {
                next.theirs[to] = 0;
                next.theirs[25] += 1;
                true
            }
            _ => return None,
        };
        next.mine[from] -= 1;
        next.mine[to] += 1;
        return Some((next, hit));
    }
    // Bearing off: every one of my checkers must be in my home board or off.
    if (7..=25).any(|i| pos.mine[i] > 0) {
        return None;
    }
    // Exact die, or a larger die when no checker sits on a higher point.
    if die > from && (from + 1..=6).any(|i| pos.mine[i] > 0) {
        return None;
    }
    next.mine[from] -= 1;
    next.mine[0] += 1;
    Some((next, false))
}

/// The dice a play may consume: four copies for a double, else both dice.
fn dice_pool(dice: Dice) -> Vec<u8> {
    if dice.is_double() {
        vec![dice.hi; 4]
    } else {
        vec![dice.hi, dice.lo]
    }
}

/// Replays an engine play move by move through [`oracle_step`], assigning
/// dice from `pool` by backtracking (a bear-off with no exact die may use
/// any die the oracle accepts, so a greedy choice would not do). Returns the
/// resulting position when every move is an oracle-legal single-checker move
/// that lands where the engine says with the engine's `hit` flag, and the
/// moves together consume dice from `pool` only; `None` otherwise.
fn oracle_replay(pos: &Position, moves: &[Move], pool: &mut Vec<u8>) -> Option<Position> {
    let Some((m, rest)) = moves.split_first() else {
        return Some(*pos);
    };
    let from = usize::from(m.from);
    let to = usize::from(m.to);
    for i in 0..pool.len() {
        let die = pool[i];
        // A move to a point uses exactly the die of its distance.
        if to != 0 && from != to + usize::from(die) {
            continue;
        }
        let Some((next, hit)) = oracle_step(pos, from, die) else {
            continue;
        };
        if next.mine[to] != pos.mine[to] + 1 || hit != m.hit {
            continue;
        }
        pool.remove(i);
        let result = oracle_replay(&next, rest, pool);
        pool.insert(i, die);
        if result.is_some() {
            return result;
        }
    }
    None
}

/// Every position reachable by playing the dice in the given order, as many
/// as possible. Returns `(dice used, positions)` grouped by dice used.
fn oracle_sequences(pos: &Position, order: &[u8], out: &mut Vec<(usize, Position)>, used: usize) {
    let Some((&die, rest)) = order.split_first() else {
        out.push((used, *pos));
        return;
    };
    let mut moved = false;
    for from in (1..=25).rev() {
        if let Some((next, _)) = oracle_step(pos, from, die) {
            moved = true;
            oracle_sequences(&next, rest, out, used + 1);
        }
    }
    if !moved {
        out.push((used, *pos));
    }
}

/// Orderable key for a position (`Position` itself is not `Ord`).
type PosKey = ([u8; 26], [u8; 26]);

fn key(p: &Position) -> PosKey {
    (p.mine, p.theirs)
}

/// The set of positions reachable by a legal play of `dice` from `pos`.
fn oracle_positions(pos: &Position, dice: Dice) -> BTreeSet<PosKey> {
    let orders: Vec<Vec<u8>> = if dice.is_double() {
        vec![dice_pool(dice)]
    } else {
        vec![dice_pool(dice), vec![dice.lo, dice.hi]]
    };
    let mut per_order: Vec<Vec<(usize, Position)>> = Vec::new();
    for order in &orders {
        let mut out = Vec::new();
        oracle_sequences(pos, order, &mut out, 0);
        per_order.push(out);
    }
    let max_used = per_order
        .iter()
        .flatten()
        .map(|(n, _)| *n)
        .max()
        .unwrap_or(0);
    let mut keep: Vec<&Vec<(usize, Position)>> = per_order.iter().collect();
    if max_used == 1 && !dice.is_double() {
        // Only one die can be played: the larger one if it can be played at
        // all (order 0 starts with `hi`).
        let hi_playable = per_order[0].iter().any(|(n, _)| *n == 1);
        keep = if hi_playable {
            vec![&per_order[0]]
        } else {
            vec![&per_order[1]]
        };
    }
    keep.into_iter()
        .flatten()
        .filter(|(n, _)| *n == max_used)
        .map(|(_, p)| key(p))
        .collect()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn opening() -> Position {
    Position::from_board(&Board::opening(), Player::White)
}

fn positions_of(pos: &Position, plays: &[Play]) -> Vec<Position> {
    plays
        .iter()
        .map(|p| apply(pos, p).expect("engine play must apply"))
        .collect()
}

/// Checks `legal_plays` against the oracle (resulting positions, and every
/// returned play replayed through the oracle's step for its `hit` flags and
/// dice) and verifies the engine's own invariants (one canonical play per
/// position, sorted, applicable).
fn check(pos: &Position, dice: Dice) -> Result<(), TestCaseError> {
    let plays = legal_plays(pos, dice);
    prop_assert!(
        !plays.is_empty(),
        "legal_plays must return at least the empty play"
    );
    let results = positions_of(pos, &plays);
    let engine: BTreeSet<PosKey> = results.iter().map(key).collect();
    prop_assert_eq!(
        engine.len(),
        plays.len(),
        "duplicate resulting positions for {:?} {:?}",
        pos,
        dice
    );
    let oracle = oracle_positions(pos, dice);
    prop_assert_eq!(&engine, &oracle, "position {:?} dice {:?}", pos, dice);
    let len = plays[0].moves.len();
    for (play, result) in plays.iter().zip(&results) {
        prop_assert_eq!(
            play.moves.len(),
            len,
            "all plays use the same number of dice"
        );
        let replayed = oracle_replay(pos, &play.moves, &mut dice_pool(dice));
        prop_assert_eq!(
            replayed.as_ref().map(key),
            Some(key(result)),
            "oracle cannot replay engine play {:?} (hit flags or dice) from {:?} {:?}",
            play,
            pos,
            dice
        );
        prop_assert!(play.moves.len() <= 4);
        for w in play.moves.windows(2) {
            prop_assert!(
                (w[0].from, w[0].to) >= (w[1].from, w[1].to),
                "moves not canonical in {:?}",
                play
            );
        }
        prop_assert!(
            is_legal(pos, dice, play),
            "returned play not legal: {:?}",
            play
        );
    }
    for w in plays.windows(2) {
        prop_assert!(
            play_key(&w[0]) < play_key(&w[1]),
            "plays not sorted: {:?}",
            plays
        );
    }
    Ok(())
}

fn play_key(p: &Play) -> Vec<(std::cmp::Reverse<u8>, std::cmp::Reverse<u8>)> {
    p.moves
        .iter()
        .map(|m| (std::cmp::Reverse(m.from), std::cmp::Reverse(m.to)))
        .collect()
}

fn random_dice(rng: &mut ChaCha8Rng) -> Dice {
    let a = u8::try_from(rng.next_u32() % 6 + 1).expect("1..=6");
    let b = u8::try_from(rng.next_u32() % 6 + 1).expect("1..=6");
    Dice::new(a, b).expect("valid dice")
}

/// A position reached by playing `steps` random legal plays from the opening
/// (alternating sides), stopping early when a side has borne everything off.
fn random_game_position(seed: u64, steps: usize) -> Position {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let mut pos = opening();
    for _ in 0..steps {
        if pos.mine[0] == 15 || pos.theirs[0] == 15 {
            break;
        }
        let dice = random_dice(&mut rng);
        let plays = legal_plays(&pos, dice);
        let idx = usize::try_from(rng.next_u32()).expect("usize") % plays.len();
        pos = apply(&pos, &plays[idx]).expect("legal play applies").flip();
    }
    pos
}

/// Any structurally valid position: 15 checkers each, no shared point.
fn arb_position() -> impl Strategy<Value = Position> {
    prop::collection::vec(0usize..26, 15).prop_flat_map(|slots| {
        let mut mine = [0u8; 26];
        for &s in &slots {
            mine[s] += 1;
        }
        let allowed: Vec<usize> = (0..26)
            .filter(|&i| i == 0 || i == 25 || mine[i] == 0)
            .collect();
        let n = allowed.len();
        prop::collection::vec(0usize..n, 15).prop_map(move |picks| {
            let mut theirs = [0u8; 26];
            for &k in &picks {
                theirs[allowed[k]] += 1;
            }
            Position { mine, theirs }
        })
    })
}

fn arb_dice() -> impl Strategy<Value = Dice> {
    (1u8..=6, 1u8..=6).prop_map(|(a, b)| Dice::new(a, b).expect("valid dice"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn opening_matches_oracle_for_all_rolls() {
    for dice in Dice::all() {
        check(&opening(), dice).unwrap_or_else(|e| panic!("{dice:?}: {e}"));
    }
}

/// Number of distinct legal plays from the opening position, per roll, in the
/// order of `Dice::all()` (hi ascending, then lo ascending). Frozen from the
/// oracle output; 6-5 (7), 5-5 (4) and 6-6 (11) were checked by hand:
///
/// * 6-5: sixes 24/18, 13/7, 8/2; fives 13/8, 8/3 (24/19 and 6/1 blocked),
///   plus 18/13 after 24/18 and 7/2 after 13/7. Resulting positions:
///   24/13, 24/18 13/8, 24/18 8/3, 13/7 13/8, 13/7 8/3, 8/3 8/2 and
///   13/8 8/2 (= 13/7 7/2, the same position) → 7.
/// * 5-5: only 13/8 and 8/3 are open (24/19 and 6/1 blocked). Four moves
///   split x·13/8 + y·8/3 with x + y = 4 and y ≤ 3 + x: (4,0), (3,1),
///   (2,2), (1,3) → 4.
/// * 6-6: open sixes are 24/18 (at most 2, 18/12 is blocked), 13/7 (up to 4)
///   and 8/2 (up to 3); 7/1 is blocked. Solutions of a+b+c = 4 with a ≤ 2,
///   b ≤ 4, c ≤ 3: 4 + 4 + 3 = 11.
const OPENING_PLAY_COUNTS: [(u8, u8, usize); 21] = [
    (1, 1, 42),
    (2, 1, 15),
    (2, 2, 75),
    (3, 1, 16),
    (3, 2, 17),
    (3, 3, 73),
    (4, 1, 14),
    (4, 2, 18),
    (4, 3, 17),
    (4, 4, 52),
    (5, 1, 8),
    (5, 2, 8),
    (5, 3, 9),
    (5, 4, 9),
    (5, 5, 4),
    (6, 1, 10),
    (6, 2, 14),
    (6, 3, 14),
    (6, 4, 14),
    (6, 5, 7),
    (6, 6, 11),
];

#[test]
fn opening_play_counts_are_frozen() {
    let actual: Vec<(u8, u8, usize)> = Dice::all()
        .iter()
        .map(|d| (d.hi, d.lo, oracle_positions(&opening(), *d).len()))
        .collect();
    assert_eq!(actual, OPENING_PLAY_COUNTS.to_vec(), "oracle counts");
    for (hi, lo, n) in OPENING_PLAY_COUNTS {
        let dice = Dice::new(hi, lo).expect("valid dice");
        assert_eq!(legal_plays(&opening(), dice).len(), n, "{hi}-{lo}");
    }
}

#[test]
fn closed_out_player_on_the_bar_has_only_the_empty_play() {
    // One checker on my bar, fourteen borne off; their home board is closed.
    let mut mine = [0u8; 26];
    mine[25] = 1;
    mine[0] = 14;
    let mut theirs = [0u8; 26];
    for slot in &mut theirs[19..=24] {
        *slot = 2;
    }
    theirs[0] = 3;
    let pos = Position { mine, theirs };
    for dice in Dice::all() {
        let plays = legal_plays(&pos, dice);
        assert_eq!(plays, vec![Play::empty()], "{dice:?}");
        assert_eq!(oracle_positions(&pos, dice), BTreeSet::from([key(&pos)]));
        assert!(is_legal(&pos, dice, &Play::empty()));
        assert_eq!(apply(&pos, &Play::empty()), Ok(pos));
    }
}

/// The oracle's replay is what pins the `hit` label: a hitting play whose
/// flag is inverted must be rejected by the oracle regardless of what the
/// engine's `apply`/`is_legal` say about it.
#[test]
fn oracle_replay_rejects_a_wrong_hit_flag_and_a_wrong_die() {
    // One of their five checkers on my 19 moved to 18 as a blot; my checkers
    // on 24 hit it with the 6: 24/18*.
    let mut pos = opening();
    pos.theirs[19] -= 1;
    pos.theirs[18] = 1;
    let dice = Dice::new(6, 3).expect("valid dice");
    let plays = legal_plays(&pos, dice);
    let hitting: Vec<&Play> = plays
        .iter()
        .filter(|p| p.moves.iter().any(|m| m.from == 24 && m.to == 18))
        .collect();
    assert!(!hitting.is_empty(), "24/18* must be among the legal plays");
    for play in hitting {
        assert!(play.moves.iter().any(|m| m.to == 18 && m.hit), "{play:?}");
        assert!(oracle_replay(&pos, &play.moves, &mut dice_pool(dice)).is_some());
        let unflagged = Play {
            moves: play
                .moves
                .iter()
                .map(|m| Move {
                    hit: if m.to == 18 { false } else { m.hit },
                    ..*m
                })
                .collect(),
        };
        assert!(
            oracle_replay(&pos, &unflagged.moves, &mut dice_pool(dice)).is_none(),
            "{unflagged:?}"
        );
    }
    // A play whose moves do not fit the dice.
    let fake = Play {
        moves: vec![Move {
            from: 24,
            to: 15,
            hit: false,
        }],
    };
    assert!(oracle_replay(&pos, &fake.moves, &mut dice_pool(dice)).is_none());
}

#[test]
fn dropping_a_move_or_faking_a_die_is_not_legal() {
    let pos = opening();
    let dice = Dice::new(6, 3).expect("valid dice");
    let plays = legal_plays(&pos, dice);
    assert!(plays.iter().all(|p| p.moves.len() == 2));
    for p in &plays {
        let short = Play {
            moves: vec![p.moves[0]],
        };
        assert!(!is_legal(&pos, dice, &short), "{short:?}");
    }
    // 24/15 as one move: same position as 24/21 21/15 but not a die.
    let fake = Play {
        moves: vec![Move {
            from: 24,
            to: 15,
            hit: false,
        }],
    };
    assert!(!is_legal(&pos, dice, &fake));
    assert!(apply(&pos, &fake).is_err());
}

proptest! {
    // 300 cases (plan Task 2) × 2 tests × 2 orientations = 1200 positions
    // checked against the oracle; the whole file runs well under the plan's
    // 60 s budget in debug builds.
    #![proptest_config(ProptestConfig { cases: 300, .. ProptestConfig::default() })]

    #[test]
    fn game_positions_match_oracle(seed in any::<u64>(), steps in 0usize..80, dice in arb_dice()) {
        let pos = random_game_position(seed, steps);
        check(&pos, dice)?;
        check(&pos.flip(), dice)?;
    }

    #[test]
    fn arbitrary_positions_match_oracle(pos in arb_position(), dice in arb_dice()) {
        check(&pos, dice)?;
        check(&pos.flip(), dice)?;
    }
}
