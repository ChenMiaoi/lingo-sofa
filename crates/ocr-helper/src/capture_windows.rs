use image::RgbImage;
use windows::{
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
    core::w,
};

struct Selection {
    start: Option<POINT>,
    end: POINT,
    bounds: RECT,
    done: bool,
    timed_out: bool,
}
fn region(a: POINT, b: POINT, bounds: RECT) -> Result<RECT, &'static str> {
    if [a, b].iter().any(|p| {
        p.x < 0 || p.y < 0 || p.x >= bounds.right - bounds.left || p.y >= bounds.bottom - bounds.top
    }) {
        return Err("ocr_cross_screen");
    }
    let r = RECT {
        left: a.x.min(b.x),
        top: a.y.min(b.y),
        right: a.x.max(b.x),
        bottom: a.y.max(b.y),
    };
    if r.right - r.left < 4 || r.bottom - r.top < 4 {
        return Err("ocr_cancelled");
    }
    super::validate_dimensions((r.right - r.left) as u32, (r.bottom - r.top) as u32)?;
    Ok(r)
}
unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Selection;
        if ptr.is_null() {
            return DefWindowProcW(hwnd, msg, wp, lp);
        }
        let s = &mut *ptr;
        let point = POINT {
            x: lp.0 as u16 as i16 as i32,
            y: (lp.0 >> 16) as u16 as i16 as i32,
        };
        match msg {
            WM_LBUTTONDOWN => {
                s.start = Some(point);
                s.end = point;
                let _ = SetCapture(hwnd);
            }
            WM_MOUSEMOVE if s.start.is_some() => {
                s.end = point;
                let _ = InvalidateRect(Some(hwnd), None, false);
            }
            WM_LBUTTONUP => {
                s.end = point;
                s.done = true;
                let _ = ReleaseCapture();
                PostQuitMessage(0);
            }
            WM_KEYDOWN if wp.0 == 27 => {
                s.start = None;
                PostQuitMessage(0);
            }
            WM_TIMER => {
                s.timed_out = true;
                PostQuitMessage(0);
            }
            WM_DISPLAYCHANGE => {
                s.start = None;
                PostQuitMessage(0);
            }
            WM_ACTIVATEAPP if wp.0 == 0 => {
                s.start = None;
                PostQuitMessage(0);
            }
            WM_CLOSE => {
                s.start = None;
                PostQuitMessage(0);
            }
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut paint);
                let _ = FillRect(dc, &paint.rcPaint, HBRUSH(GetStockObject(BLACK_BRUSH).0));
                let text: Vec<u16> = "拖动框选文字 · Esc 取消（仅当前屏幕）"
                    .encode_utf16()
                    .collect();
                SetTextColor(dc, COLORREF(0xffffff));
                SetBkMode(dc, TRANSPARENT);
                let _ = TextOutW(dc, 24, 24, &text);
                if let Some(a) = s.start {
                    let old = SelectObject(dc, GetStockObject(WHITE_PEN));
                    let brush = SelectObject(dc, GetStockObject(HOLLOW_BRUSH));
                    let _ = Rectangle(
                        dc,
                        a.x.min(s.end.x),
                        a.y.min(s.end.y),
                        a.x.max(s.end.x),
                        a.y.max(s.end.y),
                    );
                    SelectObject(dc, old);
                    SelectObject(dc, brush);
                }
                let _ = EndPaint(hwnd, &paint);
                return LRESULT(0);
            }
            _ => return DefWindowProcW(hwnd, msg, wp, lp),
        }
        LRESULT(0)
    }
}
pub fn capture() -> Result<(RgbImage, serde_json::Value), &'static str> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if !AreDpiAwarenessContextsEqual(
            GetThreadDpiAwarenessContext(),
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        )
        .as_bool()
        {
            return Err("ocr_capture_failed");
        }
        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor).map_err(|_| "ocr_capture_failed")?;
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("ocr_capture_failed");
        }
        let bounds = info.rcMonitor;
        let instance = GetModuleHandleW(None).map_err(|_| "ocr_capture_failed")?;
        let class = w!("LingoSofaOcrRegion");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance.into(),
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_CROSS).map_err(|_| "ocr_capture_failed")?,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return Err("ocr_capture_failed");
        }
        let mut selection = Selection {
            start: None,
            end: POINT::default(),
            bounds,
            done: false,
            timed_out: false,
        };
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
            class,
            w!("LingoSofa OCR"),
            WS_POPUP,
            bounds.left,
            bounds.top,
            bounds.right - bounds.left,
            bounds.bottom - bounds.top,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .map_err(|_| "ocr_capture_failed")?;
        SetWindowLongPtrW(
            hwnd,
            GWLP_USERDATA,
            &mut selection as *mut Selection as isize,
        );
        if SetLayeredWindowAttributes(hwnd, COLORREF(0), 90, LWA_ALPHA).is_err() {
            let _ = DestroyWindow(hwnd);
            return Err("ocr_capture_failed");
        }
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        if GetForegroundWindow() != hwnd {
            let _ = DestroyWindow(hwnd);
            return Err("ocr_capture_failed");
        }
        if SetTimer(Some(hwnd), 1, 90_000, None) == 0 {
            let _ = DestroyWindow(hwnd);
            return Err("ocr_capture_failed");
        }
        let mut msg = MSG::default();
        let message_error = loop {
            let status = GetMessageW(&mut msg, None, 0, 0).0;
            if status <= 0 {
                break status < 0;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        };
        let _ = KillTimer(Some(hwnd), 1);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        let _ = DestroyWindow(hwnd);
        if message_error {
            return Err("ocr_capture_failed");
        }
        if selection.timed_out {
            return Err("ocr_timeout");
        }
        if !selection.done {
            return Err("ocr_cancelled");
        }
        let r = region(
            selection.start.ok_or("ocr_cancelled")?,
            selection.end,
            selection.bounds,
        )?;
        // Give the compositor time to remove the overlay; capture only the requested rectangle.
        std::thread::sleep(std::time::Duration::from_millis(150));
        let width = r.right - r.left;
        let height = r.bottom - r.top;
        super::validate_dimensions(width as u32, height as u32)?;
        let screen = ScreenDc(GetDC(None));
        if screen.0.is_invalid() {
            return Err("ocr_capture_failed");
        }
        let image = copy_region(
            screen.0,
            bounds.left + r.left,
            bounds.top + r.top,
            width,
            height,
        )?;
        Ok((
            image,
            serde_json::json!({"x":bounds.left+r.left,"y":bounds.top+r.top,"width":width,"height":height}),
        ))
    }
}
struct ScreenDc(HDC);
impl Drop for ScreenDc {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_invalid() {
                ReleaseDC(None, self.0);
            }
        }
    }
}
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}
impl Surface {
    unsafe fn new(width: i32, height: i32) -> Result<Self, &'static str> {
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return Err("ocr_capture_failed");
            }
            let header = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = std::ptr::null_mut();
            let bitmap =
                match CreateDIBSection(Some(dc), &header, DIB_RGB_COLORS, &mut pixels, None, 0) {
                    Ok(bitmap) => bitmap,
                    Err(_) => {
                        let _ = DeleteDC(dc);
                        return Err("ocr_capture_failed");
                    }
                };
            let previous = SelectObject(dc, HGDIOBJ(bitmap.0));
            if previous.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(dc);
                return Err("ocr_capture_failed");
            }
            Ok(Self {
                dc,
                bitmap,
                previous,
            })
        }
    }
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}
unsafe fn copy_region(
    source: HDC,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<RgbImage, &'static str> {
    unsafe {
        let target = Surface::new(width, height)?;
        BitBlt(
            target.dc,
            0,
            0,
            width,
            height,
            Some(source),
            x,
            y,
            SRCCOPY | CAPTUREBLT,
        )
        .map_err(|_| "ocr_capture_failed")?;
        SelectObject(target.dc, target.previous);
        read_bitmap(target.dc, target.bitmap, width, height)
    }
}

