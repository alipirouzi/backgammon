//! Truncated rollouts and terminal-position scoring.
//!
//! A rollout plays the game forward from a position with seeded dice
//! ([`DiceRng`], `ChaCha8`, no OS randomness): both sides choose their
//! 1-ply best play under their own match context, for at most `depth` plies
//! (one ply = one side's roll and play). A game that ends inside the
//! horizon is scored by the rules (single, gammon or backgammon); otherwise
//! the static evaluator scores the position reached. Every trial is one
//! sample of the outcome distribution; the reported statistics are the
//! sample mean of the probabilities, the mean equity, and the standard
//! error of the equity (sample standard deviation with `n − 1`, divided by
//! `√n`; `0` for fewer than two trials).
//!
//! Results are exactly reproducible for a given seed on every target: the
//! only randomness is the dice stream and every tie is broken in the
//! canonical play order of [`bg_core::moves::legal_plays`].

use bg_core::position::{BAR, OFF};
use bg_core::{DiceRng, Position};
use serde::{Deserialize, Serialize};

use crate::search::{one_ply, opponent_context};
use crate::{Evaluator, MatchContext, Probs, equity_for};

/// Number of checkers each side has; a side with this many off has won.
const CHECKERS: u8 = 15;
/// Highest point of a home board on the owner's axis (points `1..=6`).
const HOME_TOP: usize = 6;
/// Lowest point of the opponent's home board on my axis (points `19..=24`).
const THEIR_HOME_BOTTOM: usize = 19;

/// Summary of a truncated rollout, from the perspective of the side whose
/// checkers are `pos.mine` in the position rolled out.
///
/// Wire format (`camelCase`): `{ "trials", "equity", "stdErr", "probs" }`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutStats {
    /// Number of trials played.
    pub trials: u32,
    /// Mean equity over the trials, match-normalised via [`equity_for`]
    /// (equal to `equity_for` of `probs`, since the normalisation is affine).
    pub equity: f64,
    /// Standard error of `equity`: sample standard deviation over `√trials`;
    /// `0` when there are fewer than two trials.
    pub std_err: f64,
    /// Mean outcome probabilities over the trials.
    pub probs: Probs,
}

impl RolloutStats {
    /// The same statistics seen by the opponent: equity negated, outcome
    /// probabilities mirrored, spread unchanged.
    #[must_use]
    pub fn flipped(&self) -> Self {
        Self {
            trials: self.trials,
            equity: -self.equity,
            std_err: self.std_err,
            probs: self.probs.flipped(),
        }
    }
}

/// The certain outcome of a finished game, from the perspective of
/// `pos.mine`, or `None` while the game is still going.
///
/// A side has won when all its checkers are off. The loser is gammoned
/// when it has borne off nothing, and backgammoned when in addition it has
/// a checker on the bar or in the winner's home board (see the rules
/// summary in `bg_core::game`).
#[must_use]
pub fn terminal_probs(pos: &Position) -> Option<Probs> {
    if pos.mine[OFF] >= CHECKERS {
        let in_my_home = pos.theirs[1..=HOME_TOP].iter().any(|&n| n > 0);
        let (gammon, backgammon) = loser_kind(pos.theirs[OFF], pos.theirs[BAR] > 0 || in_my_home);
        return Some(Probs {
            win: 1.0,
            win_g: gammon,
            win_bg: backgammon,
            lose_g: 0.0,
            lose_bg: 0.0,
        });
    }
    if pos.theirs[OFF] >= CHECKERS {
        let in_their_home = pos.mine[THEIR_HOME_BOTTOM..=24].iter().any(|&n| n > 0);
        let (gammon, backgammon) = loser_kind(pos.mine[OFF], pos.mine[BAR] > 0 || in_their_home);
        return Some(Probs {
            win: 0.0,
            win_g: 0.0,
            win_bg: 0.0,
            lose_g: gammon,
            lose_bg: backgammon,
        });
    }
    None
}

/// `(P(gammon or better), P(backgammon))` for a loser with `off` checkers
/// borne off and `stranded` set when a checker is on the bar or in the
/// winner's home board.
fn loser_kind(off: u8, stranded: bool) -> (f64, f64) {
    if off > 0 {
        (0.0, 0.0)
    } else if stranded {
        (1.0, 1.0)
    } else {
        (1.0, 0.0)
    }
}

