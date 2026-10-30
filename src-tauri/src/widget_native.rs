use crate::{
    widget_bridge::{authorize, validate_action, validate_controller, validate_reply},
    widget_preferences::{
        clamp_position, initial_position, preview_layout, resize_anchor, valid_day,
        PreferencesStore, PreviewDirection, Rect, PREVIEW_SIZE,
    },
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

pub struct WidgetRuntime(pub Mutex<WidgetInner>);
pub struct WidgetInner {
    pub preferences: PreferencesStore,
    pub controller: Value,
    pub ready: bool,
    pub ignore_moves_until: Option<Instant>,
    pub dragging: bool,
    pub previewing: bool,
    pub preview_direction: PreviewDirection,
}
pub struct WidgetMenu {
    pub pin: tauri::menu::CheckMenuItem<tauri::Wry>,
    pub autostart: tauri::menu::CheckMenuItem<tauri::Wry>,
}
fn lock_error() -> String {
    "Widget preferences are unavailable.".into()
}
fn preview_state(expanded: bool, direction: PreviewDirection) -> Value {
    json!({"expanded":expanded,"direction":direction.as_str()})
}
fn widget(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("widget")
        .ok_or("Widget is unavailable.".into())
}
fn work_area(monitor: &tauri::Monitor) -> Rect {
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    Rect {
        x: work.position.x as f64 / scale,
        y: work.position.y as f64 / scale,
        width: work.size.width as f64 / scale,
        height: work.size.height as f64 / scale,
    }
}
fn preferred_screen(window: &WebviewWindow, position: Option<(f64, f64)>) -> Result<Rect, String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    if let Some((x, y)) = position {
        if let Some(m) = monitors.iter().find(|m| {
            let s = work_area(m);
            x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height
        }) {
            return Ok(work_area(m));
        }
    }
    window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| monitors.first().cloned())
        .map(|m| work_area(&m))
        .ok_or("No display is available.".into())
}
pub fn prepare(app: &tauri::AppHandle, directory: &Path) -> Result<(), String> {
    let mut preferences =
        PreferencesStore::open(&directory.join("widget-preferences.json"), false)?;
    // Debug/native-QA builds may inspect the switch but never modify login items.
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|e| format!("Unable to inspect launch at login: {e}"))?;
    let initialize_production = preferences
        .preferences
        .should_initialize_production_autostart(cfg!(all(
            not(debug_assertions),
            not(feature = "native-qa")
        )));
    #[cfg(all(not(debug_assertions), not(feature = "native-qa")))]
    if initialize_production && !enabled {
        app.autolaunch()
            .enable()
            .map_err(|e| format!("Unable to enable launch at login: {e}"))?;
    }
    preferences.preferences.autostart = app
        .autolaunch()
        .is_enabled()
        .map_err(|e| format!("Unable to inspect launch at login: {e}"))?;
    if initialize_production {
        if !preferences.preferences.autostart {
            return Err("Comet could not confirm launch-at-login initialization.".into());
        }
        preferences.preferences.production_autostart_initialized = true;
        preferences.persist()?;
    }
    let _ = enabled;
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "widget",
        tauri::WebviewUrl::App("widget.html".into()),
    )
    .title("Comet widget")
    .inner_size(320.0, 300.0)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .visible(false)
    .skip_taskbar(true)
    .shadow(false)
    .build()
    .map_err(|e| e.to_string())?;
    app.manage(WidgetRuntime(Mutex::new(WidgetInner {
        preferences,
        controller: Value::Null,
        ready: false,
        ignore_moves_until: None,
        dragging: false,
        previewing: false,
        preview_direction: PreviewDirection::Right,
    })));
    revalidate_geometry(app)?;
    let pinned = app
        .state::<WidgetRuntime>()
        .0
        .lock()
        .map_err(|_| lock_error())?
        .preferences
        .preferences
        .pinned;
    apply_layer(&window, pinned)?;
    apply_appearance(app)?;
    install_tray(app)?;
    #[cfg(target_os = "macos")]
    crate::macos_widget::install_observers(app)?;
    Ok(())
}
fn apply_layer(window: &WebviewWindow, pinned: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = window.clone();
        let app = window.app_handle().clone();
        app.run_on_main_thread(move || {
            if let Err(error) = crate::macos_widget::set_layer(&window, pinned) {
                report_error(window.app_handle(), &error);
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    window
        .set_always_on_top(pinned)
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn revalidate_geometry(app: &tauri::AppHandle) -> Result<(), String> {
    let window = widget(app)?;
    let runtime = app.state::<WidgetRuntime>();
    let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
    inner.previewing = false;
    inner.preview_direction = PreviewDirection::Right;
    let prefs = &mut inner.preferences.preferences;
    let screen = preferred_screen(&window, prefs.position)?;
    let size = prefs.size();
    let position = prefs
        .position
        .map(|p| clamp_position(p, screen, size))
        .unwrap_or_else(|| initial_position(screen, size));
    prefs.position = Some(position);
    prefs.screen = Some(screen);
    inner.ignore_moves_until = Some(Instant::now() + Duration::from_millis(500));
    window
        .set_size(tauri::LogicalSize::new(size.0, size.1))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::LogicalPosition::new(position.0, position.1))
        .map_err(|e| e.to_string())?;
    let result = inner.preferences.persist();
    drop(inner);
    app.emit_to(
        "widget",
        "comet-widget-preview",
        preview_state(false, PreviewDirection::Right),
    )
    .map_err(|e| e.to_string())?;
    result
}
pub fn moved(window: &tauri::Window, position: &tauri::PhysicalPosition<i32>) {
    if window.label() != "widget" {
        return;
    }
    let app = window.app_handle();
    let runtime = app.state::<WidgetRuntime>();
    let result = (|| -> Result<(), String> {
        let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
        if inner.dragging
            || inner.previewing
            || inner
                .ignore_moves_until
                .is_some_and(|until| Instant::now() < until)
        {
            return Ok(());
        }
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let prefs = &mut inner.preferences.preferences;
        prefs.position = Some((position.x as f64 / scale, position.y as f64 / scale));
        prefs.screen = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .map(|m| work_area(&m));
        inner.preferences.persist()
    })();
    if let Err(error) = result {
        report_error(app, &error);
    }
}
pub fn report_error(app: &tauri::AppHandle, error: &str) {
    let _ = app.emit_to("main", "comet-storage-error", error);
    let _ = app.emit_to("widget", "comet-storage-error", error);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog()
        .message(error)
        .title("Comet could not save")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}
fn publish_preferences(app: &tauri::AppHandle, prefs: &Value) -> Result<(), String> {
    if let Some(menu) = app.try_state::<WidgetMenu>() {
        menu.pin
            .set_checked(prefs["pinned"].as_bool().unwrap_or(false))
            .map_err(|e| e.to_string())?;
        menu.autostart
            .set_checked(prefs["autostart"].as_bool().unwrap_or(false))
            .map_err(|e| e.to_string())?;
    }
    app.emit_to("main", "comet-widget-preferences", prefs)
        .map_err(|e| e.to_string())?;
    app.emit_to("widget", "comet-widget-preferences", prefs)
        .map_err(|e| e.to_string())
}
fn apply_appearance(app: &tauri::AppHandle) -> Result<(), String> {
    let dark = app
        .state::<WidgetRuntime>()
        .0
        .lock()
        .map_err(|_| lock_error())?
        .preferences
        .preferences
        .theme
        == "github-dark";
    let theme = if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    };
    for label in ["main", "widget"] {
        if let Some(window) = app.get_webview_window(label) {
            window.set_theme(Some(theme)).map_err(|e| e.to_string())?;
            if label == "main" {
                let color = if dark {
                    tauri::window::Color(13, 17, 23, 255)
                } else {
                    tauri::window::Color(255, 252, 249, 255)
                };
                window
                    .set_background_color(Some(color))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub fn widget_toggle_theme(window: WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    authorize(window.label(), "main")?;
    let runtime = app.state::<WidgetRuntime>();
    let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
    let value = inner.preferences.toggle_theme()?;
    drop(inner);
    // Publish durable preference even if a platform-specific titlebar update fails.
    publish_preferences(&app, &value)?;
    apply_appearance(&app)?;
    Ok(value)
}
#[tauri::command]
pub fn widget_preferences(app: tauri::AppHandle) -> Result<Value, String> {
    let runtime = app.state::<WidgetRuntime>();
    let inner = runtime.0.lock().map_err(|_| lock_error())?;
    let mut value = inner.preferences.preferences.public_value();
    value["previewing"] = json!(inner.previewing);
    value["previewDirection"] = json!(inner.preview_direction.as_str());
    Ok(value)
}
#[tauri::command]
pub fn widget_set_preview(window: WebviewWindow, expanded: bool) -> Result<Value, String> {
    authorize(window.label(), "widget")?;
    let app = window.app_handle();
    let runtime = app.state::<WidgetRuntime>();
    let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
    let expanded = expanded && inner.preferences.preferences.collapsed && !inner.dragging;
    if expanded == inner.previewing {
        return Ok(preview_state(expanded, inner.preview_direction));
    }
    let anchor = inner
        .preferences
        .preferences
        .position
        .ok_or("Widget position is unavailable.")?;
    let screen = preferred_screen(&window, Some(anchor))?;
    let (position, direction) = if expanded {
        let layout = preview_layout(anchor, screen);
        (layout.position, layout.direction)
    } else {
        (anchor, inner.preview_direction)
    };
    let size = if expanded {
        PREVIEW_SIZE
    } else {
        inner.preferences.preferences.size()
    };
    let old_size = window.inner_size().map_err(|e| e.to_string())?;
    let old_position = window.outer_position().map_err(|e| e.to_string())?;
    inner.ignore_moves_until = Some(Instant::now() + Duration::from_millis(500));
    let result = window
        .set_size(tauri::LogicalSize::new(size.0, size.1))
        .and_then(|_| window.set_position(tauri::LogicalPosition::new(position.0, position.1)));
    if let Err(error) = result {
        let _ = window.set_size(old_size);
        let _ = window.set_position(old_position);
        return Err(format!("Unable to show the hover timer: {error}"));
    }
    // The saved anchor remains untouched: preview movements are transient.
    inner.previewing = expanded;
    inner.preview_direction = direction;
    drop(inner);
    let value = preview_state(expanded, direction);
    app.emit_to("widget", "comet-widget-preview", &value)
        .map_err(|e| e.to_string())?;
    Ok(value)
}
#[tauri::command]
pub fn widget_set_pinned(app: tauri::AppHandle, pinned: bool) -> Result<Value, String> {
    let runtime = app.state::<WidgetRuntime>();
    let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
    let old = inner.preferences.preferences.clone();
    inner.preferences.preferences.pinned = pinned;
    if let Err(error) = inner.preferences.persist() {
        inner.preferences.preferences = old;
        return Err(error);
    }
    let value = inner.preferences.preferences.public_value();
    drop(inner);
    apply_layer(&widget(&app)?, pinned)?;
    publish_preferences(&app, &value)?;
    Ok(value)
}
#[tauri::command]
pub fn widget_set_collapsed(app: tauri::AppHandle, collapsed: bool) -> Result<Value, String> {
    let runtime = app.state::<WidgetRuntime>();
    let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
    let old = inner.preferences.preferences.clone();
    let prefs = &mut inner.preferences.preferences;
    let before = prefs.size();
    prefs.collapsed = collapsed;
    if let Some(position) = prefs.position {
        prefs.position = Some(resize_anchor(position, before, prefs.size()));
    }
    if let Err(error) = inner.preferences.persist() {
        inner.preferences.preferences = old;
        return Err(error);
    }
    drop(inner);
    revalidate_geometry(&app)?;
    let value = widget_preferences(app.clone())?;
    publish_preferences(&app, &value)?;
    Ok(value)
}
#[tauri::command]
pub fn widget_show(app: tauri::AppHandle) -> Result<(), String> {
    revalidate_geometry(&app)?;
    if app
        .state::<WidgetRuntime>()
        .0
        .lock()
        .map_err(|_| lock_error())?
        .ready
    {
        widget(&app)?.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn valid_drag_position(x: f64, y: f64) -> bool {
    x.is_finite() && y.is_finite() && x.abs() < 1_000_000.0 && y.abs() < 1_000_000.0
}

#[tauri::command]
pub fn widget_begin_dragging(window: WebviewWindow) -> Result<(f64, f64), String> {
    authorize(window.label(), "widget")?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let outer_position = window.outer_position().map_err(|e| e.to_string())?;
    let mut position = (
        outer_position.x as f64 / scale,
        outer_position.y as f64 / scale,
    );
    let runtime = window.app_handle().state::<WidgetRuntime>();
    let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
    if inner.previewing {
        // A left preview's window begins at the clock, 128px before the icon.
        // Restore the icon origin before shrinking and use it as the drag base.
        position = inner.preview_direction.icon_position(position);
        let old_size = window.inner_size().map_err(|e| e.to_string())?;
        inner.ignore_moves_until = Some(Instant::now() + Duration::from_millis(500));
        let result = window
            .set_position(tauri::LogicalPosition::new(position.0, position.1))
            .and_then(|_| window.set_size(tauri::LogicalSize::new(48.0, 48.0)));
        if let Err(error) = result {
            let _ = window.set_size(old_size);
            let _ = window.set_position(outer_position);
            return Err(format!("Unable to start dragging the widget: {error}"));
        }
        inner.previewing = false;
        inner.preferences.preferences.position = Some(position);
        window
            .app_handle()
            .emit_to(
                "widget",
                "comet-widget-preview",
                preview_state(false, inner.preview_direction),
            )
            .map_err(|e| e.to_string())?;
    }
    inner.dragging = true;
    Ok(position)
}

#[tauri::command]
pub fn widget_move_dragging(window: WebviewWindow, x: f64, y: f64) -> Result<(f64, f64), String> {
    authorize(window.label(), "widget")?;
    if !valid_drag_position(x, y) {
        return Err("Invalid widget position.".into());
    }
    let runtime = window.app_handle().state::<WidgetRuntime>();
    let size = {
        let inner = runtime.0.lock().map_err(|_| lock_error())?;
        if !inner.dragging {
            return Err("Widget drag is not active.".into());
        }
        inner.preferences.preferences.size()
    };
    let screen = preferred_screen(&window, Some((x, y)))?;
    let position = clamp_position((x, y), screen, size);
    window
        .set_position(tauri::LogicalPosition::new(position.0, position.1))
        .map_err(|e| e.to_string())?;
    let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
    inner.preferences.preferences.position = Some(position);
    inner.preferences.preferences.screen = Some(screen);
    Ok(position)
}

#[cfg(test)]
mod drag_tests {
    use super::{preview_state, valid_drag_position, PreviewDirection};

    #[test]
    fn drag_coordinates_reject_nonfinite_and_unbounded_positions() {
        assert!(valid_drag_position(-1440.0, 900.0));
        assert!(!valid_drag_position(f64::NAN, 0.0));
        assert!(!valid_drag_position(0.0, f64::INFINITY));
        assert!(!valid_drag_position(1_000_000.0, 0.0));
    }
    #[test]
    fn hover_preview_payload_always_includes_the_current_direction() {
        for expanded in [false, true] {
            for (direction, expected) in [
                (PreviewDirection::Left, "left"),
                (PreviewDirection::Right, "right"),
            ] {
                assert_eq!(
                    preview_state(expanded, direction),
                    serde_json::json!({"expanded":expanded,"direction":expected})
                );
            }
        }
    }
}

#[tauri::command]
pub fn widget_end_dragging(window: WebviewWindow) -> Result<(), String> {
    authorize(window.label(), "widget")?;
    let runtime = window.app_handle().state::<WidgetRuntime>();
    let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
    if !inner.dragging {
        return Ok(());
    }
    inner.dragging = false;
    inner.ignore_moves_until = Some(Instant::now() + Duration::from_millis(500));
    inner.preferences.persist()
}
#[tauri::command]
pub fn widget_open_main(app: tauri::AppHandle, date: Option<String>) -> Result<(), String> {
    if date.as_ref().is_some_and(|d| !valid_day(d)) {
        return Err("Invalid calendar date.".into());
    }
    let main = app
        .get_webview_window("main")
        .ok_or("Comet main window is unavailable.")?;
    main.unminimize().map_err(|e| e.to_string())?;
    main.show().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())?;
    if let Some(date) = date {
        app.emit_to("main", "comet-open-day", date)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn widget_dispatch(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    action: Value,
) -> Result<(), String> {
    authorize(window.label(), "widget")?;
    validate_action(&request_id, &action)?;
    app.emit_to(
        "main",
        "comet-widget-action",
        json!({"requestId":request_id,"action":action}),
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn widget_reply(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    authorize(window.label(), "main")?;
    validate_reply(&request_id, &result)?;
    app.emit_to(
        "widget",
        "comet-widget-reply",
        json!({"requestId":request_id,"result":result}),
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn controller_publish(
    window: WebviewWindow,
    app: tauri::AppHandle,
    snapshot: Value,
) -> Result<(), String> {
    authorize(window.label(), "main")?;
    validate_controller(&snapshot)?;
    app.state::<WidgetRuntime>()
        .0
        .lock()
        .map_err(|_| lock_error())?
        .controller = snapshot.clone();
    app.emit_to("widget", "comet-controller-state", snapshot)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn widget_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(app
        .state::<WidgetRuntime>()
        .0
        .lock()
        .map_err(|_| lock_error())?
        .controller
        .clone())
}
#[tauri::command]
pub fn widget_controller_ready(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    authorize(window.label(), "main")?;
    app.state::<WidgetRuntime>()
        .0
        .lock()
        .map_err(|_| lock_error())?
        .ready = true;
    widget_show(app)
}
fn set_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(any(debug_assertions, feature = "native-qa"))]
    {
        let _ = (app, enabled);
        return Err("Launch at login is disabled in development and QA builds.".into());
    }
    #[cfg(all(not(debug_assertions), not(feature = "native-qa")))]
    {
        if enabled {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        }
        .map_err(|e| format!("Unable to update launch at login: {e}"))?;
        let actual = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
        let runtime = app.state::<WidgetRuntime>();
        let mut inner = runtime.0.lock().map_err(|_| lock_error())?;
        inner.preferences.preferences.autostart = actual;
        inner
            .preferences
            .preferences
            .production_autostart_initialized = true;
        inner.preferences.persist()?;
        let value = inner.preferences.preferences.public_value();
        drop(inner);
        publish_preferences(app, &value)
    }
}
pub fn menu_event(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
    let result = match event.id().as_ref() {
        "widget-open-main" => widget_open_main(app.clone(), None),
        "widget-show" => widget_show(app.clone()),
        "widget-pin" => widget_preferences(app.clone()).and_then(|p| {
            widget_set_pinned(app.clone(), !p["pinned"].as_bool().unwrap_or(false)).map(|_| ())
        }),
        "widget-autostart" => widget_preferences(app.clone())
            .and_then(|p| set_autostart(app, !p["autostart"].as_bool().unwrap_or(false))),
        _ => Ok(()),
    };
    if let Err(error) = result {
        report_error(app, &error);
    }
}
fn install_tray(app: &tauri::AppHandle) -> Result<(), String> {
    let prefs = widget_preferences(app.clone())?;
    let pin = tauri::menu::CheckMenuItem::with_id(
        app,
        "widget-pin",
        "Pin widget",
        true,
        prefs["pinned"].as_bool().unwrap_or(false),
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let autostart = tauri::menu::CheckMenuItem::with_id(
        app,
        "widget-autostart",
        "Launch at login",
        !cfg!(any(debug_assertions, feature = "native-qa")),
        prefs["autostart"].as_bool().unwrap_or(false),
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let menu = tauri::menu::Menu::with_items(
        app,
        &[
            &tauri::menu::MenuItem::with_id(
                app,
                "widget-open-main",
                "Open Comet",
                true,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?,
            &tauri::menu::MenuItem::with_id(app, "widget-show", "Show widget", true, None::<&str>)
                .map_err(|e| e.to_string())?,
            &pin,
            &autostart,
            &tauri::menu::PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &tauri::menu::MenuItem::with_id(app, "comet-quit", "Quit Comet", true, None::<&str>)
                .map_err(|e| e.to_string())?,
        ],
    )
    .map_err(|e| e.to_string())?;
    // A 16×16 monochrome template remains crisp and follows the menu bar theme.
    let mut rgba = vec![0u8; 16 * 16 * 4];
    for y in 0..16usize {
        for x in 0..16usize {
            let dx = x as i32 - 10;
            let dy = y as i32 - 5;
            if dx * dx + dy * dy <= 12
                || (x + y >= 12 && x + y <= 15 && x >= 2 && y >= 6 && x <= 10)
            {
                rgba[(y * 16 + x) * 4 + 3] = 255;
            }
        }
    }
    tauri::tray::TrayIconBuilder::with_id("comet-widget-tray")
        .icon(tauri::image::Image::new_owned(rgba, 16, 16))
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app)
        .map_err(|e| e.to_string())?;
    app.manage(WidgetMenu { pin, autostart });
    Ok(())
}
