use core_foundation::{
    base::{CFType, CFTypeRef, TCFType},
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
fn selection(element: Element) -> Result<(String, Range, Rect), &'static str> {
    let role = attribute(element, "AXSubrole")
        .ok()
        .and_then(|v| v.downcast::<CFString>());
    if role.is_some_and(|role| role == "AXSecureTextField") {
        return Err("selection_unavailable");
    }
    let text = attribute(element, "AXSelectedText")?
        .downcast::<CFString>()
        .ok_or("selection_unsupported")?
        .to_string();
    if text.trim().is_empty() {
        return Err("selection_empty");
    }
    if text.len() > 15000 {
        return Err("text_too_long");
    }
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
    let mut value = ptr::null();
    let error = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            element,
            CFString::new("AXBoundsForRange").as_concrete_TypeRef(),
            range_value.as_CFTypeRef(),
            &mut value,
        )
    };
    if error != 0 || value.is_null() {
        return Err("selection_unsupported");
    }
    let value = unsafe { CFType::wrap_under_create_rule(value) };
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
    Ok((text, range, rect))
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
    let focused = attribute(app.as_CFTypeRef(), "AXFocusedUIElement")?;
    if focused.type_of() != unsafe { AXUIElementGetTypeID() } {
        return Err("selection_unavailable");
    }
    let (text, range, bounds) = selection(focused.as_CFTypeRef())?;
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
        let (current_text, current_range, current_bounds) = selection(focused.as_CFTypeRef())?;
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
