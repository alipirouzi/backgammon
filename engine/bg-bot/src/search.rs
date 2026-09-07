//! Move search: 1-ply ranking of every legal play, optional Gaussian noise,
//! 2-ply refinement of the leading candidates and truncated rollouts on
//! them, plus the difficulty [`Level`]s that pick those parameters.
//!
//! # Pipeline of [`rank_plays`]
//!
//! 1. **1-ply.** Every legal play is applied; the resulting position is
//!    evaluated from the opponent's point of view (they are on roll) and the
//!    probabilities are flipped back to mine. A play that ends the game is
//!    scored by the rules ([`crate::rollout::terminal_probs`]), not by the
//!    evaluator. Equities are match-normalised with [`equity_for`].
//! 2. **Noise** (`noise_sigma > 0`). `N(0, σ)` from a seeded `ChaCha8`
//!    stream (Box–Muller, no OS randomness) is added to each 1-ply equity
//!    before ranking. The probabilities are left untouched, so the noise
//!    only perturbs the *choice*, which is what a weaker level needs.
//! 3. **Ranking.** Descending equity; ties keep the canonical order of
//!    [`bg_core::moves::legal_plays`] (the sort is stable).
//! 4. **2-ply** (`two_ply`). For the top `keep_top` plays: the expectation
//!    over the 21 opponent rolls (weights 1/36 and 2/36) of the opponent's
//!    best 1-ply reply, where "best" minimises my equity. A play that has
//!    already ended the game keeps its rule-scored value (the opponent does
//!    not get to move in a finished game). Those candidates are re-sorted;
//!    the rest keep their 1-ply values and order.
//! 5. **Rollouts** (`rollouts > 0`). For the top `keep_top` after step 4:
//!    `rollouts` truncated rollouts of `rollout_depth` plies from the
//!    position after the play, dice seeded with `seed + candidate_index`
//!    (the index in the 2-ply order; see [`crate::rollout::rollout`]). The
//!    search equity stays in [`Candidate::equity`] and the rollout goes in
//!    [`Candidate::rollout`].
//!
//! # Ranking rule: search equity first, rollouts only when decisive
//!
//! The order of the list — and therefore the play the bot makes — is the
//! **search equity** order ([`Candidate::equity`]: 2-ply for the refined
//! head, 1-ply for the tail). A rollout is attached as information
//! (`trials`, `equity`, `stdErr`) and changes the order only when it is
//! *decisive*: a candidate moves ahead of a neighbour iff both were rolled
//! out and the rollout gap exceeds [`DECISIVE_SIGMAS`] × the combined
//! standard error `√(se₁² + se₂²)` ([`ranking_gap`]). With the club level's
//! 100 trials a single candidate's standard error is ≈ 0.04, so only a
//! gap above ≈ 0.11 overrides the 2-ply order; smaller gaps are noise and
//! would otherwise re-sort correct 2-ply rankings differently on every seed.
//! The override is an adjacent insertion pass over the 2-ply-sorted head
//! (the comparator is not transitive, so no general sort is used), which is
//! deterministic and stable. [`crate::analysis::MoveAnalysis`] grades a
//! play with the same [`ranking_gap`], so a decisive override and the error
//! it implies always agree. When an override happens the head is no longer
//! monotone in `equity`; the attached rollouts show why.
//!
//! Everything is deterministic for a given seed: identical inputs and seed
//! give identical output, and a different seed changes only equities, never
//! the set of plays. No `std::time`, no threads.

use bg_core::moves::{apply, legal_plays};
use bg_core::{Dice, Play, Position};
use rand_chacha::ChaCha8Rng;
use rand_core::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

use crate::rollout::{RolloutStats, rollout, terminal_probs};
use crate::{Evaluator, MatchContext, Probs, equity_for};

/// Number of equally likely dice outcomes.
const DICE_OUTCOMES: f64 = 36.0;
/// `2³²`, the range of a `u32` draw, as a float.
const U32_RANGE: f64 = 4_294_967_296.0;
/// `ChaCha8` stream used for equity noise. [`bg_core::DiceRng`] uses stream
/// `0` for the same seed, so noise and dice never share a stream.
const NOISE_STREAM: u64 = 1;
/// Number of candidates every level refines and rolls out.
const DEFAULT_KEEP_TOP: usize = 5;
/// Rollout horizon in plies for every level.
const DEFAULT_ROLLOUT_DEPTH: u32 = 8;
/// Equity noise (standard deviation, in points) for the beginner level.
const BEGINNER_NOISE_SIGMA: f64 = 0.05;
/// Rollout trials per candidate for the club level.
const CLUB_ROLLOUTS: u32 = 100;
/// A rollout gap re-orders two candidates only when it exceeds this many
/// combined standard errors (see the module docs).
pub const DECISIVE_SIGMAS: f64 = 2.0;

