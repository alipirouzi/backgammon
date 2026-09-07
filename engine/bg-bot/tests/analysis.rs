//! Cube decisions (dead-cube MET model), analysis categories and the `Bot`
//! facade: thresholds, categorisation, serde shapes, cube actions on pure
//! probabilities and on club-evaluated positions, and play analysis.

use bg_bot::analysis::{Category, MoveAnalysis, categorize, thresholds};
use bg_bot::cube::{
    CubeAction, CubeAnalysis, CubeChoice, can_double, cube_analysis, cube_analysis_for, cube_error,
};
use bg_bot::race::keith_lead;
use bg_bot::search::ranking_gap;
use bg_bot::{Bot, Evaluator, Level, MatchContext, Probs, met};
use bg_core::moves::legal_plays;
use bg_core::position::OFF;
use bg_core::{Dice, Move, Play, Position};

const TOL: f64 = 1e-9;

fn money() -> MatchContext {
    MatchContext {
        length: 0,
        my_away: 0,
        their_away: 0,
        crawford: false,
        post_crawford: false,
        cube: 1,
        cube_owner_is_me: None,
    }
}

fn two_away_two_away() -> MatchContext {
    MatchContext {
        length: 5,
        my_away: 2,
        their_away: 2,
        crawford: false,
        post_crawford: false,
        cube: 1,
        cube_owner_is_me: None,
    }
}

fn win_only(win: f64) -> Probs {
    Probs {
        win,
        ..Probs::default()
    }
}

fn pos(mine: &[(usize, u8)], theirs: &[(usize, u8)]) -> Position {
    let mut p = Position {
        mine: [0; 26],
        theirs: [0; 26],
    };
    for &(i, n) in mine {
        p.mine[i] = n;
    }
    for &(i, n) in theirs {
        p.theirs[i] = n;
    }
    p
}

/// Opening position with an opposing blot slotted on my 5-point (taken from
/// their mid-point). With 3-1, `8/5* 6/5` hits and makes the point.
fn slotted_five_point() -> Position {
    pos(
        &[(24, 2), (13, 5), (8, 3), (6, 5)],
        &[(1, 2), (12, 4), (17, 3), (19, 5), (5, 1)],
    )
}

/// My race side for the Keith fixtures: 102 pips, no wastage (Keith 102,
/// bumped 116 on roll).
const RACE_MINE: &[(usize, u8)] = &[(4, 3), (5, 3), (6, 3), (8, 3), (11, 3)];

/// A pure race where I lead 102 to 113 pips: Keith `D = 116 − 113 = 3`,
/// inside his double/take window (`2 ≤ D ≤ 4`).
fn race_lead() -> Position {
    pos(RACE_MINE, &[(19, 3), (20, 3), (21, 3), (14, 4), (13, 2)])
}

/// A dead-even 102-pip race: Keith `D = 14`, well outside his window.
fn race_even() -> Position {
    pos(
        RACE_MINE,
        &[(19, 3), (20, 3), (21, 3), (15, 4), (16, 1), (17, 1)],
    )
}

/// 102 to 112 pips: Keith `D = 4`, his marginal double (but not a redouble).
fn race_marginal_double() -> Position {
    pos(RACE_MINE, &[(19, 3), (20, 3), (21, 3), (13, 5), (18, 1)])
}

/// 102 to 116 pips: Keith `D = 0`, past his take point.
fn race_past_take_point() -> Position {
    pos(RACE_MINE, &[(19, 3), (20, 3), (21, 3), (13, 5), (14, 1)])
}

/// The opponent has 13 checkers off and two on their ace point; I have 15
/// checkers on my mid-point.
fn hopeless_race() -> Position {
    pos(&[(12, 15)], &[(OFF, 13), (24, 2)])
}

fn dice(hi: u8, lo: u8) -> Dice {
    Dice::new(hi, lo).expect("valid dice")
}

fn mv(from: u8, to: u8, hit: bool) -> Move {
    Move { from, to, hit }
}

