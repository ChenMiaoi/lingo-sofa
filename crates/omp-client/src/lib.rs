#![cfg(windows)]
pub mod client;
pub mod protocol;
pub mod usage;
pub mod vault;
mod windows;
pub use lingo_sofa_core::{Result, scheduler};
pub use windows::Job;
