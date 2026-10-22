#![cfg(windows)]
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name)
}
fn recognize(program: &Path, image: &Path) -> serde_json::Value {
    let start = Instant::now();
    let result = Command::new(program).arg(image).output().unwrap();
    assert!(
        result.status.success(),
        "helper failed: {:?}",
        result.stderr
    );
    assert!(start.elapsed() < Duration::from_secs(25));
    let text = String::from_utf8(result.stdout).unwrap();
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("not one JSON response: {text}"))
}
fn executable() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_lingo-sofa-ocr-helper"))
}
fn distance(a: &str, b: &str) -> usize {
    let b = b.chars().collect::<Vec<_>>();
    let mut row = (0..=b.len()).collect::<Vec<_>>();
    for (i, c) in a.chars().enumerate() {
        let mut next = vec![i + 1];
        for (j, d) in b.iter().enumerate() {
            next.push(
                (next[j] + 1)
                    .min(row[j + 1] + 1)
                    .min(row[j] + usize::from(c != *d)),
            );
        }
        row = next;
    }
    row[b.len()]
}
#[test]
fn real_engine_preserves_small_underlined_mixed_text_and_existing_large_fixture() {
    let small = recognize(executable(), &fixture("windows-ocr-small.png"));
    assert_eq!(
        small["text"],
        "LingoSofa OCR acceptance 42\nThe quick brown fox jumps over the lazy dog.\n本地截图识别：只测试合成文字，不包含个人信息。"
    );
    let large = recognize(executable(), &fixture("ocr-sample.png"));
    assert_eq!(large["text"], "LingoSofa OCR 42\n本地识别，校对后翻译。");
}
#[test]
fn wide_small_font_input_retains_original_pixels_and_bounds_raw_character_errors() {
    let expected: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(fixture("windows-ocr-wide.json")).unwrap())
            .unwrap();
    let expected = expected.join("\n");
    let result = recognize(executable(), &fixture("windows-ocr-wide.png"));
    let text = result["text"]
        .as_str()
        .unwrap_or_else(|| panic!("{result}"));
    let errors = distance(&expected, text);
    assert!(
        errors * 100 <= expected.chars().count() * 3,
        "raw CER exceeds 3%: {errors} edits\n{text}"
    );
    assert_eq!(text.lines().count(), 4);
    assert!(text.contains("punctuation and spaces. UTF-8 中文 English 123."));
}
#[test]
fn blank_oversized_and_invalid_images_fail_without_text() {
    let root = tempfile::tempdir().unwrap();
    let blank = root.path().join("blank.png");
    image::RgbImage::from_pixel(493, 85, image::Rgb([255, 255, 255]))
        .save(&blank)
        .unwrap();
    assert_eq!(recognize(executable(), &blank)["error"], "ocr_empty");
    let oversized = root.path().join("oversized.png");
    image::RgbImage::new(4097, 4).save(&oversized).unwrap();
    assert_eq!(
        recognize(executable(), &oversized)["error"],
        "ocr_image_too_large"
    );
    let invalid = root.path().join("invalid.png");
    std::fs::write(&invalid, b"not an image").unwrap();
    assert_eq!(
        recognize(executable(), &invalid)["error"],
        "ocr_invalid_image"
    );
}
#[test]
fn missing_or_forged_installed_resources_do_not_fall_back_to_a_system_engine() {
    let root = tempfile::tempdir().unwrap();
    let helper = root.path().join("ocr-helper.exe");
    std::fs::copy(executable(), &helper).unwrap();
    std::fs::create_dir(root.path().join("ocr")).unwrap();
    std::fs::write(root.path().join("ocr/provenance.json"), b"{\"assets\":[]}").unwrap();
    assert_eq!(
        recognize(&helper, &fixture("windows-ocr-small.png"))["error"],
        "ocr_resource_invalid"
    );
}
