use std::{fs, path::PathBuf, sync::mpsc, sync::Mutex};

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::RunEvent;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

/** File opened via macOS "Open with…" (delivered as a RunEvent::Opened URL,
 * not argv). Stashed at startup so the frontend's initial_open query finds it. */
struct OpenedFile(Mutex<Option<PathBuf>>);

fn workspace_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("workspace.txt"))
}

/** Scope a workspace dir for the fs plugin. The `.palimpsest` history dir must
 * be allowed explicitly: the recursive glob `dir` + `**` never matches dotfiles
 * (`require_literal_leading_dot` on unix). */
fn scope_workspace(app: &AppHandle, dir: &std::path::Path) -> tauri::Result<()> {
    app.fs_scope().allow_directory(dir, true)?;
    app.fs_scope()
        .allow_directory(dir.join(".palimpsest"), true)?;
    Ok(())
}

fn persist_workspace(app: &AppHandle, path: &std::path::Path) -> tauri::Result<()> {
    if let Some(f) = workspace_file(app) {
        fs::create_dir_all(f.parent().unwrap_or(&f)).map_err(tauri::Error::Io)?;
        fs::write(&f, path.to_string_lossy().as_bytes()).map_err(tauri::Error::Io)?;
    }
    Ok(())
}

fn open_md_file(app: &AppHandle, path: PathBuf) -> Option<(String, String)> {
    if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }
    let dir = path.parent()?;
    scope_workspace(app, dir).ok()?;
    persist_workspace(app, dir).ok()?;
    Some((
        dir.to_string_lossy().to_string(),
        path.file_name()?.to_string_lossy().to_string(),
    ))
}

#[tauri::command]
fn get_workspace(app: AppHandle) -> Result<Option<String>, String> {
    let Some(f) = workspace_file(&app) else {
        return Ok(None);
    };
    match fs::read_to_string(&f) {
        Ok(p) if !p.trim().is_empty() => {
            scope_workspace(&app, PathBuf::from(p.trim()).as_path()).map_err(|e| e.to_string())?;
            Ok(Some(p.trim().to_string()))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
async fn pick_workspace(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = mpsc::channel();
    app.dialog().file().pick_folder(move |dir| {
        let _ = tx.send(dir);
    });
    let Some(dir) = rx.recv().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path: PathBuf = dir.into_path().map_err(|e| e.to_string())?;
    scope_workspace(&app, &path).map_err(|e| e.to_string())?;
    persist_workspace(&app, &path).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/** Open a .md file passed on the command line ("Open with…" on Windows/Linux)
 * or via the macOS Opened event ("Open with…" in Finder / file manager):
 * scope its folder, persist it as the workspace, return (workspace, name). */
#[tauri::command]
fn initial_open(app: AppHandle) -> Option<(String, String)> {
    if let Some(state) = app.try_state::<OpenedFile>() {
        if let Ok(mut slot) = state.0.lock() {
            if let Some(path) = slot.take() {
                if let Some(found) = open_md_file(&app, path) {
                    return Some(found);
                }
            }
        }
    }
    let arg = std::env::args().nth(1)?;
    let path = PathBuf::from(arg.strip_prefix("file://").unwrap_or(&arg));
    open_md_file(&app, path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenedFile(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_workspace,
            pick_workspace,
            initial_open
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // macOS "Open with…": the file arrives as an Apple Event, surfaced
            // as RunEvent::Opened (file URLs). Stash it for initial_open;
            // to_file_path handles the file:// URL decoding. The variant only
            // exists on macOS/iOS/Android — other platforms do nothing.
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Some(state) = _app.try_state::<OpenedFile>() {
                            if let Ok(mut slot) = state.0.lock() {
                                *slot = Some(path);
                                break;
                            }
                        }
                    }
                }
            }
        });
}
