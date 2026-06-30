use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    fs::File,
    hash::{Hash, Hasher},
    io::Read as IoRead,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::UNIX_EPOCH,
};
use tauri::{
    image::Image, utils::config::Color, AppHandle, LogicalPosition, LogicalSize, Manager,
    PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

#[cfg(windows)]
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

#[cfg(windows)]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
#[cfg(windows)]
const DWMWCP_DEFAULT: u32 = 0;
#[cfg(windows)]
const DWMWCP_DONOTROUND: u32 = 1;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "avif", "tif", "tiff",
];
const RESTORED_WINDOW_PHYSICAL_X_OFFSET: f64 = -1.0;
const CATEGORIZER_SIDECAR_FILE_NAME: &str = ".image-categorizer.json";
const CATEGORIZER_MAX_SCAN_DEPTH: usize = 4;
const CATEGORIZER_HASH_SAMPLE_BYTES: usize = 65536;

fn set_app_window_icon(window: &WebviewWindow) {
    let icon = Image::new_owned(include_bytes!("../icons/icon.rgba").to_vec(), 1024, 1024);
    let _ = window.set_icon(icon);
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folder: Option<String>,
    #[serde(default)]
    first_display_folder_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_display_folder: Option<String>,
    #[serde(default)]
    secondary_display_folder_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secondary_display_folder: Option<String>,
    #[serde(default)]
    browse_mode: String,
    #[serde(default)]
    multi_folders: Vec<String>,
    #[serde(default)]
    multi_folder_filter: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    categorized_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    categorized_category_filter: Option<Vec<String>>,
    #[serde(default)]
    startup_browse_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup_folder: Option<String>,
    #[serde(default)]
    startup_multi_folders: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup_multi_folder_filter: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup_categorized_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    startup_categorized_category_filter: Option<Vec<String>>,
    #[serde(default = "default_image_count")]
    image_count: u32,
    #[serde(default)]
    empty_count: u32,
    #[serde(default = "default_display_mode")]
    display_mode: String,
    #[serde(default = "default_slideshow_duration")]
    slideshow_duration: u64,
    #[serde(default = "default_zoom_fill_enabled")]
    zoom_fill_enabled: bool,
    #[serde(default = "default_zoom_fill_level")]
    zoom_fill_level: u32,
    #[serde(default)]
    zoom_fill_version: u32,
    #[serde(default)]
    zoom_fill_bias_direction: String,
    #[serde(default)]
    zoom_fill_bias_amount: u32,
    #[serde(default)]
    square_app_corners: bool,
    #[serde(default)]
    auto_open_slideshow: bool,
    #[serde(default)]
    first_auto_open_slideshow: bool,
    #[serde(default)]
    secondary_auto_open_slideshow: bool,
    #[serde(default = "default_auto_slideshow_source")]
    auto_slideshow_source: String,
    #[serde(default)]
    auto_hide_ui_on_startup: bool,
    #[serde(default = "default_instant_filter_categorized")]
    instant_filter_categorized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window: Option<WindowState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_window: Option<WindowState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secondary_window: Option<WindowState>,
}

fn default_image_count() -> u32 {
    9
}

fn default_display_mode() -> String {
    "random".to_string()
}

fn default_slideshow_duration() -> u64 {
    5000
}

fn default_zoom_fill_enabled() -> bool {
    true
}

fn default_zoom_fill_level() -> u32 {
    2
}

fn default_instant_filter_categorized() -> bool {
    true
}

