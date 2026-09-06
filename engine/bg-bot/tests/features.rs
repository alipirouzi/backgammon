//! Contact feature extraction on hand-built relative positions.

use bg_bot::features::{Features, extract};
use bg_core::position::{BAR, OFF};
use bg_core::{Board, Player, Position};

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

/// Number of rolls (of 36) that hit a lone blot `d` pips away with no
/// blocking points, the standard shot table (index 0 unused).
const SHOT_TABLE: [u32; 13] = [0, 11, 12, 14, 15, 15, 17, 6, 6, 5, 3, 2, 3];

#[test]
fn opening_position_features() {
    let f = extract(&Position::from_board(&Board::opening(), Player::White));
    assert_eq!(
        f,
        Features {
            pips_mine: 167,
            pips_theirs: 167,
            blots_mine: 0,
            blots_theirs: 0,
            direct_shots_on_me: 0,
            indirect_shots_on_me: 0,
            direct_shot_pips_on_me: 0,
            indirect_shot_pips_on_me: 0,
            points_made_mine: 4,
            points_made_theirs: 4,
            prime_len_mine: 1,
            prime_len_theirs: 1,
            anchors_mine: 1,
            home_board_points_mine: 1,
            home_board_points_theirs: 1,
            checkers_back_mine: 2,
            checkers_back_theirs: 2,
            bar_mine: 0,
            bar_theirs: 0,
            off_mine: 0,
            off_theirs: 0,
            // 2 × (24 − 6) + 5 × (13 − 6) + 3 × (8 − 6) = 36 + 35 + 6.
            outside_pips_mine: 77,
            outside_pips_theirs: 77,
        }
    );
}

#[test]
fn shot_pips_weight_each_shot_by_the_pips_a_hit_costs() {
    // A blot on my 5-point is 20 pips from the bar; one attacker 3 away
    // (14 rolls) → 14 × 20 weighted pips. A blot on my 24-point costs one
    // pip per shot.
    let deep = extract(&pos(&[(5, 1)], &[(2, 1)]));
    assert_eq!(deep.direct_shots_on_me, SHOT_TABLE[3]);
    assert_eq!(deep.direct_shot_pips_on_me, SHOT_TABLE[3] * 20);
    let back = extract(&pos(&[(24, 1)], &[(21, 1)]));
    assert_eq!(back.direct_shots_on_me, SHOT_TABLE[3]);
    assert_eq!(back.direct_shot_pips_on_me, SHOT_TABLE[3]);
    // Indirect: 8 away from my 13-point blot (12 pips to the bar).
    let far = extract(&pos(&[(13, 1)], &[(5, 1)]));
    assert_eq!(far.indirect_shots_on_me, SHOT_TABLE[8]);
    assert_eq!(far.indirect_shot_pips_on_me, SHOT_TABLE[8] * 12);
    assert_eq!(far.direct_shot_pips_on_me, 0);
}

#[test]
fn outside_pips_count_the_distance_to_each_home_board() {
    // Mine: one on the bar (25 − 6 = 19) and one on my 13-point (7); the
    // rest home. Theirs: one on my 1-point (their 24 → 18) and one on my 12
    // (their 13 → 7); the rest on their 6-point (my 19).
    let f = extract(&pos(
        &[(BAR, 1), (13, 1), (6, 13)],
        &[(1, 1), (12, 1), (19, 13)],
    ));
    assert_eq!(f.outside_pips_mine, 26);
    assert_eq!(f.outside_pips_theirs, 25);
    let home = extract(&pos(&[(6, 15)], &[(19, 15)]));
    assert_eq!(home.outside_pips_mine, 0);
    assert_eq!(home.outside_pips_theirs, 0);
}

#[test]
fn lone_blot_direct_shots_follow_the_shot_table() {
    // My blot on my 13-point; one of their checkers `d` pips behind it
    // (they move up my axis, so the attacker stands on my point 13 - d).
    for (d, &expected) in SHOT_TABLE.iter().enumerate().skip(1).take(6) {
        let f = extract(&pos(&[(13, 1)], &[(13 - d, 1)]));
        assert_eq!(f.direct_shots_on_me, expected, "d = {d}");
        assert_eq!(f.indirect_shots_on_me, 0, "d = {d}");
        assert_eq!(f.blots_mine, 1);
        assert_eq!(f.blots_theirs, 1);
    }
}

#[test]
fn lone_blot_indirect_shots_follow_the_shot_table() {
    for (d, &expected) in SHOT_TABLE.iter().enumerate().skip(7) {
        let f = extract(&pos(&[(13, 1)], &[(13 - d, 1)]));
        assert_eq!(f.indirect_shots_on_me, expected, "d = {d}");
        assert_eq!(f.direct_shots_on_me, 0, "d = {d}");
    }
}

#[test]
fn hand_built_shot_examples_from_the_plan() {
    // 1 away: any 1 = 11 rolls.
    assert_eq!(extract(&pos(&[(13, 1)], &[(12, 1)])).direct_shots_on_me, 11);
    // 2 away: any 2 (11) plus 1-1 = 12.
    assert_eq!(extract(&pos(&[(13, 1)], &[(11, 1)])).direct_shots_on_me, 12);
    // 12 away: 6-6, 4-4, 3-3 = 3.
    assert_eq!(extract(&pos(&[(13, 1)], &[(1, 1)])).indirect_shots_on_me, 3);
}

