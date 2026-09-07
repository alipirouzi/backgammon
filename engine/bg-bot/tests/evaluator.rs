//! Sanity, invariant and symmetry tests for [`ClubEvaluator`].
//!
//! Positions are built on the relative axis of `bg_core::position`: `mine[i]`
//! is my checker count on my point `i`, `theirs[i]` the opponent's count on
//! the same physical point; index 0 = off, 25 = bar for both arrays.

use bg_bot::heuristic::{ClubEvaluator, PositionClass, classify};
use bg_bot::{Evaluator, Probs};
use bg_core::moves::{apply, legal_plays};
use bg_core::position::{BAR, OFF};
use bg_core::{Board, DiceRng, Player, Position};

/// Component-wise tolerance for the symmetry invariant (plan, Task 8).
const SYMMETRY_TOL: f64 = 0.02;
/// Number of random positions the symmetry invariant is checked on.
const RANDOM_POSITIONS: usize = 200;
/// Longest random walk (plies) from the opening.
const MAX_PLIES: u32 = 60;

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

fn opening() -> Position {
    Position::from_board(&Board::opening(), Player::White)
}

/// Five of my checkers on the bar against a closed board (their home board
/// is my 19–24); their spare three checkers sit on my 17 (their 8-point).
fn five_on_bar_vs_closed_board() -> Position {
    pos(
        &[(BAR, 5), (13, 10)],
        &[
            (19, 2),
            (20, 2),
            (21, 2),
            (22, 2),
            (23, 2),
            (24, 2),
            (17, 3),
        ],
    )
}

/// Pure race, I lead by 40 pips: mine 60 (5 on 6, 5 on 4, 5 on 2), theirs
/// 100 (5 on my 19, 4 on my 18, 4 on my 17, 2 on my 20 = 30 + 28 + 32 + 10).
fn race_40_ahead() -> Position {
    let p = pos(
        &[(6, 5), (4, 5), (2, 5)],
        &[(19, 5), (18, 4), (17, 4), (20, 2)],
    );
    assert_eq!(p.pips(), (60, 100), "fixture pip counts");
    assert!(p.is_race(), "fixture must be a race");
    p
}

fn assert_valid(p: Probs, what: &str) {
    for (name, v) in [
        ("win", p.win),
        ("win_g", p.win_g),
        ("win_bg", p.win_bg),
        ("lose_g", p.lose_g),
        ("lose_bg", p.lose_bg),
    ] {
        assert!(v.is_finite(), "{what}: {name} = {v} is not finite");
        assert!(
            (0.0..=1.0).contains(&v),
            "{what}: {name} = {v} out of range"
        );
    }
    assert!(p.win_bg <= p.win_g + 1e-12, "{what}: win_bg > win_g: {p:?}");
    assert!(p.win_g <= p.win + 1e-12, "{what}: win_g > win: {p:?}");
    assert!(
        p.lose_bg <= p.lose_g + 1e-12,
        "{what}: lose_bg > lose_g: {p:?}"
    );
    assert!(
        p.lose_g <= 1.0 - p.win + 1e-12,
        "{what}: lose_g > 1 − win: {p:?}"
    );
}

fn assert_symmetric(ev: ClubEvaluator, p: &Position, what: &str) {
    let a = ev.evaluate(p).flipped();
    let b = ev.evaluate(&p.flip());
    for (name, x, y) in [
        ("win", a.win, b.win),
        ("win_g", a.win_g, b.win_g),
        ("win_bg", a.win_bg, b.win_bg),
        ("lose_g", a.lose_g, b.lose_g),
        ("lose_bg", a.lose_bg, b.lose_bg),
    ] {
        assert!(
            (x - y).abs() <= SYMMETRY_TOL,
            "{what}: {name} asymmetric: flipped {x:.4} vs flip {y:.4}\n{p:?}"
        );
    }
    assert_eq!(
        classify(p),
        classify(&p.flip()),
        "{what}: classification differs under flip"
    );
}

/// Deterministic walk of `plies` random legal plays from the opening.
fn random_position(rng: &mut DiceRng, plies: u32) -> Position {
    let mut p = opening();
    for _ in 0..plies {
        if p.mine[OFF] == 15 || p.theirs[OFF] == 15 {
            break;
        }
        let dice = rng.roll();
        let plays = legal_plays(&p, dice);
        let a = usize::from(rng.roll_one()) - 1;
        let b = usize::from(rng.roll_one()) - 1;
        let play = &plays[(a * 6 + b) % plays.len()];
        p = apply(&p, play).expect("legal play applies").flip();
    }
    p
}