/// Bot strength. Levels change search depth and noise only; the rules and
/// the evaluator are identical.
///
/// Wire format: `"beginner"`, `"intermediate"`, `"club"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// 1-ply with Gaussian equity noise (σ = 0.05).
    Beginner,
    /// 1-ply, no noise.
    Intermediate,
    /// 1-ply, 2-ply refinement of the top five, 100 rollouts of depth 8 on
    /// them (informational unless decisive; see the module docs).
    Club,
}

impl Level {
    /// The search parameters of this level (plan, Task 9):
    /// `Beginner {5, false, 0.05, 0, 8}`, `Intermediate {5, false, 0, 0, 8}`,
    /// `Club {5, true, 0, 100, 8}`.
    #[must_use]
    pub fn params(self) -> SearchParams {
        let base = SearchParams {
            keep_top: DEFAULT_KEEP_TOP,
            two_ply: false,
            noise_sigma: 0.0,
            rollouts: 0,
            rollout_depth: DEFAULT_ROLLOUT_DEPTH,
        };
        match self {
            Self::Beginner => SearchParams {
                noise_sigma: BEGINNER_NOISE_SIGMA,
                ..base
            },
            Self::Intermediate => base,
            Self::Club => SearchParams {
                two_ply: true,
                rollouts: CLUB_ROLLOUTS,
                ..base
            },
        }
    }
}

/// Knobs of [`rank_plays`].
///
/// Wire format (`camelCase`): `{ "keepTop", "twoPly", "noiseSigma",
/// "rollouts", "rolloutDepth" }`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    /// How many of the leading 1-ply candidates are refined at 2-ply and
    /// rolled out.
    pub keep_top: usize,
    /// Refine the top `keep_top` with a 2-ply expectation.
    pub two_ply: bool,
    /// Standard deviation of the Gaussian noise added to 1-ply equities;
    /// `0` disables noise.
    pub noise_sigma: f64,
    /// Rollout trials per candidate for the top `keep_top`; `0` = none.
    pub rollouts: u32,
    /// Rollout horizon in plies (one ply = one side's roll and play).
    pub rollout_depth: u32,
}

/// One ranked play.
///
/// Wire format (`camelCase`): `{ "play", "equity", "probs", "rollout" }`
/// with `rollout` `null` unless the candidate was rolled out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// The play.
    pub play: Play,
    /// Search equity for the player on roll, match-normalised via
    /// [`equity_for`]: 2-ply if refined, else 1-ply (plus noise if enabled).
    pub equity: f64,
    /// Outcome probabilities behind `equity` (never noised).
    pub probs: Probs,
    /// Rollout statistics, present for the top `keep_top` when rollouts
    /// were requested. Informational: the order follows `equity` unless the
    /// rollout gap to a neighbour is decisive (module docs).
    pub rollout: Option<RolloutStats>,
}

/// The ranking's view of how much better `a` is than `b` (positive: `a`
/// ranks higher). When both were rolled out and the rollout gap exceeds
/// [`DECISIVE_SIGMAS`] combined standard errors it is that gap; otherwise
/// it is the search-equity difference `a.equity − b.equity`. This is the
/// comparator behind the head order of [`rank_plays`] and behind
/// [`crate::analysis::MoveAnalysis::error_size`].
#[must_use]
pub fn ranking_gap(a: &Candidate, b: &Candidate) -> f64 {
    decisive_rollout_gap(a, b).unwrap_or(a.equity - b.equity)
}

/// The rollout gap `a − b` when both candidates were rolled out and the gap
/// is decisive, else `None`. Two certain results (zero spread) with
/// different equities are decisive; equal ones are not.
fn decisive_rollout_gap(a: &Candidate, b: &Candidate) -> Option<f64> {
    let (ra, rb) = (a.rollout?, b.rollout?);
    let gap = ra.equity - rb.equity;
    let combined = ra.std_err.hypot(rb.std_err);
    (gap.abs() > DECISIVE_SIGMAS * combined).then_some(gap)
}

