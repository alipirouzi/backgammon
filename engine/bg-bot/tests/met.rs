//! Match equity table and match-context equity tests (Task 6 oracles).

use bg_bot::{MatchContext, Probs, cubeless_mwc, equity_for, met, met_post_crawford, mwc_after};

const TOL: f64 = 1e-5;

fn assert_close(actual: f64, expected: f64, what: &str) {
    assert!(
        (actual - expected).abs() < TOL,
        "{what}: expected {expected}, got {actual}"
    );
}

fn pre_crawford(my_away: u8, their_away: u8) -> MatchContext {
    MatchContext {
        length: 7,
        my_away,
        their_away,
        crawford: false,
        post_crawford: false,
        cube: 1,
        cube_owner_is_me: None,
    }
}

fn certain(
    win: f64,
    gammon: f64,
    backgammon: f64,
    lose_gammon: f64,
    lose_backgammon: f64,
) -> Probs {
    Probs {
        win,
        win_g: gammon,
        win_bg: backgammon,
        lose_g: lose_gammon,
        lose_bg: lose_backgammon,
    }
}

#[test]
fn met_matches_kazaross_xg2_anchor_values() {
    assert_close(met(1, 2), 0.67736, "met(1,2)");
    assert_close(met(2, 3), 0.59947, "met(2,3)");
    assert_close(met(3, 4), 0.57150, "met(3,4)");
    assert_close(met(4, 5), 0.57732, "met(4,5)");
    assert_close(met(5, 6), 0.56635, "met(5,6)");
    assert_close(met(6, 7), 0.56261, "met(6,7)");
}

#[test]
fn met_is_symmetric_for_all_pairs() {
    for a in 1..=25u8 {
        for b in 1..=25u8 {
            assert_close(
                met(a, b) + met(b, a),
                1.0,
                &format!("met({a},{b}) + met({b},{a})"),
            );
        }
    }
}

#[test]
fn met_diagonal_is_one_half() {
    for a in 1..=25u8 {
        assert_close(met(a, a), 0.5, &format!("met({a},{a})"));
    }
}

#[test]
fn met_values_are_probabilities_and_monotonic() {
    for a in 1..=25u8 {
        for b in 1..=25u8 {
            let v = met(a, b);
            assert!((0.0..=1.0).contains(&v), "met({a},{b}) = {v} out of range");
            if b < 25 {
                assert!(met(a, b) < met(a, b + 1), "more opponent away must help me");
            }
            if a < 25 {
                assert!(
                    met(a, b) > met(a + 1, b),
                    "more of my own away must hurt me"
                );
            }
        }
    }
}

#[test]
fn met_clamps_out_of_range_away_counts() {
    assert_close(met(0, 5), met(1, 5), "met(0,5) clamps to 1-away");
    assert_close(met(30, 5), met(25, 5), "met(30,5) clamps to 25-away");
    assert_close(
        met_post_crawford(0),
        met_post_crawford(1),
        "post-Crawford clamp low",
    );
    assert_close(
        met_post_crawford(40),
        met_post_crawford(25),
        "post-Crawford clamp high",
    );
}

#[test]
fn met_post_crawford_anchor_values() {
    assert_close(met_post_crawford(2), 0.48803, "met_post_crawford(2)");
    assert_close(met_post_crawford(1), 0.5, "met_post_crawford(1) is DMP");
    for away in 1..25u8 {
        assert!(
            met_post_crawford(away) > met_post_crawford(away + 1),
            "trailer further away must have less MWC"
        );
    }
}

#[test]
fn mwc_after_pre_crawford_uses_pre_crawford_table() {
    let ctx = pre_crawford(7, 7);
    assert_close(mwc_after(&ctx, true, 1), met(6, 7), "win single from 7-7");
    assert_close(mwc_after(&ctx, false, 1), met(7, 6), "lose single from 7-7");
    assert_close(mwc_after(&ctx, true, 2), met(5, 7), "win gammon from 7-7");
    assert_close(
        mwc_after(&ctx, false, 3),
        met(7, 4),
        "lose backgammon from 7-7",
    );
    assert_close(mwc_after(&ctx, true, 7), 1.0, "winning the match");
    assert_close(mwc_after(&ctx, true, 12), 1.0, "over-winning the match");
    assert_close(mwc_after(&ctx, false, 7), 0.0, "losing the match");
    assert_close(mwc_after(&ctx, false, 8), 0.0, "over-losing the match");
}