#[test]
fn opening_is_close_to_even_with_modest_gammons() {
    let p = ClubEvaluator.evaluate(&opening());
    assert_valid(p, "opening");
    assert!((0.48..=0.56).contains(&p.win), "opening win = {}", p.win);
    assert!(
        (0.05..=0.30).contains(&p.win_g),
        "opening win_g = {}",
        p.win_g
    );
    assert!(p.win_bg < p.win_g, "opening win_bg = {}", p.win_bg);
    assert!(
        (p.win_g - p.lose_g).abs() < 0.03,
        "opening gammons lopsided: {p:?}"
    );
}

#[test]
fn five_on_the_bar_against_a_closed_board_is_nearly_lost() {
    let p = ClubEvaluator.evaluate(&five_on_bar_vs_closed_board());
    assert_valid(p, "five on bar");
    assert!(p.win < 0.2, "win = {}", p.win);
    assert!(p.lose_g > 0.5, "lose_g = {} (a gammon is likely)", p.lose_g);
    assert!(
        p.lose_bg > 0.0,
        "lose_bg = {} (checkers on the bar)",
        p.lose_bg
    );
}

#[test]
fn a_forty_pip_race_lead_is_a_clear_win() {
    let p = ClubEvaluator.evaluate(&race_40_ahead());
    assert_valid(p, "race +40");
    assert!(p.win > 0.9, "win = {}", p.win);
    assert_eq!(classify(&race_40_ahead()), PositionClass::Race);
}

#[test]
// Hard zeros by construction (the loser has borne off), so exact comparison is intended.
#[allow(clippy::float_cmp)]
fn race_gammon_is_zero_once_the_loser_has_borne_off() {
    // Same race, but they already have one checker off (taken from my 17).
    let p = pos(
        &[(6, 5), (4, 5), (2, 5)],
        &[(19, 5), (18, 4), (17, 3), (20, 2), (OFF, 1)],
    );
    assert!(p.is_race());
    let e = ClubEvaluator.evaluate(&p);
    assert_valid(e, "race, they have one off");
    assert_eq!(e.win_g, 0.0);
    assert_eq!(e.win_bg, 0.0);
}

#[test]
// Finished games return exact 0.0 / 1.0, so exact comparison is intended.
#[allow(clippy::float_cmp)]
fn finished_games_are_certain() {
    let won = pos(&[(OFF, 15)], &[(19, 5), (20, 5), (21, 5)]);
    let e = ClubEvaluator.evaluate(&won);
    assert_eq!(e.win, 1.0);
    assert_eq!(e.lose_g, 0.0);
    let lost = pos(&[(4, 5), (5, 5), (6, 5)], &[(OFF, 15)]);
    let e = ClubEvaluator.evaluate(&lost);
    assert_eq!(e.win, 0.0);
    assert_eq!(e.win_g, 0.0);
}

#[test]
fn classification_covers_race_bearoff_and_contact() {
    assert_eq!(classify(&opening()), PositionClass::Contact);
    assert_eq!(
        classify(&five_on_bar_vs_closed_board()),
        PositionClass::Contact
    );
    // Separated but not both home: race.
    let race = pos(&[(13, 5), (6, 5), (4, 5)], &[(19, 5), (20, 5), (14, 5)]);
    assert!(race.is_race());
    assert_eq!(classify(&race), PositionClass::Race);
    // Both sides home: bearoff.
    let bearoff = pos(&[(4, 5), (5, 5), (6, 5)], &[(19, 5), (20, 5), (21, 5)]);
    assert_eq!(classify(&bearoff), PositionClass::Bearoff);
    // Mutual anchors: still contact (holding games share contact weights).
    let holding = pos(
        &[(20, 2), (13, 5), (8, 3), (6, 5)],
        &[(5, 2), (12, 5), (17, 3), (19, 5)],
    );
    assert_eq!(classify(&holding), PositionClass::Contact);
}

