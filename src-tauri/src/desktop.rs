use crate::{
    backups::{read_backup, write_backup},
    storage::Store,
};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub(crate) struct Database(pub(crate) Mutex<Store>);

enum OpenReason {
    Startup {
        background: bool,
    },
    #[cfg(target_os = "macos")]
    Reopen {
        has_visible_windows: bool,
    },
}

fn show_main_for_open(reason: OpenReason) -> bool {
    match reason {
        OpenReason::Startup { background } => !background,
        // The widget can be visible while the main window is hidden.
        #[cfg(target_os = "macos")]
        OpenReason::Reopen {
            has_visible_windows,
        } => {
            let _ = has_visible_windows;
            true
        }
    }
}

pub(crate) fn pause_for_sleep(app: &tauri::AppHandle) {
    let result = app
        .state::<Database>()
        .0
        .lock()
        .map_err(|_| "Comet storage is unavailable.".to_owned())
        .and_then(|mut db| db.pause_at(chrono::Local::now().timestamp_millis()));
    match result {
        Ok(()) => {
            let _ = app.emit_to("main", "comet-state-changed", Value::Null);
        }
        Err(error) => crate::widget_native::report_error(
            app,
            &format!("Comet could not save the paused timer before sleep. {error}"),
        ),
    }
}

#[tauri::command]
fn load_snapshot(
    window: tauri::WebviewWindow,
    database: tauri::State<'_, Database>,
) -> Result<Value, String> {
    crate::widget_bridge::authorize(window.label(), "main")?;
    database
        .0
        .lock()
        .map_err(|_| "Comet storage is unavailable. Restart the app.".to_owned())?
        .load_snapshot()
}

