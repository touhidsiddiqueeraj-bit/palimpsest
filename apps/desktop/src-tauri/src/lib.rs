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

#[tauri::command]
fn get_workspace(app: AppHandle) -> Result<Option<String>, String> {
    let Some(f) = workspace_file(&app) else {
        return Ok(None);
    };
    match fs::read_to_string(&f) {
        Ok(p) if !p.trim().is_empty() => Ok(Some(p.trim().to_string())),
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
    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())?;
    if let Some(f) = workspace_file(&app) {
        fs::create_dir_all(f.parent().unwrap_or(&f)).map_err(|e| e.to_string())?;
        fs::write(&f, path.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_workspace, pick_workspace])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}