// ---------------------------------------------------------------------------
// Thresholds and categories
// ---------------------------------------------------------------------------

#[test]
fn thresholds_follow_the_xg_legend() {
    assert!((thresholds::BEST - 0.0005).abs() < TOL);
    assert!((thresholds::FINE - 0.020).abs() < TOL);
    assert!((thresholds::ERROR - 0.080).abs() < TOL);
}

#[test]
fn categorize_boundaries() {
    assert_eq!(categorize(0.0), Category::Best);
    assert_eq!(categorize(-0.01), Category::Best);
    assert_eq!(categorize(0.0005), Category::Best);
    assert_eq!(categorize(0.0006), Category::Fine);
    assert_eq!(categorize(0.0199), Category::Fine);
    assert_eq!(categorize(0.020), Category::Error);
    assert_eq!(categorize(0.0799), Category::Error);
    assert_eq!(categorize(0.080), Category::Blunder);
    assert_eq!(categorize(1.5), Category::Blunder);
    assert_eq!(categorize(f64::NAN), Category::Blunder);
}

#[test]
fn category_serialises_lowercase() {
    let json = serde_json::to_value([
        Category::Best,
        Category::Fine,
        Category::Error,
        Category::Blunder,
    ])
    .expect("serialise");
    assert_eq!(
        json,
        serde_json::json!(["best", "fine", "error", "blunder"])
    );
    let back: Category = serde_json::from_str("\"blunder\"").expect("deserialise");
    assert_eq!(back, Category::Blunder);
}

#[test]
fn cube_action_and_choice_serialise_camel_case() {
    let json = serde_json::to_value([
        CubeAction::NoDouble,
        CubeAction::DoubleTake,
        CubeAction::DoubleDrop,
        CubeAction::TooGood,
        CubeAction::RedoubleTake,
        CubeAction::RedoubleDrop,
        CubeAction::NoRedouble,
    ])
    .expect("serialise");
    assert_eq!(
        json,
        serde_json::json!([
            "noDouble",
            "doubleTake",
            "doubleDrop",
            "tooGood",
            "redoubleTake",
            "redoubleDrop",
            "noRedouble"
        ])
    );
    let choices = serde_json::to_value([
        CubeChoice::NoDouble,
        CubeChoice::Double,
        CubeChoice::Take,
        CubeChoice::Drop,
    ])
    .expect("serialise");
    assert_eq!(
        choices,
        serde_json::json!(["noDouble", "double", "take", "drop"])
    );
}

// ---------------------------------------------------------------------------
// Cube analysis on pure probabilities (money)
// ---------------------------------------------------------------------------

#[test]
fn money_double_take_window() {
    let a = cube_analysis(&money(), &win_only(0.65));
    assert_eq!(a.action, CubeAction::DoubleTake);
    assert!(a.can_double);
    assert!((a.equity_no_double - 0.3).abs() < TOL);
    assert!((a.equity_double_take - 0.6).abs() < TOL);
    assert!((a.equity_double_drop - 1.0).abs() < TOL);
    assert!((a.take_point - 0.25).abs() < TOL);
}

#[test]
fn money_double_drop_past_the_take_point() {
    let a = cube_analysis(&money(), &win_only(0.80));
    assert_eq!(a.action, CubeAction::DoubleDrop);
    assert!((a.equity_double_take - 1.2).abs() < TOL);
}

#[test]
fn money_exact_take_point_is_a_drop() {
    // DT == DP: the taker is indifferent, so the analysis says drop.
    let a = cube_analysis(&money(), &win_only(0.75));
    assert_eq!(a.action, CubeAction::DoubleDrop);
}

#[test]
fn money_too_good_when_playing_on_beats_cashing() {
    let p = Probs {
        win: 0.95,
        win_g: 0.6,
        ..Probs::default()
    };
    let a = cube_analysis(&money(), &p);
    assert_eq!(a.action, CubeAction::TooGood);
    assert!(a.equity_no_double > a.equity_double_drop);
}

