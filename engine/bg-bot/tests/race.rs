//! Race evaluation: Keith count, race win probability, race gammon estimates.
//!
//! Keith count and thresholds per Tom Keith, "Cube Handling in Noncontact
//! Positions", <https://bkgm.com/articles/CubeHandlingInRaces/>.

use bg_bot::race::{keith_count, race_gammon_probabilities, race_win_probability};
use bg_core::Position;
use bg_core::position::{BAR, OFF};

/// Builds a relative position from `(index, count)` lists; anything not
/// listed is placed on the off slot so both sides always have 15 checkers.
fn pos(mine: &[(usize, u8)], theirs: &[(usize, u8)]) -> Position {
    let fill = |slots: &[(usize, u8)]| {
        let mut a = [0u8; 26];
        let mut total = 0u8;
        for &(i, n) in slots {
            a[i] += n;
            total += n;
        }
        a[OFF] += 15 - total;
        a
    };
    Position {
        mine: fill(mine),
        theirs: fill(theirs),
    }
}

/// My 5-5-5 on the 4/5/6 points (75 pips); their 5-5-5 on their 4/5/6
/// points (my 21/20/19), 75 pips.
fn even_75() -> Position {
    pos(&[(4, 5), (5, 5), (6, 5)], &[(19, 5), (20, 5), (21, 5)])
}

#[test]
fn keith_count_without_adjustments_only_adds_one_seventh_for_the_roller() {
    // 75 pips each, no wastage adjustments; 75 / 7 = 10 (rounded down).
    assert_eq!(keith_count(&even_75()), (85, 75));
}

#[test]
fn keith_count_applies_all_four_wastage_adjustments() {
    // Mine: 3 on the ace (+2 for each beyond 1 = +4), 3 on the 2-point
    // (+1 each beyond 1 = +2), 5 on the 3-point (+1 each beyond 3 = +2),
    // 4 on the 6-point; points 4 and 5 empty (+2).
    // Pips = 3 + 6 + 15 + 24 = 48; adjusted = 48 + 4 + 2 + 2 + 2 = 58;
    // on roll: 58 + 58 / 7 = 58 + 8 = 66.
    // Theirs: 15 on their 6-point (my 19) = 90 pips, their 4 and 5 empty
    // (+2) = 92; not on roll, no bump.
    let p = pos(&[(1, 3), (2, 3), (3, 5), (6, 4)], &[(19, 15)]);
    assert_eq!(keith_count(&p), (66, 92));
}

#[test]
fn keith_count_is_symmetric_under_flip_apart_from_the_roller_bump() {
    let p = pos(&[(1, 3), (2, 3), (3, 5), (6, 4)], &[(19, 15)]);
    let (mine, theirs) = keith_count(&p);
    let (f_mine, f_theirs) = keith_count(&p.flip());
    // My count carries the bump in `p`, theirs carries it in the flip.
    assert_eq!(f_theirs, mine - 58 / 7);
    assert_eq!(f_mine, theirs + 92 / 7);
}

#[test]
fn keith_count_counts_bar_checkers_as_25_pips_and_empty_home_points() {
    // One checker on my bar, fourteen off: 25 pips + 3 empty points
    // (4, 5, 6) = 28; on roll 28 + 4 = 32. Opponent all off: 0 pips but 3
    // empty points = 3.
    let p = pos(&[(BAR, 1)], &[]);
    assert_eq!(keith_count(&p), (32, 3));
}

#[test]
fn marginal_double_is_about_seventy_percent() {
    // Keith: double when my count exceeds theirs by no more than 4.
    // Mine = 85 (see `even_75`); theirs = 81: move one checker from their
    // 4-point (my 21) to their 10-point (my 15): +6 pips.
    let p = pos(
        &[(4, 5), (5, 5), (6, 5)],
        &[(19, 5), (20, 5), (21, 4), (15, 1)],
    );
    assert_eq!(keith_count(&p), (85, 81));
    let win = race_win_probability(&p);
    assert!((win - 0.70).abs() < 0.05, "win = {win}");
}

#[test]
fn marginal_take_is_about_seventy_five_percent_for_the_doubler() {
    // Keith: take when the doubler's count exceeds the taker's by at least
    // 2, i.e. the taker has ~25% at the borderline.
    // Mine = 85; theirs = 83: move one checker from their 4-point (my 21)
    // to their 12-point (my 13): +8 pips.
    let p = pos(
        &[(4, 5), (5, 5), (6, 5)],
        &[(19, 5), (20, 5), (21, 4), (13, 1)],
    );
    assert_eq!(keith_count(&p), (85, 83));
    let win = race_win_probability(&p);
    assert!((win - 0.75).abs() < 0.05, "win = {win}");
}

