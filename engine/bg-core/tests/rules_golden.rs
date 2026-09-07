//! Golden tests: one per cited rule. Every test carries the rule text it
//! checks, quoted from <https://www.bkgm.com/rules.html> ("Rules of
//! Backgammon", Backgammon Galore) or from the USBGF Ruling Guide for the
//! USBGF Tournament Rules – 2024
//! (<https://usbgf.org/wp-content/uploads/2024/06/ruling-guide-2025-01.pdf>),
//! and drives the public `GameState` / `MatchState` API rather than the
//! move generator directly.
//!
//! Boards are given in absolute numbering (White on roll, so relative and
//! absolute point numbers coincide): index 0 = bar, 1..=24 = points, 25 = off.

use bg_core::game::{Cube, GameState, Phase, ResultKind, Rules};
use bg_core::match_play::MatchState;
use bg_core::{Board, Dice, Play, Player, RulesError, parse_play};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A board from sparse `(slot, count)` lists; every checker not placed is
/// counted as borne off so `Board::validate` holds.
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

/// A game in `Phase::ToMove` for White with the given board and dice.
fn to_move(rules: Rules, b: Board, dice: (u8, u8)) -> GameState {
    let mut g = GameState::new(rules);
    g.board = b;
    g.on_roll = Some(Player::White);
    g.dice = Some(Dice::new(dice.0, dice.1).unwrap());
    g.phase = Phase::ToMove;
    g
}

fn notations(g: &GameState) -> Vec<String> {
    g.legal_plays().iter().map(ToString::to_string).collect()
}

fn play(s: &str) -> Play {
    parse_play(s).unwrap()
}

fn assert_illegal(g: &GameState, s: &str) {
    let mut g = g.clone();
    assert!(
        matches!(g.play(&play(s)), Err(RulesError::IllegalPlay(_))),
        "{s:?} should be illegal"
    );
}

// ---------------------------------------------------------------------------
// Movement of the Checkers — https://www.bkgm.com/rules.html
// ---------------------------------------------------------------------------

/// "A player must use both numbers of a roll if this is legally possible (or
/// all four numbers of a double)."
/// — <https://www.bkgm.com/rules.html>, "Movement of the Checkers"
#[test]
fn both_dice_must_be_played_when_possible() {
    let g = to_move(Rules::money(), Board::opening(), (6, 5));
    let plays = g.legal_plays();
    assert!(!plays.is_empty());
    assert!(
        plays.iter().all(|p| p.moves.len() == 2),
        "every legal play of 6-5 from the opening uses both dice: {:?}",
        notations(&g)
    );
    assert_illegal(&g, "24/18");
    assert_illegal(&g, "13/8");
    // 6-6 from the opening: 24/18(2) is blocked by nothing but 13/7(2) and
    // 24/18(2) are the natural four; every legal play uses all four numbers.
    let g = to_move(Rules::money(), Board::opening(), (6, 6));
    assert!(g.legal_plays().iter().all(|p| p.moves.len() == 4));
    assert_illegal(&g, "24/18(2)");
}

/// "When only one number can be played, the player must play that number.
/// Or if either number can be played but not both, the player must play the
/// larger one."
/// — <https://www.bkgm.com/rules.html>, "Movement of the Checkers"
#[test]
fn larger_die_must_be_played_when_only_one_can_be() {
    // White's last checker sits on 24; Black owns 13, so 24/18 13 and 24/19 13
    // are both blocked after the first move: either die can be played, not
    // both. The 6 must be played.
    let b = board(&[(24, 1)], &[(13, 2)]);
    let g = to_move(Rules::money(), b, (6, 5));
    assert_eq!(notations(&g), ["24/18"]);
    assert_illegal(&g, "24/19");
    assert_illegal(&g, "");
}

// ---------------------------------------------------------------------------
// Hitting and Entering — https://www.bkgm.com/rules.html
// ---------------------------------------------------------------------------

