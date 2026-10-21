use core_foundation::{
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    string::{CFString, CFStringRef},
};
use lingo_sofa_core::overlay::{Rect, SelectionFrame};
use objc2_app_kit::NSWorkspace;
use std::{
    ffi::c_void,
    io::{self, Write},
    ptr,
    time::Duration,
};

type Element = CFTypeRef;
#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
struct Range {
    location: isize,
    length: isize,
}
#[derive(PartialEq)]
enum SelectionRange {
    Text(Range),
    Marker(CFType),
}
type Selected = (String, SelectionRange, Rect);
#[repr(C)]
#[derive(Default)]
struct NativeRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> Element;
    fn AXUIElementCopyAttributeValue(
        element: Element,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementCopyParameterizedAttributeValue(
        element: Element,
        attribute: CFStringRef,
        parameter: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementSetAttributeValue(
        element: Element,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> i32;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, output: *mut c_void) -> bool;
    fn AXValueGetTypeID() -> usize;
    fn AXUIElementGetTypeID() -> usize;
}
fn attribute(element: Element, name: &str) -> Result<CFType, &'static str> {
    let mut value = ptr::null();
    let error = unsafe {
        AXUIElementCopyAttributeValue(
            element,
            CFString::new(name).as_concrete_TypeRef(),
            &mut value,
        )
    };
    if error != 0 || value.is_null() {
        return Err("selection_unsupported");
    }
    Ok(unsafe { CFType::wrap_under_create_rule(value) })
}
fn parameterized(element: Element, name: &str, parameter: &CFType) -> Result<CFType, &'static str> {
    let mut value = ptr::null();
    let error = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            element,
            CFString::new(name).as_concrete_TypeRef(),
            parameter.as_CFTypeRef(),
            &mut value,
        )
    };
    if error != 0 || value.is_null() {
        return Err("selection_unsupported");
    }
    Ok(unsafe { CFType::wrap_under_create_rule(value) })
}
fn checked_text(value: CFType) -> Result<String, &'static str> {
    let text = value
        .downcast::<CFString>()
        .ok_or("selection_unsupported")?
        .to_string();
    if text.trim().is_empty() {
        return Err("selection_empty");
    }
    if text.len() > 15000 {
        return Err("text_too_long");
    }
    Ok(text)
}
fn standard_selection(element: Element) -> Result<Selected, &'static str> {
    let text = checked_text(attribute(element, "AXSelectedText")?)?;
    let range_value = attribute(element, "AXSelectedTextRange")?;
    if range_value.type_of() != unsafe { AXValueGetTypeID() } {
        return Err("selection_unsupported");
    }
    let mut range = Range {
        location: 0,
        length: 0,
    };
    if !unsafe {
        AXValueGetValue(
            range_value.as_CFTypeRef(),
            4,
            (&mut range as *mut Range).cast(),
        )
    } || range.length <= 0
    {
        return Err("selection_unavailable");
    }
    let bounds = selection_bounds(parameterized(element, "AXBoundsForRange", &range_value)?)?;
    Ok((text, SelectionRange::Text(range), bounds))
}
fn marker_selection(element: Element) -> Result<Selected, &'static str> {
    let marker = attribute(element, "AXSelectedTextMarkerRange")?;
    let text = match attribute(element, "AXSelectedText").and_then(checked_text) {
        Ok(text) => text,
        Err("text_too_long") => return Err("text_too_long"),
        Err(_) => checked_text(parameterized(
            element,
            "AXStringForTextMarkerRange",
            &marker,
        )?)?,
    };
    let bounds = selection_bounds(parameterized(
        element,
        "AXBoundsForTextMarkerRange",
        &marker,
    )?)?;
    Ok((text, SelectionRange::Marker(marker), bounds))
}
fn selection_bounds(value: CFType) -> Result<Rect, &'static str> {
    let mut bounds = NativeRect::default();
    if value.type_of() != unsafe { AXValueGetTypeID() }
        || !unsafe {
            AXValueGetValue(
                value.as_CFTypeRef(),
                3,
                (&mut bounds as *mut NativeRect).cast(),
            )
        }
    {
        return Err("invalid_selection_bounds");
    }
    let rect = Rect {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
    };
    if !rect.valid() {
        return Err("invalid_selection_bounds");
    }
    Ok(rect)
}
fn compatible_selection(
    secure: bool,
    standard: impl FnOnce() -> Result<Selected, &'static str>,
    marker: impl FnOnce() -> Result<Selected, &'static str>,
) -> Result<Selected, &'static str> {
    if secure {
        return Err("selection_unavailable");
    }
    match standard() {
        Ok(selected) => Ok(selected),
        Err("text_too_long") => Err("text_too_long"),
        Err(error) => marker().map_err(|marker_error| {
            if marker_error == "selection_unsupported" {
                error
            } else {
                marker_error
            }
        }),
    }
}
fn selection(element: Element) -> Result<Selected, &'static str> {
    let secure = attribute(element, "AXSubrole")
        .ok()
        .and_then(|value| value.downcast::<CFString>())
        .is_some_and(|role| role == "AXSecureTextField");
    compatible_selection(
        secure,
        || standard_selection(element),
        || marker_selection(element),
    )
}
fn selection_element(focused: &CFType) -> Result<(CFType, Selected), &'static str> {
    find_selection_element(
        focused.clone(),
        |element| selection(element.as_CFTypeRef()),
        |element| {
            let parent = attribute(element.as_CFTypeRef(), "AXParent").ok()?;
            (parent.type_of() == unsafe { AXUIElementGetTypeID() }).then_some(parent)
        },
    )
}
fn find_selection_element<T: Clone + PartialEq>(
    focused: T,
    read: impl Fn(&T) -> Result<Selected, &'static str>,
    parent: impl Fn(&T) -> Option<T>,
) -> Result<(T, Selected), &'static str> {
    let mut element = focused;
    let mut last_error = "selection_unsupported";
    for _ in 0..8 {
        match read(&element) {
            Ok(selected) => return Ok((element, selected)),
            Err(error @ ("selection_unavailable" | "text_too_long")) => return Err(error),
            Err(error) => {
                if error != "selection_unsupported" || last_error == "selection_unsupported" {
                    last_error = error;
                }
            }
        }
        let Some(parent) = parent(&element) else {
            break;
        };
        if parent == element {
            break;
        }
        element = parent;
    }
    Err(last_error)
}
fn focused_selection(app: Element) -> Result<(CFType, CFType, Selected), &'static str> {
    let focused = attribute(app, "AXFocusedUIElement")?;
    if focused.type_of() != unsafe { AXUIElementGetTypeID() } {
        return Err("selection_unavailable");
    }
    let (element, selected) = selection_element(&focused)?;
    Ok((focused, element, selected))
}
fn enable_accessibility_tree(app: Element) {
    let enable = |element, name: &str| unsafe {
        AXUIElementSetAttributeValue(
            element,
            CFString::new(name).as_concrete_TypeRef(),
            CFBoolean::true_value().as_CFTypeRef(),
        )
    };
    // Electron documents AXManualAccessibility for third-party assistive clients.
    // Chromium also uses AXEnhancedUserInterface to enable its renderer AX tree.
    // Unsupported attributes on native applications are harmless and ignored.
    enable(app, "AXManualAccessibility");
    enable(app, "AXEnhancedUserInterface");
    if let Ok(window) = attribute(app, "AXFocusedWindow")
        && window.type_of() == unsafe { AXUIElementGetTypeID() }
    {
        enable(window.as_CFTypeRef(), "AXEnhancedUserInterface");
    }
}
// Request Electron's native AX tree before the first editor read: in its
// default auto mode, VS Code prepares the accessible editor asynchronously.
// This is transient assistive-client state, never a user settings change.
fn prepare_selection<T>(
    enable: impl FnOnce(),
    mut read: impl FnMut() -> Result<T, &'static str>,
    mut wait: impl FnMut(),
) -> Result<T, &'static str> {
    enable();
    for attempt in 0..=6 {
        let selected = read();
        if attempt == 6 || !matches!(selected, Err("selection_unsupported" | "selection_empty")) {
            return selected;
        }
        wait();
    }
    unreachable!()
}
fn emit(frame: SelectionFrame) -> Result<(), &'static str> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &frame).map_err(|_| "selection_pipe_closed")?;
    writeln!(stdout)
        .and_then(|_| stdout.flush())
        .map_err(|_| "selection_pipe_closed")
}
fn run() -> Result<(), &'static str> {
    if !unsafe { AXIsProcessTrusted() } {
        // This helper only runs after an explicit capture action. Let macOS
        // identify the responsible app (the launching terminal in development).
        let options = CFDictionary::from_CFType_pairs(&[(
            CFString::new("AXTrustedCheckOptionPrompt"),
            CFBoolean::true_value(),
        )]);
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) };
        return Err("accessibility_permission_required");
    }
    let mut args = std::env::args().skip(1);
    let host: i32 = args
        .next()
        .and_then(|n| n.parse().ok())
        .filter(|pid| *pid > 0)
        .ok_or("selection_unavailable")?;
    let own: i32 = args
        .next()
        .and_then(|n| n.parse().ok())
        .filter(|pid| *pid > 0)
        .ok_or("selection_unavailable")?;
    let front = || {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier())
    };
    if front() != Some(host) {
        return Err("source_window_changed");
    }
    let app = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(host)) };
    let (focused, selected_element, (text, range, bounds)) = prepare_selection(
        || enable_accessibility_tree(app.as_CFTypeRef()),
        || {
            if front() != Some(host) {
                return Err("source_window_changed");
            }
            focused_selection(app.as_CFTypeRef())
        },
        || std::thread::sleep(Duration::from_millis(80)),
    )?;
    if front() != Some(host) {
        return Err("source_window_changed");
    }
    emit(SelectionFrame::Selection {
        text: text.clone(),
        bounds,
    })?;
    loop {
        std::thread::sleep(Duration::from_millis(150));
        if !front().is_some_and(|pid| pid == host || pid == own) {
            return Err("source_window_changed");
        }
        let current = attribute(app.as_CFTypeRef(), "AXFocusedUIElement")?;
        if current != focused {
            return Err("selection_changed");
        }
        let (current_text, current_range, current_bounds) =
            selection(selected_element.as_CFTypeRef())?;
        if current_text != text || current_range != range || !bounds.near(current_bounds) {
            return Err("selection_changed");
        }
        emit(SelectionFrame::Tick {
            bounds: current_bounds,
        })?;
    }
}
pub fn main() {
    if let Err(code) = run() {
        let _ = emit(SelectionFrame::Invalid { code: code.into() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core_foundation::data::CFData;
    use std::cell::Cell;

    fn sample() -> Selected {
        (
            "selected text".into(),
            SelectionRange::Marker(CFData::from_buffer(b"selected range").as_CFType()),
            Rect {
                x: 12.0,
                y: 24.0,
                width: 180.0,
                height: 20.0,
            },
        )
    }

    #[test]
    fn default_editor_tree_is_enabled_before_reading_and_can_become_ready_later() {
        let enabled = Cell::new(false);
        let attempts = Cell::new(0);
        let waits = Cell::new(0);
        let result = prepare_selection(
            || enabled.set(true),
            || {
                assert!(enabled.get());
                attempts.set(attempts.get() + 1);
                if attempts.get() < 4 {
                    Err("selection_unsupported")
                } else {
                    Ok(sample())
                }
            },
            || waits.set(waits.get() + 1),
        );
        assert!(result.is_ok());
        assert_eq!(attempts.get(), 4);
        assert_eq!(waits.get(), 3);
    }

    #[test]
    fn tree_preparation_is_bounded_and_never_retries_secure_or_changed_sources() {
        let waits = Cell::new(0);
        assert!(matches!(
            prepare_selection(
                || {},
                || Err::<(), _>("selection_empty"),
                || waits.set(waits.get() + 1)
            ),
            Err("selection_empty")
        ));
        assert_eq!(waits.get(), 6);
        for code in [
            "selection_unavailable",
            "source_window_changed",
            "text_too_long",
        ] {
            assert_eq!(
                prepare_selection(|| {}, || Err::<(), _>(code), || panic!("unsafe retry")),
                Err(code)
            );
        }
    }

    #[test]
    fn browser_marker_selection_survives_missing_standard_ranges() {
        let (text, range, bounds) =
            compatible_selection(false, || Err("selection_unsupported"), || Ok(sample()))
                .ok()
                .unwrap();
        assert_eq!(text, "selected text");
        assert!(matches!(range, SelectionRange::Marker(_)));
        assert_eq!(bounds, sample().2);
        assert!(range == sample().1);
        let empty_standard =
            compatible_selection(false, || Err("selection_empty"), || Ok(sample()));
        assert!(empty_standard.is_ok());
    }

    #[test]
    fn secure_fields_and_oversized_selections_never_try_other_ranges() {
        assert!(matches!(
            compatible_selection(
                true,
                || panic!("secure text read"),
                || panic!("secure marker read")
            ),
            Err("selection_unavailable")
        ));
        assert!(matches!(
            compatible_selection(
                false,
                || Err("text_too_long"),
                || panic!("oversized text fallback")
            ),
            Err("text_too_long")
        ));
        assert!(matches!(
            checked_text(CFString::new(&"中".repeat(5001)).as_CFType()),
            Err("text_too_long")
        ));
        assert!(matches!(
            selection_bounds(CFString::new("not a rectangle").as_CFType()),
            Err("invalid_selection_bounds")
        ));
    }

    #[test]
    fn focused_child_can_use_its_parent_selection_but_secure_children_stop() {
        let result = find_selection_element(
            0,
            |node| {
                if *node == 2 {
                    Ok(sample())
                } else {
                    Err("selection_unsupported")
                }
            },
            |node| Some(node + 1),
        );
        assert_eq!(result.ok().unwrap().0, 2);
        assert!(matches!(
            find_selection_element(
                0,
                |_| Err("selection_unavailable"),
                |_| panic!("secure ancestor traversal")
            ),
            Err("selection_unavailable")
        ));
    }

    #[test]
    fn parent_queries_are_bounded_and_empty_selection_is_not_hidden() {
        let attempts = Cell::new(0);
        let result = find_selection_element(
            0,
            |_| {
                attempts.set(attempts.get() + 1);
                Err("selection_unsupported")
            },
            |node| Some(1 - node),
        );
        assert!(result.is_err());
        assert_eq!(attempts.get(), 8);
        let result = find_selection_element(
            0,
            |node| {
                if *node == 0 {
                    Err("selection_empty")
                } else {
                    Err("selection_unsupported")
                }
            },
            |node| (*node == 0).then_some(1),
        );
        assert!(matches!(result, Err("selection_empty")));
    }
}
