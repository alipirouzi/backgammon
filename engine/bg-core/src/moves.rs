//! Moves, plays, legal-play generation and application.
//!
//! Rules implemented here (see <https://www.bkgm.com/rules.html>, "Movement
//! of the Checkers", "Hitting and Entering" and "Bearing Off"):
//!
//! * a checker may only land on a point holding at most one opposing
//!   checker (`theirs[to] <= 1`); landing on a lone opposing checker hits it
//!   and sends it to the opponent's bar (`theirs[25]`);
//! * a player with checkers on the bar must enter them before moving
//!   anything else;
//! * bearing off is allowed only once every checker is in the home board
//!   (`Position::all_home`), with the exact die, or with a larger die from
//!   the highest occupied point;
//! * both dice must be played when any order allows it; when only one die
//!   can be played the larger one must be used if it can; doubles are played
//!   up to four times, as many as possible.
//!
//! [`legal_plays`] returns one canonical play per distinct resulting
//! position, sorted; [`apply`] validates a play move by move and returns the
//! new position; [`is_legal`] checks a play against a roll.

use core::cmp::Reverse;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::position::{BAR, OFF};
use crate::{Dice, Position, RulesError};

/// One checker moving by one die, relative to the mover: `from` is `1..=24`
/// or `25` (bar), `to` is `1..=24` or `0` (off); `hit` is set when the move
/// sends an opposing blot to the bar.
///
/// JSON shape: `{ "from": 24, "to": 18, "hit": false }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    /// Source point (`1..=24`) or `25` for the bar.
    pub from: u8,
    /// Destination point (`1..=24`) or `0` for off.
    pub to: u8,
    /// `true` when an opposing blot on `to` is hit.
    pub hit: bool,
}

/// A full play: 0–4 moves in the order they are made. Two plays are the same
/// play iff they produce the same position; canonical plays list moves sorted
/// by `from` descending, then `to` descending.
///
/// JSON shape: `{ "moves": [Move, ...], "notation": "24/18 13/10" }`; the
/// `Serialize`/`Deserialize` impls live in [`crate::notation`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct Play {
    /// The moves, in the order they are made (at most four).
    pub moves: Vec<Move>,
}

impl Play {
    /// The play with no moves (used when a roll cannot be played).
    #[must_use]
    pub fn empty() -> Self {
        Self { moves: Vec::new() }
    }

    /// `true` when the play contains no moves.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.moves.is_empty()
    }
}

/// The most moves a play can contain (doubles).
const MAX_MOVES: usize = 4;
/// `Move::from` value that denotes the bar.
const BAR_FROM: u8 = 25;
/// `Move::to` value that denotes bearing off.
const OFF_TO: u8 = 0;
/// Highest point of the home board.
const HOME_TOP: u8 = 6;

/// A single move together with the die that made it.
#[derive(Debug, Clone, Copy)]
struct DieMove {
    mv: Move,
    die: u8,
}

/// A sequence of die moves and the position it leads to.
#[derive(Debug, Clone)]
struct Sequence {
    moves: Vec<DieMove>,
    end: Position,
}

/// Sort key for canonical order: `from` descending, then `to` descending.
type MoveKey = (Reverse<u8>, Reverse<u8>);

fn move_key(m: Move) -> MoveKey {
    (Reverse(m.from), Reverse(m.to))
}

fn play_key(p: &Play) -> Vec<MoveKey> {
    p.moves.iter().copied().map(move_key).collect()
}

