#![windows_subsystem = "windows"]

#[link(name = "kernel32")]
unsafe extern "system" {
    fn AttachConsole(process_id: u32) -> i32;
    fn FreeConsole() -> i32;
    fn GetLastError() -> u32;
    fn GetConsoleWindow() -> *mut std::ffi::c_void;
}

fn main() {
    let mut args = std::env::args().skip(1);
    let pid = args.next().unwrap().parse().unwrap();
    let report = args.next().unwrap();
    // CREATE_NO_WINDOW can leave an attachable headless console. Check for a
    // window after attaching rather than treating attachment itself as a leak.
    let state = if unsafe { AttachConsole(pid) } != 0 {
        let window = unsafe { GetConsoleWindow() };
        unsafe { FreeConsole() };
        if window.is_null() { "none" } else { "window" }
    } else {
        let error = unsafe { GetLastError() };
        assert_eq!(error, 6, "Console probe failed for process {pid}");
        "none"
    };
    std::fs::write(report, state).unwrap();
}