#[test]
fn money_no_double_when_behind_or_level() {
    assert_eq!(
        cube_analysis(&money(), &win_only(0.45)).action,
        CubeAction::NoDouble
    );
    // DT == ND == 0: ties favour not doubling.
    assert_eq!(
        cube_analysis(&money(), &win_only(0.5)).action,
        CubeAction::NoDouble
    );
}

#[test]
fn owned_cube_gives_redouble_variants() {
    let owned = MatchContext {
        cube: 2,
        cube_owner_is_me: Some(true),
        ..money()
    };
    assert_eq!(
        cube_analysis(&owned, &win_only(0.65)).action,
        CubeAction::RedoubleTake
    );
    assert_eq!(
        cube_analysis(&owned, &win_only(0.85)).action,
        CubeAction::RedoubleDrop
    );
    assert_eq!(
        cube_analysis(&owned, &win_only(0.40)).action,
        CubeAction::NoRedouble
    );
}

#[test]
fn opponent_owned_cube_is_dead() {
    let theirs = MatchContext {
        cube: 2,
        cube_owner_is_me: Some(false),
        ..money()
    };
    assert!(!can_double(&theirs));
    let a = cube_analysis(&theirs, &win_only(0.7));
    assert_eq!(a.action, CubeAction::NoDouble);
    assert!(!a.can_double);
}

#[test]
fn crawford_game_has_no_cube() {
    let crawford = MatchContext {
        length: 5,
        my_away: 3,
        their_away: 1,
        crawford: true,
        ..money()
    };
    assert!(!can_double(&crawford));
    let a = cube_analysis(&crawford, &win_only(0.7));
    assert_eq!(a.action, CubeAction::NoDouble);
    assert!(!a.can_double);
}

// ---------------------------------------------------------------------------
// Cube analysis in a match
// ---------------------------------------------------------------------------

#[test]
fn match_take_point_at_two_away_two_away_is_met_2_1() {
    // Dropping leaves the taker trailing 2-away vs 1-away (Crawford next);
    // taking plays for the match. Gammonless take point = met(2, 1).
    let a = cube_analysis(&two_away_two_away(), &win_only(0.6));
    assert!((a.take_point - met(2, 1)).abs() < TOL, "{}", a.take_point);
}

#[test]
fn match_double_take_equity_is_on_the_current_cube_scale() {
    // At 2-away/2-away with the cube on 2 every result ends the match, so
    // MWC(DT) = w. On the current (cube 1) EMG scale that is
    // 2·(w − L1)/(W1 − L1) − 1 with W1 = met(1, 2), L1 = met(2, 1).
    let ctx = two_away_two_away();
    let w = 0.6;
    let a = cube_analysis(&ctx, &win_only(w));
    let w1 = met(1, 2);
    let l1 = met(2, 1);
    let expected = 2.0 * (w - l1) / (w1 - l1) - 1.0;
    assert!((a.equity_double_take - expected).abs() < TOL);
    assert!((a.equity_double_drop - 1.0).abs() < TOL);
    // Below the take point the opponent takes; the double is correct.
    assert_eq!(a.action, CubeAction::DoubleTake);
}

#[test]
fn match_leader_at_post_crawford_never_doubles() {
    let leader = MatchContext {
        length: 5,
        my_away: 1,
        their_away: 3,
        crawford: false,
        post_crawford: true,
        cube: 1,
        cube_owner_is_me: None,
    };
    assert!(can_double(&leader));
    assert_eq!(
        cube_analysis(&leader, &win_only(0.7)).action,
        CubeAction::NoDouble
    );
}

// ---------------------------------------------------------------------------
// Error sizes per choice
// ---------------------------------------------------------------------------