fn default_auto_slideshow_source() -> String {
    String::new()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            folder: None,
            first_display_folder_enabled: false,
            first_display_folder: None,
            secondary_display_folder_enabled: false,
            secondary_display_folder: None,
            browse_mode: "multi".to_string(),
            multi_folders: Vec::new(),
            multi_folder_filter: None,
            categorized_root: None,
            categorized_category_filter: None,
            startup_browse_mode: "multi".to_string(),
            startup_folder: None,
            startup_multi_folders: Vec::new(),
            startup_multi_folder_filter: None,
            startup_categorized_root: None,
            startup_categorized_category_filter: None,
            image_count: 9,
            empty_count: 0,
            display_mode: "random".to_string(),
            slideshow_duration: 5000,
            zoom_fill_enabled: true,
            zoom_fill_level: 2,
            zoom_fill_version: 2,
            zoom_fill_bias_direction: String::new(),
            zoom_fill_bias_amount: 0,
            square_app_corners: false,
            auto_open_slideshow: false,
            first_auto_open_slideshow: false,
            secondary_auto_open_slideshow: false,
            auto_slideshow_source: String::new(),
            auto_hide_ui_on_startup: false,
            instant_filter_categorized: true,
            window: None,
            first_window: None,
            secondary_window: None,
        }
    }
}

