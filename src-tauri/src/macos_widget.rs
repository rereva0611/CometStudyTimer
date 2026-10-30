//! Main-thread Cocoa desktop layering and NSWorkspace sleep notifications.
use objc2::{
    ffi, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, ClassBuilder, Imp, Sel},
    sel, MainThreadMarker,
};
use objc2_core_foundation::CGRect;
use std::sync::OnceLock;
use tauri::{Emitter, Manager};
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static HOVER_OWNER_KEY: u8 = 0;
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
}

pub fn set_layer(window: &tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("Widget layering must run on the main thread.".into());
    }
    let ptr = window
        .ns_window()
        .map_err(|e| e.to_string())?
        .cast::<AnyObject>();
    if ptr.is_null() {
        return Err("Widget native window is unavailable.".into());
    }
    // Official CoreGraphics desktopIcon key is 18. Floating NSWindow level is 3.
    // CanJoinAllApplications is used for pinned fullscreen/Stage Manager display.
    let level = if pinned {
        3
    } else {
        (unsafe { CGWindowLevelForKey(18) }) as isize + 1
    };
    let behavior: usize = if pinned {
        (1 << 0) | (1 << 8) | (1 << 18)
    } else {
        (1 << 0) | (1 << 4)
    };
    unsafe {
        let _: () = msg_send![ptr,setLevel:level];
        let _: () = msg_send![ptr,setCollectionBehavior:behavior];
        let _: () = msg_send![ptr,setHidesOnDeactivate:false];
        let _: () = msg_send![ptr,setHasShadow:false];
    }
    Ok(())
}
extern "C-unwind" fn will_sleep(_delegate: &AnyObject, _selector: Sel, _notification: &AnyObject) {
    if let Some(app) = APP.get() {
        crate::desktop::pause_for_sleep(app);
    }
}
extern "C-unwind" fn screens_changed(
    _delegate: &AnyObject,
    _selector: Sel,
    _notification: &AnyObject,
) {
    if let Some(app) = APP.get() {
        if let Err(error) = crate::widget_native::revalidate_geometry(app) {
            crate::widget_native::report_error(app, &error);
        }
    }
}
fn publish_hover(inside: bool) {
    if let Some(app) = APP.get() {
        let _ = app.emit_to(
            "widget",
            "comet-widget-hover",
            serde_json::json!({"inside":inside}),
        );
        #[cfg(feature = "native-qa")]
        unsafe {
            let class = AnyClass::get(c"NSApplication").unwrap();
            let application: *mut AnyObject = msg_send![class, sharedApplication];
            let active: bool = msg_send![application, isActive];
            eprintln!("COMET_QA_HOVER inside={inside} active={active}");
        }
    }
}
extern "C-unwind" fn mouse_entered(_owner: &AnyObject, _selector: Sel, _event: &AnyObject) {
    publish_hover(true);
}
extern "C-unwind" fn mouse_exited(_owner: &AnyObject, _selector: Sel, _event: &AnyObject) {
    publish_hover(false);
}
fn install_hover_tracking(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("widget")
        .ok_or("Widget is unavailable.")?;
    let view = window
        .ns_view()
        .map_err(|e| e.to_string())?
        .cast::<AnyObject>();
    let class = AnyClass::get(c"NSTrackingArea").ok_or("NSTrackingArea is unavailable.")?;
    if view.is_null() {
        return Err("Widget content view is unavailable.".into());
    }
    let superclass = AnyClass::get(c"NSObject").ok_or("NSObject is unavailable.")?;
    let mut builder = ClassBuilder::new(c"CometWidgetHoverOwner", superclass)
        .ok_or("Widget hover owner already exists.")?;
    // A dedicated NSObject owns only our tracking callbacks. In particular,
    // do not replace NSResponder mouse methods on Tao's app delegate or view.
    unsafe {
        builder.add_method(
            sel!(mouseEntered:),
            mouse_entered as extern "C-unwind" fn(_, _, _),
        );
        builder.add_method(
            sel!(mouseExited:),
            mouse_exited as extern "C-unwind" fn(_, _, _),
        );
    }
    let owner_class = builder.register();
    // MouseEnteredAndExited | ActiveAlways | InVisibleRect. AppKit tracks the
    // visible window bounds through preview resizes, even while another app is
    // active. Unlike DOM pointer events this does not require activating Comet.
    let options: usize = 0x01 | 0x80 | 0x200;
    unsafe {
        let owner: Retained<AnyObject> = msg_send![owner_class, new];
        let allocated: *mut AnyObject = msg_send![class, alloc];
        let area: *mut AnyObject = msg_send![allocated,initWithRect:CGRect::ZERO,
            options:options,owner:&*owner,userInfo:std::ptr::null::<AnyObject>()];
        let area = Retained::from_raw(area).ok_or("Unable to create widget mouse tracking.")?;
        // NSTrackingArea does not retain its owner. Associate it with this view
        // so both live and are released with the widget, without a retain cycle.
        ffi::objc_setAssociatedObject(
            view,
            (&HOVER_OWNER_KEY as *const u8).cast(),
            Retained::as_ptr(&owner).cast_mut(),
            ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        let _: () = msg_send![view,addTrackingArea:&*area];
        #[cfg(feature = "native-qa")]
        {
            let actual: usize = msg_send![&*area, options];
            if actual != options {
                return Err("Widget tracking options did not match.".into());
            }
            eprintln!("COMET_QA_HOVER_TRACKING options={actual}");
        }
    }
    Ok(())
}
pub fn install_observers(app: &tauri::AppHandle) -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("Widget observers must be installed on the main thread.".into());
    }
    let app_class = AnyClass::get(c"NSApplication").ok_or("NSApplication is unavailable.")?;
    let workspace_class = AnyClass::get(c"NSWorkspace").ok_or("NSWorkspace is unavailable.")?;
    let string_class = AnyClass::get(c"NSString").ok_or("NSString is unavailable.")?;
    let center_class =
        AnyClass::get(c"NSNotificationCenter").ok_or("NSNotificationCenter is unavailable.")?;
    let application: *mut AnyObject = unsafe { msg_send![app_class, sharedApplication] };
    if application.is_null() {
        return Err("The macOS application is unavailable.".into());
    }
    let delegate: *mut AnyObject = unsafe { msg_send![application, delegate] };
    if delegate.is_null() {
        return Err("The macOS delegate is unavailable.".into());
    }
    let class = unsafe { &*delegate }.class();
    if class.name().to_bytes() != b"TaoAppDelegateParent" {
        return Err("Unsupported macOS delegate for widget observers.".into());
    }
    let sleep = sel!(cometWorkspaceWillSleep:);
    let screens = sel!(cometScreensChanged:);
    if class.instance_method(sleep).is_some() || class.instance_method(screens).is_some() {
        return Err("Widget notification methods already exist.".into());
    }
    APP.set(app.clone())
        .map_err(|_| "Widget observers were already initialized.")?;
    // Add new selectors to Tao's retained delegate without replacing its
    // methods, changing object layout, or retaining an unowned observer object.
    let sleep_imp: Imp = unsafe {
        std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel, &AnyObject), Imp>(will_sleep)
    };
    let screens_imp: Imp = unsafe {
        std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel, &AnyObject), Imp>(
            screens_changed,
        )
    };
    let target = class as *const AnyClass as *mut AnyClass;
    let installed = unsafe {
        ffi::class_addMethod(target, sleep, sleep_imp, c"v@:@".as_ptr()).as_bool()
            && ffi::class_addMethod(target, screens, screens_imp, c"v@:@".as_ptr()).as_bool()
    };
    if !installed {
        return Err("Unable to install macOS widget notification methods.".into());
    }
    unsafe {
        let workspace: *mut AnyObject = msg_send![workspace_class, sharedWorkspace];
        if workspace.is_null() {
            return Err("NSWorkspace is unavailable.".into());
        }
        let workspace_center: *mut AnyObject = msg_send![workspace, notificationCenter];
        let default_center: *mut AnyObject = msg_send![center_class, defaultCenter];
        if workspace_center.is_null() || default_center.is_null() {
            return Err("macOS notification center is unavailable.".into());
        }
        let sleep_name: *mut AnyObject = msg_send![string_class,stringWithUTF8String:c"NSWorkspaceWillSleepNotification".as_ptr()];
        let screens_name: *mut AnyObject = msg_send![string_class,stringWithUTF8String:c"NSApplicationDidChangeScreenParametersNotification".as_ptr()];
        if sleep_name.is_null() || screens_name.is_null() {
            return Err("Unable to create macOS notification names.".into());
        }
        let _: () = msg_send![workspace_center,addObserver:delegate,selector:sleep,name:sleep_name,object:std::ptr::null::<AnyObject>()];
        let _: () = msg_send![default_center,addObserver:delegate,selector:screens,name:screens_name,object:std::ptr::null::<AnyObject>()];
    }
    install_hover_tracking(app)
}

