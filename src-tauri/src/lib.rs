pub mod color;
pub mod error;
pub mod imaging;
pub mod import;
pub mod layout;
pub mod model;
pub mod print;
pub mod providers;
pub mod render;
pub mod store;
pub mod upscale;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use error::{AppError, AppResult};
use model::*;
use providers::{CardResult, Providers};
use store::Store;
use upscale::{UpscaleRequest, Upscaler};

pub struct AppState {
    store: Arc<Store>,
    providers: Arc<Providers>,
    cancel: Arc<AtomicBool>,
    upscaler: Arc<Upscaler>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    task: String,
    progress: f32,
    message: String,
}

fn emit(app: &tauri::AppHandle, task: &str, progress: f32, message: &str) {
    let _ = app.emit("progress", ProgressEvent { task: task.into(), progress, message: message.into() });
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AppError::Other(e.to_string()))?
}

// ------------------------------------------------------------------ app info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    data_dir: String,
    upscaler_available: bool,
    games: Vec<providers::GameInfo>,
    models: Vec<upscale::ModelInfo>,
    card_presets: Vec<Preset>,
    page_presets: Vec<Preset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preset {
    id: &'static str,
    name: &'static str,
    width: f32,
    height: f32,
}

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    let conv = |v: Vec<(&'static str, &'static str, f32, f32)>| v.into_iter().map(|(id, name, width, height)| Preset { id, name, width, height }).collect();
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        data_dir: state.store.root.to_string_lossy().to_string(),
        upscaler_available: state.upscaler.available(),
        games: providers::games(),
        models: upscale::models(),
        card_presets: conv(layout::card_presets()),
        page_presets: conv(layout::page_presets()),
    }
}

// ------------------------------------------------------------------ projects

#[tauri::command]
fn list_projects(state: State<AppState>) -> AppResult<Vec<ProjectSummary>> {
    state.store.list_projects()
}
#[tauri::command]
fn new_project(state: State<AppState>, name: String) -> AppResult<Project> {
    state.store.new_project(&name)
}
#[tauri::command]
fn load_project(state: State<AppState>, id: String) -> AppResult<Project> {
    state.store.load_project(&id)
}
#[tauri::command]
fn save_project(state: State<AppState>, project: Project) -> AppResult<Project> {
    state.store.save_project(&project)
}
#[tauri::command]
fn delete_project(state: State<AppState>, id: String) -> AppResult<()> {
    state.store.delete_project(&id)
}
#[tauri::command]
fn duplicate_project(state: State<AppState>, id: String) -> AppResult<Project> {
    state.store.duplicate_project(&id)
}
#[tauri::command]
async fn export_bundle(state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    let s = state.store.clone();
    blocking(move || s.export_bundle(&id, &PathBuf::from(path))).await
}
#[tauri::command]
async fn import_bundle(state: State<'_, AppState>, path: String) -> AppResult<Project> {
    let s = state.store.clone();
    blocking(move || s.import_bundle(&PathBuf::from(path))).await
}

// ------------------------------------------------------------------ images

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImagePaths {
    full: String,
    thumb: String,
    meta: ImageMeta,
}

#[tauri::command]
fn image_paths(state: State<AppState>, ids: Vec<String>) -> HashMap<String, ImagePaths> {
    ids.into_iter()
        .filter_map(|id| {
            let meta = state.store.image_meta(&id).ok()?;
            let full = state.store.images.join(&meta.file).to_string_lossy().to_string();
            let thumb = state.store.thumb_path(&id).ok()?.to_string_lossy().to_string();
            Some((id, ImagePaths { full, thumb, meta }))
        })
        .collect()
}

#[tauri::command]
async fn import_images(state: State<'_, AppState>, paths: Vec<String>, card: SizeMm) -> AppResult<Vec<CardEntry>> {
    let s = state.store.clone();
    blocking(move || {
        let mut out = vec![];
        for p in paths {
            let pb = PathBuf::from(&p);
            let meta = s.import_image_file(&pb)?;
            let name = pb.file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or_else(|| "Custom card".into());
            let bleed = meta.decodable.then(|| imaging::detect_bleed_mm(meta.width, meta.height, card));
            out.push(entry(name, meta.id, None, None, bleed, false));
        }
        Ok(out)
    })
    .await
}