#[test]
fn checkers_beyond_twelve_pips_or_already_past_do_not_shoot() {
    // 13 pips away: unreachable.
    let f = extract(&pos(&[(14, 1)], &[(1, 1)]));
    assert_eq!((f.direct_shots_on_me, f.indirect_shots_on_me), (0, 0));
    // Their checker ahead of my blot cannot come back.
    let f = extract(&pos(&[(13, 1)], &[(20, 1)]));
    assert_eq!((f.direct_shots_on_me, f.indirect_shots_on_me), (0, 0));
}

#[test]
fn their_bar_checkers_shoot_from_below_my_ace_point() {
    // Entering checker vs my blot on my 4-point: 4 pips, 15 rolls.
    let f = extract(&pos(&[(4, 1)], &[(BAR, 1)]));
    assert_eq!(f.direct_shots_on_me, 15);
    assert_eq!(f.bar_theirs, 1);
    // Blot on my 9-point: 9 pips, indirect (6-3, 5-4, 3-3) = 5.
    let f = extract(&pos(&[(9, 1)], &[(BAR, 1)]));
    assert_eq!(f.indirect_shots_on_me, 5);
}

#[test]
fn several_attackers_on_one_blot_count_distinct_rolls() {
    // Attackers 1 and 2 pips behind: rolls containing a 1 or a 2 (20);
    // 1-1 is already among them.
    let f = extract(&pos(&[(13, 1)], &[(12, 1), (11, 1)]));
    assert_eq!(f.direct_shots_on_me, 20);
}

#[test]
fn shots_are_summed_over_my_blots() {
    // Blot A on 13 with an attacker 6 behind (17 direct) and 9 behind
    // (5 indirect); blot B on 5 with an attacker 1 behind (11 direct).
    let f = extract(&pos(&[(13, 1), (5, 1)], &[(7, 1), (4, 1)]));
    assert_eq!(f.blots_mine, 2);
    assert_eq!(f.direct_shots_on_me, 28);
    assert_eq!(f.indirect_shots_on_me, 5);
}

#[test]
fn primes_are_the_longest_run_of_made_points() {
    let f = extract(&pos(
        &[(4, 2), (5, 2), (6, 2), (7, 2), (8, 2), (9, 2)],
        &[(16, 2), (17, 2), (18, 2)],
    ));
    assert_eq!(f.prime_len_mine, 6);
    assert_eq!(f.prime_len_theirs, 3);
    assert_eq!(f.points_made_mine, 6);
    assert_eq!(f.points_made_theirs, 3);
    // A gap breaks the prime.
    let f = extract(&pos(&[(4, 2), (5, 2), (7, 2), (8, 2), (9, 2)], &[]));
    assert_eq!(f.prime_len_mine, 3);
    assert_eq!(f.prime_len_theirs, 0);
}

#[test]
fn counts_of_anchors_home_points_back_checkers_bar_and_off() {
    let p = pos(
        &[(BAR, 2), (24, 1), (22, 2), (6, 3), (5, 2), (8, 4)],
        &[(3, 2), (1, 1), (19, 2), (21, 3), (13, 5)],
    );
    let f = extract(&p);
    assert_eq!(f.bar_mine, 2);
    assert_eq!(f.off_mine, 1);
    assert_eq!(f.off_theirs, 2);
    assert_eq!(f.blots_mine, 1);
    assert_eq!(f.blots_theirs, 1);
    assert_eq!(f.anchors_mine, 1);
    assert_eq!(f.checkers_back_mine, 3);
    assert_eq!(f.checkers_back_theirs, 3);
    assert_eq!(f.home_board_points_mine, 2);
    assert_eq!(f.home_board_points_theirs, 2);
    assert_eq!(f.points_made_mine, 4);
    assert_eq!(f.points_made_theirs, 4);
    assert_eq!((f.pips_mine, f.pips_theirs), p.pips());
}

#[test]
fn side_counts_swap_under_flip() {
    let p = pos(
        &[(BAR, 2), (24, 1), (22, 2), (6, 3), (5, 2), (8, 4)],
        &[(3, 2), (1, 1), (19, 2), (21, 3), (13, 5)],
    );
    let f = extract(&p);
    let g = extract(&p.flip());
    assert_eq!((g.pips_mine, g.pips_theirs), (f.pips_theirs, f.pips_mine));
    assert_eq!(
        (g.blots_mine, g.blots_theirs),
        (f.blots_theirs, f.blots_mine)
    );
    assert_eq!(
        (g.points_made_mine, g.points_made_theirs),
        (f.points_made_theirs, f.points_made_mine)
    );
    assert_eq!(
        (g.prime_len_mine, g.prime_len_theirs),
        (f.prime_len_theirs, f.prime_len_mine)
    );
    assert_eq!(
        (g.home_board_points_mine, g.home_board_points_theirs),
        (f.home_board_points_theirs, f.home_board_points_mine)
    );
    assert_eq!(
        (g.checkers_back_mine, g.checkers_back_theirs),
        (f.checkers_back_theirs, f.checkers_back_mine)
    );
    assert_eq!((g.bar_mine, g.bar_theirs), (f.bar_theirs, f.bar_mine));
    assert_eq!((g.off_mine, g.off_theirs), (f.off_theirs, f.off_mine));
}

#[test]
fn features_serialise_in_camel_case() {
    let f = extract(&Position::from_board(&Board::opening(), Player::White));
    let json = serde_json::to_value(f).expect("serialise");
    assert_eq!(json["pipsMine"], 167);
    assert_eq!(json["directShotsOnMe"], 0);
}