#[test]
fn cube_error_per_choice_in_the_take_window() {
    let a = cube_analysis(&money(), &win_only(0.65)); // ND .3, DT .6, DP 1
    assert!((cube_error(&a, CubeChoice::NoDouble) - 0.3).abs() < TOL);
    assert!(cube_error(&a, CubeChoice::Double).abs() < TOL);
    assert!(cube_error(&a, CubeChoice::Take).abs() < TOL);
    assert!((cube_error(&a, CubeChoice::Drop) - 0.4).abs() < TOL);
}

#[test]
fn cube_error_per_choice_when_no_double_is_right() {
    let a = cube_analysis(&money(), &win_only(0.40)); // ND −.2, DT −.4
    assert!(cube_error(&a, CubeChoice::NoDouble).abs() < TOL);
    assert!((cube_error(&a, CubeChoice::Double) - 0.2).abs() < TOL);
}

#[test]
fn cube_error_is_zero_when_the_cube_cannot_be_turned() {
    let crawford = MatchContext {
        length: 5,
        my_away: 3,
        their_away: 1,
        crawford: true,
        ..money()
    };
    let a = cube_analysis(&crawford, &win_only(0.7));
    for choice in [
        CubeChoice::NoDouble,
        CubeChoice::Double,
        CubeChoice::Take,
        CubeChoice::Drop,
    ] {
        assert!(cube_error(&a, choice).abs() < TOL);
    }
}

#[test]
fn cube_analysis_serialises_the_plan_shape() {
    let a = cube_analysis(&money(), &win_only(0.65));
    let json = serde_json::to_value(a).expect("serialise");
    let obj = json.as_object().expect("object");
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "action",
            "canDouble",
            "equityDoubleDrop",
            "equityDoubleTake",
            "equityNoDouble",
            "takePoint"
        ]
    );
    assert_eq!(json["action"], "doubleTake");
    let back: CubeAnalysis = serde_json::from_value(json).expect("deserialise");
    assert_eq!(back, a);
}

// ---------------------------------------------------------------------------
// Bot facade: cube
// ---------------------------------------------------------------------------

#[test]
fn bot_race_lead_in_keiths_window_is_double_take() {
    let bot = Bot::new(Level::Club);
    assert!(race_lead().is_race());
    assert_eq!(keith_lead(&race_lead()), 3);
    let a = bot.cube_action(&money(), &race_lead());
    assert_eq!(a.action, CubeAction::DoubleTake, "{a:?}");
    assert!(a.can_double);
    // The dead-cube equities are still reported, on the usual scale.
    assert!(a.equity_no_double > 0.0 && a.equity_double_take > a.equity_no_double);
    assert!((a.equity_double_drop - 1.0).abs() < TOL);
}

#[test]
fn bot_even_race_is_no_double_although_the_dead_cube_model_would_double() {
    // Without gammons DT = 4w − 2 > ND = 2w − 1 for every w > 0.5, so the
    // dead-cube model doubles a dead-even race; Keith (D = 14) does not.
    let bot = Bot::new(Level::Club);
    assert_eq!(keith_lead(&race_even()), 14);
    let a = bot.cube_action(&money(), &race_even());
    assert_eq!(a.action, CubeAction::NoDouble, "{a:?}");
    assert!(
        a.equity_double_take.min(a.equity_double_drop) > a.equity_no_double,
        "fixture must be one the dead-cube arithmetic would double: {a:?}"
    );
    // Grading follows the recommendation, not the raw arithmetic.
    let (_, err, cat) = bot.analyze_cube(&money(), &race_even(), CubeChoice::NoDouble);
    assert!(err.abs() < TOL);
    assert_eq!(cat, Category::Best);
    let (_, err, _) = bot.analyze_cube(&money(), &race_even(), CubeChoice::Double);
    assert!(err > 0.0);
}