/// Receives a PNG re-encoded by the webview for formats Rust cannot decode (AVIF).
#[tauri::command]
fn convert_image(state: State<AppState>, request: tauri::ipc::Request) -> AppResult<ImageMeta> {
    let id = request
        .headers()
        .get("x-image-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Invalid("missing x-image-id".into()))?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Invalid("expected raw PNG body".into()));
    };
    state.store.replace_with_converted(&id, bytes)
}

fn header(request: &tauri::ipc::Request, name: &str) -> AppResult<String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode(v))
        .ok_or_else(|| AppError::Invalid(format!("missing {name}")))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> AppResult<&'a [u8]> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b),
        _ => Err(AppError::Invalid("expected raw body".into())),
    }
}

/// Store image bytes produced by the UI (card builder renders). Header `x-name` (URI-encoded).
#[tauri::command]
fn import_image_data(state: State<AppState>, request: tauri::ipc::Request) -> AppResult<ImageMeta> {
    let name = header(&request, "x-name").unwrap_or_default();
    state.store.import_image_bytes(raw_body(&request)?, None, None, &name)
}

/// Add a single image file to the library without creating a card (builder art).
#[tauri::command]
fn import_image_file(state: State<AppState>, path: String) -> AppResult<ImageMeta> {
    state.store.import_image_file(&PathBuf::from(path))
}

/// Original image bytes, for drawing on the builder canvas without tainting it.
#[tauri::command]
async fn read_image(state: State<'_, AppState>, id: String) -> AppResult<tauri::ipc::Response> {
    let s = state.store.clone();
    blocking(move || Ok(tauri::ipc::Response::new(std::fs::read(s.image_path(&id)?)?))).await
}

/// Write bytes to a path the user picked in the save dialog. Header `x-path` (URI-encoded).
#[tauri::command]
fn save_bytes(request: tauri::ipc::Request) -> AppResult<()> {
    let path = header(&request, "x-path")?;
    std::fs::write(path, raw_body(&request)?)?;
    Ok(())
}

#[tauri::command]
fn import_font(state: State<AppState>, path: String) -> AppResult<store::FontInfo> {
    state.store.import_font(&PathBuf::from(path))
}

#[tauri::command]
fn list_fonts(state: State<AppState>) -> AppResult<Vec<store::FontInfo>> {
    state.store.list_fonts()
}

/// Font bytes for `FontFace`; only files inside the app's fonts folder.
#[tauri::command]
async fn read_font(state: State<'_, AppState>, path: String) -> AppResult<tauri::ipc::Response> {
    let dir = std::fs::canonicalize(state.store.fonts_dir())?;
    let p = std::fs::canonicalize(&path)?;
    if !p.starts_with(&dir) {
        return Err(AppError::Invalid("font outside library".into()));
    }
    Ok(tauri::ipc::Response::new(std::fs::read(p)?))
}

fn entry(name: String, front: String, back: Option<String>, source: Option<CardSource>, bleed: Option<f32>, token: bool) -> CardEntry {
    CardEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        qty: 1,
        front,
        back,
        original_front: None,
        original_back: None,
        source,
        builtin_bleed_mm: bleed.filter(|b| *b > 0.0),
        is_token: token,
        design_id: None,
    }
}

async fn cached_image(store: &Store, providers: &Providers, url: &str) -> AppResult<String> {
    if let Some(id) = store.image_id_for_url(url) {
        return Ok(id);
    }
    let bytes = providers.get_bytes(url).await?;
    Ok(store.import_image_bytes(&bytes, Some(url.to_string()), None, "")?.id)
}

async fn card_from_result(store: &Store, providers: &Providers, r: &CardResult) -> AppResult<CardEntry> {
    let front = cached_image(store, providers, &r.image_url).await?;
    let back = match &r.back_image_url {
        Some(u) => Some(cached_image(store, providers, u).await?),
        None => None,
    };
    let source = CardSource { game: r.game, card_id: r.id.clone(), set_code: r.set_code.clone(), number: r.number.clone() };
    Ok(entry(r.name.clone(), front, back, Some(source), None, r.is_token))
}

// ------------------------------------------------------------------ search & import