/// A play scored at 1-ply, kept with the position it leads to (on my axis,
/// opponent to roll) so later stages need not re-apply it.
#[derive(Debug, Clone)]
pub(crate) struct Scored {
    /// The play.
    pub(crate) play: Play,
    /// The position after the play, still on my axis.
    pub(crate) after: Position,
    /// My outcome probabilities after the play.
    pub(crate) probs: Probs,
    /// `equity_for(ctx, &probs)` (plus noise once [`add_noise`] has run).
    pub(crate) equity: f64,
}

/// The match context seen by the opponent: away counts swapped, cube
/// ownership mirrored, everything else unchanged.
pub(crate) fn opponent_context(ctx: MatchContext) -> MatchContext {
    MatchContext {
        my_away: ctx.their_away,
        their_away: ctx.my_away,
        cube_owner_is_me: ctx.cube_owner_is_me.map(|mine| !mine),
        ..ctx
    }
}

/// My probabilities in `after` (my axis, opponent to roll): the certain
/// result if the game is over, else the evaluator's view of the flipped
/// position, flipped back and clamped.
fn probs_after_my_play(ev: &dyn Evaluator, after: &Position) -> Probs {
    terminal_probs(after).unwrap_or_else(|| ev.evaluate(&after.flip()).flipped().clamp())
}

/// Every legal play of `dice` from `pos` scored at 1-ply, in the canonical
/// order of [`legal_plays`] (unsorted). Equities are normalised for `ctx`.
pub(crate) fn one_ply(
    ev: &dyn Evaluator,
    ctx: MatchContext,
    pos: &Position,
    dice: Dice,
) -> Vec<Scored> {
    legal_plays(pos, dice)
        .into_iter()
        // `legal_plays` only yields plays `apply` accepts; a rejection would
        // be a rules bug and the play is dropped rather than mis-scored.
        .filter_map(|play| apply(pos, &play).ok().map(|after| (play, after)))
        .map(|(play, after)| {
            let probs = probs_after_my_play(ev, &after);
            Scored {
                play,
                after,
                equity: equity_for(&ctx, &probs),
                probs,
            }
        })
        .collect()
}

/// Ranks every legal play of `dice` from `pos` for the player on roll
/// (`pos.mine`), best first, following the pipeline in the [module
/// docs](self). Equities are match-normalised for `ctx`; `seed` drives the
/// noise stream and the rollout dice.
///
/// A roll with no legal move yields the single empty play.
#[must_use]
pub fn rank_plays(
    ev: &dyn Evaluator,
    ctx: &MatchContext,
    pos: &Position,
    dice: Dice,
    params: &SearchParams,
    seed: u64,
) -> Vec<Candidate> {
    let mut scored = one_ply(ev, *ctx, pos, dice);
    if params.noise_sigma > 0.0 {
        add_noise(&mut scored, params.noise_sigma, seed);
    }
    sort_desc_by(&mut scored, |s| s.equity);
    let k = params.keep_top.min(scored.len());
    if params.two_ply {
        for s in &mut scored[..k] {
            (s.probs, s.equity) = two_ply_value(ev, *ctx, &s.after);
        }
        sort_desc_by(&mut scored[..k], |s| s.equity);
    }
    let mut candidates: Vec<Candidate> = scored
        .iter()
        .map(|s| Candidate {
            play: s.play.clone(),
            equity: s.equity,
            probs: s.probs,
            rollout: None,
        })
        .collect();
    if params.rollouts > 0 {
        for (index, (c, s)) in candidates[..k].iter_mut().zip(&scored).enumerate() {
            c.rollout = Some(roll_out(ev, *ctx, &s.after, params, seed, index));
        }
        decisive_reorder(&mut candidates[..k]);
    }
    candidates
}

/// Re-scores `after` (the position after my play, on my axis) exactly as
/// the head of [`rank_plays`] is scored: 2-ply when `params.two_ply`, and a
/// rollout seeded `seed + index` when `params.rollouts > 0`. Used for a
/// played move outside the head so it is graded on the head's scale.
pub(crate) fn refine(
    ev: &dyn Evaluator,
    ctx: MatchContext,
    after: &Position,
    params: &SearchParams,
    seed: u64,
    index: usize,
) -> (Probs, f64, Option<RolloutStats>) {
    let (probs, equity) = if params.two_ply {
        two_ply_value(ev, ctx, after)
    } else {
        let probs = probs_after_my_play(ev, after);
        (probs, equity_for(&ctx, &probs))
    };
    let rollout = (params.rollouts > 0).then(|| roll_out(ev, ctx, after, params, seed, index));
    (probs, equity, rollout)
}

