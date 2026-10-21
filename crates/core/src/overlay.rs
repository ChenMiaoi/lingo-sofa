use serde::{Deserialize, Serialize};

/// Physical desktop coordinates; negative coordinates are valid on secondary displays.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite() && v.abs() < 1e7)
            && self.width > 0.0
            && self.height > 0.0
    }
    pub fn near(self, other: Self) -> bool {
        (self.x - other.x).abs() < 2.0
            && (self.y - other.y).abs() < 2.0
            && (self.width - other.width).abs() < 2.0
            && (self.height - other.height).abs() < 2.0
    }
}

pub fn place(anchor: Option<Rect>, work: Rect, scale: f64, width: f64, height: f64) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let width = (width * scale).min(work.width);
    let height = (height * scale).min(work.height);
    let (x, y) = if let Some(source) = anchor.filter(|a| a.valid()) {
        let below = source.y + source.height + 4.0 * scale;
        let y = if below + height <= work.y + work.height {
            below
        } else {
            source.y - height - 4.0 * scale
        };
        (source.x - 12.0 * scale, y)
    } else {
        (
            work.x + (work.width - width) / 2.0,
            work.y + (work.height - height) / 2.0,
        )
    };
    Rect {
        x: x.clamp(work.x, work.x + work.width - width),
        y: y.clamp(work.y, work.y + work.height - height),
        width,
        height,
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionFrame {
    Selection { text: String, bounds: Rect },
    Tick { bounds: Rect },
    Invalid { code: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn placement_preserves_source_alignment_and_negative_monitor_coordinates() {
        let work = Rect {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let source = Rect {
            x: -1500.0,
            y: 240.0,
            width: 480.0,
            height: 60.0,
        };
        let r = place(Some(source), work, 1.5, 500.0, 174.0);
        assert_eq!(r.x + 18.0, source.x);
        assert_eq!(r.y, 306.0);
        assert_eq!(r.width, 750.0);
    }
    #[test]
    fn placement_clamps_small_displays_and_uses_space_above_when_needed() {
        let work = Rect {
            x: 0.0,
            y: 0.0,
            width: 400.0,
            height: 300.0,
        };
        let source = Rect {
            x: 350.0,
            y: 260.0,
            width: 100.0,
            height: 30.0,
        };
        let r = place(Some(source), work, 2.0, 500.0, 174.0);
        assert_eq!(r, work);
        assert!(
            !Rect {
                width: f64::NAN,
                ..work
            }
            .valid()
        );
        let r = place(
            Some(source),
            Rect {
                width: 1000.0,
                height: 400.0,
                ..work
            },
            1.0,
            500.0,
            174.0,
        );
        assert_eq!(r.y, 82.0);
    }
}