#[tauri::command]
fn load_state(
    window: tauri::WebviewWindow,
    database: tauri::State<'_, Database>,
) -> Result<Option<Value>, String> {
    crate::widget_bridge::authorize(window.label(), "main")?;
    database
        .0
        .lock()
        .map_err(|_| "Comet storage is unavailable. Restart the app.".to_owned())?
        .load()
}
#[tauri::command]
fn save_state(
    window: tauri::WebviewWindow,
    database: tauri::State<'_, Database>,
    value: Value,
    expected_revision: u64,
) -> Result<Value, String> {
    crate::widget_bridge::authorize(window.label(), "main")?;
    database
        .0
        .lock()
        .map_err(|_| "Comet storage is unavailable. Restart the app.".to_owned())?
        .save_checked(&value, expected_revision)
}
#[tauri::command]
fn backup_status(database: tauri::State<'_, Database>) -> Result<Option<String>, String> {
    Ok(database
        .0
        .lock()
        .map_err(|_| "Comet storage is unavailable. Restart the app.".to_owned())?
        .backup_status())
}
#[tauri::command]
fn show_backup_folder(app: tauri::AppHandle) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Unable to locate app data folder.".to_owned())?;
    let folder = crate::backups::prepare_backup_folder(&directory)?;
    let status = std::process::Command::new("/usr/bin/open")
        .arg(&folder)
        .status()
        .map_err(|_| "Unable to open backup folder in Finder.".to_owned())?;
    if !status.success() {
        return Err("Unable to open backup folder in Finder.".into());
    }
    Ok(())
}
#[tauri::command]
fn list_auto_backups(database: tauri::State<'_, Database>) -> Result<Vec<Value>, String> {
    database
        .0
        .lock()
        .map_err(|_| "Comet storage is unavailable. Restart the app.".to_owned())?
        .list_auto_backups()
}
#[tauri::command]
fn restore_auto_backup(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    database: tauri::State<'_, Database>,
    id: String,
) -> Result<Value, String> {
    crate::widget_bridge::authorize(window.label(), "main")?;
    let value = database
        .0
        .lock()
        .map_err(|_| "Comet storage is unavailable. Restart the app.".to_owned())?
        .restore_auto_backup(&id)?;
    app.emit_to("main", "comet-state-changed", Value::Null)
        .map_err(|e| e.to_string())?;
    Ok(value)
}
#[tauri::command]
async fn import_backup(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("Import Comet backup")
            .add_filter("Comet backup", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|_| "Choose a local backup file.".to_owned())?;
        read_backup(&path).map(Some)
    })
    .await
    .map_err(|e| format!("Unable to open the import dialog: {e}"))?
}
#[tauri::command]
async fn export_backup(
    app: tauri::AppHandle,
    content: String,
    filename: String,
) -> Result<bool, String> {
    if filename.is_empty() || filename.contains(['/', '\\']) || filename == "." || filename == ".."
    {
        return Err("Invalid backup filename.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .set_title("Export Comet backup")
            .set_file_name(filename)
            .add_filter("Comet backup", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = file
            .into_path()
            .map_err(|_| "Choose a local backup location.".to_owned())?;
        write_backup(&path, &content)?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("Unable to open the export dialog: {e}"))?
}

pub fn run() {
    let app = tauri::Builder::default()
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            #[cfg(target_os = "macos")]
            {
                // The predefined macOS Quit item calls NSApplication terminate:
                // directly, bypassing the cancellable Tauri ExitRequested event.
                // A normal custom item routes both Quit and Cmd+Q through our
                // durable timer-save guard before the process may exit.
                let items = menu.items()?;
                let app_menu = items
                    .first()
                    .and_then(|item| item.as_submenu())
                    .expect("The default macOS application menu must exist");
                let app_items = app_menu.items()?;
                app_menu.remove_at(app_items.len() - 1)?;
                app_menu.set_text("Comet")?;
                app_menu.append(&tauri::menu::MenuItem::with_id(
                    app,
                    "comet-quit",
                    "Quit Comet",
                    true,
                    Some("CmdOrCtrl+Q"),
                )?)?;
            }
            let restore = tauri::menu::MenuItem::with_id(
                app,
                "comet-restore-backup",
                "Backups…",
                true,
                None::<&str>,
            )?;
            let mut file_menu = None;
            for item in menu.items()? {
                if let Some(submenu) = item.as_submenu() {
                    if submenu.text()?.replace('&', "") == "File" {
                        file_menu = Some(submenu.clone());
                        break;
                    }
                }
            }
            if let Some(file_menu) = file_menu {
                file_menu.append(&restore)?;
            } else {
                menu.append(&tauri::menu::Submenu::with_items(
                    app,
                    "File",
                    true,
                    &[&restore],
                )?)?;
            }
            #[cfg(all(feature = "native-qa", target_os = "macos"))]
            menu.append(&tauri::menu::Submenu::with_items(
                app,
                "QA",
                true,
                &[
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "qa-simulate-sleep",
                        "QA Simulate sleep",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "qa-system-quit",
                        "QA System Quit",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "qa-block-writes",
                        "QA Block writes",
                        true,
                        None::<&str>,
                    )?,
                    &tauri::menu::MenuItem::with_id(
                        app,
                        "qa-allow-writes",
                        "QA Allow writes",
                        true,
                        None::<&str>,
                    )?,
                ],
            )?)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            crate::widget_native::menu_event(app, &event);
            #[cfg(all(feature = "native-qa", target_os = "macos"))]
            if event.id() == "qa-simulate-sleep" {
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    if let Err(error) = crate::macos_widget::qa_simulate_sleep() {
                        handle
                            .dialog()
                            .message(error)
                            .title("Native QA failed")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }) {
                    app.dialog()
                        .message(error.to_string())
                        .title("Native QA failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
            if event.id() == "comet-restore-backup" {
                let _ = app.emit("comet-restore-backup", ());
            }
            if event.id() == "comet-quit" {
                app.exit(0);
            }
            #[cfg(all(feature = "native-qa", target_os = "macos"))]
            if event.id() == "qa-system-quit" {
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    if let Err(error) = crate::macos_quit::qa_system_quit() {
                        handle
                            .dialog()
                            .message(error)
                            .title("Native QA failed")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }) {
                    app.dialog()
                        .message(error.to_string())
                        .title("Native QA failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
            #[cfg(all(feature = "native-qa", target_os = "macos"))]
            if event.id() == "qa-block-writes" || event.id() == "qa-allow-writes" {
                let result = (|| -> Result<(), String> {
                    let enabled = event.id() == "qa-block-writes";
                    app.state::<Database>()
                        .0
                        .lock()
                        .map_err(|_| "QA database lock failed.".to_owned())?
                        .qa_set_read_only(enabled)
                })();
                if let Err(error) = result {
                    app.dialog()
                        .message(error)
                        .title("Native QA failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _| {
            if arguments.iter().any(|arg| arg == "--background") {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--background")
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            // Never redirect release app data through environment variables.
            #[cfg(debug_assertions)]
            let directory = if let Some(qa) = std::env::var_os("COMET_QA_DATA_DIR") {
                let path = std::path::PathBuf::from(qa);
                if !path.is_absolute() {
                    return Err("COMET_QA_DATA_DIR must be absolute".into());
                }
                path
            } else {
                directory
            };
            std::fs::create_dir_all(&directory)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
            }
            let store = Store::open_with_backups(
                &directory.join("comet.sqlite3"),
                &directory.join("backups"),
            )
            .map_err(std::io::Error::other)?;
            app.manage(Database(Mutex::new(store)));
            #[cfg(target_os = "macos")]
            crate::macos_quit::install(app.handle()).map_err(std::io::Error::other)?;
            crate::widget_native::prepare(app.handle(), &directory)
                .map_err(std::io::Error::other)?;
            if show_main_for_open(OpenReason::Startup {
                background: std::env::args().any(|arg| arg == "--background"),
            }) {
                if let Some(main) = app.get_webview_window("main") {
                    main.show()?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            load_snapshot,
            save_state,
            import_backup,
            export_backup,
            backup_status,
            list_auto_backups,
            restore_auto_backup,
            show_backup_folder,
            crate::widget_native::widget_preferences,
            crate::widget_native::widget_toggle_theme,
            crate::widget_native::widget_set_pinned,
            crate::widget_native::widget_set_collapsed,
            crate::widget_native::widget_set_preview,
            crate::widget_native::widget_show,
            crate::widget_native::widget_begin_dragging,
            crate::widget_native::widget_move_dragging,
            crate::widget_native::widget_end_dragging,
            crate::widget_native::widget_open_main,
            crate::widget_native::widget_dispatch,
            crate::widget_native::widget_reply,
            crate::widget_native::controller_publish,
            crate::widget_native::widget_snapshot,
            crate::widget_native::widget_controller_ready
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            if let tauri::WindowEvent::Moved(position) = event {
                crate::widget_native::moved(window, position);
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to start Comet");
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            if show_main_for_open(OpenReason::Reopen {
                has_visible_windows,
            }) {
                if let Err(error) = crate::widget_native::widget_show(app.clone()) {
                    crate::widget_native::report_error(app, &error);
                }
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.unminimize();
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            }
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let result = app
                .state::<Database>()
                .0
                .lock()
                .map_err(|_| "Comet storage is unavailable.".to_owned())
                .and_then(|mut db| db.pause_at(chrono::Local::now().timestamp_millis()));
            if let Err(error) = result {
                api.prevent_exit();
                let _ = app.emit("comet-storage-error", &error);
                app.dialog()
                    .message(format!(
                        "Comet could not save your timer and has stayed open.\n\n{error}"
                    ))
                    .title("Unable to quit Comet")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });
}

#[cfg(test)]
mod opening_tests {
    use super::{show_main_for_open, OpenReason};

    #[test]
    fn background_startup_keeps_main_hidden() {
        assert!(!show_main_for_open(OpenReason::Startup {
            background: true
        }));
        assert!(show_main_for_open(OpenReason::Startup {
            background: false
        }));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn manual_reopen_shows_main_even_when_widget_is_visible() {
        assert!(show_main_for_open(OpenReason::Reopen {
            has_visible_windows: true,
        }));
        assert!(show_main_for_open(OpenReason::Reopen {
            has_visible_windows: false,
        }));
    }
}