#[test]
fn win_probability_is_monotone_in_the_pip_lead() {
    // Move one of my 6-point checkers progressively farther back; every
    // step costs a pip and must not increase my win probability.
    let theirs: &[(usize, u8)] = &[(19, 5), (20, 5), (21, 5)];
    let mut previous = f64::INFINITY;
    for back in 6..=24 {
        let p = pos(&[(4, 5), (5, 5), (6, 4), (back, 1)], theirs);
        let win = race_win_probability(&p);
        assert!(win <= previous, "back = {back}: {win} > {previous}");
        assert!((0.0..=1.0).contains(&win));
        previous = win;
    }
    // Over 18 pips the probability must actually move.
    let far = race_win_probability(&pos(&[(4, 5), (5, 5), (6, 4), (24, 1)], theirs));
    let near = race_win_probability(&pos(&[(4, 5), (5, 5), (6, 5)], theirs));
    assert!(near - far > 0.2, "near = {near}, far = {far}");
}

#[test]
fn being_on_roll_in_an_even_race_is_an_edge() {
    let win = race_win_probability(&even_75());
    assert!(win > 0.5 && win < 0.7, "win = {win}");
}

#[test]
fn a_forty_pip_lead_is_over_ninety_percent() {
    // Mine 60 pips (15 on the 4-point), theirs 100: 10 on their 6-point
    // (my 19) and 5 on their 8-point (my 17).
    let p = pos(&[(4, 15)], &[(19, 10), (17, 5)]);
    assert_eq!(p.pips(), (60, 100));
    assert!(race_win_probability(&p) > 0.9);
    assert!(race_win_probability(&p.flip()) < 0.1);
}

#[test]
fn terminal_races_are_certain() {
    let won = pos(&[], &[(19, 15)]);
    assert!((race_win_probability(&won) - 1.0).abs() < f64::EPSILON);
    let lost = pos(&[(6, 15)], &[]);
    assert!(race_win_probability(&lost).abs() < f64::EPSILON);
}

#[test]
fn no_gammon_once_the_opponent_has_borne_off() {
    let p = pos(&[(6, 15)], &[(19, 14)]);
    let (mine, theirs) = race_gammon_probabilities(&p);
    assert!(mine.abs() < f64::EPSILON, "mine = {mine}");
    assert!((0.0..=1.0).contains(&theirs));
}

#[test]
fn no_gammon_when_the_opponent_is_home_and_i_cannot_finish_this_roll() {
    // They are all home (their 6-point), I have 15 checkers left.
    let p = pos(&[(6, 15)], &[(19, 15)]);
    let (mine, _) = race_gammon_probabilities(&p);
    assert!(mine.abs() < f64::EPSILON, "mine = {mine}");
}

#[test]
fn a_gammon_that_cannot_be_avoided_is_near_certain() {
    // I bear off my last checker this roll; they have 15 checkers on their
    // 23-point (my 2) and none off.
    let p = pos(&[(1, 1)], &[(2, 15)]);
    assert!(p.is_race());
    let (mine, theirs) = race_gammon_probabilities(&p);
    assert!(mine > 0.9, "mine = {mine}");
    assert!(theirs.abs() < f64::EPSILON, "theirs = {theirs}");
}

#[test]
fn their_unavoidable_gammon_is_near_certain() {
    // I have 15 checkers on my 23-point, they have one checker on their ace
    // (my 24) and fourteen off: they finish next turn, I cannot bear off.
    let p = pos(&[(23, 15)], &[(24, 1)]);
    assert!(p.is_race());
    let (mine, theirs) = race_gammon_probabilities(&p);
    assert!(mine.abs() < f64::EPSILON, "mine = {mine}");
    assert!(theirs > 0.9, "theirs = {theirs}");
}

#[test]
fn gammon_chances_are_small_in_a_close_race_and_grow_with_the_lead() {
    let even = race_gammon_probabilities(&even_75());
    assert!(even.0 < 0.05 && even.1 < 0.05, "even = {even:?}");
    // 3 checkers left on my ace point against 15 checkers on their mid-point
    // (my 13): a big but not certain gammon.
    let big = race_gammon_probabilities(&pos(&[(1, 3)], &[(13, 15)]));
    assert!(big.0 > even.0);
    assert!((0.0..=1.0).contains(&big.0));
    assert!(big.1.abs() < f64::EPSILON);
}

#[test]
fn an_even_race_is_an_edge_for_the_roller_at_every_length() {
    // Both viewpoints of an even race must be above one half (the roller
    // has the edge), and equal to each other by symmetry.
    for (name, p) in [
        ("even 100", pos(&[(10, 10)], &[(15, 10)])),
        (
            "even 30",
            pos(&[(1, 5), (2, 5), (3, 5)], &[(24, 5), (23, 5), (22, 5)]),
        ),
        ("even 120", pos(&[(8, 15)], &[(17, 15)])),
    ] {
        let a = race_win_probability(&p);
        let b = race_win_probability(&p.flip());
        assert!((a - b).abs() < 1e-12, "{name}: {a} vs {b}");
        assert!(a > 0.5 && a < 0.7, "{name}: roller's edge = {a}");
    }
    // The edge in probability shrinks as the race gets longer.
    let short = race_win_probability(&pos(
        &[(1, 5), (2, 5), (3, 5)],
        &[(24, 5), (23, 5), (22, 5)],
    ));
    let long = race_win_probability(&pos(&[(8, 15)], &[(17, 15)]));
    assert!(short > long, "{short} vs {long}");
}
