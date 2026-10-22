#[cfg(any(windows, test))]
fn packed_coordinates(x: i32, y: i32) -> isize {
    (((y as u16 as u32) << 16) | x as u16 as u32) as isize
}

pub fn start(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::{
            Foundation::{LPARAM, POINT, WPARAM},
            UI::{
                Input::KeyboardAndMouse::ReleaseCapture,
                WindowsAndMessaging::{GetCursorPos, HTCAPTION, PostMessageW, WM_NCLBUTTONDOWN},
            },
        };
        let window = window.clone();
        window
            .clone()
            .run_on_main_thread(move || {
                let Ok(hwnd) = window.hwnd() else { return };
                let mut point = POINT::default();
                unsafe {
                    if GetCursorPos(&mut point).is_err() {
                        return;
                    }
                    // ReleaseCapture can return false when no window owns capture.
                    // WM_NCLBUTTONDOWN expects packed screen coordinates, not a POINT pointer.
                    let _ = ReleaseCapture();
                    let _ = PostMessageW(
                        Some(hwnd),
                        WM_NCLBUTTONDOWN,
                        WPARAM(HTCAPTION as usize),
                        LPARAM(packed_coordinates(point.x, point.y)),
                    );
                }
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    window.start_dragging().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn drag_message_coordinates_preserve_signed_multimonitor_positions() {
        for (x, y) in [(950, 376), (-1920, 100), (200, -1080), (-300, -400)] {
            let packed = super::packed_coordinates(x, y);
            assert_eq!(packed as i16 as i32, x);
            assert_eq!((packed >> 16) as i16 as i32, y);
        }
    }
}
