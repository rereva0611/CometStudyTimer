pub mod auto_backups;
pub mod backups;
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod macos_widget;
pub mod storage;
pub mod widget_bridge;
#[cfg(feature = "desktop")]
mod widget_native;
pub mod widget_preferences;
#[cfg(feature = "desktop")]
pub use desktop::run;
#[cfg(all(feature = "desktop", target_os = "macos"))]
mod macos_quit;