#[cfg(feature = "native-qa")]
pub fn qa_simulate_sleep() -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("Sleep QA must run on the main thread.".into());
    }
    if APP.get().is_none() {
        return Err("Widget sleep observer is not installed.".into());
    }
    let workspace_class = AnyClass::get(c"NSWorkspace").ok_or("NSWorkspace is unavailable.")?;
    let string_class = AnyClass::get(c"NSString").ok_or("NSString is unavailable.")?;
    unsafe {
        let workspace: *mut AnyObject = msg_send![workspace_class, sharedWorkspace];
        if workspace.is_null() {
            return Err("NSWorkspace is unavailable.".into());
        }
        let center: *mut AnyObject = msg_send![workspace, notificationCenter];
        if center.is_null() {
            return Err("NSWorkspace notification center is unavailable.".into());
        }
        let sleep_name: *mut AnyObject = msg_send![string_class,stringWithUTF8String:c"NSWorkspaceWillSleepNotification".as_ptr()];
        if sleep_name.is_null() {
            return Err("Unable to create the sleep notification name.".into());
        }
        // QA posts to the center that install_observers registered with, so
        // the installed will_sleep callback runs without suspending the Mac.
        let _: () = msg_send![center,postNotificationName:sleep_name,object:workspace];
    }
    Ok(())
}