/// Moves one checker from `from` by `die`, validating every single-checker
/// rule (bar first, blocked points, bearing off). Returns the new position
/// and the move made, with `hit` filled in.
fn step(pos: &Position, from: u8, die: u8) -> Result<(Position, Move), RulesError> {
    if !(1..=BAR_FROM).contains(&from) {
        return Err(RulesError::IllegalPlay(format!(
            "from {from} is not a point or the bar"
        )));
    }
    if !(1..=6).contains(&die) {
        return Err(RulesError::IllegalPlay(format!(
            "distance {die} is not a die"
        )));
    }
    let from_i = usize::from(from);
    if pos.mine[from_i] == 0 {
        return Err(RulesError::IllegalPlay(format!("no checker on {from}")));
    }
    if pos.mine[BAR] > 0 && from != BAR_FROM {
        return Err(RulesError::IllegalPlay(
            "checkers on the bar must enter first".into(),
        ));
    }
    let mut next = *pos;
    next.mine[from_i] -= 1;
    if from > die {
        let to = from - die;
        let to_i = usize::from(to);
        let hit = match pos.theirs[to_i] {
            0 => false,
            1 => true,
            _ => {
                return Err(RulesError::IllegalPlay(format!("point {to} is blocked")));
            }
        };
        if hit {
            next.theirs[to_i] = 0;
            next.theirs[BAR] += 1;
        }
        next.mine[to_i] += 1;
        return Ok((next, Move { from, to, hit }));
    }
    // Bearing off (from <= die, so from is a home-board point).
    if !pos.all_home() {
        return Err(RulesError::IllegalPlay(
            "cannot bear off before every checker is home".into(),
        ));
    }
    if die > from && (from + 1..=HOME_TOP).any(|p| pos.mine[usize::from(p)] > 0) {
        return Err(RulesError::IllegalPlay(format!(
            "cannot bear off from {from} with a {die} while a higher point is occupied"
        )));
    }
    next.mine[OFF] += 1;
    Ok((
        next,
        Move {
            from,
            to: OFF_TO,
            hit: false,
        },
    ))
}

/// Depth-first enumeration state for one die order.
struct Enumeration<'a> {
    order: &'a [u8],
    prefix: Vec<DieMove>,
    out: Vec<Sequence>,
    /// Positions already expanded at each depth. Within a fixed die order the
    /// position after `k` moves determines which moves were made (the net
    /// flow of checkers along fixed-length edges has a unique decomposition),
    /// so a repeated position at the same depth would only repeat work.
    seen: Vec<HashSet<Position>>,
}

/// Every maximal sequence obtained by playing `order` (one die per step) as
/// far as possible, trying every source point at every step.
fn sequences(pos: &Position, order: &[u8]) -> Vec<Sequence> {
    let mut e = Enumeration {
        order,
        prefix: Vec::with_capacity(order.len()),
        out: Vec::new(),
        seen: vec![HashSet::new(); order.len() + 1],
    };
    e.extend(pos, 0);
    e.out
}

impl Enumeration<'_> {
    fn extend(&mut self, pos: &Position, depth: usize) {
        if !self.seen[depth].insert(*pos) {
            return;
        }
        let Some(&die) = self.order.get(depth) else {
            self.emit(pos);
            return;
        };
        let mut moved = false;
        for from in (1..=BAR_FROM).rev() {
            if pos.mine[usize::from(from)] == 0 {
                continue;
            }
            if let Ok((next, mv)) = step(pos, from, die) {
                moved = true;
                self.prefix.push(DieMove { mv, die });
                self.extend(&next, depth + 1);
                self.prefix.pop();
            }
        }
        if !moved {
            self.emit(pos);
        }
    }

    fn emit(&mut self, end: &Position) {
        self.out.push(Sequence {
            moves: self.prefix.clone(),
            end: *end,
        });
    }
}

/// Puts a sequence's moves in canonical order (`from` desc, `to` desc) and
/// replays them so the `hit` flags belong to the moves that actually hit in
/// that order. Falls back to the played order if the replay fails.
fn canonical(pos: &Position, seq: &Sequence) -> Play {
    let mut moves = seq.moves.clone();
    moves.sort_by_key(|dm| move_key(dm.mv));
    let mut cur = *pos;
    let mut out = Vec::with_capacity(moves.len());
    for dm in &moves {
        match step(&cur, dm.mv.from, dm.die) {
            Ok((next, mv)) => {
                cur = next;
                out.push(mv);
            }
            Err(_) => {
                return Play {
                    moves: seq.moves.iter().map(|dm| dm.mv).collect(),
                };
            }
        }
    }
    Play { moves: out }
}

