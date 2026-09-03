//! Notation: `Display` for `Play`, `parse_play`, and the JSON shape of `Play`
//! (`{ "moves": [...], "notation": "..." }`).

use bg_core::notation::parse_play;
use bg_core::{Board, Dice, DiceRng, Move, Play, Player, Position, RulesError};
use serde_json::json;

const fn mv(from: u8, to: u8, hit: bool) -> Move {
    Move { from, to, hit }
}

fn play(moves: &[Move]) -> Play {
    Play {
        moves: moves.to_vec(),
    }
}

// ---------------------------------------------------------------------------
// Golden formatting (plan §"Notation" examples)
// ---------------------------------------------------------------------------

#[test]
fn formats_two_plain_moves() {
    let p = play(&[mv(24, 18, false), mv(13, 10, false)]);
    assert_eq!(p.to_string(), "24/18 13/10");
}

#[test]
fn formats_bar_entry_with_hit() {
    let p = play(&[mv(25, 22, true), mv(6, 2, false)]);
    assert_eq!(p.to_string(), "bar/22* 6/2");
}

#[test]
fn collapses_identical_consecutive_moves() {
    let p = play(&[
        mv(8, 4, false),
        mv(8, 4, false),
        mv(6, 2, false),
        mv(6, 2, false),
    ]);
    assert_eq!(p.to_string(), "8/4(2) 6/2(2)");
}

#[test]
fn formats_bear_off() {
    let p = play(&[mv(6, 0, false), mv(5, 0, false)]);
    assert_eq!(p.to_string(), "6/off 5/off");
}

#[test]
fn collapses_hitting_group_only_when_both_hit() {
    assert_eq!(
        play(&[mv(13, 7, true), mv(13, 7, true)]).to_string(),
        "13/7*(2)"
    );
    assert_eq!(
        play(&[mv(13, 7, true), mv(13, 7, false)]).to_string(),
        "13/7* 13/7"
    );
}

#[test]
fn does_not_collapse_non_consecutive_repeats() {
    let p = play(&[mv(13, 7, false), mv(6, 2, false), mv(13, 7, false)]);
    assert_eq!(p.to_string(), "13/7 6/2 13/7");
}

#[test]
fn collapses_four_identical_moves() {
    let p = play(&[mv(6, 3, false); 4]);
    assert_eq!(p.to_string(), "6/3(4)");
}

#[test]
fn empty_play_formats_as_empty_string() {
    assert_eq!(Play::empty().to_string(), "");
}

#[test]
fn does_not_reorder_moves() {
    let p = play(&[mv(6, 2, false), mv(13, 7, false)]);
    assert_eq!(p.to_string(), "6/2 13/7");
}

// ---------------------------------------------------------------------------
// Golden parsing
// ---------------------------------------------------------------------------

#[test]
fn parses_golden_examples() {
    assert_eq!(
        parse_play("24/18 13/10").unwrap(),
        play(&[mv(24, 18, false), mv(13, 10, false)])
    );
    assert_eq!(
        parse_play("bar/22* 6/2").unwrap(),
        play(&[mv(25, 22, true), mv(6, 2, false)])
    );
    assert_eq!(
        parse_play("8/4(2) 6/2(2)").unwrap(),
        play(&[
            mv(8, 4, false),
            mv(8, 4, false),
            mv(6, 2, false),
            mv(6, 2, false)
        ])
    );
    assert_eq!(
        parse_play("6/off 5/off").unwrap(),
        play(&[mv(6, 0, false), mv(5, 0, false)])
    );
    assert_eq!(
        parse_play("13/7*(2)").unwrap(),
        play(&[mv(13, 7, true), mv(13, 7, true)])
    );
    assert_eq!(parse_play("").unwrap(), Play::empty());
}

#[test]
fn parse_is_whitespace_tolerant() {
    assert_eq!(parse_play("   ").unwrap(), Play::empty());
    assert_eq!(
        parse_play("  24/18 \t 13/10\n").unwrap(),
        play(&[mv(24, 18, false), mv(13, 10, false)])
    );
}