#[derive(Default)]
struct AppState {
    window_counter: AtomicUsize,
    image_window_counter: AtomicUsize,
    /// Floating image window label -> source file path.
    image_paths: Mutex<HashMap<String, String>>,
    /// Floating image window label -> the app window that opened it.
    image_owners: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageInfo {
    path: String,
    modified: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedCategoryView {
    name: String,
    count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedImageView {
    path: String,
    category: String,
    modified: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedRootView {
    root: String,
    categories: Vec<CategorizedCategoryView>,
    images: Vec<CategorizedImageView>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategorizerImageRecord {
    #[serde(default)]
    category: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategorizerSidecar {
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    images: HashMap<String, CategorizerImageRecord>,
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            IMAGE_EXTS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(ext))
        })
        .unwrap_or(false)
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn categorizer_hash_file(path: &Path, size: u64) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut buffer = vec![0u8; CATEGORIZER_HASH_SAMPLE_BYTES.min(size as usize).max(1)];
    let read = file
        .read(&mut buffer)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    size.hash(&mut hasher);
    buffer[..read].hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn collect_categorized_images(
    sidecar: &CategorizerSidecar,
    folder: &Path,
    depth: usize,
    images: &mut Vec<CategorizedImageView>,
    category_counts: &mut HashMap<String, usize>,
) -> Result<(), String> {
    let entries = fs::read_dir(folder)
        .map_err(|error| format!("Failed to read folder {}: {error}", folder.display()))?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            if depth < CATEGORIZER_MAX_SCAN_DEPTH {
                collect_categorized_images(sidecar, &path, depth + 1, images, category_counts)?;
            }
            continue;
        }

        if !path.is_file() || !is_image_path(&path) {
            continue;
        }

        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let Ok(hash) = categorizer_hash_file(&path, metadata.len()) else {
            continue;
        };
        let Some(record) = sidecar.images.get(&hash) else {
            continue;
        };
        let Some(category) = record.category.clone() else {
            continue;
        };

        *category_counts.entry(category.clone()).or_insert(0) += 1;
        images.push(CategorizedImageView {
            path: path.to_string_lossy().to_string(),
            category,
            modified: modified_ms(&path),
        });
    }
    Ok(())
}

fn scan_categorized_root_blocking(root: String) -> Result<CategorizedRootView, String> {
    let root_path = PathBuf::from(&root);
    let sidecar_path = root_path.join(CATEGORIZER_SIDECAR_FILE_NAME);
    let sidecar_raw = fs::read_to_string(&sidecar_path)
        .map_err(|_| "Not a categorized folder (no .image-categorizer.json found).".to_string())?;
    let sidecar: CategorizerSidecar = serde_json::from_str(&sidecar_raw)
        .map_err(|error| format!("Failed to parse .image-categorizer.json: {error}"))?;

    let mut images = Vec::new();
    let mut category_counts: HashMap<String, usize> = HashMap::new();
    collect_categorized_images(&sidecar, &root_path, 0, &mut images, &mut category_counts)?;

    let categories = sidecar
        .categories
        .iter()
        .filter_map(|name| {
            let count = *category_counts.get(name).unwrap_or(&0);
            (count > 0).then(|| CategorizedCategoryView {
                name: name.clone(),
                count,
            })
        })
        .collect();

    Ok(CategorizedRootView {
        root,
        categories,
        images,
    })
}

fn now_iso() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    let rem = secs % 86400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// Howard Hinnant's days-from-civil algorithm (inverse), public-domain.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn set_image_category_blocking(root: String, path: String, category: String) -> Result<(), String> {
    let sidecar_path = PathBuf::from(&root).join(CATEGORIZER_SIDECAR_FILE_NAME);
    let raw = fs::read_to_string(&sidecar_path)
        .map_err(|_| "Not a categorized folder (no .image-categorizer.json found).".to_string())?;
    // Parse as a generic value so any fields the external categorizer tool
    // wrote (beyond `category`) survive the write-back untouched.
    let mut sidecar: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse .image-categorizer.json: {error}"))?;

    let file_path = PathBuf::from(&path);
    let metadata = fs::metadata(&file_path)
        .map_err(|error| format!("Failed to read {}: {error}", file_path.display()))?;
    let hash = categorizer_hash_file(&file_path, metadata.len())?;

    let root_obj = sidecar
        .as_object_mut()
        .ok_or_else(|| "Invalid .image-categorizer.json structure.".to_string())?;

    let categories = root_obj
        .entry("categories")
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if let Some(list) = categories.as_array_mut() {
        if !list
            .iter()
            .any(|value| value.as_str() == Some(category.as_str()))
        {
            list.push(serde_json::Value::String(category.clone()));
        }
    }

    let images = root_obj
        .entry("images")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let images_obj = images
        .as_object_mut()
        .ok_or_else(|| "Invalid .image-categorizer.json images map.".to_string())?;
    let record = images_obj
        .entry(hash)
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    // Mirror the categorizer's own manual assignment: classifiedBy "manual"
    // marks it as a user override so the categorizer's next scan keeps the
    // choice instead of re-running auto-classification over it.
    let classified_at = now_iso();
    match record.as_object_mut() {
        Some(record_obj) => {
            record_obj.insert("category".to_string(), serde_json::Value::String(category));
            record_obj.insert(
                "classifiedBy".to_string(),
                serde_json::Value::String("manual".to_string()),
            );
            record_obj.insert(
                "classifiedAt".to_string(),
                serde_json::Value::String(classified_at),
            );
        }
        None => {
            *record = serde_json::json!({
                "category": category,
                "classifiedBy": "manual",
                "classifiedAt": classified_at,
            });
        }
    }

    let data = serde_json::to_string_pretty(&sidecar)
        .map_err(|error| format!("Failed to serialize .image-categorizer.json: {error}"))?;
    fs::write(&sidecar_path, data)
        .map_err(|error| format!("Failed to write .image-categorizer.json: {error}"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join("settings.json"))
}

fn load_settings_inner(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str::<Settings>(&data).ok())
        .map(normalize_settings)
        .unwrap_or_default()
}

fn normalize_settings(mut settings: Settings) -> Settings {
    if settings.first_window.is_none() {
        settings.first_window = settings.window.take();
    } else {
        settings.window = None;
    }

    if settings.auto_open_slideshow && !settings.first_auto_open_slideshow {
        settings.first_auto_open_slideshow = true;
    }
    settings.auto_open_slideshow = false;

    settings
}

fn save_settings_inner(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory: {error}"))?;
    }
    let data = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, data).map_err(|error| format!("Failed to save settings: {error}"))
}

fn current_logical_window_state(window: &WebviewWindow) -> Result<WindowState, String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Failed to read scale factor: {error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Failed to read window size: {error}"))?;

    Ok(WindowState {
        x: (f64::from(position.x) / scale).round() as i32,
        y: (f64::from(position.y) / scale).round() as i32,
        width: (f64::from(size.width) / scale).round() as u32,
        height: (f64::from(size.height) / scale).round() as u32,
    })
}