/// The insertion pass of the ranking rule (module docs): a candidate moves
/// ahead of its predecessor iff its rollout is decisively better.
fn decisive_reorder(head: &mut [Candidate]) {
    for i in 1..head.len() {
        let mut j = i;
        while j > 0 && decisive_rollout_gap(&head[j], &head[j - 1]).is_some_and(|gap| gap > 0.0) {
            head.swap(j, j - 1);
            j -= 1;
        }
    }
}

/// Stable descending sort by a float key (`total_cmp`, so it never panics
/// and is deterministic even for NaN); ties keep their current order.
fn sort_desc_by<T>(items: &mut [T], key: impl Fn(&T) -> f64) {
    items.sort_by(|a, b| key(b).total_cmp(&key(a)));
}

/// Adds `N(0, sigma)` to every equity, in canonical play order, from the
/// noise stream of `seed`.
fn add_noise(scored: &mut [Scored], sigma: f64, seed: u64) {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    rng.set_stream(NOISE_STREAM);
    for s in scored {
        s.equity += sigma * standard_normal(&mut rng);
    }
}

/// One standard normal draw by Box–Muller from two `u32` words:
/// `u1 ∈ (0, 1]` (so `ln u1` is finite), `u2 ∈ [0, 1)`.
fn standard_normal(rng: &mut ChaCha8Rng) -> f64 {
    let u1 = (f64::from(rng.next_u32()) + 1.0) / U32_RANGE;
    let u2 = f64::from(rng.next_u32()) / U32_RANGE;
    (-2.0 * u1.ln()).sqrt() * (2.0 * core::f64::consts::PI * u2).cos()
}

/// 2-ply value of `after` (my axis, opponent to roll): `(probs, equity)`
/// for me, the expectation over the 21 opponent rolls of my probabilities
/// after the opponent's best 1-ply reply (the one minimising my equity;
/// the first such reply in canonical order on ties). A finished game is
/// scored by the rules instead: the opponent has no reply to a play that
/// bore off my last checker.
fn two_ply_value(ev: &dyn Evaluator, ctx: MatchContext, after: &Position) -> (Probs, f64) {
    if let Some(p) = terminal_probs(after) {
        return (p, equity_for(&ctx, &p));
    }
    let opp = after.flip();
    let mut acc = Probs::default();
    for roll in Dice::all() {
        let weight = f64::from(roll.weight()) / DICE_OUTCOMES;
        let mine = best_reply_for_opponent(ev, ctx, &opp, roll);
        acc = add_scaled(&acc, &mine, weight);
    }
    (acc, equity_for(&ctx, &acc))
}

/// My probabilities after the opponent's best reply to `roll` from `opp`
/// (opponent's axis, opponent on roll). With no legal move the reply is
/// the empty play and the position is unchanged.
fn best_reply_for_opponent(
    ev: &dyn Evaluator,
    ctx: MatchContext,
    opp: &Position,
    roll: Dice,
) -> Probs {
    let mut best: Option<(f64, Probs)> = None;
    for reply in legal_plays(opp, roll) {
        let Ok(after) = apply(opp, &reply) else {
            continue;
        };
        // `after` is on the opponent's axis with me to roll.
        let mine = terminal_probs(&after)
            .map_or_else(|| ev.evaluate(&after.flip()).clamp(), |p| p.flipped());
        let e = equity_for(&ctx, &mine);
        if best.is_none_or(|(be, _)| e < be) {
            best = Some((e, mine));
        }
    }
    best.map_or_else(|| probs_after_my_play(ev, &opp.flip()), |(_, p)| p)
}

/// Rolls out `after` (my axis, opponent to roll) from the opponent's side
/// with dice seeded `seed + index`, and returns the statistics oriented to
/// me.
fn roll_out(
    ev: &dyn Evaluator,
    ctx: MatchContext,
    after: &Position,
    params: &SearchParams,
    seed: u64,
    index: usize,
) -> RolloutStats {
    let trial_seed = seed.wrapping_add(u64::try_from(index).unwrap_or(u64::MAX));
    rollout(
        ev,
        &opponent_context(ctx),
        &after.flip(),
        params.rollouts,
        params.rollout_depth,
        trial_seed,
    )
    .flipped()
}

