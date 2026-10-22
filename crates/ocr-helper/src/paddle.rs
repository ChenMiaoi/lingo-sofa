// PP-OCRv5 preprocessing/DB/CTC follow PaddleOCR (Apache-2.0).
// See third-party-notices/ocr.md for source and model provenance.
use clipper2::{EndType, JoinType, Paths};
use image::{GrayImage, Luma, RgbImage};
use imageproc::{
    contours::find_contours, drawing::draw_polygon_mut, geometric_transformations::Projection,
    geometry::min_area_rect, point::Point,
};
use ort::{
    session::{RunOptions, Session},
    value::Tensor,
};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

const MAX_PIXELS: u64 = 4_000_000;
const MAX_EDGE: u32 = 4096;
const MAX_BOXES: usize = 128;
const MAX_CONTOURS: usize = 1000;
const MAX_REC_WIDTH: u32 = 8192;
const MAX_OUTPUT: usize = 20_000_000;
type Error = &'static str;
type Quad = [Point<f32>; 4];

pub fn validate_dimensions(width: u32, height: u32) -> Result<(), Error> {
    if width == 0 || height == 0 {
        return Err("ocr_invalid_image");
    }
    if width > MAX_EDGE || height > MAX_EDGE || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("ocr_image_too_large");
    }
    Ok(())
}
fn check(deadline: Instant) -> Result<(), Error> {
    if Instant::now() >= deadline {
        Err("ocr_timeout")
    } else {
        Ok(())
    }
}
struct Budget {
    options: Arc<RunOptions>,
    done: mpsc::Sender<()>,
    worker: Option<std::thread::JoinHandle<()>>,
    deadline: Instant,
}
impl Budget {
    fn new(deadline: Instant) -> Result<Self, Error> {
        let options = Arc::new(RunOptions::new().map_err(|_| "ocr_failed")?);
        let (done, recv) = mpsc::channel();
        let stop = options.clone();
        let worker = std::thread::spawn(move || {
            if matches!(
                recv.recv_timeout(deadline.saturating_duration_since(Instant::now())),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                let _ = stop.terminate();
            }
        });
        Ok(Self {
            options,
            done,
            worker: Some(worker),
            deadline,
        })
    }
}
impl Drop for Budget {
    fn drop(&mut self) {
        let _ = self.done.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn run<T>(
    session: &mut Session,
    shape: [usize; 4],
    data: Vec<f32>,
    budget: &Budget,
    predicted_output: usize,
    consume: impl FnOnce(&[i64], &[f32]) -> Result<T, Error>,
) -> Result<T, Error> {
    check(budget.deadline)?;
    if predicted_output > MAX_OUTPUT {
        return Err("ocr_image_too_large");
    }
    let tensor = Tensor::from_array((shape, data.into_boxed_slice())).map_err(|_| "ocr_failed")?;
    let outputs = session
        .run_with_options(ort::inputs![tensor], &budget.options)
        .map_err(|_| {
            if Instant::now() >= budget.deadline {
                "ocr_timeout"
            } else {
                "ocr_failed"
            }
        })?;
    check(budget.deadline)?;
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|_| "ocr_model_invalid")?;
    if data.len() > predicted_output || data.iter().any(|v| !v.is_finite()) {
        return Err("ocr_model_invalid");
    }
    consume(shape, data)
}

fn tensor(image: &RgbImage, det: bool) -> Vec<f32> {
    let count = (image.width() * image.height()) as usize;
    let mut data = vec![0.0; count * 3];
    for (i, pixel) in image.pixels().enumerate() {
        for c in 0..3 {
            let v = pixel[2 - c] as f32 / 255.0;
            data[c * count + i] = if det {
                (v - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c]
            } else {
                (v - 0.5) / 0.5
            };
        }
    }
    data
}
fn linear_resize(image: &RgbImage, width: u32, height: u32) -> RgbImage {
    let sw = image.width();
    let sh = image.height();
    RgbImage::from_fn(width, height, |x, y| {
        let sx = ((x as f64 + 0.5) * sw as f64 / width as f64 - 0.5)
            .clamp(0., sw.saturating_sub(1) as f64);
        let sy = ((y as f64 + 0.5) * sh as f64 / height as f64 - 0.5)
            .clamp(0., sh.saturating_sub(1) as f64);
        let x0 = sx.floor() as u32;
        let y0 = sy.floor() as u32;
        let x1 = (x0 + 1).min(sw - 1);
        let y1 = (y0 + 1).min(sh - 1);
        let ax = ((sx - x0 as f64) * 2048.).round() as i64;
        let ay = ((sy - y0 as f64) * 2048.).round() as i64;
        image::Rgb(std::array::from_fn(|c| {
            let top = image.get_pixel(x0, y0)[c] as i64 * (2048 - ax)
                + image.get_pixel(x1, y0)[c] as i64 * ax;
            let bottom = image.get_pixel(x0, y1)[c] as i64 * (2048 - ax)
                + image.get_pixel(x1, y1)[c] as i64 * ax;
            ((top * (2048 - ay) + bottom * ay + (1 << 21)) >> 22) as u8
        }))
    })
}
fn aligned(value: f64) -> u32 {
    ((value / 32.).round() as u32 * 32).max(32)
}
fn length(a: Point<f32>, b: Point<f32>) -> f32 {
    (a.x - b.x).hypot(a.y - b.y)
}
fn minimum_rect(points: &[Point<f32>]) -> Option<Quad> {
    // imageproc's hull orientation operates on integers. Fixed-point inputs avoid
    // inconsistent float-to-integer comparisons and retain subpixel geometry.
    if points
        .iter()
        .any(|p| !p.x.is_finite() || !p.y.is_finite() || p.x.abs() > 4096. || p.y.abs() > 4096.)
    {
        return None;
    }
    let mut fixed = points
        .iter()
        .map(|p| Point::new((p.x * 10.).round() as i32, (p.y * 10.).round() as i32))
        .collect::<Vec<_>>();
    // geometry::orientation uses i32 products; cap each difference to 20000
    // so the difference of two products cannot overflow even on large masks.
    let min_x = fixed.iter().map(|p| p.x).min()?;
    let max_x = fixed.iter().map(|p| p.x).max()?;
    let min_y = fixed.iter().map(|p| p.y).min()?;
    let max_y = fixed.iter().map(|p| p.y).max()?;
    if max_x - min_x > 20000 || max_y - min_y > 20000 {
        return None;
    }
    fixed.sort_by_key(|p| (p.x, p.y));
    fixed.dedup();
    if fixed.len() < 3 {
        return None;
    }
    Some(min_area_rect(&fixed).map(|p| Point::new(p.x as f32 / 10., p.y as f32 / 10.)))
}
fn short_side(q: &Quad) -> f32 {
    length(q[0], q[1]).min(length(q[1], q[2]))
}
fn score(q: &Quad, prob: &[f32], w: u32, h: u32) -> f32 {
    let x0 = q
        .iter()
        .map(|p| p.x.floor().max(0.) as u32)
        .min()
        .unwrap()
        .min(w - 1);
    let y0 = q
        .iter()
        .map(|p| p.y.floor().max(0.) as u32)
        .min()
        .unwrap()
        .min(h - 1);
    let x1 = q
        .iter()
        .map(|p| p.x.ceil().max(0.) as u32)
        .max()
        .unwrap()
        .min(w - 1);
    let y1 = q
        .iter()
        .map(|p| p.y.ceil().max(0.) as u32)
        .max()
        .unwrap()
        .min(h - 1);
    let mut mask = GrayImage::new(x1 - x0 + 1, y1 - y0 + 1);
    let points = q
        .iter()
        .map(|p| Point::new(p.x as i32 - x0 as i32, p.y as i32 - y0 as i32))
        .collect::<Vec<_>>();
    draw_polygon_mut(&mut mask, &points, Luma([1]));
    let (mut sum, mut count) = (0., 0u32);
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] != 0 {
            sum += prob[((y + y0) * w + x + x0) as usize];
            count += 1;
        }
    }
    if count == 0 { 0. } else { sum / count as f32 }
}
fn unclip(q: &Quad) -> Option<Quad> {
    let mut twice_area = 0f64;
    let mut perimeter = 0f64;
    for i in 0..4 {
        let a = q[i];
        let b = q[(i + 1) % 4];
        twice_area += a.x as f64 * b.y as f64 - b.x as f64 * a.y as f64;
        perimeter += length(a, b) as f64;
    }
    if perimeter <= 0. {
        return None;
    }
    let paths: Paths<clipper2::One> = q
        .iter()
        .map(|p| (p.x.trunc() as f64, p.y.trunc() as f64))
        .collect::<Vec<_>>()
        .into();
    let expanded = paths.inflate(
        twice_area.abs() * 0.5 * 1.5 / perimeter,
        JoinType::Round,
        EndType::Polygon,
        2.,
    );
    if expanded.len() != 1 {
        return None;
    }
    let pts = expanded
        .iter()
        .next()?
        .iter()
        .map(|p| Point::new(p.x() as f32, p.y() as f32))
        .collect::<Vec<_>>();
    if pts.len() < 4 {
        return None;
    }
    minimum_rect(&pts)
}
fn boxes(
    prob: &[f32],
    w: u32,
    h: u32,
    source: (u32, u32),
    deadline: Instant,
) -> Result<Vec<Quad>, Error> {
    if prob.len() != (w * h) as usize {
        return Err("ocr_model_invalid");
    }
    let mask = GrayImage::from_raw(
        w,
        h,
        prob.iter()
            .map(|p| if *p > 0.3 { 255 } else { 0 })
            .collect(),
    )
    .ok_or("ocr_model_invalid")?;
    let contours = find_contours::<i32>(&mask);
    if contours.len() > MAX_CONTOURS {
        return Err("ocr_image_too_large");
    }
    let mut result = Vec::new();
    for contour in contours {
        check(deadline)?;
        if contour.points.len() < 4 {
            continue;
        }
        let pts = contour
            .points
            .iter()
            .map(|p| Point::new(p.x as f32, p.y as f32))
            .collect::<Vec<_>>();
        let Some(q) = minimum_rect(&pts) else {
            continue;
        };
        if short_side(&q) < 3. || score(&q, prob, w, h) < 0.6 {
            continue;
        }
        let Some(mut q) = unclip(&q) else {
            continue;
        };
        if short_side(&q) < 5. {
            continue;
        }
        for p in &mut q {
            p.x = (p.x * source.0 as f32 / w as f32)
                .round()
                .clamp(0., source.0.saturating_sub(1) as f32);
            p.y = (p.y * source.1 as f32 / h as f32)
                .round()
                .clamp(0., source.1.saturating_sub(1) as f32);
        }
        if short_side(&q) <= 3. {
            continue;
        }
        result.push(q);
        if result.len() > MAX_BOXES {
            return Err("ocr_image_too_large");
        }
    }
    result.sort_by(|a, b| a[0].y.total_cmp(&b[0].y).then(a[0].x.total_cmp(&b[0].x)));
    for i in 1..result.len() {
        let mut j = i;
        while j > 0
            && (result[j][0].y - result[j - 1][0].y).abs() < 10.
            && result[j][0].x < result[j - 1][0].x
        {
            result.swap(j, j - 1);
            j -= 1;
        }
    }
    Ok(result)
}
fn cubic_weight(distance: f32) -> f32 {
    let x = distance.abs();
    let a = -0.75;
    if x <= 1. {
        ((a + 2.) * x - (a + 3.)) * x * x + 1.
    } else if x < 2. {
        ((a * x - 5. * a) * x + 8. * a) * x - 4. * a
    } else {
        0.
    }
}
fn project_crop(image: &RgbImage, projection: Projection, width: u32, height: u32) -> RgbImage {
    let inverse = projection.invert();
    RgbImage::from_fn(width, height, |x, y| {
        let (sx, sy) = inverse * (x as f32, y as f32);
        let sx = (sx * 32.).round() / 32.;
        let sy = (sy * 32.).round() / 32.;
        let x0 = sx.floor() as i32;
        let y0 = sy.floor() as i32;
        image::Rgb(std::array::from_fn(|channel| {
            let mut sum = 0.;
            for iy in -1..=2 {
                for ix in -1..=2 {
                    let px = (x0 + ix).clamp(0, image.width() as i32 - 1) as u32;
                    let py = (y0 + iy).clamp(0, image.height() as i32 - 1) as u32;
                    sum += image.get_pixel(px, py)[channel] as f32
                        * cubic_weight(sx - (x0 + ix) as f32)
                        * cubic_weight(sy - (y0 + iy) as f32);
                }
            }
            sum.round().clamp(0., 255.) as u8
        }))
    })
}
fn crop(image: &RgbImage, q: &Quad) -> Result<RgbImage, Error> {
    let width = length(q[0], q[1]).max(length(q[2], q[3])) as u32;
    let height = length(q[0], q[3]).max(length(q[1], q[2])) as u32;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("ocr_image_too_large");
    }
    let from = q.map(|p| (p.x, p.y));
    let to = [
        (0., 0.),
        (width as f32, 0.),
        (width as f32, height as f32),
        (0., height as f32),
    ];
    let projection = Projection::from_control_points(from, to).ok_or("ocr_failed")?;
    let mut out = project_crop(image, projection, width, height);
    if height as f32 / width as f32 >= 1.5 {
        out = image::imageops::rotate270(&out);
    }
    Ok(out)
}
fn decode(data: &[f32], classes: usize, characters: &[String]) -> Result<String, Error> {
    if classes != characters.len() + 2 || !data.len().is_multiple_of(classes) {
        return Err("ocr_model_invalid");
    }
    let mut text = String::new();
    let mut previous = 0;
    for row in data.chunks_exact(classes) {
        let (id, _) = row
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .ok_or("ocr_model_invalid")?;
        if id != 0 && id != previous {
            if id == classes - 1 {
                text.push(' ');
            } else {
                text.push_str(characters.get(id - 1).ok_or("ocr_model_invalid")?);
            }
        }
        previous = id;
    }
    Ok(text)
}
fn session(bytes: &[u8]) -> Result<Session, Error> {
    Session::builder()
        .map_err(|_| "ocr_runtime_unavailable")?
        .with_intra_threads(2)
        .map_err(|_| "ocr_runtime_unavailable")?
        .with_inter_threads(1)
        .map_err(|_| "ocr_runtime_unavailable")?
        .with_memory_pattern(false)
        .map_err(|_| "ocr_runtime_unavailable")?
        .commit_from_memory(bytes)
        .map_err(|_| "ocr_model_invalid")
}
fn assets(root: &Path) -> Result<std::collections::HashMap<String, Vec<u8>>, Error> {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../assets.json")).map_err(|_| "ocr_resource_invalid")?;
    let mut result = std::collections::HashMap::new();
    if std::fs::symlink_metadata(root)
        .map_err(|_| "ocr_resource_invalid")?
        .file_type()
        .is_symlink()
    {
        return Err("ocr_resource_invalid");
    }
    for asset in manifest["assets"]
        .as_array()
        .ok_or("ocr_resource_invalid")?
    {
        let name = asset["name"].as_str().ok_or("ocr_resource_invalid")?;
        let path = root.join(name);
        let meta = std::fs::symlink_metadata(&path).map_err(|_| "ocr_resource_invalid")?;
        if !meta.is_file() || meta.len() != asset["bytes"].as_u64().ok_or("ocr_resource_invalid")? {
            return Err("ocr_resource_invalid");
        }
        let bytes = std::fs::read(path).map_err(|_| "ocr_resource_invalid")?;
        if format!("{:x}", Sha256::digest(&bytes))
            != asset["sha256"].as_str().ok_or("ocr_resource_invalid")?
        {
            return Err("ocr_resource_invalid");
        }
        if !name.ends_with(".dll") {
            result.insert(name.into(), bytes);
        }
    }
    Ok(result)
}
pub fn recognize(image: RgbImage, root: &Path) -> Result<String, Error> {
    let deadline = Instant::now() + Duration::from_secs(20);
    validate_dimensions(image.width(), image.height())?;
    let files = assets(root)?;
    check(deadline)?;
    ort::init_from(root.join("onnxruntime.dll"))
        .map_err(|_| "ocr_runtime_unavailable")?
        .commit();
    let budget = Budget::new(deadline)?;
    let mut det = session(&files["det.onnx"])?;
    let mut rec = session(&files["rec.onnx"])?;
    let characters = std::str::from_utf8(&files["characters.txt"])
        .map_err(|_| "ocr_model_invalid")?
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    if characters.len() != 18383 {
        return Err("ocr_model_invalid");
    }
    // Keep the full-resolution source for recognition. Only the detector tensor is capped.
    let longest = image.width().max(image.height());
    let base = if longest < 960 {
        let ratio = 960. / longest as f64;
        linear_resize(
            &image,
            (image.width() as f64 * ratio).round() as u32,
            (image.height() as f64 * ratio).round() as u32,
        )
    } else {
        image
    };
    let ratio = (960. / base.width().max(base.height()) as f64).min(1.);
    let dw = aligned(base.width() as f64 * ratio);
    let dh = aligned(base.height() as f64 * ratio);
    let input = linear_resize(&base, dw, dh);
    let regions = run(
        &mut det,
        [1, 3, dh as usize, dw as usize],
        tensor(&input, true),
        &budget,
        (dw * dh) as usize,
        |shape, prob| {
            if shape != [1, 1, dh as i64, dw as i64] {
                return Err("ocr_model_invalid");
            }
            boxes(prob, dw, dh, base.dimensions(), deadline)
        },
    )?;
    drop(input);
    if regions.is_empty() {
        return Err("ocr_empty");
    }
    let mut ordered = (0..regions.len()).collect::<Vec<_>>();
    let dimensions = regions
        .iter()
        .map(|q| {
            let w = length(q[0], q[1]).max(length(q[2], q[3])) as u32;
            let h = length(q[0], q[3]).max(length(q[1], q[2])) as u32;
            if h as f32 / w.max(1) as f32 >= 1.5 {
                (h, w)
            } else {
                (w, h)
            }
        })
        .collect::<Vec<_>>();
    ordered.sort_by(|a, b| {
        ((dimensions[*a].0 as f64) / (dimensions[*a].1.max(1) as f64))
            .total_cmp(&((dimensions[*b].0 as f64) / (dimensions[*b].1.max(1) as f64)))
    });
    let mut lines = vec![String::new(); regions.len()];
    // Match the reference's aspect-ratio padding groups, but run each line alone
    // so a long line cannot multiply the recognition output allocation by six.
    for group in ordered.chunks(6) {
        let width = group
            .iter()
            .map(|i| (48. * dimensions[*i].0 as f64 / dimensions[*i].1.max(1) as f64) as u32)
            .max()
            .unwrap_or(320)
            .max(320);
        if width > MAX_REC_WIDTH || (width as usize).div_ceil(8) * 18385 > MAX_OUTPUT {
            return Err("ocr_image_too_large");
        }
        for index in group {
            check(deadline)?;
            let crop = crop(&base, &regions[*index])?;
            let actual_width =
                ((48. * crop.width() as f64 / crop.height() as f64).ceil() as u32).min(width);
            let scaled = linear_resize(&crop, actual_width, 48);
            let mut data = tensor(&scaled, false);
            if actual_width < width {
                let mut padded = vec![0.; (width * 48 * 3) as usize];
                for c in 0..3usize {
                    for y in 0..48usize {
                        let from = (c * 48 + y) * actual_width as usize;
                        let to = (c * 48 + y) * width as usize;
                        padded[to..to + actual_width as usize]
                            .copy_from_slice(&data[from..from + actual_width as usize]);
                    }
                }
                data = padded;
            }
            lines[*index] = run(
                &mut rec,
                [1, 3, 48, width as usize],
                data,
                &budget,
                (width as usize).div_ceil(8) * 18385,
                |shape, output| {
                    if shape.len() != 3 || shape[0] != 1 || shape[2] != 18385 {
                        return Err("ocr_model_invalid");
                    }
                    decode(output, 18385, &characters)
                },
            )?;
            let size = lines.iter().map(String::len).sum::<usize>() + lines.len().saturating_sub(1);
            if size > 15000 {
                return Err("ocr_text_too_long");
            }
        }
    }

    let text = lines.join("\n");
    validate_text(&text)?;
    Ok(text)
}