/// "Any time a player has one or more checkers on the bar, his first
/// obligation is to enter those checker(s) into the opposing home board."
/// — <https://www.bkgm.com/rules.html>, "Hitting and Entering"
#[test]
fn bar_checkers_enter_before_anything_else() {
    // White: one on the bar, others on 13, 8 and 6. Black holds 19 (White's
    // six-point entry), so the 6 cannot enter; the 3 enters on 22 and then
    // the 6 is free for any checker.
    let b = board(&[(0, 1), (13, 5), (8, 3), (6, 5)], &[(19, 2), (1, 2)]);
    let g = to_move(Rules::money(), b, (6, 3));
    let plays = g.legal_plays();
    assert!(!plays.is_empty());
    for p in &plays {
        assert_eq!(p.moves[0].from, 25, "{p} must start by entering");
        assert_eq!(p.moves[0].to, 22, "{p} can only enter with the 3");
    }
    assert!(notations(&g).contains(&"bar/22 13/7".to_owned()));
    assert_illegal(&g, "13/7 8/5");
    assert_illegal(&g, "13/7 bar/22");
}

/// "If a player is able to enter some but not all of his checkers, he must
/// enter as many as he can and then forfeit the remainder of his turn."
/// — <https://www.bkgm.com/rules.html>, "Hitting and Entering"
#[test]
fn partial_entry_forfeits_the_rest_of_the_turn() {
    // Two on the bar, 6-3, Black holds 19: only one checker enters (with the
    // 3), the other stays on the bar so the 6 is forfeited.
    let b = board(&[(0, 2), (13, 5), (8, 3), (6, 5)], &[(19, 2), (1, 2)]);
    let g = to_move(Rules::money(), b, (6, 3));
    assert_eq!(notations(&g), ["bar/22"]);
    assert_illegal(&g, "bar/22 22/16");
    assert_illegal(&g, "bar/22 13/7");
    let mut g = g;
    g.play(&play("bar/22")).unwrap();
    assert_eq!(g.board.white[0], 1, "one checker remains on the bar");
    assert_eq!(g.on_roll, Some(Player::Black));
}

// ---------------------------------------------------------------------------
// Bearing Off — https://www.bkgm.com/rules.html
// ---------------------------------------------------------------------------

/// "If there is no checker on the point indicated by the roll, the player
/// must make a legal move using a checker on a higher-numbered point. If there
/// are no checkers on higher-numbered points, the player is permitted (and
/// required) to remove a checker from the highest point on which one of his
/// checkers resides."
/// — <https://www.bkgm.com/rules.html>, "Bearing Off"
#[test]
fn higher_die_bears_off_from_highest_point_when_nothing_higher() {
    // White: one on 4, one on 2 (13 off). The 6 has no checker and nothing
    // sits above 4, so the 6 bears the 4 off; the 1 moves 2/1 (or 4/3 first,
    // after which the 6 bears off the 3).
    let b = board(&[(4, 1), (2, 1)], &[(24, 2), (12, 5), (17, 3), (19, 5)]);
    let g = to_move(Rules::money(), b, (6, 1));
    // The full legal set: the 6 must bear off the highest checker (from 4,
    // or from 3 after 4/3); `2/off 4/3` is not among them.
    assert_eq!(notations(&g), ["4/3 3/off", "4/off 2/1"]);
    assert_illegal(&g, "2/off 4/3");
    let mut g2 = g.clone();
    g2.play(&play("4/off 2/1")).unwrap();
    assert_eq!(g2.board.white[25], 14);
    assert_eq!(g2.board.white[1], 1);
    // Two checkers on 3, roll 6-5: both bear off from the highest point.
    let b = board(&[(3, 2)], &[(24, 2), (12, 5), (17, 3), (19, 5)]);
    let g = to_move(Rules::money(), b, (6, 5));
    assert_eq!(notations(&g), ["3/off(2)"]);
}

