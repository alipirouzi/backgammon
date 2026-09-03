//! The committed test vectors in `engine/vectors/` match the generator and
//! the engine.

use bg_core::moves::legal_plays;
use bg_core::{Board, Dice, Player, Position};

#[path = "../examples/gen_vectors.rs"]
#[allow(dead_code)]
mod gen_vectors;

use gen_vectors::PlayVector;

const PLAYS_JSON: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/plays.json");

/// Opening position × 21 rolls plus 40 random positions × 3 rolls.
const EXPECTED_ENTRIES: usize = 21 + 40 * 3;

/// Frozen by Task 2 (`tests/oracle.rs`): number of legal plays from the
/// opening position for every roll, in `Dice::all()` order.
const OPENING_PLAY_COUNTS: [usize; 21] = [
    42, 15, 75, 16, 17, 73, 14, 18, 17, 52, 8, 8, 9, 9, 4, 10, 14, 14, 14, 7, 11,
];

fn committed_text() -> String {
    std::fs::read_to_string(PLAYS_JSON)
        .unwrap_or_else(|e| panic!("cannot read {PLAYS_JSON}: {e}; regenerate with `cargo run -p bg-core --example gen_vectors -- plays vectors/plays.json`"))
}

fn committed_vectors() -> Vec<PlayVector> {
    serde_json::from_str(&committed_text()).expect("plays.json parses")
}

#[test]
fn committed_plays_json_equals_regenerated_output() {
    assert!(
        committed_text() == gen_vectors::render_plays(),
        "engine/vectors/plays.json is out of date; regenerate with \
         `cargo run -p bg-core --example gen_vectors -- plays vectors/plays.json`"
    );
}

#[test]
fn committed_plays_match_the_engine() {
    let vectors = committed_vectors();
    assert_eq!(vectors.len(), EXPECTED_ENTRIES);
    for (i, v) in vectors.iter().enumerate() {
        v.board
            .validate()
            .unwrap_or_else(|e| panic!("entry {i}: invalid board: {e}"));
        let pos = Position::from_board(&v.board, v.on_roll);
        let expected: Vec<String> = legal_plays(&pos, v.dice)
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(v.plays, expected, "entry {i}: {:?} {:?}", v.on_roll, v.dice);
        assert!(
            !v.plays.is_empty(),
            "entry {i}: a position always has at least the empty play"
        );
        let mut unique = v.plays.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            v.plays.len(),
            "entry {i}: duplicate notations"
        );
    }
}

#[test]
fn first_entries_are_the_opening_position_for_every_roll() {
    let vectors = committed_vectors();
    let opening = Board::opening();
    for (i, (v, dice)) in vectors.iter().zip(Dice::all()).enumerate() {
        assert_eq!(v.board, opening, "entry {i}");
        assert_eq!(v.on_roll, Player::White, "entry {i}");
        assert_eq!(v.dice, dice, "entry {i}");
        assert_eq!(v.plays.len(), OPENING_PLAY_COUNTS[i], "entry {i}: {dice:?}");
    }
}

#[test]
fn random_entries_cover_both_players_and_many_positions() {
    let vectors = committed_vectors();
    let random = &vectors[21..];
    assert!(random.iter().any(|v| v.on_roll == Player::White));
    assert!(random.iter().any(|v| v.on_roll == Player::Black));
    let mut boards: Vec<Board> = random.iter().map(|v| v.board).collect();
    boards.dedup();
    assert_eq!(boards.len(), 40, "40 distinct consecutive random positions");
    for chunk in random.chunks(3) {
        assert!(
            chunk
                .iter()
                .all(|v| v.board == chunk[0].board && v.on_roll == chunk[0].on_roll)
        );
    }
}