#[tauri::command]
async fn search_cards(state: State<'_, AppState>, game: Game, query: String, page: u32, all_prints: bool) -> AppResult<providers::SearchPage> {
    state.providers.search(game, &query, page, all_prints).await
}

#[tauri::command]
async fn fetch_card(state: State<'_, AppState>, result: CardResult) -> AppResult<CardEntry> {
    card_from_result(&state.store, &state.providers, &result).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportReport {
    entries: Vec<CardEntry>,
    missing: Vec<String>,
}

async fn resolve_lines(app: &tauri::AppHandle, state: &AppState, game: Game, lines: Vec<import::DeckLine>) -> AppResult<ImportReport> {
    let mut entries = vec![];
    let mut missing = vec![];
    let total = lines.len().max(1) as f32;
    for (i, l) in lines.iter().enumerate() {
        if state.cancel.load(Ordering::Relaxed) {
            break;
        }
        emit(app, "import", i as f32 / total, &l.name);
        let res: AppResult<Option<CardEntry>> = async {
            if let Some(url) = &l.image_url {
                let front = cached_image(&state.store, &state.providers, url).await?;
                let back = match &l.back_image_url {
                    Some(u) => cached_image(&state.store, &state.providers, u).await.ok(),
                    None => None,
                };
                return Ok(Some(entry(l.name.clone(), front, back, None, None, false)));
            }
            match state.providers.resolve(game, &l.name, l.set.as_deref(), l.number.as_deref()).await? {
                Some(r) => Ok(Some(card_from_result(&state.store, &state.providers, &r).await?)),
                None => Ok(None),
            }
        }
        .await;
        match res {
            Ok(Some(mut e)) => {
                e.qty = l.qty;
                if l.section.contains("token") {
                    e.is_token = true;
                }
                entries.push(e);
            }
            Ok(None) => missing.push(format!("{} {}", l.qty, l.name)),
            Err(err) => missing.push(format!("{} {} ({err})", l.qty, l.name)),
        }
    }
    emit(app, "import", 1.0, "Done");
    Ok(ImportReport { entries, missing })
}

#[tauri::command]
async fn import_decklist(app: tauri::AppHandle, state: State<'_, AppState>, game: Game, text: String, format: String) -> AppResult<ImportReport> {
    state.cancel.store(false, Ordering::Relaxed);
    let lines = match format.as_str() {
        "ydk" => import::parse_ydk(&text),
        "mpc" => import::parse_mpc_xml(&text)?,
        _ if text.trim_start().starts_with("<order") => import::parse_mpc_xml(&text)?,
        _ if text.contains("#main") => import::parse_ydk(&text),
        _ => import::parse_text(&text),
    };
    resolve_lines(&app, &state, game, lines).await
}

#[tauri::command]
async fn import_deck_url(app: tauri::AppHandle, state: State<'_, AppState>, url: String) -> AppResult<ImportReport> {
    state.cancel.store(false, Ordering::Relaxed);
    let (api, kind) = import::deck_api_url(&url)?;
    let client = reqwest::Client::builder().user_agent(providers::USER_AGENT).build()?;
    let r = client.get(&api).header("Accept", "application/json").send().await?;
    if !r.status().is_success() {
        return Err(AppError::Http(format!(
            "{kind} returned {}. The deck may be private, or the site blocked the request — export it as text and paste it instead.",
            r.status()
        )));
    }
    let v: serde_json::Value = r.json().await?;
    let lines = import::parse_deck_json(kind, &v);
    resolve_lines(&app, &state, Game::Mtg, lines).await
}

/// Reads a decklist chosen by the user in the open dialog (text only, max 5 MB).
#[tauri::command]
fn read_text_file(path: String) -> AppResult<String> {
    let meta = std::fs::metadata(&path)?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err(AppError::Invalid("file too large for a decklist".into()));
    }
    Ok(String::from_utf8_lossy(&std::fs::read(&path)?).to_string())
}