fn set_window_bounds(window: &WebviewWindow, state: &WindowState) -> Result<(), String> {
    if state.width == 0 || state.height == 0 {
        return Ok(());
    }
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Failed to read window scale factor: {error}"))?;
    let restored_x = f64::from(state.x) + (RESTORED_WINDOW_PHYSICAL_X_OFFSET / scale);

    window
        .set_position(Position::Logical(LogicalPosition {
            x: restored_x,
            y: f64::from(state.y),
        }))
        .map_err(|error| format!("Failed to restore window position: {error}"))?;
    window
        .set_size(Size::Logical(LogicalSize {
            width: f64::from(state.width),
            height: f64::from(state.height),
        }))
        .map_err(|error| format!("Failed to restore window size: {error}"))?;
    window
        .set_position(Position::Logical(LogicalPosition {
            x: restored_x,
            y: f64::from(state.y),
        }))
        .map_err(|error| format!("Failed to restore final window position: {error}"))
}

fn secondary_window_count(app: &AppHandle) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| label.as_str() != "main")
        .count()
}

fn stagger_window_state(bounds: &WindowState, stagger_index: usize) -> WindowState {
    let steps = i32::try_from(stagger_index.min(1024)).unwrap_or(0);
    let offset = steps.saturating_mul(28);

    WindowState {
        x: bounds.x.saturating_add(offset),
        y: bounds.y.saturating_add(offset),
        width: bounds.width,
        height: bounds.height,
    }
}

/// Closes every floating image window owned by `owner_label` when that
/// window itself is destroyed, so floating viewers never outlive the app
/// window that spawned them.
fn register_owner_cascade_close(app: &AppHandle, owner_label: &str) {
    let app = app.clone();
    let owner_label = owner_label.to_string();
    if let Some(window) = app.get_webview_window(&owner_label) {
        window.on_window_event(move |event| {
            if !matches!(event, WindowEvent::Destroyed) {
                return;
            }
            let state = app.state::<AppState>();
            let owned: Vec<String> = state
                .image_owners
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, owner)| owner.as_str() == owner_label)
                .map(|(label, _)| label.clone())
                .collect();
            for label in owned {
                if let Some(image_window) = app.get_webview_window(&label) {
                    let _ = image_window.close();
                }
            }
        });
    }
}

fn create_viewer_window(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let window_id = state.window_counter.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("viewer-{window_id}");
    let stagger_index = secondary_window_count(app);
    let settings = load_settings_inner(app);

    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "No window configuration found.".to_string())?;
    config.label = label;

    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|error| format!("Failed to create viewer window: {error}"))?
        .build()
        .map_err(|error| format!("Failed to build viewer window: {error}"))?;

    set_app_window_icon(&window);
    let _ = set_square_window_corners(&window, settings.square_app_corners);
    if let Some(bounds) = settings.secondary_window.as_ref() {
        let bounds = stagger_window_state(bounds, stagger_index);
        let _ = set_window_bounds(&window, &bounds);
    }

    let _ = window.unminimize();
    let _ = window.set_focus();
    register_owner_cascade_close(app, window.label());

    Ok(())
}

fn list_multi_folder_images_blocking(folders: Vec<String>) -> Vec<ImageInfo> {
    let mut images = Vec::new();
    for folder in folders {
        let dir = PathBuf::from(folder);
        if !dir.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_file() || !is_image_path(&path) {
                continue;
            }
            images.push(ImageInfo {
                path: path.to_string_lossy().to_string(),
                modified: modified_ms(&path),
            });
        }
    }
    images.sort_by(|a, b| b.modified.cmp(&a.modified));
    images
}

#[tauri::command]
async fn list_multi_folder_images(folders: Vec<String>) -> Result<Vec<ImageInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_multi_folder_images_blocking(folders))
        .await
        .map_err(|error| format!("Multi-folder scan failed: {error}"))
}

#[tauri::command]
async fn scan_categorized_root(root: String) -> Result<CategorizedRootView, String> {
    tauri::async_runtime::spawn_blocking(move || scan_categorized_root_blocking(root))
        .await
        .map_err(|error| format!("Categorized folder scan failed: {error}"))?
}