#[test]
fn bot_race_keith_thresholds_double_redouble_and_take() {
    let bot = Bot::new(Level::Club);
    assert_eq!(keith_lead(&race_marginal_double()), 4);
    assert_eq!(keith_lead(&race_past_take_point()), 0);
    assert_eq!(
        bot.cube_action(&money(), &race_marginal_double()).action,
        CubeAction::DoubleTake
    );
    assert_eq!(
        bot.cube_action(&money(), &race_past_take_point()).action,
        CubeAction::DoubleDrop
    );
    let owned = MatchContext {
        cube: 2,
        cube_owner_is_me: Some(true),
        ..money()
    };
    // Redouble window is D ≤ 3: D = 4 is not a redouble, D = 3 is.
    assert_eq!(
        bot.cube_action(&owned, &race_marginal_double()).action,
        CubeAction::NoRedouble
    );
    assert_eq!(
        bot.cube_action(&owned, &race_lead()).action,
        CubeAction::RedoubleTake
    );
    assert_eq!(
        bot.cube_action(&owned, &race_past_take_point()).action,
        CubeAction::RedoubleDrop
    );
}

#[test]
fn keith_gate_applies_only_to_money_game_races() {
    let bot = Bot::new(Level::Club);
    // Match play keeps the dead-cube MET model even in a race.
    let ctx = MatchContext {
        length: 7,
        my_away: 3,
        their_away: 5,
        ..money()
    };
    let p = bot.evaluator.evaluate(&race_even()).clamp();
    assert_eq!(bot.cube_action(&ctx, &race_even()), cube_analysis(&ctx, &p));
    assert_eq!(
        cube_analysis_for(&ctx, &race_even(), &p),
        cube_analysis(&ctx, &p)
    );
    // Contact positions keep it in money games too.
    let contact = slotted_five_point();
    assert!(!contact.is_race());
    let p = bot.evaluator.evaluate(&contact).clamp();
    assert_eq!(
        bot.cube_action(&money(), &contact),
        cube_analysis(&money(), &p)
    );
}

#[test]
fn bot_hopeless_position_is_no_double() {
    let bot = Bot::new(Level::Club);
    let a = bot.cube_action(&money(), &hopeless_race());
    assert_eq!(a.action, CubeAction::NoDouble, "{a:?}");
    assert!(a.equity_no_double < -0.9);
}

#[test]
fn bot_crawford_is_no_double_even_when_ahead() {
    let bot = Bot::new(Level::Club);
    let crawford = MatchContext {
        length: 5,
        my_away: 3,
        their_away: 1,
        crawford: true,
        ..money()
    };
    let a = bot.cube_action(&crawford, &race_lead());
    assert_eq!(a.action, CubeAction::NoDouble);
    assert!(!a.can_double);
}

#[test]
fn bot_analyze_cube_grades_a_hopeless_double_as_a_blunder() {
    let bot = Bot::new(Level::Club);
    let (a, err, cat) = bot.analyze_cube(&money(), &hopeless_race(), CubeChoice::Double);
    assert_eq!(a.action, CubeAction::NoDouble);
    assert!(err > thresholds::ERROR, "{err}");
    assert_eq!(cat, Category::Blunder);
    let (_, err, cat) = bot.analyze_cube(&money(), &hopeless_race(), CubeChoice::NoDouble);
    assert!(err.abs() < TOL);
    assert_eq!(cat, Category::Best);
}

// ---------------------------------------------------------------------------
// Bot facade: plays
// ---------------------------------------------------------------------------