fn validate_text(text: &str) -> Result<(), Error> {
    if text.trim().is_empty() {
        return Err("ocr_empty");
    }
    if text.len() > 15000 || text.chars().count() > 5000 {
        return Err("ocr_text_too_long");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_masks_unclip_and_degenerate_geometry_do_not_overflow_or_panic() {
        let points = [
            Point::new(0., 0.),
            Point::new(959., 0.),
            Point::new(959., 959.),
            Point::new(0., 959.),
        ];
        let rectangle = minimum_rect(&points).unwrap();
        let expanded = unclip(&rectangle).unwrap();
        assert!(short_side(&expanded) > 959.);
        let mut large_mask = vec![0.; 960 * 960];
        for y in 1..959 {
            large_mask[y * 960 + 1..y * 960 + 959].fill(1.);
        }
        assert_eq!(
            boxes(
                &large_mask,
                960,
                960,
                (960, 960),
                Instant::now() + Duration::from_secs(5)
            )
            .unwrap()
            .len(),
            1
        );
        assert!(minimum_rect(&[Point::new(1., 1.); 4]).is_none());
        assert!(
            minimum_rect(&[
                Point::new(f32::NAN, 0.),
                Point::new(0., 1.),
                Point::new(1., 1.)
            ])
            .is_none()
        );
        let flat = [
            Point::new(1., 1.),
            Point::new(2., 1.),
            Point::new(3., 1.),
            Point::new(4., 1.),
        ];
        if let Some(rect) = minimum_rect(&flat) {
            assert!(crop(&RgbImage::new(8, 8), &rect).is_err());
        }
    }
    #[test]
    fn dimensions_tensor_and_text_limits_reject_instead_of_truncating() {
        assert!(validate_dimensions(1920, 1080).is_ok());
        assert!(validate_dimensions(2400, 560).is_ok());
        assert!(validate_dimensions(2000, 2000).is_ok());
        assert_eq!(validate_dimensions(2001, 2000), Err("ocr_image_too_large"));
        assert_eq!(validate_dimensions(4097, 4), Err("ocr_image_too_large"));
        assert_eq!(validate_dimensions(0, 1), Err("ocr_invalid_image"));
        assert_eq!(validate_text(" \n\t"), Err("ocr_empty"));
        assert!(validate_text(&"中".repeat(5000)).is_ok());
        assert_eq!(validate_text(&"a".repeat(5001)), Err("ocr_text_too_long"));
        assert_eq!(validate_text(&"𠮷".repeat(4000)), Err("ocr_text_too_long"));
        assert_eq!(aligned(1.), 32);
        assert_eq!(aligned(960.), 960);
        assert!(MAX_REC_WIDTH.div_ceil(8) as usize * 18385 <= MAX_OUTPUT);
    }
    #[test]
    fn ctc_decodes_blank_duplicates_unicode_and_model_spaces_without_correction() {
        let chars = vec!["a".into(), "中".into()];
        let ids = [1, 1, 0, 1, 2, 2, 3, 1];
        let mut logits = Vec::new();
        for id in ids {
            let mut row = [0.; 4];
            row[id] = 1.;
            logits.extend(row);
        }
        assert_eq!(decode(&logits, 4, &chars).unwrap(), "aa中 a");
        assert_eq!(decode(&logits, 5, &chars), Err("ocr_model_invalid"));
    }
    #[test]
    fn installed_manifest_cannot_replace_compiled_resource_expectations() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("provenance.json"), r#"{"assets":[]}"#).unwrap();
        std::fs::write(root.path().join("det.onnx"), b"untrusted model").unwrap();
        assert_eq!(assets(root.path()).err(), Some("ocr_resource_invalid"));
    }
    #[test]
    fn run_options_interrupt_real_native_inference() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src-tauri/resources/ocr");
        let files = assets(&root).unwrap();
        ort::init_from(root.join("onnxruntime.dll"))
            .unwrap()
            .commit();
        let mut rec = session(&files["rec.onnx"]).unwrap();
        let data = vec![0_f32; 3 * 48 * MAX_REC_WIDTH as usize];
        let input = Tensor::from_array(([1, 3, 48, MAX_REC_WIDTH as usize], data)).unwrap();
        let options = Arc::new(RunOptions::new().unwrap());
        let terminate = options.clone();
        let interrupt = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            terminate.terminate().unwrap();
        });
        let start = Instant::now();
        // Call ORT directly: a pre-run deadline check cannot satisfy this assertion.
        let result = rec.run_with_options(ort::inputs![input], &options);
        let error = result.expect_err("inference must be interrupted");
        interrupt.join().unwrap();
        assert!(
            error.to_string().to_lowercase().contains("terminate"),
            "{error}"
        );
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