#[tauri::command]
async fn set_image_category(root: String, path: String, category: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_image_category_blocking(root, path, category))
        .await
        .map_err(|error| format!("Failed to set image category: {error}"))?
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Settings {
    load_settings_inner(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let mut current = load_settings_inner(&app);
    current.folder = settings.folder;
    current.first_display_folder_enabled = settings.first_display_folder_enabled;
    current.first_display_folder = settings.first_display_folder;
    current.secondary_display_folder_enabled = settings.secondary_display_folder_enabled;
    current.secondary_display_folder = settings.secondary_display_folder;
    current.browse_mode = match settings.browse_mode.as_str() {
        "multi" | "categorized" => settings.browse_mode,
        _ => "multi".to_string(),
    };
    current.multi_folders = settings.multi_folders;
    current.multi_folder_filter = settings.multi_folder_filter;
    current.categorized_root = settings.categorized_root;
    current.categorized_category_filter = settings.categorized_category_filter;
    current.startup_browse_mode = match settings.startup_browse_mode.as_str() {
        "multi" | "categorized" => settings.startup_browse_mode,
        _ => "multi".to_string(),
    };
    current.startup_folder = settings.startup_folder;
    current.startup_multi_folders = settings.startup_multi_folders;
    current.startup_multi_folder_filter = settings.startup_multi_folder_filter;
    current.startup_categorized_root = settings.startup_categorized_root;
    current.startup_categorized_category_filter = settings.startup_categorized_category_filter;
    current.image_count = settings.image_count.clamp(4, 99);
    current.empty_count = settings
        .empty_count
        .min(settings.image_count.saturating_sub(1));
    current.display_mode = settings.display_mode;
    current.slideshow_duration = settings.slideshow_duration.max(1000);
    current.zoom_fill_enabled = settings.zoom_fill_enabled;
    current.zoom_fill_level = settings.zoom_fill_level.clamp(1, 3);
    current.zoom_fill_version = settings.zoom_fill_version.max(2);
    current.zoom_fill_bias_direction = match settings.zoom_fill_bias_direction.as_str() {
        "L" | "R" | "U" | "D" => settings.zoom_fill_bias_direction,
        _ => String::new(),
    };
    current.zoom_fill_bias_amount = if current.zoom_fill_bias_direction.is_empty() {
        0
    } else {
        settings.zoom_fill_bias_amount
    };
    current.square_app_corners = settings.square_app_corners;
    current.auto_open_slideshow = false;
    current.first_auto_open_slideshow = settings.first_auto_open_slideshow;
    current.secondary_auto_open_slideshow = settings.secondary_auto_open_slideshow;
    current.auto_slideshow_source = match settings.auto_slideshow_source.as_str() {
        "folders" | "categorized" => settings.auto_slideshow_source,
        _ => "folders".to_string(),
    };
    current.auto_hide_ui_on_startup = settings.auto_hide_ui_on_startup;
    current.instant_filter_categorized = settings.instant_filter_categorized;
    save_settings_inner(&app, &current)
}

#[tauri::command]
fn save_window_position_preset(
    app: AppHandle,
    window: WebviewWindow,
    preset: String,
) -> Result<(), String> {
    let state = current_logical_window_state(&window)?;
    let mut settings = load_settings_inner(&app);

    match preset.as_str() {
        "first" => settings.first_window = Some(state),
        "secondary" => settings.secondary_window = Some(state),
        _ => return Err(format!("Unknown window position preset: {preset}")),
    }

    settings.window = None;
    save_settings_inner(&app, &settings)
}

#[tauri::command]
fn reset_window_position_preset(app: AppHandle, preset: String) -> Result<(), String> {
    let mut settings = load_settings_inner(&app);

    match preset.as_str() {
        "first" => settings.first_window = None,
        "secondary" => settings.secondary_window = None,
        _ => return Err(format!("Unknown window position preset: {preset}")),
    }

    settings.window = None;
    save_settings_inner(&app, &settings)
}

#[cfg(windows)]
fn set_square_window_corners(window: &WebviewWindow, square: bool) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to read window handle: {error}"))?;
    let preference = if square {
        DWMWCP_DONOTROUND
    } else {
        DWMWCP_DEFAULT
    };
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            (&preference as *const u32).cast(),
            std::mem::size_of_val(&preference) as u32,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!("Failed to set window corner preference: {result}"))
    }
}