/// "If there is no checker on the point indicated by the roll, the player
/// must make a legal move using a checker on a higher-numbered point."
/// — <https://www.bkgm.com/rules.html>, "Bearing Off"
///
/// The corollary: a die larger than a checker's point may not bear that
/// checker off while a higher point is still occupied.
#[test]
fn cannot_bear_off_lower_checker_with_big_die_while_higher_point_occupied() {
    // White: one on 6, one on 4 (13 off); roll 5-5. The first 5 cannot bear
    // off the 4 (the 6 is higher) and must play 6/1; then 4/off and 1/off.
    let b = board(&[(6, 1), (4, 1)], &[(24, 2), (12, 5), (17, 3), (19, 5)]);
    let g = to_move(Rules::money(), b, (5, 5));
    assert_eq!(notations(&g), ["6/1 4/off 1/off"]);
    // Same resulting position, wrong order: the bear-off comes first while
    // the 6 is still occupied.
    assert_illegal(&g, "4/off 6/1 1/off");
    let mut g2 = g.clone();
    g2.play(&play("6/1 4/off 1/off")).unwrap();
    assert_eq!(g2.phase, Phase::Finished);
}

// ---------------------------------------------------------------------------
// Gammons and Backgammons — https://www.bkgm.com/rules.html
// ---------------------------------------------------------------------------

/// "At the end of the game, if the losing player has borne off at least one
/// checker, he loses only the value showing on the doubling cube (one point,
/// if there have been no doubles). However, if the loser has not borne off
/// any of his checkers, he is gammoned and loses twice the value of the
/// doubling cube. Or, worse, if the loser has not borne off any of his
/// checkers and still has a checker on the bar or in the winner's home board,
/// he is backgammoned and loses three times the value of the doubling cube."
/// — <https://www.bkgm.com/rules.html>, "Gammons and Backgammons"
#[test]
fn single_gammon_and_backgammon_scoring() {
    // Match rules (no Jacoby) so a centred cube still pays gammons. White's
    // last checker is on the ace point and bears off with either die.
    let finish = |black: &[(usize, u8)], cube: Cube| {
        let mut g = to_move(Rules::match_play(), board(&[(1, 1)], black), (2, 1));
        g.cube = cube;
        g.play(&play("1/off")).unwrap();
        assert_eq!(g.phase, Phase::Finished);
        let r = g.result.unwrap();
        assert_eq!(r.winner, Player::White);
        (r.kind, r.points)
    };
    let centred = Cube {
        value: 1,
        owner: None,
    };
    let owned_by_white_at_2 = Cube {
        value: 2,
        owner: Some(Player::White),
    };
    // Loser has borne off one checker: single.
    assert_eq!(
        finish(&[(19, 14), (25, 1)], centred),
        (ResultKind::Single, 1)
    );
    // Loser has none off, all in his own home board: gammon.
    assert_eq!(finish(&[(19, 15)], centred), (ResultKind::Gammon, 2));
    assert_eq!(
        finish(&[(19, 15)], owned_by_white_at_2),
        (ResultKind::Gammon, 4)
    );
    // Loser has none off and a checker in the winner's home board (point 3).
    assert_eq!(
        finish(&[(19, 14), (3, 1)], centred),
        (ResultKind::Backgammon, 3)
    );
    // Loser has none off and a checker on the bar.
    assert_eq!(
        finish(&[(19, 14), (0, 1)], owned_by_white_at_2),
        (ResultKind::Backgammon, 6)
    );
    // A checker in the winner's outer board (point 10) is not a backgammon.
    assert_eq!(
        finish(&[(19, 14), (10, 1)], centred),
        (ResultKind::Gammon, 2)
    );
}

// ---------------------------------------------------------------------------
// Optional Rules — https://www.bkgm.com/rules.html
// ---------------------------------------------------------------------------

