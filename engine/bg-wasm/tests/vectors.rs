//! The JSON binding layer reproduces the committed engine vectors
//! (`engine/vectors/plays.json` and `decisions.json`) through the exact
//! string-in/string-out path the WASM and native bindings expose.

use bg_wasm::api;
use serde_json::Value;

const PLAYS_JSON: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/plays.json");
const DECISIONS_JSON: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/decisions.json");

/// `decisions.json` rounds equities to this many decimals (see
/// `bg-bot/examples/gen_decisions.rs`, `EQUITY_DECIMALS`).
const EQUITY_DECIMALS: i32 = 6;

/// In the debug profile every beginner/intermediate entry and every
/// `DEBUG_CLUB_STRIDE`-th club entry is checked (a club decision costs about
/// a second unoptimised); the full run is release-only, like bg-bot's own
/// drift test.
const DEBUG_CLUB_STRIDE: usize = 4;

fn load(path: &str) -> Vec<Value> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    serde_json::from_str(&text).expect("vector file parses as a JSON array")
}

fn round_equity(x: f64) -> f64 {
    let scale = 10f64.powi(EQUITY_DECIMALS);
    (x * scale).round() / scale + 0.0
}

fn notations(plays: &Value) -> Vec<String> {
    plays
        .as_array()
        .expect("array of plays")
        .iter()
        .map(|p| p["notation"].as_str().expect("notation string").to_owned())
        .collect()
}

#[test]
fn legal_plays_reproduce_plays_json() {
    let vectors = load(PLAYS_JSON);
    assert_eq!(vectors.len(), 141);
    for (i, v) in vectors.iter().enumerate() {
        let out = api::legal_plays_json(
            &v["board"].to_string(),
            &v["onRoll"].to_string(),
            &v["dice"].to_string(),
        )
        .unwrap_or_else(|e| panic!("entry {i}: {e}"));
        let plays: Value = serde_json::from_str(&out).expect("legal_plays output parses");
        let expected: Vec<String> = v["plays"]
            .as_array()
            .expect("plays array")
            .iter()
            .map(|s| s.as_str().expect("notation").to_owned())
            .collect();
        assert_eq!(notations(&plays), expected, "entry {i}");
    }
}

#[test]
fn apply_play_reaches_every_legal_position_of_plays_json() {
    let vectors = load(PLAYS_JSON);
    for (i, v) in vectors.iter().enumerate() {
        let board = v["board"].to_string();
        let on_roll = v["onRoll"].to_string();
        let out = api::legal_plays_json(&board, &on_roll, &v["dice"].to_string())
            .unwrap_or_else(|e| panic!("entry {i}: {e}"));
        let plays: Value = serde_json::from_str(&out).expect("legal_plays output parses");
        for play in plays.as_array().expect("array") {
            // The Play object and its notation must apply to the same board.
            let by_object = api::apply_play_json(&board, &on_roll, &play.to_string())
                .unwrap_or_else(|e| panic!("entry {i}, play {play}: {e}"));
            let by_notation = api::apply_play_json(&board, &on_roll, &play["notation"].to_string())
                .unwrap_or_else(|e| panic!("entry {i}, play {play}: {e}"));
            assert_eq!(by_object, by_notation, "entry {i}, play {play}");
        }
    }
}

fn check_decision(i: usize, v: &Value) {
    let out = api::choose_play_json(
        &v["board"].to_string(),
        &v["onRoll"].to_string(),
        &v["dice"].to_string(),
        &v["match"].to_string(),
        &v["level"].to_string(),
        &v["seed"].to_string(),
    )
    .unwrap_or_else(|e| panic!("entry {i}: {e}"));
    let result: Value = serde_json::from_str(&out).expect("choose_play output parses");

    assert_eq!(
        result["play"]["notation"].as_str(),
        v["chosen"].as_str(),
        "entry {i}: chosen play"
    );
    let candidates = result["candidates"].as_array().expect("candidates array");
    let expected = v["candidates"].as_array().expect("expected candidates");
    assert_eq!(
        candidates.len(),
        expected.len(),
        "entry {i}: candidate count"
    );
    for (k, (c, e)) in candidates.iter().zip(expected).enumerate() {
        assert_eq!(
            c["play"]["notation"].as_str(),
            e["notation"].as_str(),
            "entry {i}, candidate {k}: notation"
        );
        let equity = c["equity"].as_f64().expect("equity number");
        let expected_equity = e["equity"].as_f64().expect("expected equity");
        // Exact after rounding (the vectors' stated criterion), bitwise so
        // clippy's float_cmp does not object.
        assert!(
            round_equity(equity).to_bits() == expected_equity.to_bits(),
            "entry {i}, candidate {k}: equity {equity} rounds to {} != {expected_equity}",
            round_equity(equity)
        );
    }
    assert_eq!(
        result["play"], candidates[0]["play"],
        "entry {i}: play is candidates[0]"
    );
}

#[test]
fn choose_play_reproduces_the_cheap_subset_of_decisions_json() {
    let vectors = load(DECISIONS_JSON);
    assert_eq!(vectors.len(), 30);
    let mut checked = 0;
    for (i, v) in vectors.iter().enumerate() {
        let club = v["level"].as_str() == Some("club");
        if club && !i.is_multiple_of(DEBUG_CLUB_STRIDE) {
            continue;
        }
        check_decision(i, v);
        checked += 1;
    }
    assert!(checked >= 15, "checked only {checked} entries");
}

#[test]
#[cfg_attr(
    debug_assertions,
    ignore = "full decision replay is release-only: cargo test --release -p bg-wasm --test vectors -- --include-ignored"
)]
fn choose_play_reproduces_every_entry_of_decisions_json() {
    for (i, v) in load(DECISIONS_JSON).iter().enumerate() {
        check_decision(i, v);
    }
}

#[test]
fn analyze_play_of_the_chosen_play_is_best_for_club_entries() {
    // Analysis always uses the club parameters, so for a club-level entry the
    // chosen play analysed with the same seed is the best play.
    let vectors = load(DECISIONS_JSON);
    let v = vectors
        .iter()
        .enumerate()
        .find(|(i, v)| v["level"].as_str() == Some("club") && i.is_multiple_of(DEBUG_CLUB_STRIDE))
        .map(|(_, v)| v)
        .expect("a club entry");
    let out = api::analyze_play_json(
        &v["board"].to_string(),
        &v["onRoll"].to_string(),
        &v["dice"].to_string(),
        &v["match"].to_string(),
        &v["chosen"].to_string(),
        &v["seed"].to_string(),
    )
    .expect("analyze_play succeeds");
    let analysis: Value = serde_json::from_str(&out).expect("analysis parses");
    assert_eq!(analysis["playedIndex"], 0);
    assert_eq!(analysis["category"], "best");
    assert_eq!(analysis["errorSize"], 0.0);
    assert_eq!(
        analysis["candidates"].as_array().map(Vec::len),
        v["candidates"].as_array().map(Vec::len)
    );
}
