//! Hold Ctrl+Alt+F24 for native conflict acceptance without touching another app.
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, RegisterHotKey, UnregisterHotKey, VK_F24,
};
#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    // No HWND: the registration belongs to this thread, and process exit
    // also releases it. The bounded lifetime prevents a stranded test fixture.
    unsafe {
        RegisterHotKey(
            None,
            0x4c53,
            MOD_ALT | MOD_CONTROL | MOD_NOREPEAT,
            VK_F24.0 as u32,
        )?;
    }
    println!("Ctrl+Alt+F24 reserved for acceptance");
    std::thread::sleep(std::time::Duration::from_secs(300));
    unsafe {
        UnregisterHotKey(None, 0x4c53)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This fixture reserves a Windows hotkey; use a second app on macOS.");
}