unsafe fn read_bitmap(
    memory: HDC,
    bitmap: HBITMAP,
    width: i32,
    height: i32,
) -> Result<RgbImage, &'static str> {
    unsafe {
        let mut data = vec![0u8; width as usize * height as usize * 4];
        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        if GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            Some(data.as_mut_ptr().cast()),
            &mut header,
            DIB_RGB_COLORS,
        ) != height
        {
            return Err("ocr_capture_failed");
        }
        let rgb = data
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| [p[2], p[1], p[0]])
            .collect();
        let image =
            RgbImage::from_raw(width as u32, height as u32, rgb).ok_or("ocr_capture_failed")?;
        Ok(image)
    }
}
pub fn self_test(blank: bool) -> Result<RgbImage, &'static str> {
    unsafe {
        let surface = Surface::new(1600, 320)?;
        let dc = surface.dc;
        let font = CreateFontW(
            64,
            0,
            0,
            0,
            400,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            DEFAULT_PITCH.0 as u32,
            w!("Microsoft YaHei"),
        );
        if font.is_invalid() {
            return Err("ocr_capture_failed");
        }
        let old_font = SelectObject(dc, HGDIOBJ(font.0));
        if old_font.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(font.0));
            return Err("ocr_capture_failed");
        }
        let result = (|| {
            if FillRect(
                dc,
                &RECT {
                    left: 0,
                    top: 0,
                    right: 1600,
                    bottom: 320,
                },
                HBRUSH(GetStockObject(WHITE_BRUSH).0),
            ) == 0
            {
                return Err("ocr_capture_failed");
            }
            SetTextColor(dc, COLORREF(0));
            SetBkColor(dc, COLORREF(0xffffff));
            let english: Vec<u16> = "LingoSofa OCR 42".encode_utf16().collect();
            let chinese: Vec<u16> = "本地识别，校对后翻译。".encode_utf16().collect();
            if !blank
                && (!TextOutW(dc, 24, 24, &english).as_bool()
                    || !TextOutW(dc, 24, 160, &chinese).as_bool())
            {
                return Err("ocr_capture_failed");
            }
            let image = copy_region(dc, 0, 0, 1600, 320)?;
            Ok(image)
        })();
        SelectObject(dc, old_font);
        let _ = DeleteObject(HGDIOBJ(font.0));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_monitor_geometry_and_cross_screen_rejection() {
        let bounds = RECT {
            left: -1920,
            top: -200,
            right: 0,
            bottom: 880,
        };
        let a = POINT { x: 500, y: 100 };
        let b = POINT { x: 100, y: 300 };
        let r = region(a, b, bounds).unwrap();
        assert_eq!(
            (
                r.left + bounds.left,
                r.top + bounds.top,
                r.right - r.left,
                r.bottom - r.top
            ),
            (-1820, -100, 400, 200)
        );
        assert_eq!(
            region(a, POINT { x: 1920, y: 300 }, bounds).unwrap_err(),
            "ocr_cross_screen"
        );
        assert_eq!(region(a, a, bounds).unwrap_err(), "ocr_cancelled");
    }
}