#[tauri::command]
fn cancel_task(state: State<AppState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

// ------------------------------------------------------------------ layout & preview

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GridInfo {
    columns: u32,
    rows: u32,
    per_page: usize,
    pages: usize,
    page: SizeMm,
}

#[tauri::command]
fn grid_info(layout: LayoutSettings, card_count: usize) -> GridInfo {
    let g = layout::compute_grid(&layout);
    let sheets = layout::page_count(card_count, g.per_page());
    GridInfo {
        columns: g.columns,
        rows: g.rows,
        per_page: g.per_page(),
        pages: if layout.duplex.enabled { sheets * 2 } else { sheets },
        page: g.page,
    }
}

/// Card positions on every page of the live view (blank pages left out).
#[tauri::command]
async fn page_map(project: Project) -> AppResult<Vec<render::PageMap>> {
    blocking(move || render::page_map(&project)).await
}

/// Returns raw bytes (no base64/JSON): a little-endian u32 page count followed by the PNG.
#[tauri::command]
async fn render_preview(
    state: State<'_, AppState>,
    project: Project,
    page: usize,
    dpi: u32,
    proof: bool,
    gamut_warning: bool,
) -> AppResult<tauri::ipc::Response> {
    let s = state.store.clone();
    blocking(move || {
        let pp = s.print_profile(project.print_profile_id.as_deref())?;
        let (png, page_count) = render::preview_png(&s, &project, &pp, page, dpi.clamp(20, 220), proof, gamut_warning)?;
        let mut out = Vec::with_capacity(png.len() + 4);
        out.extend_from_slice(&(page_count as u32).to_le_bytes());
        out.extend_from_slice(&png);
        Ok(tauri::ipc::Response::new(out))
    })
    .await
}

#[tauri::command]
async fn card_preview(
    state: State<'_, AppState>,
    image_id: String,
    layout: LayoutSettings,
    profile_id: Option<String>,
    dpi: u32,
    proof: bool,
) -> AppResult<String> {
    let s = state.store.clone();
    blocking(move || {
        let pp = s.print_profile(profile_id.as_deref())?;
        let png = render::card_preview_png(&s, &image_id, &layout, &pp, dpi.clamp(30, 400), proof)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(png))
    })
    .await
}

// ------------------------------------------------------------------ presets & colour

#[tauri::command]
fn list_presets(state: State<AppState>) -> AppResult<Vec<LayoutPreset>> {
    state.store.presets()
}
#[tauri::command]
fn save_presets(state: State<AppState>, presets: Vec<LayoutPreset>) -> AppResult<()> {
    state.store.save_presets(&presets)
}
#[tauri::command]
fn print_profiles(state: State<AppState>) -> AppResult<Vec<PrintProfile>> {
    state.store.print_profiles()
}
#[tauri::command]
fn save_print_profiles(state: State<AppState>, profiles: Vec<PrintProfile>) -> AppResult<()> {
    if profiles.is_empty() {
        return Err(AppError::Invalid("keep at least one print profile".into()));
    }
    state.store.save_print_profiles(&profiles)
}
#[tauri::command]
fn list_icc(state: State<AppState>) -> AppResult<Vec<IccInfo>> {
    state.store.list_icc()
}
#[tauri::command]
fn import_icc(state: State<AppState>, path: String) -> AppResult<IccInfo> {
    state.store.import_icc(&PathBuf::from(path))
}
#[tauri::command]
async fn test_chart(state: State<'_, AppState>, profile_id: String, layout: LayoutSettings, path: String) -> AppResult<()> {
    let s = state.store.clone();
    blocking(move || {
        let pp = s.print_profile(Some(&profile_id))?;
        render::test_chart_pdf(&s, &pp, &layout, &PathBuf::from(path))
    })
    .await
}
#[tauri::command]
async fn duplex_calibration(layout: LayoutSettings, path: String) -> AppResult<()> {
    blocking(move || render::duplex_calibration_pdf(&layout, &PathBuf::from(path))).await
}

// ------------------------------------------------------------------ export