/// "The Jacoby Rule. Gammons and backgammons count only as a single game if
/// neither player has offered a double during the course of the game."
/// — <https://www.bkgm.com/rules.html>, "Optional Rules"
#[test]
fn jacoby_rule_reduces_gammons_to_single_when_cube_untouched() {
    let gammon_board = board(&[(1, 1)], &[(19, 14), (0, 1)]); // backgammon on the board
    // Money rules (Jacoby on), cube centred: single, one point.
    let mut g = to_move(Rules::money(), gammon_board, (2, 1));
    assert!(g.rules.jacoby);
    g.play(&play("1/off")).unwrap();
    let r = g.result.unwrap();
    assert_eq!((r.kind, r.points), (ResultKind::Single, 1));
    // Money rules, cube has been turned (owned): the backgammon counts, ×2.
    let mut g = to_move(Rules::money(), gammon_board, (2, 1));
    g.cube = Cube {
        value: 2,
        owner: Some(Player::Black),
    };
    g.play(&play("1/off")).unwrap();
    let r = g.result.unwrap();
    assert_eq!((r.kind, r.points), (ResultKind::Backgammon, 6));
    // An automatic double is not an offered double: cube 2, still centred,
    // Jacoby still applies (single, two points).
    let mut g = to_move(Rules::money(), gammon_board, (2, 1));
    g.cube = Cube {
        value: 2,
        owner: None,
    };
    g.play(&play("1/off")).unwrap();
    let r = g.result.unwrap();
    assert_eq!((r.kind, r.points), (ResultKind::Single, 2));
    // Match rules (Jacoby off), cube centred: full backgammon.
    let mut g = to_move(Rules::match_play(), gammon_board, (2, 1));
    g.play(&play("1/off")).unwrap();
    let r = g.result.unwrap();
    assert_eq!((r.kind, r.points), (ResultKind::Backgammon, 3));
}

/// "Beavers. When a player is doubled, he may immediately redouble (beaver)
/// while retaining possession of the cube."
/// — <https://www.bkgm.com/rules.html>, "Optional Rules"
///
/// Beavers are off by default (spec §4.1): an attempt is `NotAllowed`.
#[test]
fn beavers_are_not_allowed_by_default() {
    let mut g = GameState::new(Rules::money());
    assert!(!g.rules.beavers);
    g.on_roll = Some(Player::White);
    g.phase = Phase::ToRoll;
    g.double().unwrap();
    assert_eq!(g.phase, Phase::Doubled);
    assert_eq!(
        g.beaver(),
        Err(RulesError::NotAllowed("beavers are not allowed"))
    );
    assert_eq!(g.phase, Phase::Doubled, "a refused beaver changes nothing");
    assert_eq!(g.cube.value, 1);

    // With beavers enabled the taker redoubles at once and keeps the cube.
    let mut g = GameState::new(Rules {
        beavers: true,
        ..Rules::money()
    });
    g.on_roll = Some(Player::White);
    g.phase = Phase::ToRoll;
    g.double().unwrap();
    g.beaver().unwrap();
    assert_eq!(g.cube.value, 4);
    assert_eq!(g.cube.owner, Some(Player::Black));
    assert_eq!(g.phase, Phase::ToRoll);
    assert_eq!(g.on_roll, Some(Player::White), "the original doubler rolls");
}

/// A beaver is a redouble, so it is refused where a double would be: the
/// cube may not go past [`bg_core::game::MAX_CUBE`]. The same cap that makes
/// `double()` fail at 64 makes `beaver()` fail when × 4 would exceed 64,
/// instead of silently clamping to the value a plain take would give.
#[test]
fn beaver_that_would_exceed_the_maximum_cube_is_not_allowed() {
    let rules = Rules {
        beavers: true,
        ..Rules::money()
    };
    // Cube 32 owned by White: White doubles to 64; a beaver to 128 is over.
    let mut g = GameState::new(rules);
    g.on_roll = Some(Player::White);
    g.phase = Phase::ToRoll;
    g.cube = Cube {
        value: 32,
        owner: Some(Player::White),
    };
    g.double().unwrap();
    assert!(
        matches!(g.beaver(), Err(RulesError::NotAllowed(_))),
        "a beaver past the maximum cube must be refused"
    );
    assert_eq!(g.phase, Phase::Doubled, "a refused beaver changes nothing");
    assert_eq!(
        g.cube,
        Cube {
            value: 32,
            owner: Some(Player::White)
        }
    );
    // The take is still available at the same point.
    g.take().unwrap();
    assert_eq!(g.cube.value, 64);

    // Boundary: from 16 a beaver reaches exactly 64 and is allowed.
    let mut g = GameState::new(rules);
    g.on_roll = Some(Player::White);
    g.phase = Phase::ToRoll;
    g.cube = Cube {
        value: 16,
        owner: Some(Player::White),
    };
    g.double().unwrap();
    g.beaver().unwrap();
    assert_eq!(g.cube.value, 64);
    assert_eq!(g.cube.owner, Some(Player::Black));
}

