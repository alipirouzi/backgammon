//! Seed + move-log determinism: a match played through `MatchState` /
//! `GameState` while logging every `Turn` replays to an identical
//! `MatchState`; a tampered record is rejected.

use bg_core::game::{Phase, ResultKind, Rules};
use bg_core::match_play::MatchState;
use bg_core::record::{Record, Turn, replay};
use bg_core::{DiceRng, Play, Player, RulesError};
use rand_chacha::ChaCha8Rng;
use rand_core::{Rng, SeedableRng};

/// Upper bound on logged turns per match; random play terminates long
/// before this, so hitting it means the driver is stuck.
const MAX_TURNS: usize = 100_000;

/// Plays a whole match with random (legal) decisions. Dice come only from
/// the seeded `DiceRng`; every choice comes from a separate generator so the
/// dice stream is exactly the one `replay` re-derives from `seed`.
fn play_match(
    seed: u64,
    length: u8,
    rules: Rules,
    choice_seed: u64,
) -> (MatchState, Record, usize) {
    let mut dice_rng = DiceRng::from_seed(seed);
    let mut pick = ChaCha8Rng::seed_from_u64(choice_seed);
    let mut choose = |n: usize| -> usize { (pick.next_u32() as usize) % n };
    let mut m = MatchState::new(length, rules);
    let mut record = Record::new(seed, length, rules);
    let mut games = 0usize;

    while record.turns.len() < MAX_TURNS {
        match m.game.phase {
            Phase::OpeningRoll => {
                let d = m.game.opening_roll(&mut dice_rng);
                record.turns.push(Turn::roll(m.game.on_roll.unwrap(), d));
            }
            Phase::ToRoll => {
                let p = m.game.on_roll.unwrap();
                if m.cube_allowed() && m.game.can_double() && choose(6) == 0 {
                    m.game.double().unwrap();
                    record.turns.push(Turn::double(p));
                } else if choose(150) == 0 {
                    let kind = [
                        ResultKind::Single,
                        ResultKind::Gammon,
                        ResultKind::Backgammon,
                    ][choose(3)];
                    m.game.resign(kind).unwrap();
                    let points = m.game.result.unwrap().points;
                    record.turns.push(Turn::resign(p, points));
                } else {
                    let d = m.game.roll(&mut dice_rng).unwrap();
                    record.turns.push(Turn::roll(p, d));
                }
            }
            Phase::Doubled => {
                let taker = m.game.on_roll.unwrap().opponent();
                if choose(3) == 0 {
                    m.game.drop().unwrap();
                    record.turns.push(Turn::drop(taker));
                } else {
                    m.game.take().unwrap();
                    record.turns.push(Turn::take(taker));
                }
            }
            Phase::ToMove => {
                let p = m.game.on_roll.unwrap();
                let d = m.game.dice.unwrap();
                let plays = m.game.legal_plays();
                let chosen = if plays.is_empty() {
                    Play::empty()
                } else {
                    plays[choose(plays.len())].clone()
                };
                m.game.play(&chosen).unwrap();
                record.turns.push(Turn::mv(p, d, &chosen));
            }
            Phase::Finished => {
                games += 1;
                if m.finish_game().is_some() {
                    return (m, record, games);
                }
            }
        }
    }
    panic!("match did not finish within {MAX_TURNS} turns");
}

const MATCHES: [(u64, u8, u64); 9] = [
    (1, 7, 100),
    (2, 5, 200),
    (3, 3, 300),
    (4, 1, 400),
    (0xDEAD_BEEF, 11, 500),
    (5, 0, 600),
    (6, 9, 700),
    (7, 7, 800),
    (8, 5, 900),
];

fn rules_for(length: u8) -> Rules {
    if length == 0 {
        Rules::money()
    } else {
        Rules::match_play()
    }
}