/// Every legal play of `dice` from `pos`, paired with the position it leads
/// to; one canonical play per position, sorted by canonical move order.
fn legal_plays_with_positions(pos: &Position, dice: Dice) -> Vec<(Position, Play)> {
    let (hi_first, lo_first) = if dice.is_double() {
        (sequences(pos, &[dice.hi; MAX_MOVES]), Vec::new())
    } else {
        (
            sequences(pos, &[dice.hi, dice.lo]),
            sequences(pos, &[dice.lo, dice.hi]),
        )
    };
    let max_used = hi_first
        .iter()
        .chain(&lo_first)
        .map(|s| s.moves.len())
        .max()
        .unwrap_or(0);
    // Only one die can be played: the larger one when it can be played at all.
    let hi_only = max_used == 1 && hi_first.iter().any(|s| s.moves.len() == 1);
    let mut best: HashMap<Position, Play> = HashMap::new();
    let candidates = hi_first
        .iter()
        .chain(if hi_only { &[][..] } else { &lo_first[..] })
        .filter(|s| s.moves.len() == max_used);
    for seq in candidates {
        let play = canonical(pos, seq);
        best.entry(seq.end)
            .and_modify(|existing| {
                if play_key(&play) < play_key(existing) {
                    *existing = play.clone();
                }
            })
            .or_insert(play);
    }
    let mut plays: Vec<(Position, Play)> = best.into_iter().collect();
    plays.sort_by_cached_key(|(_, p)| play_key(p));
    plays
}

/// All legal plays of `dice` from `pos`: one canonical representative per
/// distinct resulting position, sorted by canonical move order (`from`
/// descending, then `to` descending, move by move).
///
/// When no move is possible the result is `vec![Play::empty()]`. Where two
/// move sequences reach the same position via different intermediate points
/// (e.g. `24/21 21/15` and `24/18 18/15`), the one whose moves sort first
/// under the canonical order is returned (`24/21 21/15`).
#[must_use]
pub fn legal_plays(pos: &Position, dice: Dice) -> Vec<Play> {
    legal_plays_with_positions(pos, dice)
        .into_iter()
        .map(|(_, p)| p)
        .collect()
}

/// Applies `play` to `pos`, validating each move in sequence: the source
/// holds a checker, bar checkers enter first, the destination is not
/// blocked, the `hit` flag matches, and bearing off happens only with every
/// checker home. The dice are not known here, so a bear-off is checked as an
/// exact bear-off (the highest-point rule needs the die; see [`is_legal`]).
///
/// # Errors
///
/// [`RulesError::IllegalPlay`] describing the first offending move, or a
/// play with more than four moves.
pub fn apply(pos: &Position, play: &Play) -> Result<Position, RulesError> {
    if play.moves.len() > MAX_MOVES {
        return Err(RulesError::IllegalPlay(format!(
            "a play has at most {MAX_MOVES} moves, got {}",
            play.moves.len()
        )));
    }
    let mut cur = *pos;
    for mv in &play.moves {
        let die = if mv.to == OFF_TO {
            mv.from
        } else if mv.to < mv.from && mv.to <= 24 {
            mv.from - mv.to
        } else {
            return Err(RulesError::IllegalPlay(format!(
                "move {}/{} does not go forward",
                mv.from, mv.to
            )));
        };
        let (next, made) = step(&cur, mv.from, die)?;
        if made != *mv {
            return Err(RulesError::IllegalPlay(format!(
                "move {}/{} hit flag is {} but should be {}",
                mv.from, mv.to, mv.hit, made.hit
            )));
        }
        cur = next;
    }
    Ok(cur)
}

/// Plays `moves` with the dice in `remaining`, assigning a die to each move
/// (a bear-off may use any die at least as large as its point).
fn walk(pos: &Position, remaining: &[u8], moves: &[Move]) -> Option<Position> {
    let Some((mv, rest)) = moves.split_first() else {
        return Some(*pos);
    };
    let mut dice: Vec<u8> = remaining.to_vec();
    dice.sort_unstable();
    dice.dedup();
    for die in dice {
        let fits = if mv.to == OFF_TO {
            die >= mv.from
        } else {
            mv.to < mv.from && mv.from - mv.to == die
        };
        if !fits {
            continue;
        }
        let Ok((next, made)) = step(pos, mv.from, die) else {
            continue;
        };
        if made != *mv {
            continue;
        }
        let mut left = remaining.to_vec();
        if let Some(i) = left.iter().position(|&d| d == die) {
            left.swap_remove(i);
        }
        if let Some(end) = walk(&next, &left, rest) {
            return Some(end);
        }
    }
    None
}