// ---------------------------------------------------------------------------
// Crawford rule — USBGF Ruling Guide §4.4.8
// ---------------------------------------------------------------------------

/// "4.4.8 Crawford Rule — The doubling cube is removed from play for the
/// first game after either player is exactly one point away from winning the
/// match (the Crawford game). Any cube action during the Crawford game or
/// with a dead cube is void." … "the doubling cube will be out of play for
/// the first game, and only the first game, after either player has reached
/// a score that is exactly one point away from winning the match" … "After
/// the Crawford Game has ended, the doubling cube shall be returned to play
/// for allowable use in any subsequent 'post-Crawford' games."
/// — USBGF Ruling Guide (for the USBGF Tournament Rules – 2024), §4.4.8,
///   <https://usbgf.org/wp-content/uploads/2024/06/ruling-guide-2025-01.pdf>
///   (also USBGF Tournament Rules, "Crawford game; dead cubes",
///   <https://usbgf.org/tournament-rules/rules-for-in-person-play/>)
#[test]
fn crawford_game_is_one_game_only_and_cube_returns_afterwards() {
    /// Finishes the current game for `winner` with `kind` at cube value 1.
    fn win(m: &mut MatchState, winner: Player, kind: ResultKind) -> Option<Player> {
        let mut g = to_move(m.game.rules, board(&[(1, 1)], &[(19, 15)]), (2, 1));
        g.cube_dead = m.game.cube_dead;
        if winner == Player::Black {
            // Mirror: Black bears off the last checker instead.
            g.board = board(&[(6, 15)], &[(24, 1)]);
            g.on_roll = Some(Player::Black);
        }
        if kind == ResultKind::Single {
            // Give the loser one checker off so it is a single game.
            let (loser_side, home) = if winner == Player::White {
                (&mut g.board.black, 19)
            } else {
                (&mut g.board.white, 6)
            };
            loser_side[home] -= 1;
            loser_side[25] += 1;
        }
        m.game = g;
        m.game.play(&play("1/off")).unwrap();
        assert_eq!(m.game.result.unwrap().kind, kind);
        m.finish_game()
    }
    fn ready_to_roll(m: &mut MatchState, p: Player) {
        m.game.on_roll = Some(p);
        m.game.phase = Phase::ToRoll;
    }

    let mut m = MatchState::new(3, Rules::match_play());
    assert!(m.cube_allowed());

    // White wins a gammon: 2–0, White is 1-away → the next game is Crawford.
    assert_eq!(win(&mut m, Player::White, ResultKind::Gammon), None);
    assert_eq!(m.score, [2, 0]);
    assert_eq!(m.away(Player::White), 1);
    assert!(m.crawford && !m.post_crawford);
    assert!(!m.cube_allowed());
    assert!(m.game.cube_dead);
    ready_to_roll(&mut m, Player::Black);
    assert!(!m.game.can_double());
    assert!(matches!(m.game.double(), Err(RulesError::NotAllowed(_))));
    assert_eq!(m.game.phase, Phase::ToRoll);

    // Black wins the Crawford game (single): 2–1, cube is back.
    assert_eq!(win(&mut m, Player::Black, ResultKind::Single), None);
    assert_eq!(m.score, [2, 1]);
    assert!(!m.crawford && m.post_crawford);
    assert!(m.cube_allowed());
    assert!(!m.game.cube_dead);
    ready_to_roll(&mut m, Player::Black);
    assert!(m.game.can_double());
    m.game.double().unwrap();
    m.game.take().unwrap();
    assert_eq!(m.game.cube.value, 2);

    // Black wins again: 2–2. Black is now also 1-away, but Crawford has
    // already been played and does not recur.
    assert_eq!(win(&mut m, Player::Black, ResultKind::Single), None);
    assert_eq!(m.score, [2, 2]);
    assert!(!m.crawford && m.post_crawford);
    assert!(m.cube_allowed());
    assert!(!m.is_over());

    // Decider.
    assert_eq!(
        win(&mut m, Player::White, ResultKind::Single),
        Some(Player::White)
    );
    assert_eq!(m.score, [3, 2]);
    assert!(m.is_over());
}