#[test]
fn mwc_after_reaching_one_away_uses_crawford_game_value() {
    // 2-away / 5-away, I win a single game: the next game is the Crawford
    // game, whose value is the pre-Crawford table's 1-away entry.
    let ctx = pre_crawford(2, 5);
    assert_close(mwc_after(&ctx, true, 1), met(1, 5), "leader reaches 1-away");
    let ctx = pre_crawford(5, 2);
    assert_close(
        mwc_after(&ctx, false, 1),
        met(5, 1),
        "opponent reaches 1-away",
    );
}

#[test]
fn mwc_after_crawford_game_transitions_to_post_crawford_table() {
    let trailer = MatchContext {
        crawford: true,
        ..pre_crawford(3, 1)
    };
    assert_close(
        mwc_after(&trailer, true, 1),
        0.48803,
        "trailer 3-away wins Crawford game",
    );
    assert_close(
        mwc_after(&trailer, true, 2),
        0.5,
        "trailer wins gammon → 1-away/1-away",
    );
    assert_close(
        mwc_after(&trailer, true, 3),
        1.0,
        "trailer wins backgammon → match",
    );
    assert_close(
        mwc_after(&trailer, false, 1),
        0.0,
        "trailer loses Crawford game",
    );

    let leader = MatchContext {
        crawford: true,
        ..pre_crawford(1, 3)
    };
    assert_close(
        mwc_after(&leader, false, 1),
        1.0 - 0.48803,
        "leader loses Crawford game",
    );
    assert_close(
        mwc_after(&leader, true, 1),
        1.0,
        "leader wins Crawford game",
    );
}

#[test]
fn mwc_after_post_crawford_stays_on_post_crawford_table() {
    let trailer = MatchContext {
        post_crawford: true,
        cube: 2,
        cube_owner_is_me: Some(false),
        ..pre_crawford(4, 1)
    };
    assert_close(
        mwc_after(&trailer, true, 2),
        met_post_crawford(2),
        "4-away wins 2 points",
    );
    assert_close(mwc_after(&trailer, true, 4), 1.0, "4-away wins 4 points");
    assert_close(mwc_after(&trailer, false, 2), 0.0, "trailer loses");
    let leader = MatchContext {
        post_crawford: true,
        cube: 2,
        cube_owner_is_me: Some(true),
        ..pre_crawford(1, 4)
    };
    assert_close(
        mwc_after(&leader, false, 2),
        1.0 - met_post_crawford(2),
        "leader loses 2 points",
    );
}

#[test]
fn mwc_after_money_game_is_win_indicator() {
    let money = MatchContext {
        length: 0,
        ..pre_crawford(0, 0)
    };
    assert_close(mwc_after(&money, true, 1), 1.0, "money win");
    assert_close(mwc_after(&money, false, 3), 0.0, "money loss");
}

#[test]
fn cubeless_mwc_weights_outcomes_at_current_cube() {
    let ctx = MatchContext {
        cube: 2,
        cube_owner_is_me: Some(true),
        ..pre_crawford(7, 7)
    };
    // Certain single win / loss.
    assert_close(
        cubeless_mwc(&ctx, &certain(1.0, 0.0, 0.0, 0.0, 0.0)),
        met(5, 7),
        "certain single win at cube 2",
    );
    assert_close(
        cubeless_mwc(&ctx, &certain(0.0, 0.0, 0.0, 0.0, 0.0)),
        met(7, 5),
        "certain single loss at cube 2",
    );
    // Certain gammon win: 4 points.
    assert_close(
        cubeless_mwc(&ctx, &certain(1.0, 1.0, 0.0, 0.0, 0.0)),
        met(3, 7),
        "certain gammon win at cube 2",
    );
    // A mixed distribution is the probability-weighted sum.
    let p = certain(0.6, 0.2, 0.05, 0.1, 0.02);
    let expected = (0.6 - 0.2) * met(5, 7)
        + (0.2 - 0.05) * met(3, 7)
        + 0.05 * met(1, 7)
        + (0.4 - 0.1) * met(7, 5)
        + (0.1 - 0.02) * met(7, 3)
        + 0.02 * met(7, 1);
    assert_close(cubeless_mwc(&ctx, &p), expected, "weighted sum");
}

