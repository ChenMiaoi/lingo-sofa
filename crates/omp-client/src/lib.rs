pub mod client;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
pub mod protocol;
pub mod usage;
pub mod vault;
pub use lingo_sofa_core::{Result, scheduler};
pub use platform::Job;