#[test]
fn even_races_of_any_length_are_symmetric() {
    let ev = ClubEvaluator;
    let cases = [
        (
            "even 40",
            pos(&[(1, 5), (2, 5), (5, 5)], &[(24, 5), (23, 5), (20, 5)]),
        ),
        (
            "even 75",
            pos(&[(4, 5), (5, 5), (6, 5)], &[(19, 5), (20, 5), (21, 5)]),
        ),
        (
            "even 120",
            pos(&[(8, 5), (7, 5), (9, 5)], &[(17, 5), (18, 5), (16, 5)]),
        ),
        ("race +40", race_40_ahead()),
        // Bearoff with a plausible gammon: I have 12 off, they have 15 in.
        (
            "bearoff gammon",
            pos(&[(OFF, 12), (1, 2), (2, 1)], &[(19, 5), (20, 5), (21, 5)]),
        ),
        // Race with a gammon threat: they are far from home, I am nearly done.
        (
            "race gammon",
            pos(&[(OFF, 10), (1, 3), (2, 2)], &[(12, 5), (13, 5), (14, 5)]),
        ),
    ];
    for (name, p) in &cases {
        assert!(p.is_race(), "{name}: fixture is not a race");
        assert_valid(ev.evaluate(p), name);
        assert_symmetric(ev, p, name);
    }
    // An even race is exactly even apart from the on-roll term.
    let even = ev.evaluate(&cases[1].1);
    assert!(
        (even.win - 0.5).abs() <= SYMMETRY_TOL,
        "even 75 win = {}",
        even.win
    );
}

#[test]
fn contact_positions_are_symmetric_and_bounded_on_random_play() {
    let ev = ClubEvaluator;
    let mut rng = DiceRng::from_seed(0x5EED_2026_0903);
    let mut classes = [0usize; 3];
    for k in 0..RANDOM_POSITIONS {
        let plies = u32::try_from(k).expect("small") * MAX_PLIES
            / u32::try_from(RANDOM_POSITIONS).expect("small");
        let p = random_position(&mut rng, plies);
        let what = format!("random #{k} after {plies} plies");
        assert_valid(ev.evaluate(&p), &what);
        assert_symmetric(ev, &p, &what);
        classes[match classify(&p) {
            PositionClass::Contact => 0,
            PositionClass::Race => 1,
            PositionClass::Bearoff => 2,
        }] += 1;
    }
    assert!(classes[0] > 0, "no contact positions sampled");
}

#[test]
fn evaluation_is_deterministic() {
    let p = five_on_bar_vs_closed_board();
    assert_eq!(ClubEvaluator.evaluate(&p), ClubEvaluator.evaluate(&p));
}

#[test]
fn works_through_the_trait_object() {
    let ev: &dyn Evaluator = &ClubEvaluator;
    let p = ev.evaluate(&opening());
    assert_valid(p, "dyn opening");
    let json = serde_json::to_string(&p).expect("serialises");
    assert!(json.contains("\"winG\""));
}

#[test]
fn more_pips_behind_in_contact_means_fewer_wins() {
    // Same structure, but my midpoint checkers are further back.
    let near = pos(
        &[(24, 2), (13, 5), (8, 3), (6, 5)],
        &[(1, 2), (12, 5), (17, 3), (19, 5)],
    );
    let far = pos(
        &[(24, 2), (18, 5), (8, 3), (6, 5)],
        &[(1, 2), (12, 5), (17, 3), (19, 5)],
    );
    let ev = ClubEvaluator;
    assert!(ev.evaluate(&far).win < ev.evaluate(&near).win);
}

#[test]
fn contact_gammon_share_depends_on_where_the_losers_checkers_stand() {
    // Closed board, opponent with two on the bar. (a) the other thirteen are
    // already home; (b) they are stuck in my outfield; (c) on my mid-point.
    let mine: &[(usize, u8)] = &[(1, 2), (2, 2), (3, 2), (4, 2), (5, 2), (6, 2), (8, 3)];
    let share = |theirs: &[(usize, u8)]| {
        let p = pos(mine, theirs);
        assert_eq!(classify(&p), PositionClass::Contact);
        let e = ClubEvaluator.evaluate(&p);
        assert_valid(e, "closed board");
        e.win_g / e.win
    };
    let home = share(&[(BAR, 2), (19, 3), (20, 3), (21, 3), (22, 2), (23, 2)]);
    let outfield = share(&[(BAR, 2), (9, 4), (10, 3), (11, 3), (12, 3)]);
    let mid = share(&[(BAR, 2), (13, 13)]);
    // Self-play rollouts put these near 0.44 / 0.99 / 1.00.
    assert!((0.3..=0.7).contains(&home), "home share = {home}");
    assert!(outfield > 0.9, "outfield share = {outfield}");
    assert!(mid > 0.9, "mid share = {mid}");
    assert!(outfield > home + 0.3);
}
