use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    fs::File,
    hash::{Hash, Hasher},
    io::Read as IoRead,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{
    image::Image, utils::config::Color, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager,
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

// Only formats WebView2 can actually decode. `tif`/`tiff` used to be here and
// were the worst kind of listing: the scan counted them, the grid drew a cell
// for them, and Chromium has no TIFF decoder — so they were permanently blank
// tiles that kept getting re-drawn. A format the viewer cannot show does not
// belong in the pool.
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "avif"];
/// How far below a chosen folder the plain-folder scan walks. Deeper than the
/// categorized scan's cap of 4 on purpose: that one hashes every file it finds,
/// so its depth limit is protecting real work, while this one only reads
/// directory entries. Picking a folder is also an explicit "show me what is in
/// here", and real photo trees nest further than four
/// (Photos/2024/Summer/Trip/DCIM/100CANON/…). Still capped, so a symlink loop
/// or a drive root terminates.
const MULTI_FOLDER_MAX_SCAN_DEPTH: usize = 8;
const RESTORED_WINDOW_PHYSICAL_X_OFFSET: f64 = -1.0;
const CATEGORIZER_SIDECAR_FILE_NAME: &str = ".image-categorizer.json";
const CATEGORIZER_OCR_TEXT_DIR_NAME: &str = ".image-categorizer-ocr-text";
// Curated image sets built by the sibling image-categorizer (country sets, from its geo layer).
// Members are content hashes, the same keying the OCR sidecar uses, so they resolve through the
// hash cache the categorized scan already maintains.
const CATEGORIZER_GEO_SETS_FILE_NAME: &str = ".image-categorizer-geo-sets.json";
// Images kicked out of geo set building by hand. Shared with image-categorizer, which honours it
// when rebuilding sets — so an exclusion made here survives the next rebuild instead of being
// undone by it.
const CATEGORIZER_GEO_EXCLUDED_FILE_NAME: &str = ".image-categorizer-geo-excluded.json";
const CATEGORIZER_GEO_EXCLUDED_NOTE: &str =
    "Images excluded from geo sets, keyed by content hash. They keep their category and still \
appear everywhere else - they are only kept out of country set building. Delete a line to let one \
back in; image-categorizer reads this file when it rebuilds sets.";
const CATEGORIZED_OCR_SNIPPET_MAX_CHARS: usize = 160;
const CATEGORIZER_MAX_SCAN_DEPTH: usize = 4;
const CATEGORIZER_HASH_SAMPLE_BYTES: usize = 65536;
const CATEGORIZED_HASH_CACHE_FILE_NAME: &str = "categorized-hash-cache.json";
const CATEGORIZED_HASH_MAX_THREADS: usize = 8;
const CATEGORIZED_SCAN_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const CATEGORIZED_SCAN_PROGRESS_EVENT: &str = "categorized-scan-progress";

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
    /// The geo SCOPE: `"any"` (rotate across every country) or `"country"` (rotate within
    /// `categorized_set_country`). `None` = nothing picked yet. It is remembered independently of
    /// the mode and only reaches the grid while `browse_mode == "geo"` — a set replaces the
    /// category filter rather than intersecting with it (a curated sixteen diluted into a
    /// seventeen-thousand-image category is no longer a set), so it must never be able to take
    /// over the categorized pool just by having been selected once.
    ///
    /// The *selection* persists, never the particular set on screen: which set is showing is
    /// re-rolled on every new board, so storing it would only pin a random draw.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    categorized_set_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    categorized_set_country: Option<String>,
    /// Mix mode's tile split: the percentage of each board drawn from the country set, the rest
    /// from the category filter. 0 = all categorized, 100 = all geo. It is a *board* ratio, not a
    /// pool weight — the two pools never merge, because a curated sixteen dropped into a
    /// seventeen-thousand-image category would draw roughly none of the tiles.
    #[serde(default = "default_blend_geo_ratio")]
    mix_geo_ratio: u32,
    /// Alt mode's BOARD split: the percentage of whole boards that are geo boards, the rest drawn
    /// entirely from the category filter. Same 0-100 scale as `mix_geo_ratio` and deliberately a
    /// separate setting — one is "how much of a board", the other "how many boards", and a user
    /// who wants a heavy blend does not necessarily want geo four boards out of five.
    #[serde(default = "default_blend_geo_ratio")]
    alt_geo_ratio: u32,
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
    /// The continuous 0-100 slider position. `None` means "never saved" and
    /// must stay distinguishable from `Some(0)`, which means zoom fill off:
    /// the frontend only falls back to deriving the amount from
    /// `zoom_fill_level` while this is absent, so defaulting it to 0 would read
    /// as a real "off" and silently disable zoom fill for existing settings.
    #[serde(default)]
    zoom_fill_amount: Option<u32>,
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
    #[serde(default = "default_focus_indicators")]
    focus_indicators: bool,
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

