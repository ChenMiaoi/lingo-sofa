# Windows local OCR notices

Windows OCR uses PP-OCRv5 mobile detection and recognition models, published by PaddlePaddle under Apache-2.0. Exact official repository revisions, URLs, file sizes and SHA-256 values are in `crates/ocr-helper/assets.json`; these expectations are compiled into the helper, rather than loaded from a mutable installed manifest. The character dictionary is extracted without changes from the official recognition configuration.

Preprocessing, DB postprocessing, reading order, perspective crops and CTC decoding follow PaddleOCR and the RapidOCR compatibility reference (Apache-2.0). The implementation is Rust; RapidOCR and Python are not distributed with the application. Geometric and interpolation conventions are retained for model compatibility; no spelling dictionary or LLM correction is applied.

- PaddleOCR source and license: https://github.com/PaddlePaddle/PaddleOCR (Apache-2.0)
- RapidOCR reference: https://github.com/RapidAI/RapidOCR (Apache-2.0)
- ONNX Runtime 1.31.0 CPU: https://github.com/microsoft/onnxruntime (MIT). Its LICENSE and ThirdPartyNotices are copied from the checksum-verified official Windows archive into the packaged OCR resources.
- Rust bindings and image processing: `ort` (MIT/Apache-2.0), `image` (MIT/Apache-2.0), `imageproc` (MIT), `clipper2` (MIT/Apache-2.0), and `sha2` (MIT/Apache-2.0). Their resolved versions are recorded in Cargo.lock. Clipper2's native component includes the upstream Boost Software License 1.0 code.

The bundled ONNX Runtime DLL requires Microsoft Visual C++ 2015–2022 x64 runtime. The application does not redistribute or install that runtime automatically. Microsoft installation instructions: https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170

Model bytes stay local. The inference helper makes no network requests and does not download models or alternate engines at runtime.