#[cfg(not(windows))]
fn set_square_window_corners(_window: &WebviewWindow, _square: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn set_window_square_corners(window: WebviewWindow, square: bool) -> Result<(), String> {
    set_square_window_corners(&window, square)
}

#[tauri::command]
fn get_window_label(window: WebviewWindow) -> String {
    window.label().to_string()
}

#[tauri::command]
fn window_start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn open_image_window(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    rect_x: f64,
    rect_y: f64,
    rect_w: f64,
    rect_h: f64,
    natural_w: f64,
    natural_h: f64,
) -> Result<(), String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Failed to read scale factor: {error}"))?;
    let owner_position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;
    let click_center_x_phys = f64::from(owner_position.x) + (rect_x + rect_w / 2.0) * scale;
    let click_center_y_phys = f64::from(owner_position.y) + (rect_y + rect_h / 2.0) * scale;

    let monitor = window
        .current_monitor()
        .map_err(|error| format!("Failed to read current monitor: {error}"))?
        .ok_or_else(|| "No monitor found for window.".to_string())?;
    let mut monitor_scale = monitor.scale_factor();
    let mut mon_left = monitor.position().x;
    let mut mon_top = monitor.position().y;
    let mut mon_right = mon_left + monitor.size().width as i32;
    let mut mon_bottom = mon_top + monitor.size().height as i32;

    if let Ok(monitors) = window.available_monitors() {
        for candidate in monitors {
            let left = candidate.position().x;
            let top = candidate.position().y;
            let right = left + candidate.size().width as i32;
            let bottom = top + candidate.size().height as i32;
            if click_center_x_phys >= f64::from(left)
                && click_center_x_phys < f64::from(right)
                && click_center_y_phys >= f64::from(top)
                && click_center_y_phys < f64::from(bottom)
            {
                monitor_scale = candidate.scale_factor();
                mon_left = left;
                mon_top = top;
                mon_right = right;
                mon_bottom = bottom;
                break;
            }
        }
    }

    // Cap the viewer at 90% of the spawning app window (not the whole monitor),
    // so floating viewers stay smaller than the app that opened them.
    let owner_size = window
        .inner_size()
        .map_err(|error| format!("Failed to read window size: {error}"))?;
    let owner_w = f64::from(owner_size.width) / scale;
    let owner_h = f64::from(owner_size.height) / scale;

    const MAX_FRACTION: f64 = 0.9;
    const MIN_WIDTH: f64 = 200.0;
    const MIN_HEIGHT: f64 = 150.0;

    let max_w = owner_w * MAX_FRACTION;
    let max_h = owner_h * MAX_FRACTION;
    let fit_scale = (max_w / natural_w.max(1.0))
        .min(max_h / natural_h.max(1.0))
        .min(1.0);

    let width = (natural_w * fit_scale).max(MIN_WIDTH.min(max_w));
    let height = (natural_h * fit_scale).max(MIN_HEIGHT.min(max_h));

    // Clamp the initial placement in physical pixels against the monitor under
    // the clicked cell. Keep global monitor origins in physical coordinates the
    // whole way through; converting an origin to logical pixels and back can
    // drift on mixed-DPI multi-monitor layouts.
    const EDGE_INSET_PHYS: i32 = 8;
    const WINDOWS_FRAME_OVERHANG_PHYS: i32 = 2;
    let clamp_left = mon_left + EDGE_INSET_PHYS;
    let clamp_top = mon_top + EDGE_INSET_PHYS;
    let clamp_right = mon_right - EDGE_INSET_PHYS - WINDOWS_FRAME_OVERHANG_PHYS;
    let clamp_bottom = mon_bottom - EDGE_INSET_PHYS - WINDOWS_FRAME_OVERHANG_PHYS;
    let available_w_phys = (clamp_right - clamp_left).max(1);
    let available_h_phys = (clamp_bottom - clamp_top).max(1);

    let width_phys = ((width * monitor_scale).round().max(1.0) as i32).min(available_w_phys);
    let height_phys = ((height * monitor_scale).round().max(1.0) as i32).min(available_h_phys);
    let target_x_phys = (click_center_x_phys - f64::from(width_phys) / 2.0).round() as i32;
    let target_y_phys = (click_center_y_phys - f64::from(height_phys) / 2.0).round() as i32;
    let target_x_phys = target_x_phys.min(clamp_right - width_phys).max(clamp_left);
    let target_y_phys = target_y_phys.min(clamp_bottom - height_phys).max(clamp_top);

    let state = app.state::<AppState>();
    let window_id = state.image_window_counter.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("image-{window_id}");
    let settings = load_settings_inner(&app);

    state
        .image_paths
        .lock()
        .unwrap()
        .insert(label.clone(), path);
    state
        .image_owners
        .lock()
        .unwrap()
        .insert(label.clone(), window.label().to_string());

    let image_window = WebviewWindowBuilder::new(
        &app,
        label.clone(),
        WebviewUrl::App("image-view.html".into()),
    )
    .title("Image")
    .decorations(false)
    .resizable(true)
    .always_on_top(true)
    .shadow(true)
    .background_color(Color(17, 17, 17, 255))
    .build()
    .map_err(|error| format!("Failed to build image window: {error}"))?;

    set_app_window_icon(&image_window);
    let _ = set_square_window_corners(&image_window, settings.square_app_corners);
    // Set size first, then position last: on Windows a resize can nudge the
    // window across DPI boundaries, so the final `set_position` pins the
    // clamped placement. Physical units avoid any logical round-trip drift.
    let _ = image_window.set_size(Size::Physical(PhysicalSize {
        width: width_phys as u32,
        height: height_phys as u32,
    }));
    let _ = image_window.set_position(Position::Physical(PhysicalPosition {
        x: target_x_phys,
        y: target_y_phys,
    }));
    let _ = image_window.show();
    let _ = image_window.set_position(Position::Physical(PhysicalPosition {
        x: target_x_phys,
        y: target_y_phys,
    }));
    let _ = image_window.set_focus();

    let app_for_cleanup = app.clone();
    let label_for_cleanup = label.clone();
    image_window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Destroyed) {
            return;
        }
        let state = app_for_cleanup.state::<AppState>();
        state.image_paths.lock().unwrap().remove(&label_for_cleanup);
        state
            .image_owners
            .lock()
            .unwrap()
            .remove(&label_for_cleanup);
    });

    Ok(())
}

#[tauri::command]
fn get_assigned_image_path(window: WebviewWindow, state: tauri::State<AppState>) -> Option<String> {
    state
        .image_paths
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            let app_for_task = app.clone();

            let _ = app.run_on_main_thread(move || {
                if create_viewer_window(&app_for_task).is_ok() {
                    return;
                }

                if let Some(window) = app_for_task.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings = load_settings_inner(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                set_app_window_icon(&window);
                let _ = set_square_window_corners(&window, settings.square_app_corners);
                if let Some(ref state) = settings.first_window {
                    let _ = set_window_bounds(&window, state);
                }
            }
            register_owner_cascade_close(app.handle(), "main");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_multi_folder_images,
            scan_categorized_root,
            set_image_category,
            load_settings,
            get_window_label,
            reset_window_position_preset,
            save_settings,
            save_window_position_preset,
            set_window_square_corners,
            window_start_drag,
            window_minimize,
            window_close,
            open_image_window,
            get_assigned_image_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