#[tauri::command]
async fn export_project(app: tauri::AppHandle, state: State<'_, AppState>, project: Project, options: ExportOptions) -> AppResult<Vec<String>> {
    state.cancel.store(false, Ordering::Relaxed);
    let s = state.store.clone();
    let cancel = state.cancel.clone();
    blocking(move || {
        let pp = s.print_profile(project.print_profile_id.as_deref())?;
        let progress = |p: f32, m: &str| emit(&app, "export", p, m);
        let paths = match options.format {
            ExportFormat::Pdf => vec![render::export_pdf(&s, &project, &pp, &options, &progress, &cancel)?],
            ExportFormat::Png | ExportFormat::Tiff => render::export_raster(&s, &project, &pp, &options, &progress, &cancel)?,
            ExportFormat::Zip => vec![render::export_zip(&s, &project, &pp, &options, &progress, &cancel)?],
        };
        Ok(paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
    })
    .await
}

// ------------------------------------------------------------------ print

#[tauri::command]
async fn list_printers() -> AppResult<Vec<print::PrinterInfo>> {
    blocking(print::list_printers).await
}

/// Render the project to a temporary PDF (same pipeline as the export) and queue it.
#[tauri::command]
async fn print_project(app: tauri::AppHandle, state: State<'_, AppState>, project: Project, options: print::PrintOptions) -> AppResult<String> {
    state.cancel.store(false, Ordering::Relaxed);
    let s = state.store.clone();
    let cancel = state.cancel.clone();
    blocking(move || {
        let pp = s.print_profile(project.print_profile_id.as_deref())?;
        let path = std::env::temp_dir().join(format!("proxyforge-print-{}.pdf", uuid::Uuid::new_v4()));
        let export = ExportOptions {
            format: ExportFormat::Pdf,
            path: path.to_string_lossy().to_string(),
            dpi: options.dpi,
            compression: PdfCompression::Lossless,
            jpeg_quality: 95,
            sixteen_bit: false,
            cut_file: false,
        };
        let progress = |p: f32, m: &str| emit(&app, "print", p * 0.95, m);
        let pdf = render::export_pdf(&s, &project, &pp, &export, &progress, &cancel)?;
        emit(&app, "print", 0.97, "Sending to printer");
        let res = print::send(&pdf, &options);
        let _ = std::fs::remove_file(&pdf);
        emit(&app, "print", 1.0, "");
        res.map(|out| out.trim().to_string())
    })
    .await
}

// ------------------------------------------------------------------ upscale

#[tauri::command]
async fn upscale_image(app: tauri::AppHandle, state: State<'_, AppState>, request: UpscaleRequest) -> AppResult<ImageMeta> {
    let s = state.store.clone();
    let up = state.upscaler.clone();
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    blocking(move || {
        let id = request.image_id.clone();
        up.run(&s, &request, &|p| emit(&app, &format!("upscale:{id}"), p, ""), &cancel)
    })
    .await
}

// ------------------------------------------------------------------ setup

fn upscaler_paths(app: &tauri::App) -> Upscaler {
    let exe_name = if cfg!(windows) { "realesrgan-ncnn-vulkan.exe" } else { "realesrgan-ncnn-vulkan" };
    let mut base = app.path().resource_dir().unwrap_or_default().join("resources");
    if !base.join("bin").join(exe_name).exists() {
        // `tauri dev` before resources are copied: use the source tree
        base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    }
    let binary = base.join("bin").join(exe_name);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(m) = std::fs::metadata(&binary) {
            if m.permissions().mode() & 0o111 == 0 {
                let _ = std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    Upscaler { binary, models_dir: base.join("models") }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let store = Arc::new(Store::open(data)?);
            let providers = Arc::new(Providers::new(store.cache.clone())?);
            let upscaler = Arc::new(upscaler_paths(app));
            app.manage(AppState { store, providers, cancel: Arc::new(AtomicBool::new(false)), upscaler });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_projects,
            new_project,
            load_project,
            save_project,
            delete_project,
            duplicate_project,
            export_bundle,
            import_bundle,
            image_paths,
            import_images,
            convert_image,
            search_cards,
            fetch_card,
            import_decklist,
            import_deck_url,
            cancel_task,
            read_text_file,
            grid_info,
            render_preview,
            page_map,
            list_printers,
            print_project,
            card_preview,
            list_presets,
            save_presets,
            print_profiles,
            save_print_profiles,
            list_icc,
            import_icc,
            test_chart,
            duplex_calibration,
            export_project,
            upscale_image,
            import_image_data,
            import_image_file,
            read_image,
            save_bytes,
            import_font,
            list_fonts,
            read_font,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ProxyForge");
}
