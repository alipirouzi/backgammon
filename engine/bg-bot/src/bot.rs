//! The [`Bot`] facade: one object that plays (at a [`Level`]), decides the
//! cube and analyses checker and cube decisions with the club evaluator.
//!
//! Every method takes the position on the axis of the side on roll
//! (`pos.mine`) and that side's [`MatchContext`]. Cube methods describe the
//! decision of the side on roll *before it rolls*; see [`crate::cube`] for
//! the dead-cube model and how `Take`/`Drop` are graded from the same view.

use bg_core::moves::apply;
use bg_core::{Dice, Play, Position};

use crate::analysis::{Category, MoveAnalysis, categorize, value};
use crate::cube::{CubeAnalysis, CubeChoice, cube_analysis_for, cube_error};
use crate::heuristic::ClubEvaluator;
use crate::search::{Candidate, Level, rank_plays, refine};
use crate::{Evaluator, MatchContext, Probs};

/// A playing and analysing bot: the [`ClubEvaluator`] behind a [`Level`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bot {
    /// Strength used by [`Bot::choose_play`]; analysis always uses the club
    /// parameters.
    pub level: Level,
    /// The static evaluator behind every decision.
    pub evaluator: ClubEvaluator,
}

impl Default for Bot {
    fn default() -> Self {
        Self::new(Level::Club)
    }
}

impl Bot {
    /// A bot playing at `level` with the [`ClubEvaluator`].
    #[must_use]
    pub fn new(level: Level) -> Self {
        Self {
            level,
            evaluator: ClubEvaluator,
        }
    }

    /// The play to make for `dice` from `pos`, with the ranked candidates it
    /// was chosen from ([`rank_plays`] with this level's parameters). The
    /// chosen play is `candidates[0]`; a roll with no legal move yields the
    /// empty play.
    #[must_use]
    pub fn choose_play(
        &self,
        ctx: &MatchContext,
        pos: &Position,
        dice: Dice,
        seed: u64,
    ) -> (Play, Vec<Candidate>) {
        let candidates = rank_plays(&self.evaluator, ctx, pos, dice, &self.level.params(), seed);
        let chosen = candidates
            .first()
            .map_or_else(Play::empty, |c| c.play.clone());
        (chosen, candidates)
    }

    /// Cube decision for the side on roll before rolling
    /// ([`cube_analysis_for`] of the static evaluation of `pos`: Keith's
    /// race window in a money-game race, the dead-cube MET model otherwise).
    #[must_use]
    pub fn cube_action(&self, ctx: &MatchContext, pos: &Position) -> CubeAnalysis {
        cube_analysis_for(ctx, pos, &self.evaluator.evaluate(pos).clamp())
    }

    /// Analyses `played` for `dice` from `pos` against every legal play,
    /// ranked with the club parameters (2-ply and rollouts) regardless of
    /// `self.level`.
    ///
    /// The played move is located by the position it produces, so a
    /// non-canonical move order still matches. The error is
    /// [`crate::search::ranking_gap`] against `candidates[0]`, so the played
    /// move must be scored the way the head was: a played move found in
    /// the 1-ply tail is refined in place (2-ply plus a rollout seeded
    /// `seed + its index`, exactly as the head), keeping its position in
    /// the list. A play that is not legal for this roll is appended as an
    /// extra candidate, refined the same way if it can be applied to `pos`;
    /// an impossible play is scored like the worst legal candidate with no
    /// rollout. The list is not re-sorted after refining, so if the refined
    /// played move outranks `candidates[0]` the error clamps at zero
    /// (`Best`) while `candidates[0]` stays the bot's own choice.
    #[must_use]
    pub fn analyze_play(
        &self,
        ctx: &MatchContext,
        pos: &Position,
        dice: Dice,
        played: &Play,
        seed: u64,
    ) -> MoveAnalysis {
        let params = Level::Club.params();
        let mut candidates = rank_plays(&self.evaluator, ctx, pos, dice, &params, seed);
        let head = params.keep_top.min(candidates.len());
        let played_after = apply(pos, played).ok();
        let found = played_after.and_then(|after| {
            candidates
                .iter()
                .position(|c| apply(pos, &c.play).ok() == Some(after))
        });
        let index = found.unwrap_or_else(|| {
            let extra = self.extra_candidate(*ctx, played, played_after, &candidates);
            candidates.push(extra);
            candidates.len() - 1
        });
        if index >= head
            && let Some(after) = played_after
        {
            let (probs, equity, rollout) =
                refine(&self.evaluator, *ctx, &after, &params, seed, index);
            let c = &mut candidates[index];
            c.probs = probs;
            c.equity = equity;
            c.rollout = rollout;
        }
        MoveAnalysis::from_candidates(candidates, index)
    }

    /// Grades a cube decision: the analysis for the side on roll before
    /// rolling, the equity lost by `decision_taken` ([`cube_error`]) and its
    /// [`Category`].
    #[must_use]
    pub fn analyze_cube(
        &self,
        ctx: &MatchContext,
        pos: &Position,
        decision_taken: CubeChoice,
    ) -> (CubeAnalysis, f64, Category) {
        let analysis = self.cube_action(ctx, pos);
        let error = cube_error(&analysis, decision_taken);
        (analysis, error, categorize(error))
    }

    /// The candidate appended for a play outside the legal list: a
    /// placeholder that [`Bot::analyze_play`] refines when the play can be
    /// applied, else the worst legal candidate's value.
    fn extra_candidate(
        self,
        ctx: MatchContext,
        played: &Play,
        after: Option<Position>,
        legal: &[Candidate],
    ) -> Candidate {
        let (probs, equity) = match after {
            Some(after) => {
                let probs = crate::rollout::terminal_probs(&after)
                    .unwrap_or_else(|| self.evaluator.evaluate(&after.flip()).flipped().clamp());
                (probs, crate::equity_for(&ctx, &probs))
            }
            None => legal
                .iter()
                .min_by(|a, b| value(a).total_cmp(&value(b)))
                .map_or((Probs::default(), -1.0), |worst| {
                    (worst.probs, value(worst))
                }),
        };
        Candidate {
            play: played.clone(),
            equity,
            probs,
            rollout: None,
        }
    }
}