fn default_focus_indicators() -> bool {
    true
}

fn default_auto_slideshow_source() -> String {
    String::new()
}

fn default_blend_geo_ratio() -> u32 {
    50
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
            categorized_set_mode: None,
            categorized_set_country: None,
            mix_geo_ratio: 50,
            alt_geo_ratio: 50,
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
            zoom_fill_amount: None,
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
            focus_indicators: true,
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
    /// (owner label, image path) pairs with a viewer mid-build. Distinct from
    /// `image_paths`, which holds *built* viewers: a registered label whose
    /// window has vanished is stale, but one of these is simply not ready yet.
    opening_images: Mutex<HashSet<(String, String)>>,
    /// Serializes read/modify/write access to the derived on-disk hash cache
    /// when several viewer windows scan at the same time.
    categorized_hash_cache_io: Mutex<()>,
    /// The parsed hash cache for one root, kept in memory: `(root, cache file
    /// mtime, entries)`. `get_categorized_ocr` runs once per board and used to
    /// re-read and re-parse the whole file each time — 8.6 MB of JSON for a 30k
    /// library, measured at 252 ms per board, on the main thread. Keyed on the
    /// file's mtime so a rewrite by another window (or the categorizer) is
    /// picked up without any invalidation call.
    categorized_hash_memo: Mutex<Option<(String, u64, HashMap<String, CategorizedHashEntry>)>>,
}

/// Releases an `opening_images` claim on drop, so an early return, an error, or
/// a panic can't strand an image as permanently "already opening".
struct OpenClaim<'a> {
    claims: &'a Mutex<HashSet<(String, String)>>,
    key: (String, String),
}

