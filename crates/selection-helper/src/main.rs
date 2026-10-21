use lingo_sofa_core::overlay::{Rect, SelectionFrame};
use std::{
    io::{self, Write},
    time::Duration,
};
use windows::Win32::{
    Foundation::{HWND, RECT},
    System::{
        Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize, SAFEARRAY,
        },
        Ole::*,
    },
    UI::{Accessibility::*, HiDpi::*, WindowsAndMessaging::*},
};

struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct Array(*mut SAFEARRAY, bool);
impl Drop for Array {
    fn drop(&mut self) {
        unsafe {
            if self.1 {
                let _ = SafeArrayUnaccessData(self.0);
            }
            let _ = SafeArrayDestroy(self.0);
        }
    }
}

fn bounds(ranges: &[IUIAutomationTextRange]) -> Result<Rect, &'static str> {
    let mut all: Option<Rect> = None;
    for range in ranges {
        let ptr = unsafe { range.GetBoundingRectangles() }.map_err(|_| "selection_unavailable")?;
        if ptr.is_null() {
            return Err("selection_unavailable");
        }
        let mut array = Array(ptr, false);
        unsafe {
            if SafeArrayGetDim(ptr) != 1 || SafeArrayGetElemsize(ptr) != 8 {
                return Err("invalid_selection_bounds");
            }
            let low = SafeArrayGetLBound(ptr, 1).map_err(|_| "invalid_selection_bounds")?;
            let high = SafeArrayGetUBound(ptr, 1).map_err(|_| "invalid_selection_bounds")?;
            let count = i64::from(high) - i64::from(low) + 1;
            if count <= 0 || count > 4096 || count % 4 != 0 {
                return Err("selection_unavailable");
            }
            let mut data = std::ptr::null_mut();
            SafeArrayAccessData(ptr, &mut data).map_err(|_| "invalid_selection_bounds")?;
            array.1 = true;
            if data.is_null() {
                return Err("invalid_selection_bounds");
            }
            for r in std::slice::from_raw_parts(data.cast::<f64>(), count as usize)
                .as_chunks::<4>()
                .0
            {
                let rect = Rect {
                    x: r[0],
                    y: r[1],
                    width: r[2],
                    height: r[3],
                };
                if !rect.valid() {
                    continue;
                }
                all = Some(match all {
                    None => rect,
                    Some(old) => {
                        let x = old.x.min(rect.x);
                        let y = old.y.min(rect.y);
                        Rect {
                            x,
                            y,
                            width: (old.x + old.width).max(rect.x + rect.width) - x,
                            height: (old.y + old.height).max(rect.y + rect.height) - y,
                        }
                    }
                });
            }
        }
    }
    all.ok_or("selection_unavailable")
}
fn emit(frame: SelectionFrame) -> Result<(), &'static str> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &frame).map_err(|_| "pipe_closed")?;
    out.write_all(b"\n")
        .and_then(|_| out.flush())
        .map_err(|_| "pipe_closed")
}
fn window_rect(hwnd: HWND) -> Result<RECT, &'static str> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|_| "source_window_lost")?;
    Ok(rect)
}
// Validate the complete path before trying a text provider. Never search siblings
// or descend into a document: only the focused control and its source ancestors.
fn source_ancestors<N: Clone>(
    focus: N,
    mut is_source: impl FnMut(&N) -> Result<bool, &'static str>,
    mut is_password: impl FnMut(&N) -> Result<bool, &'static str>,
    mut parent: impl FnMut(&N) -> Result<N, &'static str>,
) -> Result<Vec<N>, &'static str> {
    let mut current = focus;
    let mut chain = Vec::new();
    for _ in 0..32 {
        if is_password(&current)? {
            return Err("selection_unavailable");
        }
        chain.push(current.clone());
        if is_source(&current)? {
            return Ok(chain);
        }
        current = parent(&current)?;
    }
    Err("selection_unsupported")
}
fn selection_pattern(
    automation: &IUIAutomation,
    host: HWND,
) -> Result<IUIAutomationTextPattern, &'static str> {
    let focus = unsafe { automation.GetFocusedElement() }.map_err(|_| "selection_unavailable")?;
    let source = unsafe { automation.ElementFromHandle(host) }.map_err(|_| "source_window_lost")?;
    let walker = unsafe { automation.RawViewWalker() }.map_err(|_| "selection_unavailable")?;
    let chain = source_ancestors(
        focus,
        |node| {
            unsafe { automation.CompareElements(node, &source) }
                .map(|v| v.as_bool())
                .map_err(|_| "source_window_lost")
        },
        |node| {
            unsafe { node.CurrentIsPassword() }
                .map(|v| v.as_bool())
                .map_err(|_| "selection_unavailable")
        },
        |node| unsafe { walker.GetParentElement(node) }.map_err(|_| "selection_unsupported"),
    )?;
    for element in chain {
        if let Ok(pattern) = unsafe { element.GetCurrentPatternAs(UIA_TextPatternId) } {
            return Ok(pattern);
        }
    }
    Err("selection_unsupported")
}
fn run() -> Result<(), &'static str> {
    let args: Vec<_> = std::env::args().collect();
    let handle = |index: usize| -> Result<HWND, &'static str> {
        Ok(HWND(
            args.get(index)
                .and_then(|s| s.parse::<usize>().ok())
                .ok_or("invalid_source")? as *mut _,
        ))
    };
    let host = handle(1)?;
    let own = handle(2)?;
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|_| "uia_initialization_failed")?;
    }
    let _com = Com;
    if unsafe { GetForegroundWindow() } != host {
        return Err("source_window_changed");
    }
    let initial = window_rect(host)?;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|_| "uia_initialization_failed")?;
    let pattern = selection_pattern(&automation, host)?;
    let selected = unsafe { pattern.GetSelection() }.map_err(|_| "selection_unavailable")?;
    let length = unsafe { selected.Length() }.map_err(|_| "selection_unavailable")?;
    if !(1..=16).contains(&length) {
        return Err("selection_unavailable");
    }
    let mut ranges = Vec::new();
    let mut text = String::new();
    for index in 0..length {
        let range = unsafe { selected.GetElement(index) }.map_err(|_| "selection_unavailable")?;
        let part = unsafe { range.GetText(15001) }
            .map_err(|_| "selection_unavailable")?
            .to_string();
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&part);
        if text.len() > 15000 {
            return Err("text_too_long");
        }
        ranges.push(range);
    }
    if text.trim().is_empty() {
        return Err("selection_empty");
    }
    let original = bounds(&ranges)?;
    if unsafe { GetForegroundWindow() } != host {
        return Err("source_window_changed");
    }
    emit(SelectionFrame::Selection {
        text,
        bounds: original,
    })?;
    loop {
        std::thread::sleep(Duration::from_millis(150));
        let current = window_rect(host)?;
        let foreground = unsafe { GetForegroundWindow() };
        if current != initial || (foreground != host && foreground != own) {
            return Err("source_window_changed");
        }
        let current_selection =
            unsafe { pattern.GetSelection() }.map_err(|_| "selection_unavailable")?;
        if unsafe { current_selection.Length() }.map_err(|_| "selection_unavailable")? != length {
            return Err("selection_changed");
        }
        for index in 0..length {
            let range = unsafe { current_selection.GetElement(index) }
                .map_err(|_| "selection_unavailable")?;
            if !unsafe { range.Compare(&ranges[index as usize]) }
                .map_err(|_| "selection_unavailable")?
                .as_bool()
            {
                return Err("selection_changed");
            }
        }
        let current = bounds(&ranges)?;
        if !original.near(current) {
            return Err("selection_moved");
        }
        emit(SelectionFrame::Tick { bounds: current })?;
    }
}
fn main() {
    if let Err(code) = run() {
        let _ = emit(SelectionFrame::Invalid { code: code.into() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_control_can_resolve_through_its_document_but_stops_at_source() {
        let path = source_ancestors(0, |n| Ok(*n == 3), |_| Ok(false), |n| Ok(n + 1)).unwrap();
        assert_eq!(path, [0, 1, 2, 3]);
        // A provider on the document is reachable, the desktop is not in the path.
        assert_eq!(path.into_iter().find(|n| *n == 2), Some(2));
    }
    #[test]
    fn foreign_or_cyclic_focus_has_no_approved_provider_path() {
        let mut visited = 0;
        let result = source_ancestors(
            0,
            |_| Ok(false),
            |_| Ok(false),
            |n| {
                visited += 1;
                Ok(*n)
            },
        );
        assert_eq!(result.unwrap_err(), "selection_unsupported");
        assert_eq!(visited, 32);
    }
    #[test]
    fn password_or_unreadable_ancestor_cannot_fall_back_to_a_document() {
        let result = source_ancestors(0, |n| Ok(*n == 3), |n| Ok(*n == 1), |n| Ok(n + 1));
        assert_eq!(result.unwrap_err(), "selection_unavailable");
        let result = source_ancestors(
            0,
            |_| Ok(false),
            |_| Err("selection_unavailable"),
            |n| Ok(n + 1),
        );
        assert_eq!(result.unwrap_err(), "selection_unavailable");
    }
}
