use std::{
    fs,
    path::PathBuf,
    sync::mpsc,
};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

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
    app.fs_scope().allow_directory(dir.join(".palimpsest"), true)?;
    Ok(())
}

fn persist_workspace(app: &AppHandle, path: &std::path::Path) -> tauri::Result<()> {
    if let Some(f) = workspace_file(app) {
        fs::create_dir_all(f.parent().unwrap_or(&f)).map_err(tauri::Error::Io)?;
        fs::write(&f, path.to_string_lossy().as_bytes()).map_err(tauri::Error::Io)?;
    }
    Ok(())
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
    app.dialog()
        .file()
        .pick_folder(move |dir| {
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

/** Open a .md file passed on the command line ("Open with…" in file managers):
 * scope its folder, persist it as the workspace, return (workspace, name). */
#[tauri::command]
fn initial_open(app: AppHandle) -> Option<(String, String)> {
    let arg = std::env::args().nth(1)?;
    let path = PathBuf::from(arg.strip_prefix("file://").unwrap_or(&arg));
    if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }
    let dir = path.parent()?;
    scope_workspace(&app, dir).ok()?;
    persist_workspace(&app, dir).ok()?;
    Some((
        dir.to_string_lossy().to_string(),
        path.file_name()?.to_string_lossy().to_string(),
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_workspace, pick_workspace, initial_open])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}