impl Drop for OpenClaim<'_> {
    fn drop(&mut self) {
        if let Ok(mut claims) = self.claims.lock() {
            claims.remove(&self.key);
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageInfo {
    path: String,
    modified: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedCategoryView {
    name: String,
    count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedImageView {
    path: String,
    category: String,
    modified: u64,
}

#[derive(Clone, Debug, Serialize)]
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedScanProgress {
    scan_id: String,
    root: String,
    scanned: usize,
    total: usize,
    images: Vec<CategorizedImageView>,
    categories: Vec<CategorizedCategoryView>,
    done: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedHashEntry {
    size: u64,
    modified: u64,
    hash: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedHashCache {
    #[serde(default)]
    roots: HashMap<String, HashMap<String, CategorizedHashEntry>>,
}

struct CategorizedCandidate {
    path: PathBuf,
    size: u64,
    modified: u64,
}

struct HashedCandidate {
    path: String,
    size: u64,
    modified: u64,
    hash: Option<String>,
    category: Option<String>,
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

fn categorized_hash_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join(CATEGORIZED_HASH_CACHE_FILE_NAME))
}

fn load_categorized_hashes(app: &AppHandle, root: &str) -> HashMap<String, CategorizedHashEntry> {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.categorized_hash_cache_io.lock() else {
        return HashMap::new();
    };
    categorized_hash_cache_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str::<CategorizedHashCache>(&data).ok())
        .and_then(|mut cache| cache.roots.remove(root))
        .unwrap_or_default()
}

// This cache is purely derived: a read/write failure only makes the next scan
// hash more files, so it must never make the image scan itself fail.
fn save_categorized_hashes(
    app: &AppHandle,
    root: &str,
    entries: HashMap<String, CategorizedHashEntry>,
) {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.categorized_hash_cache_io.lock() else {
        return;
    };
    let Ok(path) = categorized_hash_cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut cache = fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str::<CategorizedHashCache>(&data).ok())
        .unwrap_or_default();
    cache.roots.insert(root.to_string(), entries);
    if let Ok(data) = serde_json::to_string(&cache) {
        let _ = fs::write(path, data);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedOcrView {
    path: String,
    text: String,
}

/// Browser/window chrome markers the screenshot OCR almost always captures. A
/// tab reads "<page title> - YouTube", so the text BEFORE the marker is the
/// useful description — we cut there. Lowercase; matched case-insensitively.
const OCR_CHROME_MARKERS: &[&str] = &[
    " - youtube",
    " \u{2014} youtube",
    " - google chrome",
    " \u{2014} google chrome",
    " - mozilla firefox",
    " \u{2014} mozilla firefox",
    " - microsoft edge",
    " \u{2014} microsoft edge",
    " - google search",
    " - brave",
    " - opera",
];

/// Standalone one-off tokens (close-button "x", bullets, separators) that add
/// noise at the ends of an OCR line. Only whole-token matches are dropped, so a
/// real word ending in one of these characters is never truncated.
fn is_ocr_noise_token(token: &str) -> bool {
    matches!(token, "x" | "X" | "\u{2022}" | "\u{00B7}" | "|" | "-" | "\u{2014}" | "o" | "O")
}

/// Collapse an OCR text dump into a short, cleaned, single-line snippet for use
/// as an accessible name / agent-readable description. Empty in, empty out; also
/// empty if nothing but chrome/noise remains.
fn ocr_snippet(text: &str) -> String {
    // 1. Collapse all whitespace runs to single spaces.
    let mut s = text.split_whitespace().collect::<Vec<_>>().join(" ");

    // 2. Cut at the earliest browser/window chrome marker, keeping the title
    //    before it. Byte positions in the lowercased copy line up with `s` for
    //    this data (ASCII + bullets + em dashes preserve length); the
    //    char-boundary guard keeps any pathological case from panicking.
    let lower = s.to_lowercase();
    if let Some(pos) = OCR_CHROME_MARKERS.iter().filter_map(|m| lower.find(*m)).min() {
        if s.is_char_boundary(pos) {
            s.truncate(pos);
            s = s.trim().to_string();
        }
    }

    // 3. Drop standalone noise tokens (close-button "x", bullets, separators)
    //    at either end.
    let mut tokens: Vec<&str> = s.split(' ').filter(|t| !t.is_empty()).collect();
    while tokens.last().is_some_and(|t| is_ocr_noise_token(t)) {
        tokens.pop();
    }
    while tokens.first().is_some_and(|t| is_ocr_noise_token(t)) {
        tokens.remove(0);
    }
    s = tokens.join(" ");

    // 4. Truncate at a word boundary near the limit.
    if s.chars().count() > CATEGORIZED_OCR_SNIPPET_MAX_CHARS {
        let truncated: String = s.chars().take(CATEGORIZED_OCR_SNIPPET_MAX_CHARS).collect();
        let cut = truncated.rfind(' ').unwrap_or(truncated.len());
        let mut out = truncated[..cut].trim_end().to_string();
        out.push('\u{2026}');
        out
    } else {
        s
    }
}

/// Resolve `paths` to their content hashes, reusing the parsed hash cache when
/// the file behind it has not changed. Keyed on the cache file's mtime, so a
/// rewrite by another window or by the categorizer is picked up with no
/// invalidation call. Everything unknown (no mtime, poisoned lock) falls back to
/// a plain load: this is a speed cache over a cache and must never be the reason
/// a lookup fails.
///
/// Returns hashes rather than the map so the 30k-entry map is never cloned —
/// that clone was most of what the memo was supposed to save.
fn categorized_hashes_for(app: &AppHandle, root: &str, paths: &[String]) -> Vec<Option<String>> {
    let stamp = categorized_hash_cache_path(app)
        .ok()
        .map(|path| modified_ms(&path))
        .unwrap_or_default();
    let state = app.state::<AppState>();
    let pick = |entries: &HashMap<String, CategorizedHashEntry>| {
        paths
            .iter()
            .map(|path| entries.get(path).map(|entry| entry.hash.clone()))
            .collect::<Vec<_>>()
    };

    if stamp != 0 {
        if let Ok(memo) = state.categorized_hash_memo.lock() {
            if let Some((memo_root, memo_stamp, entries)) = memo.as_ref() {
                if memo_root == root && *memo_stamp == stamp {
                    return pick(entries);
                }
            }
        }
    }

    let entries = load_categorized_hashes(app, root);
    let picked = pick(&entries);
    if stamp != 0 {
        if let Ok(mut memo) = state.categorized_hash_memo.lock() {
            *memo = Some((root.to_string(), stamp, entries));
        }
    }
    picked
}

/// Look up the categorizer's OCR text for the given images. OCR lives in a
/// per-image `<hash>.txt` under the root's `.image-categorizer-ocr-text` dir;
/// path -> hash comes from the same derived hash cache the scan writes. Called
/// on demand for the ~16 displayed tiles, never over the whole library, so it
/// stays cheap. Images with no OCR text are simply omitted from the result.
fn get_categorized_ocr_blocking(
    app: AppHandle,
    root: String,
    paths: Vec<String>,
) -> Vec<CategorizedOcrView> {
    let hashes = categorized_hashes_for(&app, &root, &paths);
    let ocr_dir = PathBuf::from(&root).join(CATEGORIZER_OCR_TEXT_DIR_NAME);
    let mut out = Vec::new();
    for (path, hash) in paths.into_iter().zip(hashes) {
        let Some(hash) = hash else {
            continue;
        };
        let file = ocr_dir.join(format!("{hash}.txt"));
        if let Ok(text) = fs::read_to_string(&file) {
            let snippet = ocr_snippet(&text);
            if !snippet.is_empty() {
                out.push(CategorizedOcrView { path, text: snippet });
            }
        }
    }
    out
}

// `async` on purpose: a plain `fn` command runs on the MAIN thread, and this one
// reads one small text file per shown tile. Even memoized that is disk work on
// the thread that also has to keep the window responsive.
#[tauri::command]
async fn get_categorized_ocr(
    app: AppHandle,
    root: String,
    paths: Vec<String>,
) -> Result<Vec<CategorizedOcrView>, String> {
    tauri::async_runtime::spawn_blocking(move || get_categorized_ocr_blocking(app, root, paths))
        .await
        .map_err(|error| format!("OCR lookup failed: {error}"))
}

// ---------------------------------------------------------------------------------------------
// Curated sets (written by image-categorizer's geo layer)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategorizerSetsFile {
    #[serde(default)]
    sets: Vec<CategorizerSet>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategorizerSet {
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    country: String,
    #[serde(default)]
    sources: usize,
    #[serde(default)]
    quality: String,
    #[serde(default)]
    members: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CategorizedSetView {
    id: String,
    kind: String,
    title: String,
    country: String,
    /// Distinct source videos behind the set — the number that says whether it is varied enough to
    /// be worth practising on, as opposed to sixteen frames of the same drive.
    sources: usize,
    /// `diverse` (one frame per video) or `limited` (had to reuse videos).
    quality: String,
    /// Member image paths, in the order the set defines them.
    paths: Vec<String>,
    /// Members whose hash no longer maps to a file under this root.
    missing: usize,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeoExcludedFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    note: String,
    #[serde(default)]
    excluded: BTreeMap<String, GeoExclusion>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeoExclusion {
    #[serde(default)]
    name: String,
    #[serde(default)]
    excluded_at: String,
    #[serde(default)]
    source: String,
}

fn geo_excluded_path(root: &str) -> PathBuf {
    PathBuf::from(root).join(CATEGORIZER_GEO_EXCLUDED_FILE_NAME)
}

fn load_geo_excluded(root: &str) -> GeoExcludedFile {
    fs::read_to_string(geo_excluded_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str::<GeoExcludedFile>(&raw).ok())
        .unwrap_or_default()
}

/// Marks images as never-again members of a geo set.
///
/// This does NOT recategorize anything: the image keeps its Low Text / High Text membership and
/// still shows up everywhere else. It is a set-building veto, which is the narrow thing wanted —
/// a portrait or a rollercoaster that happens to carry a real country is bad geography practice,
/// not a miscategorized picture.
///
/// Returns the total number of exclusions on file so the caller can report it.
#[tauri::command]
fn exclude_from_geo_sets(app: AppHandle, root: String, paths: Vec<String>) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(load_geo_excluded(&root).excluded.len());
    }
    let hashes = load_categorized_hashes(&app, &root);
    let mut file = load_geo_excluded(&root);
    file.version = 1;
    file.note = CATEGORIZER_GEO_EXCLUDED_NOTE.to_string();

    let now = now_iso();
    let mut added = 0usize;
    for path in &paths {
        let Some(entry) = hashes.get(path) else {
            // No hash means the categorized scan has never seen this file; nothing stable to key on.
            continue;
        };
        let name = Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        if file
            .excluded
            .insert(
                entry.hash.clone(),
                GeoExclusion {
                    name,
                    excluded_at: now.clone(),
                    source: "super-image-viewer".to_string(),
                },
            )
            .is_none()
        {
            added += 1;
        }
    }
    if added == 0 {
        return Ok(file.excluded.len());
    }

    let data = serde_json::to_string_pretty(&file)
        .map_err(|error| format!("Failed to serialize geo exclusions: {error}"))?;
    fs::write(geo_excluded_path(&root), data)
        .map_err(|error| format!("Failed to save geo exclusions: {error}"))?;
    Ok(file.excluded.len())
}

/// Excluded images as paths, so the UI can show the action as already done rather than offering it
/// again on something already vetoed. Hashes with no file under this root are simply omitted.
#[tauri::command]
fn get_geo_excluded_paths(app: AppHandle, root: String) -> Vec<String> {
    let excluded = load_geo_excluded(&root).excluded;
    if excluded.is_empty() {
        return Vec::new();
    }
    let hashes = load_categorized_hashes(&app, &root);
    hashes
        .into_iter()
        .filter(|(_, entry)| excluded.contains_key(&entry.hash))
        .map(|(path, _)| path)
        .collect()
}

/// Lists the curated sets stored beside the categorized library, with member hashes resolved to
/// real paths.
///
/// Resolution goes through the derived hash cache the categorized scan writes, so a root that has
/// never been scanned in this app resolves nothing — that is reported as `missing` rather than as
/// an error, and the caller tells the user to rescan. Sets that resolve to no files at all are
/// dropped: an empty set is not something the UI can usefully offer.
#[tauri::command]
fn get_categorized_sets(app: AppHandle, root: String) -> Vec<CategorizedSetView> {
    let path = PathBuf::from(&root).join(CATEGORIZER_GEO_SETS_FILE_NAME);
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(file) = serde_json::from_str::<CategorizerSetsFile>(&raw) else {
        return Vec::new();
    };

    // The cache is path -> hash; sets are keyed by hash, so invert it once for the whole batch.
    let hashes = load_categorized_hashes(&app, &root);
    let mut by_hash: HashMap<&str, &str> = HashMap::with_capacity(hashes.len());
    for (image_path, entry) in &hashes {
        by_hash.insert(entry.hash.as_str(), image_path.as_str());
    }

    // Hand-excluded members are dropped on read too, not only when the categorizer rebuilds — so a
    // "remove from geo sets" takes effect immediately instead of waiting on the next rebuild.
    let excluded = load_geo_excluded(&root).excluded;

    let mut out = Vec::new();
    for set in file.sets {
        let mut paths = Vec::with_capacity(set.members.len());
        let mut missing = 0usize;
        for member in &set.members {
            if excluded.contains_key(member) {
                continue;
            }
            match by_hash.get(member.as_str()) {
                Some(image_path) => paths.push((*image_path).to_string()),
                None => missing += 1,
            }
        }
        if paths.is_empty() {
            continue;
        }
        out.push(CategorizedSetView {
            title: if set.title.is_empty() { set.id.clone() } else { set.title.clone() },
            id: set.id,
            kind: set.kind,
            country: set.country,
            sources: set.sources,
            quality: set.quality,
            paths,
            missing,
        });
    }
    out
}

fn build_categorized_categories(
    sidecar: &CategorizerSidecar,
    category_counts: &HashMap<String, usize>,
) -> Vec<CategorizedCategoryView> {
    sidecar
        .categories
        .iter()
        .filter_map(|name| {
            let count = *category_counts.get(name).unwrap_or(&0);
            (count > 0).then(|| CategorizedCategoryView {
                name: name.clone(),
                count,
            })
        })
        .collect()
}

fn collect_categorized_candidates(
    folder: &Path,
    depth: usize,
    candidates: &mut Vec<CategorizedCandidate>,
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

        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let (is_dir, metadata) = if file_type.is_symlink() {
            match fs::metadata(&path) {
                Ok(metadata) => (metadata.is_dir(), Some(metadata)),
                Err(_) => continue,
            }
        } else {
            (file_type.is_dir(), entry.metadata().ok())
        };

        if is_dir {
            if depth < CATEGORIZER_MAX_SCAN_DEPTH {
                collect_categorized_candidates(&path, depth + 1, candidates)?;
            }
            continue;
        }

        if !is_image_path(&path) {
            continue;
        }
        let Some(metadata) = metadata else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        candidates.push(CategorizedCandidate {
            path,
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default(),
        });
    }
    Ok(())
}

fn scan_categorized_root_blocking(
    app: AppHandle,
    window_label: String,
    root: String,
    scan_id: String,
) -> Result<CategorizedRootView, String> {
    let root_path = PathBuf::from(&root);
    let sidecar_path = root_path.join(CATEGORIZER_SIDECAR_FILE_NAME);
    let sidecar_raw = fs::read_to_string(&sidecar_path)
        .map_err(|_| "Not a categorized folder (no .image-categorizer.json found).".to_string())?;
    let sidecar: CategorizerSidecar = serde_json::from_str(&sidecar_raw)
        .map_err(|error| format!("Failed to parse .image-categorizer.json: {error}"))?;

    let mut candidates = Vec::new();
    collect_categorized_candidates(&root_path, 0, &mut candidates)?;
    let total = candidates.len();
    let cached_hashes = load_categorized_hashes(&app, &root);

    let mut images = Vec::new();
    let mut category_counts: HashMap<String, usize> = HashMap::new();
    let mut fresh_hashes = HashMap::with_capacity(total);

    let emit_progress = |scanned: usize,
                         batch: Vec<CategorizedImageView>,
                         counts: &HashMap<String, usize>,
                         done: bool| {
        let _ = app.emit_to(
            &window_label,
            CATEGORIZED_SCAN_PROGRESS_EVENT,
            CategorizedScanProgress {
                scan_id: scan_id.clone(),
                root: root.clone(),
                scanned,
                total,
                images: batch,
                categories: build_categorized_categories(&sidecar, counts),
                done,
            },
        );
    };

    if total == 0 {
        emit_progress(0, Vec::new(), &category_counts, true);
        save_categorized_hashes(&app, &root, fresh_hashes);
        return Ok(CategorizedRootView {
            root,
            categories: Vec::new(),
            images,
        });
    }

    let thread_count = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1)
        .clamp(1, CATEGORIZED_HASH_MAX_THREADS)
        .min(total);
    let chunk_size = total.div_ceil(thread_count);
    let (sender, receiver) = std::sync::mpsc::channel::<HashedCandidate>();

    std::thread::scope(|scope| {
        for chunk in candidates.chunks(chunk_size) {
            let sender = sender.clone();
            let sidecar = &sidecar;
            let cached_hashes = &cached_hashes;
            scope.spawn(move || {
                for candidate in chunk {
                    let path = candidate.path.to_string_lossy().to_string();
                    let hash = cached_hashes
                        .get(&path)
                        .filter(|entry| {
                            entry.size == candidate.size && entry.modified == candidate.modified
                        })
                        .map(|entry| entry.hash.clone())
                        .or_else(|| categorizer_hash_file(&candidate.path, candidate.size).ok());
                    let category = hash
                        .as_ref()
                        .and_then(|hash| sidecar.images.get(hash))
                        .and_then(|record| record.category.clone());
                    if sender
                        .send(HashedCandidate {
                            path,
                            size: candidate.size,
                            modified: candidate.modified,
                            hash,
                            category,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
        drop(sender);

        let mut scanned = 0usize;
        let mut batch = Vec::new();
        let mut last_emit = Instant::now();
        let mut emitted_images = false;
        for hashed in receiver {
            scanned += 1;
            if let Some(hash) = hashed.hash {
                fresh_hashes.insert(
                    hashed.path.clone(),
                    CategorizedHashEntry {
                        size: hashed.size,
                        modified: hashed.modified,
                        hash,
                    },
                );
            }
            if let Some(category) = hashed.category {
                *category_counts.entry(category.clone()).or_insert(0) += 1;
                let image = CategorizedImageView {
                    path: hashed.path,
                    category,
                    modified: hashed.modified,
                };
                batch.push(image.clone());
                images.push(image);
            }

            if (!emitted_images && !batch.is_empty())
                || last_emit.elapsed() >= CATEGORIZED_SCAN_PROGRESS_INTERVAL
            {
                emitted_images |= !batch.is_empty();
                emit_progress(scanned, std::mem::take(&mut batch), &category_counts, false);
                last_emit = Instant::now();
            }
        }
        emit_progress(scanned, std::mem::take(&mut batch), &category_counts, true);
    });

    save_categorized_hashes(&app, &root, fresh_hashes);
    let categories = build_categorized_categories(&sidecar, &category_counts);

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
        .filter(|label| label.as_str() != "main" && !label.starts_with("image-"))
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

// Walks one chosen folder. Subfolders are included (bounded by
// MULTI_FOLDER_MAX_SCAN_DEPTH): a folder of images is very often a folder OF
// FOLDERS of images, and the top-level-only scan this replaced answered that
// with a near-empty grid and no way to tell why. Dot-folders are skipped, the
// same rule the categorized scan uses, so `.thumbnails` / VCS dirs stay out.
fn collect_folder_images(dir: &Path, depth: usize, seen: &mut HashSet<String>, out: &mut Vec<ImageInfo>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // A symlinked directory needs the target's metadata; the depth cap is
        // what keeps a link that points at an ancestor from looping forever.
        let is_dir = if file_type.is_symlink() {
            fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
        } else {
            file_type.is_dir()
        };
        if is_dir {
            if !name.starts_with('.') && depth < MULTI_FOLDER_MAX_SCAN_DEPTH {
                collect_folder_images(&path, depth + 1, seen, out);
            }
            continue;
        }
        if !is_image_path(&path) {
            continue;
        }
        let text = path.to_string_lossy().to_string();
        // Two enabled folders can name the same directory in different ways
        // (trailing slash, case, a junction) — the pool must still hold each
        // file once, or that image is twice as likely to be drawn and can
        // appear twice on one board.
        if !seen.insert(text.to_lowercase()) {
            continue;
        }
        out.push(ImageInfo {
            path: text,
            modified: modified_ms(&path),
        });
    }
}

fn list_multi_folder_images_blocking(folders: Vec<String>) -> Vec<ImageInfo> {
    let mut images = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for folder in folders {
        let dir = PathBuf::from(folder);
        if !dir.is_dir() {
            continue;
        }
        collect_folder_images(&dir, 0, &mut seen, &mut images);
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
async fn scan_categorized_root(
    app: AppHandle,
    window: WebviewWindow,
    root: String,
    scan_id: String,
) -> Result<CategorizedRootView, String> {
    let window_label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        scan_categorized_root_blocking(app, window_label, root, scan_id)
    })
    .await
    .map_err(|error| format!("Categorized folder scan failed: {error}"))?
}

#[tauri::command]
async fn set_image_category(root: String, path: String, category: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_image_category_blocking(root, path, category))
        .await
        .map_err(|error| format!("Failed to set image category: {error}"))?
}

// Walk up from an image's folder to the nearest ancestor holding a categorizer
// sidecar, so a locked image can be filed into "Previously pinned" even when
// browsing plain folders (not a categorized root). None if it's outside any
// categorizer library.
#[tauri::command]
fn find_categorizer_root(path: String) -> Option<String> {
    let file = PathBuf::from(&path);
    let mut dir = file.parent()?.to_path_buf();
    loop {
        if dir.join(CATEGORIZER_SIDECAR_FILE_NAME).is_file() {
            return Some(dir.to_string_lossy().into_owned());
        }
        if !dir.pop() {
            return None;
        }
    }
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
        "multi" | "categorized" | "geo" | "mix" | "alt" => settings.browse_mode,
        _ => "multi".to_string(),
    };
    current.multi_folders = settings.multi_folders;
    current.multi_folder_filter = settings.multi_folder_filter;
    current.categorized_root = settings.categorized_root;
    current.categorized_category_filter = settings.categorized_category_filter;
    current.categorized_set_mode = match settings.categorized_set_mode.as_deref() {
        Some("any") | Some("country") => settings.categorized_set_mode,
        _ => None,
    };
    current.categorized_set_country = settings.categorized_set_country;
    // The struct field alone is not enough — `save_settings` copies field by field, so an
    // un-copied one is parsed, dropped, and looks exactly like a stale binary.
    current.mix_geo_ratio = settings.mix_geo_ratio.min(100);
    current.alt_geo_ratio = settings.alt_geo_ratio.min(100);
    current.startup_browse_mode = match settings.startup_browse_mode.as_str() {
        "multi" | "categorized" | "geo" | "mix" | "alt" => settings.startup_browse_mode,
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
        .min(current.image_count.saturating_sub(1));
    current.display_mode = settings.display_mode;
    current.slideshow_duration = settings.slideshow_duration.max(1000);
    current.zoom_fill_enabled = settings.zoom_fill_enabled;
    current.zoom_fill_level = settings.zoom_fill_level.clamp(1, 3);
    current.zoom_fill_amount = settings.zoom_fill_amount.map(|amount| amount.min(100));
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
        "folders" | "categorized" | "geo" | "mix" | "alt" => settings.auto_slideshow_source,
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
    let owner_label = window.label().to_string();

    // One viewer per image per owner window. A double-click on a grid cell
    // fires two opens; claiming the pair for the length of the build makes the
    // second bow out instead of stacking an identical viewer on top of the
    // first. Held until this returns, by `_claim`'s Drop.
    let _claim = {
        let key = (owner_label.clone(), path.clone());
        let mut claims = state.opening_images.lock().unwrap();
        if !claims.insert(key.clone()) {
            return Ok(());
        }
        OpenClaim {
            claims: &state.opening_images,
            key,
        }
    };

    // Raise the viewer this window already has for the image rather than
    // duplicating it. Nothing is mid-build past the claim above, so a label
    // registered with no live window is the residue of a viewer closed moments
    // ago whose Destroyed cleanup hasn't run: drop it and open fresh, or that
    // image could never be opened again this session.
    let existing_label = {
        let candidates: Vec<String> = {
            let paths = state.image_paths.lock().unwrap();
            paths
                .iter()
                .filter(|&(_, existing_path)| existing_path == &path)
                .map(|(label, _)| label.clone())
                .collect()
        };
        let owners = state.image_owners.lock().unwrap();
        candidates
            .into_iter()
            .find(|label| owners.get(label).map(String::as_str) == Some(owner_label.as_str()))
    };
    if let Some(existing_label) = existing_label {
        if let Some(existing_window) = app.get_webview_window(&existing_label) {
            let _ = existing_window.unminimize();
            let _ = existing_window.set_focus();
            return Ok(());
        }
        state.image_paths.lock().unwrap().remove(&existing_label);
        state.image_owners.lock().unwrap().remove(&existing_label);
    }

    let window_id = state.image_window_counter.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("image-{window_id}");
    // Registered before the build, not after: the new window's script calls
    // get_assigned_image_path as soon as its page loads.
    state
        .image_paths
        .lock()
        .unwrap()
        .insert(label.clone(), path);
    state
        .image_owners
        .lock()
        .unwrap()
        .insert(label.clone(), owner_label);

    let image_window = match WebviewWindowBuilder::new(
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
    {
        Ok(image_window) => image_window,
        Err(error) => {
            // Release the reservation, or this image stays unopenable for the
            // rest of the session.
            state.image_paths.lock().unwrap().remove(&label);
            state.image_owners.lock().unwrap().remove(&label);
            return Err(format!("Failed to build image window: {error}"));
        }
    };

    set_app_window_icon(&image_window);
    // Floating images keep rounded corners whatever "Square app outer corners" says: that setting
    // is about the app's own chrome, and a hard-cornered picture floating over the desktop reads as
    // a glitch rather than a style. `false` means DWMWCP_DEFAULT — "let the system decide" — so
    // Windows still squares this window off by itself the moment it is snapped or maximized. Both
    // behaviours, natively, with no snap tracking of our own.
    let _ = set_square_window_corners(&image_window, false);
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
            get_categorized_ocr,
            get_categorized_sets,
            exclude_from_geo_sets,
            get_geo_excluded_paths,
            set_image_category,
            find_categorizer_root,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Backstop against surviving our own closed window. A thread still holding
            // a runtime handle at teardown can park forever (any blocking `win.*` call
            // made after the event loop stops serving dispatches never returns), leaving
            // an invisible process with no UI that holds a Windows image lock on this
            // exe — which then fails the next build with "failed to remove file /
            // Access is denied (os error 5)". Diagnosed for real in tauri-dev-broker's
            // GUI on 2026-07-26; this app spawns no long-lived thread today, so this is
            // insurance against one being added. Safe to exit hard: the only Drop impl
            // here is a scoped open-claim guard, and settings are written in commands.
            if let tauri::RunEvent::Exit = event {
                std::process::exit(0);
            }
        });
}