/// `a + k·b`, component-wise.
fn add_scaled(a: &Probs, b: &Probs, k: f64) -> Probs {
    Probs {
        win: a.win + k * b.win,
        win_g: a.win_g + k * b.win_g,
        win_bg: a.win_bg + k * b.win_bg,
        lose_g: a.lose_g + k * b.lose_g,
        lose_bg: a.lose_bg + k * b.lose_bg,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opponent_context_swaps_away_counts_and_cube_owner() {
        let ctx = MatchContext {
            length: 7,
            my_away: 3,
            their_away: 5,
            crawford: false,
            post_crawford: false,
            cube: 2,
            cube_owner_is_me: Some(true),
        };
        let o = opponent_context(ctx);
        assert_eq!(o.my_away, 5);
        assert_eq!(o.their_away, 3);
        assert_eq!(o.cube_owner_is_me, Some(false));
        assert_eq!(o.cube, 2);
        assert_eq!(o.length, 7);
        assert_eq!(opponent_context(o), ctx);
        let centred = MatchContext {
            cube_owner_is_me: None,
            ..ctx
        };
        assert_eq!(opponent_context(centred).cube_owner_is_me, None);
    }

    #[test]
    fn standard_normal_has_unit_scale_and_is_finite() {
        let mut rng = ChaCha8Rng::seed_from_u64(5);
        rng.set_stream(NOISE_STREAM);
        let n = 20_000;
        let draws: Vec<f64> = (0..n).map(|_| standard_normal(&mut rng)).collect();
        assert!(draws.iter().all(|z| z.is_finite()));
        let mean = draws.iter().sum::<f64>() / f64::from(n);
        let var = draws.iter().map(|z| (z - mean) * (z - mean)).sum::<f64>() / f64::from(n);
        assert!(mean.abs() < 0.03, "mean {mean}");
        assert!((var - 1.0).abs() < 0.05, "variance {var}");
    }

    fn cand(equity: f64, rollout: Option<(f64, f64)>) -> Candidate {
        Candidate {
            play: Play::empty(),
            equity,
            probs: Probs::default(),
            rollout: rollout.map(|(equity, std_err)| RolloutStats {
                trials: 100,
                equity,
                std_err,
                probs: Probs::default(),
            }),
        }
    }

    #[test]
    fn ranking_gap_uses_the_rollout_only_when_decisive() {
        let noisy_hi = cand(0.20, Some((0.10, 0.04)));
        let noisy_lo = cand(0.15, Some((0.16, 0.04)));
        // Gap 0.06 < 2 × 0.0566: noise, so the search equities decide.
        assert!((ranking_gap(&noisy_hi, &noisy_lo) - 0.05).abs() < 1e-12);
        let decisive = cand(0.15, Some((0.30, 0.04)));
        // Gap 0.20 > 0.113: decisive in its favour.
        assert!((ranking_gap(&decisive, &noisy_hi) - 0.20).abs() < 1e-12);
        assert!((ranking_gap(&noisy_hi, &decisive) + 0.20).abs() < 1e-12);
        // Without rollouts on both sides only equity counts.
        let plain = cand(0.10, None);
        assert!((ranking_gap(&noisy_hi, &plain) - 0.10).abs() < 1e-12);
        // Two certain results (no spread) differing are decisive; equal are not.
        let gammon = cand(0.0, Some((2.0, 0.0)));
        let single = cand(0.5, Some((1.0, 0.0)));
        assert!((ranking_gap(&gammon, &single) - 1.0).abs() < 1e-12);
        let same_gammon = cand(0.5, Some((2.0, 0.0)));
        assert!((ranking_gap(&gammon, &same_gammon) + 0.5).abs() < 1e-12);
    }

    #[test]
    fn decisive_reorder_keeps_the_search_order_unless_the_rollout_is_decisive() {
        let mut head = vec![
            cand(0.30, Some((0.10, 0.04))),
            cand(0.25, Some((0.16, 0.04))),
            cand(0.20, Some((0.40, 0.04))),
            cand(0.10, Some((0.15, 0.04))),
        ];
        decisive_reorder(&mut head);
        let order: Vec<f64> = head.iter().map(|c| c.equity).collect();
        // Only the third candidate (rollout 0.40) is decisively better than
        // its predecessors; it rises to the top, everything else stays put.
        assert_eq!(order, vec![0.20, 0.30, 0.25, 0.10]);
    }

    #[test]
    fn sort_desc_is_stable_on_ties() {
        let mut v = vec![(1.0, 'a'), (2.0, 'b'), (1.0, 'c'), (2.0, 'd')];
        sort_desc_by(&mut v, |x| x.0);
        let order: String = v.iter().map(|x| x.1).collect();
        assert_eq!(order, "bdac");
    }
}