/// `true` when `play` is a legal way to play `dice` from `pos`: every move is
/// legal in sequence using one of the dice, and the resulting position is one
/// of those reachable by [`legal_plays`] (so both dice are used when
/// possible, the larger die when only one can be played, and so on). The
/// moves need not be in canonical order.
#[must_use]
pub fn is_legal(pos: &Position, dice: Dice, play: &Play) -> bool {
    if play.moves.len() > MAX_MOVES {
        return false;
    }
    let available: Vec<u8> = if dice.is_double() {
        vec![dice.hi; MAX_MOVES]
    } else {
        vec![dice.hi, dice.lo]
    };
    let Some(end) = walk(pos, &available, &play.moves) else {
        return false;
    };
    legal_plays_with_positions(pos, dice)
        .iter()
        .any(|(p, _)| *p == end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::SLOTS;
    use serde_json::json;

    #[test]
    fn empty_play_has_no_moves() {
        assert!(Play::empty().is_empty());
        assert_eq!(Play::empty(), Play { moves: vec![] });
        assert_eq!(Play::empty(), Play::default());
        let p = Play {
            moves: vec![Move {
                from: 24,
                to: 18,
                hit: false,
            }],
        };
        assert!(!p.is_empty());
    }

    #[test]
    fn json_shapes_match_the_plan() {
        let m = Move {
            from: 24,
            to: 18,
            hit: false,
        };
        assert_eq!(
            serde_json::to_value(m).unwrap(),
            json!({ "from": 24, "to": 18, "hit": false })
        );
        let p = Play {
            moves: vec![
                m,
                Move {
                    from: 13,
                    to: 10,
                    hit: true,
                },
            ],
        };
        // `Play`'s JSON is owned by `notation.rs`: `moves` plus `notation`.
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v["moves"],
            json!([
                { "from": 24, "to": 18, "hit": false },
                { "from": 13, "to": 10, "hit": true }
            ])
        );
        assert!(v.get("notation").is_some_and(serde_json::Value::is_string));
        assert_eq!(serde_json::from_value::<Play>(v).unwrap(), p);
        assert_eq!(
            serde_json::from_value::<Play>(json!({ "moves": [
                { "from": 24, "to": 18, "hit": false },
                { "from": 13, "to": 10, "hit": true }
            ] }))
            .unwrap(),
            p
        );
        assert_eq!(
            serde_json::from_str::<Play>(r#"{"moves":[]}"#).unwrap(),
            Play::empty()
        );
    }

    fn mv(from: u8, to: u8, hit: bool) -> Move {
        Move { from, to, hit }
    }

    fn play(moves: &[(u8, u8, bool)]) -> Play {
        Play {
            moves: moves.iter().map(|&(f, t, h)| mv(f, t, h)).collect(),
        }
    }

    fn pos(mine: &[(usize, u8)], theirs: &[(usize, u8)]) -> Position {
        let mut p = Position {
            mine: [0; SLOTS],
            theirs: [0; SLOTS],
        };
        for &(i, n) in mine {
            p.mine[i] = n;
        }
        for &(i, n) in theirs {
            p.theirs[i] = n;
        }
        p
    }

    fn dice(a: u8, b: u8) -> Dice {
        Dice::new(a, b).unwrap()
    }

    fn opening() -> Position {
        Position::from_board(&crate::Board::opening(), crate::Player::White)
    }

    #[test]
    fn opening_6_5_has_seven_plays_including_the_lovers_leap() {
        // 13/7 7/2 and 13/8 8/2 reach the same position and count once.
        let plays = legal_plays(&opening(), dice(6, 5));
        assert_eq!(plays.len(), 7);
        assert!(plays.contains(&play(&[(13, 8, false), (8, 2, false)])));
        assert!(!plays.contains(&play(&[(13, 7, false), (7, 2, false)])));
        assert!(plays.contains(&play(&[(24, 18, false), (18, 13, false)])));
        assert!(plays.contains(&play(&[(13, 8, false), (13, 7, false)])));
        // Sorted by canonical key: from descending, then to descending.
        assert_eq!(plays[0], play(&[(24, 18, false), (18, 13, false)]));
        assert_eq!(plays[1], play(&[(24, 18, false), (13, 8, false)]));
    }

    #[test]
    fn opening_6_6_has_eleven_plays_all_four_moves_long() {
        let plays = legal_plays(&opening(), dice(6, 6));
        assert_eq!(plays.len(), 11);
        assert!(plays.iter().all(|p| p.moves.len() == 4));
        assert!(plays.contains(&play(&[
            (24, 18, false),
            (24, 18, false),
            (13, 7, false),
            (13, 7, false)
        ])));
    }

    #[test]
    fn bar_must_be_entered_first_and_hits_are_flagged() {
        // My checker on the bar, their blot on my 20 point (entering with a 5).
        let p = pos(
            &[(25, 1), (13, 5), (6, 5), (8, 3), (24, 1)],
            &[(20, 1), (1, 2)],
        );
        let plays = legal_plays(&p, dice(5, 3));
        assert!(plays.iter().all(|pl| pl.moves[0].from == 25));
        let hit = play(&[(25, 20, true), (20, 17, false)]);
        assert!(plays.contains(&hit), "{plays:?}");
        let after = apply(&p, &hit).unwrap();
        assert_eq!(after.theirs[20], 0);
        assert_eq!(after.theirs[BAR], 1);
        assert_eq!(after.mine[BAR], 0);
        assert_eq!(after.mine[17], 1);
        // A play that leaves the bar checker where it is is illegal.
        assert!(!is_legal(
            &p,
            dice(5, 3),
            &play(&[(13, 8, false), (13, 10, false)])
        ));
        assert!(apply(&p, &play(&[(13, 8, false)])).is_err());
    }

    #[test]
    fn two_bar_checkers_blocked_on_one_die_play_only_the_open_one() {
        // Two on the bar; their 20 point is made, 22 is open.
        let p = pos(&[(25, 2), (6, 5), (8, 3), (13, 5)], &[(20, 2), (1, 2)]);
        let plays = legal_plays(&p, dice(5, 3));
        assert_eq!(plays, vec![play(&[(25, 22, false)])]);
        assert!(!is_legal(&p, dice(5, 3), &Play::empty()));
    }

    #[test]
    fn larger_die_must_be_played_when_only_one_die_can_be_used() {
        // One checker on 24, everything else off; their points 23..=18 all
        // made except 21 and 18... make 18 open via 6 but block 21 (via 3):
        // dice 6-3: only the 6 (24/18) or the 3 (24/21). 24/21 open, 24/18
        // open: both are single-die plays -> only the 6 may be played.
        let p = pos(
            &[(24, 1), (0, 14)],
            &[(15, 2), (12, 2), (13, 2), (5, 2), (0, 7)],
        );
        // After 24/18, the 3 would go to 15 (blocked); after 24/21, the 6 would
        // go to 15 (blocked). So only one die can be played: the larger.
        let plays = legal_plays(&p, dice(6, 3));
        assert_eq!(plays, vec![play(&[(24, 18, false)])]);
        assert!(!is_legal(&p, dice(6, 3), &play(&[(24, 21, false)])));
        // When the larger die cannot be played at all, the smaller one is used.
        let q = pos(&[(24, 1), (0, 14)], &[(18, 2), (15, 2), (12, 2), (0, 9)]);
        assert_eq!(legal_plays(&q, dice(6, 3)), vec![play(&[(24, 21, false)])]);
    }

    #[test]
    fn both_dice_must_be_used_when_some_order_allows_it() {
        // One on the bar, one on my 7. Entering with the 6 (bar/19) leaves
        // the 3 unplayable (16 and 4 are made); entering with the 3 (bar/22)
        // lets the 6 play 7/1. Only the two-move play is legal.
        let p = pos(&[(25, 1), (7, 1), (0, 13)], &[(16, 2), (4, 2), (0, 11)]);
        let plays = legal_plays(&p, dice(6, 3));
        assert_eq!(plays, vec![play(&[(25, 22, false), (7, 1, false)])]);
        assert!(!is_legal(&p, dice(6, 3), &play(&[(25, 19, false)])));
    }

    #[test]
    fn bearing_off_needs_all_home_exact_die_or_highest_point() {
        // All home: 2 on 6, 1 on 3, rest off. With 6-4 the 6 bears off from
        // 6 and the 4 must play 6/2: 3/off with a 4 needs no checker above 3,
        // and one is still on 6 in every order.
        let p = pos(&[(6, 2), (3, 1), (0, 12)], &[(24, 3), (0, 12)]);
        assert_eq!(
            legal_plays(&p, dice(6, 4)),
            vec![play(&[(6, 2, false), (6, 0, false)])]
        );
        assert!(!is_legal(
            &p,
            dice(6, 4),
            &play(&[(6, 0, false), (3, 0, false)])
        ));
        // Not all home (one checker still on 13): no bearing off.
        let q = pos(&[(6, 2), (3, 1), (13, 1), (0, 11)], &[(24, 3), (0, 12)]);
        assert!(
            legal_plays(&q, dice(6, 4))
                .iter()
                .all(|pl| pl.moves.iter().all(|m| m.to != 0))
        );
        assert!(apply(&q, &play(&[(6, 0, false)])).is_err());
        // Higher die from the highest point when nothing is above it.
        let r = pos(&[(2, 1), (1, 1), (0, 13)], &[(24, 3), (0, 12)]);
        assert_eq!(
            legal_plays(&r, dice(6, 5)),
            vec![play(&[(2, 0, false), (1, 0, false)])]
        );
    }

    #[test]
    fn canonical_representative_replays_hits_in_canonical_order() {
        // Dice 6-1, their blot on my 7: 8/7* 13/7 and 13/7* 8/7 are one play.
        let p = pos(
            &[(13, 5), (8, 3), (6, 5), (24, 2)],
            &[(7, 1), (1, 2), (12, 5), (19, 5), (0, 2)],
        );
        let plays = legal_plays(&p, dice(6, 1));
        let canonical = play(&[(13, 7, true), (8, 7, false)]);
        assert!(plays.contains(&canonical), "{plays:?}");
        assert!(!plays.contains(&play(&[(13, 7, false), (8, 7, true)])));
        assert!(!plays.contains(&play(&[(8, 7, true), (13, 7, false)])));
        // Both orders are legal to play and produce the same position.
        let alt = play(&[(8, 7, true), (13, 7, false)]);
        assert!(is_legal(&p, dice(6, 1), &alt));
        assert_eq!(apply(&p, &alt), apply(&p, &canonical));
        // A wrong hit flag is rejected by apply.
        assert!(apply(&p, &play(&[(13, 7, false), (8, 7, false)])).is_err());
    }

    #[test]
    fn same_position_via_different_intermediate_points_is_one_play() {
        let plays = legal_plays(&opening(), dice(6, 3));
        let via_21 = play(&[(24, 21, false), (21, 15, false)]);
        let via_18 = play(&[(24, 18, false), (18, 15, false)]);
        assert!(plays.contains(&via_21));
        assert!(!plays.contains(&via_18));
        assert!(is_legal(&opening(), dice(6, 3), &via_18));
    }

    #[test]
    fn apply_rejects_malformed_moves() {
        let p = opening();
        assert!(apply(&p, &play(&[(24, 24, false)])).is_err());
        assert!(apply(&p, &play(&[(26, 20, false)])).is_err());
        assert!(apply(&p, &play(&[(24, 25, false)])).is_err());
        assert!(apply(&p, &play(&[(23, 20, false)])).is_err()); // no checker
        assert!(apply(&p, &play(&[(13, 12, false)])).is_err()); // blocked
        assert!(apply(&p, &play(&[(24, 15, false)])).is_err()); // not a die
        let five = play(&[(13, 12, false); 5]);
        assert!(apply(&p, &five).is_err());
        assert_eq!(apply(&p, &Play::empty()), Ok(p));
    }

    #[test]
    fn is_legal_accepts_every_generated_play_and_rejects_partial_ones() {
        let p = opening();
        for d in Dice::all() {
            for pl in legal_plays(&p, d) {
                assert!(is_legal(&p, d, &pl), "{d:?} {pl:?}");
                if pl.moves.len() > 1 {
                    let short = Play {
                        moves: pl.moves[..1].to_vec(),
                    };
                    assert!(!is_legal(&p, d, &short), "{d:?} {short:?}");
                }
            }
        }
        assert!(!is_legal(&p, dice(6, 5), &Play::empty()));
    }

    #[test]
    fn plays_are_hashable_by_value() {
        let mut set = std::collections::HashSet::new();
        let a = Play {
            moves: vec![Move {
                from: 6,
                to: 0,
                hit: false,
            }],
        };
        assert!(set.insert(a.clone()));
        assert!(!set.insert(a));
    }
}
