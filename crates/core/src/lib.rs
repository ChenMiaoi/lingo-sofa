pub mod overlay;
pub mod scheduler;
pub type Result<T> = std::result::Result<T, &'static str>;

pub const MAX_TEXT_BYTES: usize = 15_000;

pub fn validate_text(text: &str) -> Result<()> {
    if text.trim().is_empty() {
        Err("invalid_text")
    } else if text.len() > MAX_TEXT_BYTES {
        Err("text_too_long")
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod text_tests {
    use super::*;

    #[test]
    fn input_and_followup_limits_measure_utf8_without_truncating_unicode() {
        for empty in ["", " \n\t", "\u{3000}"] {
            assert_eq!(validate_text(empty), Err("invalid_text"));
        }
        for (character, count) in [("a", 15000), ("问", 5000), ("🛋", 3750)] {
            assert_eq!(validate_text(&character.repeat(count)), Ok(()));
            assert_eq!(
                validate_text(&character.repeat(count + 1)),
                Err("text_too_long")
            );
        }
        assert_eq!(validate_text(&"问".repeat(1500)), Ok(()));
    }
}