#[test]
fn parse_accepts_case_insensitive_bar_and_off() {
    assert_eq!(
        parse_play("Bar/22 BAR/20").unwrap(),
        play(&[mv(25, 22, false), mv(25, 20, false)])
    );
    assert_eq!(
        parse_play("6/Off 4/OFF").unwrap(),
        play(&[mv(6, 0, false), mv(4, 0, false)])
    );
}

#[test]
fn parse_accepts_explicit_count_of_one() {
    assert_eq!(parse_play("13/7(1)").unwrap(), play(&[mv(13, 7, false)]));
}

#[test]
fn parse_implements_from_str() {
    let p: Play = "24/18 13/10".parse().unwrap();
    assert_eq!(p, play(&[mv(24, 18, false), mv(13, 10, false)]));
}

fn assert_parse_error(s: &str) {
    match parse_play(s) {
        Err(RulesError::Parse(_)) => {}
        other => panic!("expected Parse error for {s:?}, got {other:?}"),
    }
}

#[test]
fn parse_rejects_malformed_tokens() {
    assert_parse_error("24");
    assert_parse_error("24/");
    assert_parse_error("/18");
    assert_parse_error("24-18");
    assert_parse_error("24/18/13");
    assert_parse_error("24/18**");
    assert_parse_error("24/18(");
    assert_parse_error("24/18(2");
    assert_parse_error("24/18(x)");
    assert_parse_error("24/18(0)");
    assert_parse_error("24/18(5)");
    assert_parse_error("24/18 (2)");
    assert_parse_error("foo/18");
    assert_parse_error("24/bar");
    assert_parse_error("off/18");
}

#[test]
fn parse_rejects_out_of_range_points() {
    assert_parse_error("0/1");
    assert_parse_error("26/20");
    assert_parse_error("25/25");
    assert_parse_error("24/24");
    assert_parse_error("24/25");
    assert_parse_error("13/300");
}

#[test]
fn parse_rejects_impossible_distances() {
    // A move never goes backwards or stays put ...
    assert_parse_error("18/24");
    assert_parse_error("18/18");
    // ... and never covers more than a single die (6 pips).
    assert_parse_error("24/17");
    assert_parse_error("bar/18");
    assert_parse_error("7/off");
}

#[test]
fn parse_rejects_hit_on_bear_off() {
    assert_parse_error("6/off*");
}

#[test]
fn parse_rejects_more_than_four_moves() {
    assert_parse_error("6/3(4) 5/2");
    assert_parse_error("6/3 6/3 6/3 6/3 6/3");
}

// ---------------------------------------------------------------------------
// Hand-constructed round trips
// ---------------------------------------------------------------------------

#[test]
fn round_trips_hand_constructed_plays() {
    let plays = [
        Play::empty(),
        play(&[mv(24, 18, false), mv(13, 10, false)]),
        play(&[mv(25, 22, true), mv(6, 2, false)]),
        play(&[
            mv(8, 4, false),
            mv(8, 4, false),
            mv(6, 2, false),
            mv(6, 2, false),
        ]),
        play(&[mv(6, 0, false), mv(5, 0, false)]),
        play(&[mv(13, 7, true), mv(13, 7, true)]),
        play(&[mv(13, 7, true), mv(13, 7, false)]),
        play(&[mv(13, 7, false), mv(6, 2, false), mv(13, 7, false)]),
        play(&[
            mv(25, 20, false),
            mv(25, 20, false),
            mv(25, 20, false),
            mv(25, 20, false),
        ]),
        play(&[mv(2, 0, false), mv(1, 0, false)]),
    ];
    for p in plays {
        let s = p.to_string();
        assert_eq!(parse_play(&s).unwrap(), p, "round trip of {s:?}");
    }
}

// ---------------------------------------------------------------------------
// JSON shape
// ---------------------------------------------------------------------------

#[test]
fn play_serializes_with_notation_field() {
    let p = play(&[mv(24, 18, false), mv(13, 10, false)]);
    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        json!({
            "moves": [
                { "from": 24, "to": 18, "hit": false },
                { "from": 13, "to": 10, "hit": false }
            ],
            "notation": "24/18 13/10"
        })
    );
    assert_eq!(
        serde_json::to_value(Play::empty()).unwrap(),
        json!({ "moves": [], "notation": "" })
    );
}

