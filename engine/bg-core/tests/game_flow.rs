//! Game and match flow: phases, cube actions, results, scoring, JSON shapes.

use bg_core::game::{Cube, GameResult, GameState, Phase, ResultKind, Rules};
use bg_core::match_play::MatchState;
use bg_core::record::{Action, Record, Turn};
use bg_core::{Board, Dice, DiceRng, Play, Player, RulesError, parse_play};
use serde_json::{Value, json};

fn board(white: &[(usize, u8)], black: &[(usize, u8)]) -> Board {
    fn side(slots: &[(usize, u8)]) -> [u8; 26] {
        let mut a = [0u8; 26];
        for &(i, n) in slots {
            a[i] += n;
        }
        let placed: u8 = a.iter().sum();
        a[25] += 15 - placed;
        a
    }
    let b = Board {
        white: side(white),
        black: side(black),
    };
    b.validate().unwrap();
    b
}

fn to_roll(rules: Rules, p: Player) -> GameState {
    let mut g = GameState::new(rules);
    g.on_roll = Some(p);
    g.phase = Phase::ToRoll;
    g
}

fn json(v: &impl serde::Serialize) -> Value {
    serde_json::to_value(v).unwrap()
}

/// The object's keys, sorted (`serde_json` orders map keys alphabetically).
fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