#[test]
fn cubeless_mwc_of_even_position_at_even_score_is_one_half() {
    let ctx = pre_crawford(7, 7);
    let p = certain(0.5, 0.1, 0.01, 0.1, 0.01);
    assert_close(
        cubeless_mwc(&ctx, &p),
        0.5,
        "symmetric position, symmetric score",
    );
}

#[test]
fn equity_for_money_game_is_cubeless_equity() {
    let money = MatchContext {
        length: 0,
        ..pre_crawford(0, 0)
    };
    let p = certain(0.55, 0.2, 0.03, 0.15, 0.01);
    assert_close(equity_for(&money, &p), p.cubeless_equity(), "money equity");
    assert_close(
        equity_for(&money, &p),
        2.0 * 0.55 - 1.0 + 0.2 + 0.03 - 0.15 - 0.01,
        "formula",
    );
}

#[test]
fn equity_for_match_is_normalised_to_money_scale() {
    let ctx = pre_crawford(7, 7);
    assert_close(
        equity_for(&ctx, &certain(1.0, 0.0, 0.0, 0.0, 0.0)),
        1.0,
        "certain single win is +1",
    );
    assert_close(
        equity_for(&ctx, &certain(0.0, 0.0, 0.0, 0.0, 0.0)),
        -1.0,
        "certain single loss is -1",
    );
    assert_close(
        equity_for(&ctx, &certain(0.5, 0.0, 0.0, 0.0, 0.0)),
        0.0,
        "coin flip without gammons is 0",
    );
    assert!(
        equity_for(&ctx, &certain(1.0, 1.0, 0.0, 0.0, 0.0)) > 1.0,
        "a certain gammon is worth more than a single game"
    );
}

#[test]
fn equity_for_at_double_match_point_ignores_gammons() {
    let dmp = MatchContext {
        crawford: true,
        ..pre_crawford(1, 1)
    };
    let with_gammons = certain(0.62, 0.4, 0.2, 0.3, 0.1);
    let without = certain(0.62, 0.0, 0.0, 0.0, 0.0);
    assert_close(
        equity_for(&dmp, &with_gammons),
        2.0 * 0.62 - 1.0,
        "DMP equity is 2·win − 1",
    );
    assert_close(
        equity_for(&dmp, &with_gammons),
        equity_for(&dmp, &without),
        "gammons irrelevant at DMP",
    );
}

#[test]
fn equity_for_is_monotonic_in_win_probability() {
    let ctx = MatchContext {
        cube: 2,
        cube_owner_is_me: Some(false),
        ..pre_crawford(5, 3)
    };
    let mut last = f64::NEG_INFINITY;
    for step in 0..=20 {
        let win = f64::from(step) / 20.0;
        let e = equity_for(&ctx, &certain(win, 0.0, 0.0, 0.0, 0.0));
        assert!(e > last, "equity must increase with win probability");
        last = e;
    }
}

#[test]
fn match_context_serialises_camel_case() {
    let ctx = MatchContext {
        cube: 2,
        cube_owner_is_me: Some(true),
        ..pre_crawford(5, 3)
    };
    let json = serde_json::to_value(ctx).expect("serialise");
    assert_eq!(
        json,
        serde_json::json!({
            "length": 7, "myAway": 5, "theirAway": 3,
            "crawford": false, "postCrawford": false,
            "cube": 2, "cubeOwnerIsMe": true
        })
    );
    let back: MatchContext = serde_json::from_value(json).expect("deserialise");
    assert_eq!(back, ctx);
}