#[test]
fn replay_reproduces_the_final_match_state_of_seeded_random_matches() {
    let mut games = 0;
    let mut cube_turns = 0;
    let mut resignations = 0;
    for (seed, length, choice_seed) in MATCHES {
        let (live, record, n) = play_match(seed, length, rules_for(length), choice_seed);
        games += n;
        cube_turns += record
            .turns
            .iter()
            .filter(|t| t.action == bg_core::record::Action::Take)
            .count();
        resignations += record
            .turns
            .iter()
            .filter(|t| t.action == bg_core::record::Action::Resign)
            .count();
        assert!(live.is_over(), "driver stops when the match is over");

        let replayed = replay(&record).unwrap();
        assert_eq!(replayed, live, "seed {seed} length {length}");
        assert_eq!(
            serde_json::to_value(&replayed).unwrap(),
            serde_json::to_value(&live).unwrap()
        );

        // Through JSON as well: the record on the wire replays identically.
        let wire = serde_json::to_string(&record).unwrap();
        let parsed: Record = serde_json::from_str(&wire).unwrap();
        assert_eq!(parsed, record);
        assert_eq!(replay(&parsed).unwrap(), live);
    }
    assert!(games >= 20, "expected at least 20 games, played {games}");
    assert!(cube_turns > 0, "expected some cube action to be exercised");
    assert!(
        resignations > 0,
        "expected some resignations to be exercised"
    );
}

#[test]
fn replay_is_deterministic_across_runs() {
    let (_, record, _) = play_match(77, 5, Rules::match_play(), 7);
    let a = replay(&record).unwrap();
    let b = replay(&record).unwrap();
    assert_eq!(a, b);
    // A partial record replays to the state after those turns.
    let mut partial = record.clone();
    partial.turns.truncate(5);
    let mid = replay(&partial).unwrap();
    assert!(!mid.is_over());
}

#[test]
fn replay_rejects_a_tampered_play() {
    let (_, record, _) = play_match(1, 7, Rules::match_play(), 100);
    // Three identical moves can never be legal with a non-double roll.
    let i = record
        .turns
        .iter()
        .position(|t| {
            t.action == bg_core::record::Action::Move && t.dice.is_some_and(|d| !d.is_double())
        })
        .unwrap();
    let mut tampered = record.clone();
    tampered.turns[i].play = Some("6/1(3)".to_owned());
    assert!(matches!(replay(&tampered), Err(RulesError::IllegalPlay(_))));
    // A play that does not parse.
    let mut tampered = record.clone();
    tampered.turns[i].play = Some("nonsense".to_owned());
    assert!(matches!(replay(&tampered), Err(RulesError::Parse(_))));
}

#[test]
fn replay_rejects_a_tampered_roll_or_player() {
    let (_, record, _) = play_match(2, 5, Rules::match_play(), 200);
    let i = record
        .turns
        .iter()
        .position(|t| t.action == bg_core::record::Action::Roll)
        .unwrap();
    let mut tampered = record.clone();
    let d = tampered.turns[i].dice.unwrap();
    tampered.turns[i].dice = Some(bg_core::Dice::new(if d.hi == 6 { 1 } else { 6 }, d.lo).unwrap());
    assert!(matches!(replay(&tampered), Err(RulesError::Parse(_))));

    let mut tampered = record.clone();
    tampered.turns[i].player = tampered.turns[i].player.opponent();
    assert!(matches!(replay(&tampered), Err(RulesError::Parse(_))));

    // Extra turns after the match is over are rejected.
    let mut tampered = record.clone();
    tampered.turns.push(Turn::roll(Player::White, d));
    assert!(replay(&tampered).is_err());

    // A roll turn without dice is malformed.
    let mut tampered = record.clone();
    tampered.turns[i].dice = None;
    assert!(matches!(replay(&tampered), Err(RulesError::Parse(_))));
}

/// Records travel through JavaScript (`JSON.parse` rounds integers above
/// 2^53 − 1), so a seed beyond `MAX_SEED` cannot round-trip and `replay`
/// refuses it up front instead of failing later on drifted dice.
#[test]
fn replay_rejects_a_seed_above_max_seed() {
    use bg_core::record::MAX_SEED;
    assert_eq!(
        MAX_SEED,
        (1u64 << 53) - 1,
        "JavaScript's Number.MAX_SAFE_INTEGER"
    );

    let ok = Record::new(MAX_SEED, 0, Rules::money());
    assert!(replay(&ok).is_ok(), "the largest safe seed is accepted");

    for seed in [MAX_SEED + 1, 1u64 << 60, u64::MAX] {
        let bad = Record::new(seed, 0, Rules::money());
        assert!(
            matches!(replay(&bad), Err(RulesError::Parse(_))),
            "seed {seed} must be rejected"
        );
    }
}