#[test]
fn rules_defaults_for_money_and_match() {
    assert_eq!(
        Rules::money(),
        Rules {
            jacoby: true,
            beavers: false,
            auto_doubles: false
        }
    );
    assert_eq!(
        Rules::match_play(),
        Rules {
            jacoby: false,
            beavers: false,
            auto_doubles: false
        }
    );
    assert_eq!(Rules::for_length(0), Rules::money());
    assert_eq!(Rules::for_length(7), Rules::match_play());
    assert_eq!(
        json(&Rules::money()),
        json!({ "jacoby": true, "beavers": false, "autoDoubles": false })
    );
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

#[test]
fn new_game_waits_for_the_opening_roll() {
    let g = GameState::new(Rules::money());
    assert_eq!(g.board, Board::opening());
    assert_eq!(g.on_roll, None);
    assert_eq!(g.dice, None);
    assert_eq!(
        g.cube,
        Cube {
            value: 1,
            owner: None
        }
    );
    assert_eq!(g.phase, Phase::OpeningRoll);
    assert_eq!(g.result, None);
    assert!(!g.cube_dead);
    assert!(g.legal_plays().is_empty());
    assert!(!g.can_double());
}

#[test]
fn opening_roll_matches_the_seeded_dice_and_picks_the_higher_die() {
    // The opening procedure draws one die for White, then one for Black,
    // re-rolling ties; the winner moves the two numbers.
    let seed = 42;
    let mut expected = DiceRng::from_seed(seed);
    let (w, b) = loop {
        let (w, b) = (expected.roll_one(), expected.roll_one());
        if w != b {
            break (w, b);
        }
    };
    let mut g = GameState::new(Rules::money());
    let mut rng = DiceRng::from_seed(seed);
    let d = g.opening_roll(&mut rng);
    assert_eq!(d, Dice::new(w, b).unwrap());
    assert_eq!(g.dice, Some(d));
    let winner = if w > b { Player::White } else { Player::Black };
    assert_eq!(g.on_roll, Some(winner));
    assert_eq!(g.phase, Phase::ToMove);
    // The generator is left exactly where the reference generator is.
    assert_eq!(rng.roll(), expected.roll());
    // Frozen: seed 42's opening roll and winner. Records replay from the
    // seed, so a change here (draw order, tie handling) breaks stored
    // records, exactly like the frozen `roll_one` sequence in `dice.rs`.
    assert_eq!(d, Dice::new(5, 1).unwrap());
    assert_eq!(g.on_roll, Some(Player::White));
}

/// Finds a seed whose first two single dice are equal (an opening tie).
fn tie_seed() -> u64 {
    (0u64..10_000)
        .find(|&s| {
            let mut r = DiceRng::from_seed(s);
            r.roll_one() == r.roll_one()
        })
        .unwrap()
}

#[test]
fn opening_ties_are_rerolled_and_only_auto_double_when_enabled() {
    let seed = tie_seed();
    let mut g = GameState::new(Rules::money());
    let mut rng = DiceRng::from_seed(seed);
    let d = g.opening_roll(&mut rng);
    assert!(!d.is_double(), "ties are re-rolled");
    assert_eq!(g.cube.value, 1, "auto-doubles are off by default");
    assert_eq!(g.phase, Phase::ToMove);

    let mut g = GameState::new(Rules {
        auto_doubles: true,
        ..Rules::money()
    });
    let mut rng = DiceRng::from_seed(seed);
    g.opening_roll(&mut rng);
    assert_eq!(g.cube.value, 2, "one automatic double per game");
    assert_eq!(g.cube.owner, None, "the cube stays in the middle");
}

#[test]
fn opening_roll_outside_the_opening_phase_changes_nothing() {
    let mut g = to_roll(Rules::money(), Player::White);
    let before = g.clone();
    let mut rng = DiceRng::from_seed(7);
    let untouched = rng.clone();
    let _ = g.opening_roll(&mut rng);
    assert_eq!(g, before);
    let (mut a, mut b) = (rng, untouched);
    assert_eq!(a.roll(), b.roll(), "the generator was not consumed");
}

// ---------------------------------------------------------------------------
// Roll / play
// ---------------------------------------------------------------------------

#[test]
fn roll_requires_to_roll_phase() {
    let mut rng = DiceRng::from_seed(1);
    let mut g = GameState::new(Rules::money());
    assert!(matches!(g.roll(&mut rng), Err(RulesError::WrongPhase(_))));
    let mut g = to_roll(Rules::money(), Player::Black);
    let d = g.roll(&mut rng).unwrap();
    assert_eq!(g.dice, Some(d));
    assert_eq!(g.phase, Phase::ToMove);
    assert!(matches!(g.roll(&mut rng), Err(RulesError::WrongPhase(_))));
}

#[test]
fn play_validates_switches_turn_and_moves_to_to_roll() {
    let mut g = to_roll(Rules::money(), Player::Black);
    g.dice = Some(Dice::new(3, 1).unwrap());
    g.phase = Phase::ToMove;
    let plays = g.legal_plays();
    assert!(plays.iter().any(|p| p.to_string() == "8/5 6/5"));
    assert!(matches!(
        g.play(&parse_play("8/5 6/4").unwrap()),
        Err(RulesError::IllegalPlay(_))
    ));
    assert_eq!(g.phase, Phase::ToMove, "a rejected play changes nothing");
    g.play(&parse_play("8/5 6/5").unwrap()).unwrap();
    // Black's 8/5 6/5 in absolute terms: 17→20 and 19→20.
    assert_eq!(g.board.black[20], 2);
    assert_eq!(g.board.black[17], 2);
    assert_eq!(g.board.black[19], 4);
    assert_eq!(g.on_roll, Some(Player::White));
    assert_eq!(g.dice, None);
    assert_eq!(g.phase, Phase::ToRoll);
    assert!(matches!(
        g.play(&Play::empty()),
        Err(RulesError::WrongPhase(_))
    ));
}

#[test]
fn no_legal_move_gives_empty_list_and_accepts_the_empty_play() {
    // White on the bar against a closed board.
    let mut g = to_roll(Rules::money(), Player::White);
    g.board = board(
        &[(0, 1), (13, 5), (8, 3), (6, 5)],
        &[(19, 2), (20, 2), (21, 2), (22, 2), (23, 2), (24, 2)],
    );
    g.dice = Some(Dice::new(6, 3).unwrap());
    g.phase = Phase::ToMove;
    assert!(g.legal_plays().is_empty());
    assert!(matches!(
        g.play(&parse_play("13/7").unwrap()),
        Err(RulesError::IllegalPlay(_))
    ));
    g.play(&Play::empty()).unwrap();
    assert_eq!(g.on_roll, Some(Player::Black));
    assert_eq!(g.phase, Phase::ToRoll);
}

#[test]
fn finishing_move_sets_result_and_ends_the_game() {
    let mut g = to_roll(Rules::match_play(), Player::White);
    g.board = board(&[(2, 1), (1, 1)], &[(19, 14), (25, 1)]);
    g.dice = Some(Dice::new(2, 1).unwrap());
    g.phase = Phase::ToMove;
    g.play(&parse_play("2/off 1/off").unwrap()).unwrap();
    assert_eq!(g.phase, Phase::Finished);
    assert_eq!(
        g.result,
        Some(GameResult {
            winner: Player::White,
            kind: ResultKind::Single,
            points: 1
        })
    );
    assert_eq!(g.on_roll, None);
    assert_eq!(g.dice, None);
    assert!(g.legal_plays().is_empty());
    assert!(!g.can_double());
    let mut rng = DiceRng::from_seed(3);
    assert!(matches!(g.roll(&mut rng), Err(RulesError::WrongPhase(_))));
    assert!(matches!(g.double(), Err(RulesError::WrongPhase(_))));
    assert!(matches!(
        g.resign(ResultKind::Single),
        Err(RulesError::WrongPhase(_))
    ));
}

// ---------------------------------------------------------------------------
// Cube
// ---------------------------------------------------------------------------

#[test]
fn can_double_only_before_rolling_with_access_to_the_cube() {
    let mut g = to_roll(Rules::money(), Player::White);
    assert!(g.can_double());
    g.cube.owner = Some(Player::Black);
    assert!(!g.can_double());
    g.cube.owner = Some(Player::White);
    assert!(g.can_double());
    g.cube.owner = None;
    g.cube.value = 64;
    assert!(!g.can_double(), "64 is the largest cube value");
    g.cube.value = 32;
    assert!(g.can_double());
    g.cube_dead = true;
    assert!(!g.can_double());
    g.cube_dead = false;
    g.phase = Phase::ToMove;
    g.dice = Some(Dice::new(3, 1).unwrap());
    assert!(!g.can_double());
}

#[test]
fn double_take_flow() {
    let mut g = to_roll(Rules::money(), Player::White);
    g.double().unwrap();
    assert_eq!(g.phase, Phase::Doubled);
    assert_eq!(g.on_roll, Some(Player::White));
    assert_eq!(g.cube.value, 1, "the cube turns only on a take");
    assert!(matches!(g.double(), Err(RulesError::WrongPhase(_))));
    let mut rng = DiceRng::from_seed(9);
    assert!(matches!(g.roll(&mut rng), Err(RulesError::WrongPhase(_))));
    g.take().unwrap();
    assert_eq!(
        g.cube,
        Cube {
            value: 2,
            owner: Some(Player::Black)
        }
    );
    assert_eq!(g.phase, Phase::ToRoll);
    assert_eq!(g.on_roll, Some(Player::White), "the doubler rolls");
    assert!(!g.can_double(), "Black owns the cube now");
    assert!(matches!(g.double(), Err(RulesError::NotAllowed(_))));
    // Redouble by the owner on his turn.
    g.on_roll = Some(Player::Black);
    assert!(g.can_double());
    g.double().unwrap();
    g.take().unwrap();
    assert_eq!(
        g.cube,
        Cube {
            value: 4,
            owner: Some(Player::White)
        }
    );
}

#[test]
fn drop_awards_the_cube_value_as_a_single_game() {
    let mut g = to_roll(Rules::money(), Player::Black);
    g.cube = Cube {
        value: 4,
        owner: Some(Player::Black),
    };
    g.double().unwrap();
    g.drop().unwrap();
    assert_eq!(g.phase, Phase::Finished);
    assert_eq!(
        g.result,
        Some(GameResult {
            winner: Player::Black,
            kind: ResultKind::Single,
            points: 4
        })
    );
    assert_eq!(g.cube.value, 4, "a dropped double is not turned");
    let mut g = to_roll(Rules::money(), Player::Black);
    assert!(matches!(g.take(), Err(RulesError::WrongPhase(_))));
    assert!(matches!(g.drop(), Err(RulesError::WrongPhase(_))));
    assert!(matches!(g.beaver(), Err(RulesError::WrongPhase(_))));
}

// ---------------------------------------------------------------------------
// Resignation
// ---------------------------------------------------------------------------

#[test]
fn resignation_by_the_player_on_roll() {
    let mut g = to_roll(Rules::match_play(), Player::White);
    g.cube = Cube {
        value: 2,
        owner: Some(Player::White),
    };
    g.resign(ResultKind::Gammon).unwrap();
    assert_eq!(g.phase, Phase::Finished);
    assert_eq!(
        g.result,
        Some(GameResult {
            winner: Player::Black,
            kind: ResultKind::Gammon,
            points: 4
        })
    );
    // Jacoby: a resigned gammon with the cube centred pays a single game.
    let mut g = to_roll(Rules::money(), Player::White);
    g.resign(ResultKind::Backgammon).unwrap();
    assert_eq!(
        g.result,
        Some(GameResult {
            winner: Player::Black,
            kind: ResultKind::Single,
            points: 1
        })
    );
    // Allowed while a double is pending (the doubler resigns instead of
    // waiting for the answer) and while on move.
    let mut g = to_roll(Rules::money(), Player::Black);
    g.double().unwrap();
    g.resign(ResultKind::Single).unwrap();
    assert_eq!(g.result.unwrap().winner, Player::White);
    let mut g = GameState::new(Rules::money());
    assert!(matches!(
        g.resign(ResultKind::Single),
        Err(RulesError::WrongPhase(_))
    ));
}

// ---------------------------------------------------------------------------
// Match state
// ---------------------------------------------------------------------------

#[test]
fn match_state_new_away_and_is_over() {
    let m = MatchState::new(7, Rules::match_play());
    assert_eq!(m.length, 7);
    assert_eq!(m.score, [0, 0]);
    assert!(!m.crawford && !m.post_crawford);
    assert_eq!(m.game.phase, Phase::OpeningRoll);
    assert_eq!(m.away(Player::White), 7);
    assert_eq!(m.away(Player::Black), 7);
    assert_eq!(m.score_of(Player::White), 0);
    assert!(m.cube_allowed());
    assert!(!m.is_over());
    let money = MatchState::new(0, Rules::money());
    assert_eq!(money.away(Player::White), 0);
    assert!(!money.is_over());
}

fn finished(m: &mut MatchState, winner: Player, kind: ResultKind, points: u8) {
    m.game.phase = Phase::Finished;
    m.game.on_roll = None;
    m.game.dice = None;
    m.game.result = Some(GameResult {
        winner,
        kind,
        points,
    });
}

#[test]
fn finish_game_is_a_no_op_until_the_game_is_finished() {
    let mut m = MatchState::new(5, Rules::match_play());
    let before = m.clone();
    assert_eq!(m.finish_game(), None);
    assert_eq!(m, before);
}

#[test]
fn finish_game_scores_and_starts_the_next_game_until_the_match_is_won() {
    let mut m = MatchState::new(5, Rules::match_play());
    finished(&mut m, Player::Black, ResultKind::Gammon, 4);
    assert_eq!(m.finish_game(), None);
    assert_eq!(m.score, [0, 4]);
    assert_eq!(m.away(Player::Black), 1);
    assert!(m.crawford);
    assert_eq!(m.game.phase, Phase::OpeningRoll, "a fresh game starts");
    assert_eq!(m.game.cube.value, 1);
    assert!(m.game.cube_dead);
    finished(&mut m, Player::White, ResultKind::Single, 1);
    assert_eq!(m.finish_game(), None);
    assert!(!m.crawford && m.post_crawford);
    assert!(!m.game.cube_dead);
    // Points beyond the match length still end it.
    finished(&mut m, Player::Black, ResultKind::Backgammon, 3);
    assert_eq!(m.finish_game(), Some(Player::Black));
    assert_eq!(m.score, [1, 7]);
    assert!(m.is_over());
    assert_eq!(m.game.phase, Phase::Finished, "the last game is kept");
    assert_eq!(m.away(Player::Black), 0);
}

#[test]
fn finish_game_is_idempotent_once_the_match_is_over() {
    let mut m = MatchState::new(3, Rules::match_play());
    finished(&mut m, Player::Black, ResultKind::Backgammon, 3);
    assert_eq!(m.finish_game(), Some(Player::Black));
    let after = m.clone();
    assert_eq!(m.finish_game(), Some(Player::Black));
    assert_eq!(m, after, "a second call changes nothing");
    assert_eq!(m.score, [0, 3]);

    let mut money = MatchState::new(0, Rules::money());
    finished(&mut money, Player::White, ResultKind::Single, 2);
    assert_eq!(money.finish_game(), Some(Player::White));
    assert_eq!(money.finish_game(), Some(Player::White));
    assert_eq!(money.score, [2, 0]);
}

#[test]
fn money_game_is_a_single_game() {
    let mut m = MatchState::new(0, Rules::money());
    finished(&mut m, Player::White, ResultKind::Gammon, 4);
    assert_eq!(m.finish_game(), Some(Player::White));
    assert_eq!(m.score, [4, 0]);
    assert!(m.is_over());
    assert!(!m.crawford);
    assert_eq!(m.game.phase, Phase::Finished);
}

#[test]
fn one_point_match_has_no_crawford_game() {
    let mut m = MatchState::new(1, Rules::match_play());
    finished(&mut m, Player::White, ResultKind::Single, 1);
    assert_eq!(m.finish_game(), Some(Player::White));
    assert!(!m.crawford && !m.post_crawford);
}

// ---------------------------------------------------------------------------
// JSON shapes (binding, see the engine plan)
// ---------------------------------------------------------------------------

#[test]
fn game_state_json_shape() {
    let g = GameState::new(Rules::money());
    let v = json(&g);
    assert_eq!(v["board"], json(&Board::opening()));
    assert_eq!(v["onRoll"], Value::Null);
    assert_eq!(v["dice"], Value::Null);
    assert_eq!(v["cube"], json!({ "value": 1, "owner": null }));
    assert_eq!(v["phase"], json!("openingRoll"));
    assert_eq!(v["result"], Value::Null);
    assert_eq!(
        v["rules"],
        json!({ "jacoby": true, "beavers": false, "autoDoubles": false })
    );
    assert_eq!(
        keys(&v),
        [
            "board", "cube", "dice", "onRoll", "phase", "result", "rules"
        ]
    );
    assert_eq!(serde_json::from_value::<GameState>(v).unwrap(), g);

    let mut g = to_roll(Rules::match_play(), Player::White);
    g.cube = Cube {
        value: 2,
        owner: Some(Player::White),
    };
    g.double().unwrap();
    g.drop().unwrap();
    let v = json(&g);
    assert_eq!(v["onRoll"], Value::Null);
    assert_eq!(v["cube"], json!({ "value": 2, "owner": "white" }));
    assert_eq!(v["phase"], json!("finished"));
    assert_eq!(
        v["result"],
        json!({ "winner": "white", "kind": "single", "points": 2 })
    );
    for (phase, name) in [
        (Phase::OpeningRoll, "openingRoll"),
        (Phase::ToRoll, "toRoll"),
        (Phase::Doubled, "doubled"),
        (Phase::ToMove, "toMove"),
        (Phase::Finished, "finished"),
    ] {
        assert_eq!(json(&phase), json!(name));
    }
    for (kind, name) in [
        (ResultKind::Single, "single"),
        (ResultKind::Gammon, "gammon"),
        (ResultKind::Backgammon, "backgammon"),
    ] {
        assert_eq!(json(&kind), json!(name));
    }
}

#[test]
fn match_state_json_shape_and_round_trip() {
    let mut m = MatchState::new(7, Rules::match_play());
    m.score = [3, 1];
    let v = json(&m);
    assert_eq!(v["length"], json!(7));
    assert_eq!(v["score"], json!({ "white": 3, "black": 1 }));
    assert_eq!(v["crawford"], json!(false));
    assert_eq!(v["postCrawford"], json!(false));
    assert_eq!(v["game"], json(&m.game));
    assert_eq!(
        keys(&v),
        ["crawford", "game", "length", "postCrawford", "score"]
    );
    assert_eq!(serde_json::from_value::<MatchState>(v).unwrap(), m);

    // A Crawford match round-trips with the cube still dead.
    finished(&mut m, Player::White, ResultKind::Backgammon, 3);
    assert_eq!(m.finish_game(), None);
    assert!(m.crawford && m.game.cube_dead);
    let back: MatchState = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
    assert_eq!(back, m);
    assert!(back.game.cube_dead);
}

#[test]
fn turn_and_record_json_shapes() {
    let dice = Dice::new(6, 3).unwrap();
    let mv = Turn::mv(Player::White, dice, &parse_play("24/18 13/10").unwrap());
    assert_eq!(
        json(&mv),
        json!({
            "player": "white", "dice": { "hi": 6, "lo": 3 }, "action": "move",
            "play": "24/18 13/10", "resignPoints": null
        })
    );
    assert_eq!(
        json(&Turn::roll(Player::Black, dice)),
        json!({
            "player": "black", "dice": { "hi": 6, "lo": 3 }, "action": "roll",
            "play": null, "resignPoints": null
        })
    );
    assert_eq!(
        json(&Turn::resign(Player::Black, 2)),
        json!({
            "player": "black", "dice": null, "action": "resign",
            "play": null, "resignPoints": 2
        })
    );
    for (t, name) in [
        (Turn::double(Player::White), "double"),
        (Turn::take(Player::Black), "take"),
        (Turn::drop(Player::Black), "drop"),
    ] {
        assert_eq!(json(&t)["action"], json!(name));
    }
    for (a, name) in [
        (Action::Roll, "roll"),
        (Action::Move, "move"),
        (Action::Double, "double"),
        (Action::Take, "take"),
        (Action::Drop, "drop"),
        (Action::Resign, "resign"),
    ] {
        assert_eq!(json(&a), json!(name));
    }
    let mut r = Record::new(123_456_789, 7, Rules::match_play());
    r.turns.push(Turn::roll(Player::White, dice));
    r.turns.push(mv.clone());
    let v = json(&r);
    assert_eq!(v["seed"], json!(123_456_789_u64));
    assert_eq!(v["length"], json!(7));
    assert_eq!(v["rules"], json(&Rules::match_play()));
    assert_eq!(v["turns"].as_array().unwrap().len(), 2);
    assert_eq!(keys(&v), ["length", "rules", "seed", "turns"]);
    assert_eq!(serde_json::from_value::<Record>(v).unwrap(), r);
    // A `u64` seed above 2^53 survives the Rust-side serde round trip; it
    // would not survive JavaScript's `JSON.parse`, so `replay` refuses it
    // (see `bg_core::record::MAX_SEED` and `tests/replay.rs`).
    let r = Record::new(u64::MAX, 0, Rules::money());
    let back: Record = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
    assert_eq!(back.seed, u64::MAX);
}