#[test]
fn analyze_play_hit_beats_leaving_a_double_shot() {
    let bot = Bot::new(Level::Club);
    let position = slotted_five_point();
    let roll = dice(3, 1);
    // 24/23 13/10: no hit, blots on 10, 23 and 24 in direct range.
    let double_shot = Play {
        moves: vec![mv(24, 23, false), mv(13, 10, false)],
    };
    let analysis = bot.analyze_play(&money(), &position, roll, &double_shot, 7);
    assert_eq!(
        analysis.candidates.len(),
        legal_plays(&position, roll).len()
    );
    let best = &analysis.candidates[0];
    assert!(
        best.play.moves.iter().any(|m| m.hit),
        "best play should hit: {}",
        serde_json::to_string(&best.play).expect("json")
    );
    assert_eq!(
        analysis.candidates[analysis.played_index].play, double_shot,
        "played index must point at the analysed play"
    );
    assert!(analysis.played_index > 0);
    assert!(
        analysis.error_size >= thresholds::FINE,
        "leaving a double shot instead of hitting must be at least an error, got {}",
        analysis.error_size
    );
    assert!(matches!(
        analysis.category,
        Category::Error | Category::Blunder
    ));

    // The best play itself has no error.
    let top = bot.analyze_play(&money(), &position, roll, &best.play, 7);
    assert_eq!(top.played_index, 0);
    assert!(top.error_size.abs() < TOL);
    assert_eq!(top.category, Category::Best);

    // Plays are matched by resulting position, so move order is irrelevant.
    let reversed = Play {
        moves: vec![mv(13, 10, false), mv(24, 23, false)],
    };
    let same = bot.analyze_play(&money(), &position, roll, &reversed, 7);
    assert_eq!(same.played_index, analysis.played_index);
    assert!((same.error_size - analysis.error_size).abs() < TOL);
}

#[test]
fn analyze_play_appends_a_play_that_is_not_legal_for_the_roll() {
    let bot = Bot::new(Level::Club);
    let position = slotted_five_point();
    let roll = dice(3, 1);
    // A legal-looking move that does not use the dice rolled.
    let odd = Play {
        moves: vec![mv(13, 7, false)],
    };
    let analysis = bot.analyze_play(&money(), &position, roll, &odd, 7);
    let n_legal = legal_plays(&position, roll).len();
    assert_eq!(analysis.candidates.len(), n_legal + 1);
    assert_eq!(analysis.played_index, n_legal);
    assert_eq!(analysis.candidates[n_legal].play, odd);
    assert!(analysis.error_size >= 0.0);

    // A play that cannot be applied at all (empty source point).
    let impossible = Play {
        moves: vec![mv(20, 17, false)],
    };
    let analysis = bot.analyze_play(&money(), &position, roll, &impossible, 7);
    assert_eq!(analysis.candidates.len(), n_legal + 1);
    assert_eq!(analysis.played_index, n_legal);
    assert!(analysis.error_size >= 0.0);
}

#[test]
fn move_analysis_serialises_the_plan_shape() {
    let bot = Bot::new(Level::Intermediate);
    let position = slotted_five_point();
    let roll = dice(3, 1);
    let (chosen, candidates) = bot.choose_play(&money(), &position, roll, 3);
    assert_eq!(chosen, candidates[0].play);
    let analysis = MoveAnalysis::from_candidates(candidates, 0);
    let json = serde_json::to_value(&analysis).expect("serialise");
    let obj = json.as_object().expect("object");
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["candidates", "category", "errorSize", "playedIndex"]);
    assert_eq!(json["category"], "best");
    assert_eq!(json["playedIndex"], 0);
    let back: MoveAnalysis = serde_json::from_value(json).expect("deserialise");
    assert_eq!(back, analysis);
}

#[test]
fn choose_play_is_deterministic_and_seed_changes_only_equities() {
    let bot = Bot::new(Level::Beginner);
    let position = slotted_five_point();
    let roll = dice(3, 1);
    let a = bot.choose_play(&money(), &position, roll, 11);
    let b = bot.choose_play(&money(), &position, roll, 11);
    assert_eq!(
        serde_json::to_string(&a.1).expect("json"),
        serde_json::to_string(&b.1).expect("json")
    );
    assert_eq!(a.0, a.1[0].play);
    let c = bot.choose_play(&money(), &position, roll, 12);
    let mut plays_a: Vec<String> = a.1.iter().map(|c| c.play.to_string()).collect();
    let mut plays_c: Vec<String> = c.1.iter().map(|c| c.play.to_string()).collect();
    plays_a.sort();
    plays_c.sort();
    assert_eq!(plays_a, plays_c);
}