#[test]
fn play_deserializes_from_moves_only() {
    let p: Play = serde_json::from_str(
        r#"{"moves":[{"from":24,"to":18,"hit":false},{"from":13,"to":10,"hit":false}]}"#,
    )
    .unwrap();
    assert_eq!(p, play(&[mv(24, 18, false), mv(13, 10, false)]));
    assert_eq!(
        serde_json::from_str::<Play>(r#"{"moves":[]}"#).unwrap(),
        Play::empty()
    );
}

#[test]
fn play_deserializes_when_notation_matches_moves() {
    let v = json!({
        "moves": [{ "from": 25, "to": 22, "hit": true }, { "from": 6, "to": 2, "hit": false }],
        "notation": "bar/22* 6/2"
    });
    assert_eq!(
        serde_json::from_value::<Play>(v).unwrap(),
        play(&[mv(25, 22, true), mv(6, 2, false)])
    );
    let v = json!({ "moves": [], "notation": null });
    assert_eq!(serde_json::from_value::<Play>(v).unwrap(), Play::empty());
}

#[test]
fn play_deserialize_rejects_notation_that_disagrees_with_moves() {
    let v = json!({
        "moves": [{ "from": 24, "to": 18, "hit": false }],
        "notation": "24/18 13/10"
    });
    assert!(serde_json::from_value::<Play>(v).is_err());
    let v = json!({ "moves": [], "notation": "not a play" });
    assert!(serde_json::from_value::<Play>(v).is_err());
}

#[test]
fn play_deserialize_requires_moves() {
    assert!(serde_json::from_str::<Play>(r#"{"notation":"24/18"}"#).is_err());
    assert!(serde_json::from_str::<Play>("{}").is_err());
}

#[test]
fn play_json_round_trips() {
    let p = play(&[mv(13, 7, true), mv(13, 7, true), mv(6, 2, false)]);
    let s = serde_json::to_string(&p).unwrap();
    assert_eq!(serde_json::from_str::<Play>(&s).unwrap(), p);
}

// ---------------------------------------------------------------------------
// Round trip over the legal plays of random positions (depends on Task 2's
// `legal_plays` / `apply`).
// ---------------------------------------------------------------------------

/// `parse(format(p)) == p` and JSON round trip for every legal play of 200
/// positions reached by seeded random play from the opening.
#[test]
fn round_trips_legal_plays_of_random_positions() {
    use bg_core::moves::{apply, legal_plays};

    const POSITIONS: usize = 200;
    let mut rng = DiceRng::from_seed(0xB0A2_D5EE);
    let opening = Position::from_board(&Board::opening(), Player::White);
    let mut pos = opening;
    let mut checked_plays = 0usize;

    for _ in 0..POSITIONS {
        // Game over (someone has all 15 off): restart from the opening.
        if pos.mine[0] == 15 || pos.theirs[0] == 15 {
            pos = opening;
        }
        for dice in Dice::all() {
            for p in legal_plays(&pos, dice) {
                let s = p.to_string();
                assert_eq!(parse_play(&s).unwrap(), p, "notation round trip of {s:?}");
                let j = serde_json::to_string(&p).unwrap();
                assert_eq!(
                    serde_json::from_str::<Play>(&j).unwrap(),
                    p,
                    "json round trip of {j}"
                );
                checked_plays += 1;
            }
        }

        // Advance with a random roll and a random legal play, then hand the
        // turn to the opponent.
        let plays = legal_plays(&pos, rng.roll());
        let next = if plays.is_empty() {
            pos
        } else {
            apply(&pos, &plays[random_index(&mut rng, plays.len())]).unwrap()
        };
        pos = next.flip();
    }
    assert!(
        checked_plays > POSITIONS,
        "expected many plays, got {checked_plays}"
    );
}

/// A pseudo-random index in `0..len` derived from three die rolls (216
/// outcomes, reduced modulo `len`; bias is irrelevant for a coverage walk).
fn random_index(rng: &mut DiceRng, len: usize) -> usize {
    let mut n = 0usize;
    for _ in 0..3 {
        n = n * 6 + usize::from(rng.roll_one() - 1);
    }
    n % len
}
