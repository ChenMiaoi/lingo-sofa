const MAX_COPY_BYTES: usize = 4 * 1024 * 1024;

pub fn validate(text: &str) -> Result<(), &'static str> {
    if text.len() > MAX_COPY_BYTES {
        return Err("clipboard_text_too_long");
    }
    if text.contains('\0') {
        return Err("clipboard_text_invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_preserves_unicode_whitespace_and_rejects_truncating_inputs() {
        assert!(validate("\t代码 🛋️\n  value\n").is_ok());
        assert!(validate(&"a".repeat(MAX_COPY_BYTES)).is_ok());
        assert_eq!(
            validate(&"中".repeat(MAX_COPY_BYTES / 3 + 1)),
            Err("clipboard_text_too_long")
        );
        assert_eq!(validate("before\0after"), Err("clipboard_text_invalid"));
    }
}