/// `trials` truncated rollouts of `depth` plies from `pos` (`pos.mine` on
/// roll), with dice from [`DiceRng::from_seed(seed)`](DiceRng::from_seed).
/// Statistics are from the perspective of `pos.mine`, equities normalised
/// for `ctx`.
///
/// * A position that is already finished returns its certain result with
///   zero spread (the dice are not consulted).
/// * `trials == 0` returns the static evaluation with zero spread.
/// * `depth == 0` evaluates every trial statically (all trials agree).
#[must_use]
pub fn rollout(
    ev: &dyn Evaluator,
    ctx: &MatchContext,
    pos: &Position,
    trials: u32,
    depth: u32,
    seed: u64,
) -> RolloutStats {
    if let Some(p) = terminal_probs(pos) {
        return certain(*ctx, &p, trials);
    }
    if trials == 0 {
        return certain(*ctx, &ev.evaluate(pos).clamp(), 0);
    }
    let mut rng = DiceRng::from_seed(seed);
    let mut sum = Probs::default();
    let mut equities = Vec::with_capacity(usize::try_from(trials).unwrap_or(usize::MAX));
    for _ in 0..trials {
        let p = trial(ev, *ctx, pos, depth, &mut rng);
        sum = add(&sum, &p);
        equities.push(equity_for(ctx, &p));
    }
    let n = f64::from(trials);
    let probs = scale(&sum, 1.0 / n);
    let mean = equities.iter().sum::<f64>() / n;
    let std_err = if trials > 1 {
        let var = equities
            .iter()
            .map(|e| (e - mean) * (e - mean))
            .sum::<f64>()
            / (n - 1.0);
        (var / n).sqrt()
    } else {
        0.0
    };
    RolloutStats {
        trials,
        equity: mean,
        std_err,
        probs,
    }
}

/// Statistics for an outcome every trial agrees on.
fn certain(ctx: MatchContext, p: &Probs, trials: u32) -> RolloutStats {
    RolloutStats {
        trials,
        equity: equity_for(&ctx, p),
        std_err: 0.0,
        probs: *p,
    }
}

/// One trial: alternate 1-ply best plays for up to `depth` plies, then the
/// actual result or the static evaluation, oriented to `pos.mine`.
fn trial(
    ev: &dyn Evaluator,
    ctx: MatchContext,
    pos: &Position,
    depth: u32,
    rng: &mut DiceRng,
) -> Probs {
    let opp_ctx = opponent_context(ctx);
    let mut cur = *pos;
    let mut my_turn = true;
    for _ in 0..depth {
        let side_ctx = if my_turn { ctx } else { opp_ctx };
        let dice = rng.roll();
        let Some(best) = best_of(one_ply(ev, side_ctx, &cur, dice)) else {
            break;
        };
        cur = best;
        if let Some(p) = terminal_probs(&cur) {
            return orient(&p, my_turn);
        }
        cur = cur.flip();
        my_turn = !my_turn;
    }
    orient(&ev.evaluate(&cur).clamp(), my_turn)
}

/// The position after the highest-equity play; the first one wins ties so
/// the choice follows the canonical play order.
fn best_of(scored: Vec<crate::search::Scored>) -> Option<Position> {
    let mut best: Option<(f64, Position)> = None;
    for s in scored {
        if best.is_none_or(|(e, _)| s.equity > e) {
            best = Some((s.equity, s.after));
        }
    }
    best.map(|(_, after)| after)
}

fn orient(p: &Probs, my_turn: bool) -> Probs {
    if my_turn { *p } else { p.flipped() }
}

fn add(a: &Probs, b: &Probs) -> Probs {
    Probs {
        win: a.win + b.win,
        win_g: a.win_g + b.win_g,
        win_bg: a.win_bg + b.win_bg,
        lose_g: a.lose_g + b.lose_g,
        lose_bg: a.lose_bg + b.lose_bg,
    }
}

fn scale(p: &Probs, k: f64) -> Probs {
    Probs {
        win: p.win * k,
        win_g: p.win_g * k,
        win_bg: p.win_bg * k,
        lose_g: p.lose_g * k,
        lose_bg: p.lose_bg * k,
    }
}
