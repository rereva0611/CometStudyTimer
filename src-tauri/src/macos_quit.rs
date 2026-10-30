//! Cocoa's Dock Quit calls `terminate:` instead of the custom app-menu event.
//! Tao currently implements `applicationWillTerminate:` but no cancellable
//! `applicationShouldTerminate:`. Add that missing method to its existing
//! delegate class, without changing the delegate object, class or its ivars.

use objc2::{
    ffi, msg_send,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
use std::sync::OnceLock;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// QA uses Cocoa's exact Dock Quit entry point, rather than the custom menu.
/// This code is absent from production builds and exposes no frontend IPC.
#[cfg(feature = "native-qa")]
pub fn qa_system_quit() -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("QA System Quit must run on the main thread.".into());
    }
    let class = AnyClass::get(c"NSApplication").ok_or("NSApplication is unavailable.")?;
    // SAFETY: Same system class/main-thread/object checks as install(). Cocoa
    // permits a nil sender for terminate:, and Comet's delegate cancels direct
    // termination and queues the cancellable Tauri exit/save path.
    let application: *mut AnyObject = unsafe { msg_send![class, sharedApplication] };
    if application.is_null() {
        return Err("The QA application is unavailable.".into());
    }
    let _: () = unsafe { msg_send![application, terminate: std::ptr::null::<AnyObject>()] };
    Ok(())
}

extern "C-unwind" fn application_should_terminate(
    _delegate: &AnyObject,
    _selector: Sel,
    _application: &AnyObject,
) -> usize {
    // Cancel Cocoa's direct termination. Tauri's queued exit request runs the
    // shared SQLite pause/save guard and can keep Comet open if saving fails.
    if let Some(app) = APP.get() {
        app.exit(0);
    }
    // NSTerminateCancel is NSUInteger(0), never NSTerminateNow.
    0
}

pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("Comet's macOS quit guard must be installed on the main thread.".into());
    }
    if usize::BITS != 64 {
        return Err("Comet's macOS quit guard requires a 64-bit Mac.".into());
    }
    let application_class =
        AnyClass::get(c"NSApplication").ok_or("Unable to find the macOS application class.")?;

    // SAFETY: NSApplication is the system AppKit class; sharedApplication and
    // delegate are object-returning Cocoa selectors. Installation runs only on
    // the main thread. Tao owns and retains the delegate for the app lifetime.
    let application: *mut AnyObject = unsafe { msg_send![application_class, sharedApplication] };
    if application.is_null() {
        return Err("Unable to find the running macOS application.".into());
    }
    let delegate: *mut AnyObject = unsafe { msg_send![application, delegate] };
    if delegate.is_null() {
        return Err("Unable to find the macOS application delegate.".into());
    }
    let class = unsafe { &*delegate }.class();
    // Verify the expected runtime owner before modifying its method table.
    // A future incompatible Tao runtime fails startup instead of weakening the
    // durable-save-on-quit guarantee or replacing another delegate's policy.
    if class.name().to_bytes() != b"TaoAppDelegateParent" {
        return Err(
            "The macOS application delegate is incompatible with Comet's quit guard.".into(),
        );
    }
    let selector = sel!(applicationShouldTerminate:);
    if class.instance_method(selector).is_some() {
        return Err("The macOS application already defines a quit policy; Comet's save guard could not be installed.".into());
    }
    APP.set(app.clone())
        .map_err(|_| "Comet's macOS quit guard was already initialized.".to_owned())?;

    // SAFETY: The selector is verified absent, so no implementation is
    // replaced. The callback receives Cocoa's hidden id/SEL arguments and one
    // NSApplication id; its NSUInteger return is usize on this verified 64-bit
    // platform. Q@:@ is exactly that Objective-C ABI. The static function and
    // OnceLock AppHandle live until process exit. No ivars or layout change.
    let implementation: Imp = unsafe {
        std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel, &AnyObject) -> usize, Imp>(
            application_should_terminate,
        )
    };
    let installed = unsafe {
        ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            implementation,
            c"Q@:@".as_ptr(),
        )
    };
    if !installed.as_bool() {
        return Err("Unable to install Comet's macOS save-on-quit guard.".into());
    }
    Ok(())
}