// ---------------------------------------------------------------------------
// Regression: play quality and grading scale
// ---------------------------------------------------------------------------

/// Money, 6-1 to play with an opposing blot on my bar point: hitting must
/// beat slotting the 2-point (`8/2 6/5`) already at 1-ply. Which hitting
/// play is best is left to deeper search (the rollout prefers `13/7* 6/5`).
fn blot_on_my_bar_point() -> Position {
    pos(
        &[(6, 4), (8, 3), (13, 5), (24, 2), (5, 1)],
        &[(1, 2), (12, 5), (17, 3), (19, 4), (7, 1)],
    )
}

#[test]
fn hitting_the_blot_on_my_bar_point_beats_slotting_at_every_level() {
    let position = blot_on_my_bar_point();
    let roll = dice(6, 1);
    for level in [Level::Intermediate, Level::Club] {
        let (play, candidates) = Bot::new(level).choose_play(&money(), &position, roll, 5);
        assert!(
            play.moves.iter().any(|m| m.hit),
            "{level:?} should hit, played {play}"
        );
        let slot = candidates
            .iter()
            .position(|c| c.play.to_string() == "8/2 6/5")
            .expect("8/2 6/5 is legal");
        assert!(slot > 0, "{level:?} ranks 8/2 6/5 first");
    }
}

#[test]
fn a_played_move_outside_the_head_is_graded_on_the_heads_scale() {
    let bot = Bot::new(Level::Club);
    let position = slotted_five_point();
    let roll = dice(3, 1);
    let (_, ranked) = bot.choose_play(&money(), &position, roll, 7);
    let head = Level::Club.params().keep_top;
    assert!(ranked.len() > head + 1, "fixture needs a tail");
    // The bot's own tail entry is 1-ply, without a rollout.
    let tail = ranked.last().expect("candidates");
    assert!(tail.rollout.is_none());

    let analysis = bot.analyze_play(&money(), &position, roll, &tail.play, 7);
    let i = analysis.played_index;
    assert!(
        i >= head,
        "played move should be located in the tail, got {i}"
    );
    let played = &analysis.candidates[i];
    assert_eq!(played.play, tail.play);
    // Refined exactly like the head: 2-ply equity and a 100-trial rollout.
    let r = played.rollout.expect("played tail move is rolled out");
    assert_eq!(r.trials, Level::Club.params().rollouts);
    assert!(
        (played.equity - tail.equity).abs() > 1e-9,
        "equity should be the 2-ply value, not the 1-ply one"
    );
    // The error is the ranking comparator against the best play.
    let best = &analysis.candidates[0];
    assert!((analysis.error_size - ranking_gap(best, played).max(0.0)).abs() < TOL);
    // The worst play of a 15-play roll is a real error, not "Best".
    assert!(
        analysis.error_size >= thresholds::FINE,
        "worst play graded {} ({:?})",
        analysis.error_size,
        analysis.category
    );
    // Everything else in the list is untouched.
    for (a, b) in analysis.candidates.iter().zip(&ranked) {
        if a.play != tail.play {
            assert_eq!(a, b);
        }
    }
}

#[test]
fn club_plays_the_book_point_making_plays_on_six_one_and_three_one_for_several_seeds() {
    // Before the ranking rule the 100-trial rollout re-sorted the head by
    // its noisy mean and the club level played the classic 6-1 and 3-1
    // blunders on some seeds; the 2-ply order now stands unless a rollout
    // gap is decisive.
    let bot = Bot::new(Level::Club);
    let opening = Position::from_board(&bg_core::Board::opening(), bg_core::Player::White);
    for seed in 1..=3u64 {
        let (play, _) = bot.choose_play(&money(), &opening, dice(6, 1), seed);
        assert_eq!(play.to_string(), "13/7 8/7", "6-1, seed {seed}");
        let (play, _) = bot.choose_play(&money(), &opening, dice(3, 1), seed);
        assert_eq!(play.to_string(), "8/5 6/5", "3-1, seed {seed}");
    }
}
