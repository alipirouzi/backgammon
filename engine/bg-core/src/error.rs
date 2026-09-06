//! Error type shared by every rules-engine operation.

use thiserror::Error;

/// Failures reported by the rules engine.
///
/// The variants carry either a static description (for structural problems
/// found by validation) or an owned string (for problems that depend on the
/// offending input, such as a play or a notation string).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RulesError {
    /// A die value outside `1..=6`.
    #[error("invalid die value {0}: must be 1..=6")]
    InvalidDie(u8),
    /// A board that violates a structural invariant (checker counts, shared points).
    #[error("invalid board: {0}")]
    InvalidBoard(&'static str),
    /// A play that is not legal in the given position with the given dice.
    #[error("illegal play: {0}")]
    IllegalPlay(String),
    /// An action attempted in a game phase that does not allow it.
    #[error("wrong phase: {0}")]
    WrongPhase(&'static str),
    /// An action forbidden by the rules in force (e.g. beavers when disabled).
    #[error("not allowed: {0}")]
    NotAllowed(&'static str),
    /// Malformed textual input (notation, JSON payloads).
    #[error("parse error: {0}")]
    Parse(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displays_human_readable_messages() {
        assert_eq!(
            RulesError::InvalidDie(7).to_string(),
            "invalid die value 7: must be 1..=6"
        );
        assert_eq!(
            RulesError::InvalidBoard("x").to_string(),
            "invalid board: x"
        );
        assert_eq!(
            RulesError::IllegalPlay("p".into()).to_string(),
            "illegal play: p"
        );
        assert_eq!(RulesError::WrongPhase("w").to_string(), "wrong phase: w");
        assert_eq!(RulesError::NotAllowed("n").to_string(), "not allowed: n");
        assert_eq!(RulesError::Parse("q".into()).to_string(), "parse error: q");
    }
}
