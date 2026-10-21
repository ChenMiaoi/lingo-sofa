use objc2::{AnyThread, ClassType, rc::autoreleasepool};
use objc2_foundation::{
    NSArray, NSData, NSDictionary, NSOperatingSystemVersion, NSProcessInfo, NSString,
};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};
use std::{fs, path::Path};

const MAX_PIXELS: u64 = 16_000_000;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

fn validate_png(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err("ocr_invalid_image");
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as u64;
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap()) as u64;
    if width == 0 || height == 0 {
        return Err("ocr_invalid_image");
    }
    if width * height > MAX_PIXELS {
        return Err("ocr_image_too_large");
    }
    Ok(())
}

pub fn recognize(path: &Path) -> Result<String, &'static str> {
    if !NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
        majorVersion: 11,
        minorVersion: 0,
        patchVersion: 0,
    }) {
        return Err("ocr_os_unsupported");
    }
    if fs::metadata(path).map_err(|_| "ocr_invalid_image")?.len() > MAX_BYTES {
        return Err("ocr_image_too_large");
    }
    let bytes = fs::read(path).map_err(|_| "ocr_invalid_image")?;
    validate_png(&bytes)?;
    autoreleasepool(|_| {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        // Preserve code, identifiers and spelling for user review.
        request.setUsesLanguageCorrection(false);
        let supported = unsafe { request.supportedRecognitionLanguagesAndReturnError() }
            .map_err(|_| "ocr_failed")?;
        let languages: Vec<_> = ["zh-Hans", "zh-Hant", "en-US"]
            .into_iter()
            .filter(|language| supported.iter().any(|item| item.to_string() == *language))
            .map(NSString::from_str)
            .collect();
        if !languages.is_empty() {
            request.setRecognitionLanguages(&NSArray::from_retained_slice(&languages));
        }
        let data = NSData::with_bytes(&bytes);
        // Empty options carry no image metadata or auxiliary objects.
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        let requests = NSArray::from_slice(&[request.as_super() as &VNRequest]);
        handler
            .performRequests_error(&requests)
            .map_err(|_| "ocr_failed")?;
        let observations = request.results().ok_or("ocr_empty")?;
        let mut lines = Vec::new();
        for observation in observations.iter() {
            if let Some(candidate) = observation.topCandidates(1).firstObject() {
                let text = candidate.string().to_string();
                if !text.trim().is_empty() {
                    lines.push(text);
                }
            }
        }
        let text = lines.join("\n");
        if text.is_empty() {
            return Err("ocr_empty");
        }
        if text.len() > 15000 || text.chars().count() > 5000 {
            return Err("ocr_text_too_long");
        }
        Ok(text)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_or_oversized_images_fail_before_recognition() {
        assert_eq!(validate_png(b"bad image"), Err("ocr_invalid_image"));
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&u32::MAX.to_be_bytes());
        png.extend_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(validate_png(&png), Err("ocr_image_too_large"));
        png[16..20].copy_from_slice(&0u32.to_be_bytes());
        assert_eq!(validate_png(&png), Err("ocr_invalid_image"));
    }
    #[test]
    fn native_vision_recognizes_bilingual_fixture_without_network_or_screen_access() {
        let image =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/ocr-sample.png");
        let text = recognize(&image).unwrap();
        assert!(text.contains("LingoSofa OCR 42"), "{text}");
        assert!(text.contains("本地识别"), "{text}");
        assert!(text.contains("校对后翻译"), "{text}");
    }
    #[test]
    fn corrupt_images_do_not_return_old_text() {
        let image = tempfile::NamedTempFile::new().unwrap();
        fs::write(image.path(), b"not a screenshot").unwrap();
        assert_eq!(recognize(image.path()), Err("ocr_invalid_image"));
    }
}
