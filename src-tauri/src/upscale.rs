//! Local AI upscaling with Real-ESRGAN (ncnn/Vulkan build, MIT) shipped next to the app.
//! Runs on the GPU through Vulkan / MoltenVK; `-g -1` forces CPU.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::model::{ImageMeta, Project, SizeMm};
use crate::store::{atomic_write, Store};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleRequest {
    pub image_id: String,
    pub model: String,
    pub scale: u32,
    /// 0 = automatic tile size.
    #[serde(default)]
    pub tile: u32,
    /// GPU index; -1 = CPU.
    #[serde(default)]
    pub gpu: Option<i32>,
    /// Test-time augmentation: slower, slightly better.
    #[serde(default)]
    pub tta: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub native_scales: &'static [u32],
}

pub fn models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "realesrgan-x4plus",
            name: "Real-ESRGAN x4plus",
            description: "Best for painted and photographic card art",
            native_scales: &[4],
        },
        ModelInfo {
            id: "realesrgan-x4plus-anime",
            name: "Real-ESRGAN x4plus Anime",
            description: "Flat colours, line art and anime styles",
            native_scales: &[4],
        },
        ModelInfo {
            id: "realesr-animevideov3",
            name: "AnimeVideo v3",
            description: "Fast, small model; native x2 / x3 / x4",
            native_scales: &[2, 3, 4],
        },
    ]
}

/// One artwork that auto-upscaling still has to produce.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpscale {
    pub image_id: String,
    pub scale: u32,
}

fn index(store: &Store) -> HashMap<String, String> {
    std::fs::read(store.root.join("upscales.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Already upscaled version of `image_id` for this model and factor, if any.
pub fn lookup(store: &Store, image_id: &str, model: &str, scale: u32) -> Option<String> {
    index(store).get(&format!("{image_id}:{model}:{scale}")).filter(|id| store.image_meta(id).is_ok()).cloned()
}

/// Smallest factor (2, 4, 8, 16, up to `max`) that brings an image to `target` DPI, or
/// None when it is already sharp enough. `width_mm` is the printed width incl. built-in bleed.
pub fn needed_scale(width_px: u32, width_mm: f32, target: u32, max: u32) -> Option<u32> {
    if width_px == 0 || width_mm <= 0.0 {
        return None;
    }
    let dpi = crate::imaging::effective_dpi(width_px, width_mm);
    // 3% slack: a 590 DPI scan does not need a 4× pass for a 600 DPI print
    if dpi >= target as f32 * 0.97 {
        return None;
    }
    let max = max.clamp(2, 16);
    [2u32, 4, 8, 16].into_iter().filter(|s| *s <= max).find(|s| dpi * *s as f32 >= target as f32 * 0.97).or(Some(max.min(16)))
}

fn scale_for(store: &Store, id: &str, builtin: Option<f32>, card: SizeMm, target: u32, max: u32) -> Option<u32> {
    let meta = store.image_meta(id).ok()?;
    if meta.derived_from.is_some() && meta.note.starts_with("upscaled") {
        return None; // already an upscale
    }
    let b = builtin.unwrap_or_else(|| crate::imaging::detect_bleed_mm(meta.width, meta.height, card));
    needed_scale(meta.width, card.width + 2.0 * b, target, max)
}

/// Every image of the project (fronts, backs, default back) with its builtin bleed.
fn project_images(p: &Project) -> Vec<(String, Option<f32>)> {
    let mut out = vec![];
    for c in &p.cards {
        out.push((c.front.clone(), c.builtin_bleed_mm));
        if let Some(b) = &c.back {
            out.push((b.clone(), None));
        }
    }
    if let Some(b) = &p.layout.duplex.default_back {
        out.push((b.clone(), None));
    }
    out
}

/// Artwork that auto-upscaling would use but that is not upscaled yet.
pub fn pending(store: &Store, p: &Project, target: u32) -> Vec<PendingUpscale> {
    if !p.upscale.auto {
        return vec![];
    }
    let idx = index(store);
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for (id, builtin) in project_images(p) {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(scale) = scale_for(store, &id, builtin, p.layout.card_size, target, p.upscale.max_scale) {
            let key = format!("{id}:{}:{scale}", p.upscale.model);
            if !idx.get(&key).is_some_and(|u| store.image_meta(u).is_ok()) {
                out.push(PendingUpscale { image_id: id, scale });
            }
        }
    }
    out
}

/// The project as it prints with auto-upscaling: each image that has an upscaled version
/// for the target DPI is swapped for it. Cards, ids and quantities are untouched.
pub fn apply_auto(store: &Store, p: &Project, target: u32) -> Project {
    let mut p = p.clone();
    if !p.upscale.auto {
        return p;
    }
    let idx = index(store);
    let (model, max, card) = (p.upscale.model.clone(), p.upscale.max_scale, p.layout.card_size);
    let swap = |id: &str, builtin: Option<f32>| -> Option<String> {
        let scale = scale_for(store, id, builtin, card, target, max)?;
        idx.get(&format!("{id}:{model}:{scale}")).filter(|u| store.image_meta(u).is_ok()).cloned()
    };
    for c in &mut p.cards {
        if let Some(u) = swap(&c.front, c.builtin_bleed_mm) {
            c.front = u;
        }
        if let Some(b) = c.back.clone() {
            if let Some(u) = swap(&b, None) {
                c.back = Some(u);
            }
        }
    }
    if let Some(b) = p.layout.duplex.default_back.clone() {
        if let Some(u) = swap(&b, None) {
            p.layout.duplex.default_back = Some(u);
        }
    }
    p
}

pub struct Upscaler {
    pub binary: PathBuf,
    pub models_dir: PathBuf,
}

impl Upscaler {
    pub fn available(&self) -> bool {
        self.binary.exists() && self.models_dir.join("realesrgan-x4plus.param").exists()
    }

    /// Which passes to run to reach `scale`: e.g. x8 = 4 then 2 (or 4,4 + downscale).
    pub fn plan(model: &str, scale: u32) -> Vec<u32> {
        let natives: &[u32] = models().iter().find(|m| m.id == model).map(|m| m.native_scales).unwrap_or(&[4]);
        let mut passes = vec![];
        let mut achieved = 1u32;
        while achieved < scale {
            let need = scale.div_ceil(achieved);
            let step = natives.iter().copied().filter(|s| *s >= need).min().unwrap_or(*natives.iter().max().unwrap());
            passes.push(step);
            achieved *= step;
        }
        passes
    }

    pub fn run(
        &self,
        store: &Store,
        req: &UpscaleRequest,
        progress: &dyn Fn(f32),
        cancel: &AtomicBool,
    ) -> AppResult<ImageMeta> {
        if !self.available() {
            return Err(AppError::Other(
                "Upscaler not installed. Run `pnpm fetch:upscaler` (developers) or reinstall the app.".into(),
            ));
        }
        if !models().iter().any(|m| m.id == req.model) {
            return Err(AppError::Invalid(format!("unknown model {}", req.model)));
        }
        let scale = req.scale.clamp(2, 16);
        let key = format!("{}:{}:{}", req.image_id, req.model, scale);
        let index_path = store.root.join("upscales.json");
        let mut index: HashMap<String, String> = index(store);
        if let Some(id) = index.get(&key) {
            if let Ok(m) = store.image_meta(id) {
                progress(1.0);
                return Ok(m);
            }
        }

        let src_meta = store.image_meta(&req.image_id)?;
        let work = store.cache.join(format!("upscale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work)?;
        let result = (|| -> AppResult<ImageMeta> {
            // Always feed a PNG (handles webp/avif-converted/odd formats uniformly).
            let mut input = work.join("in-0.png");
            let img = crate::render::decoded(store, &src_meta.id)?;
            img.save_with_format(&input, image::ImageFormat::Png)?;
            let (w0, h0) = (img.width(), img.height());

            let passes = Self::plan(&req.model, scale);
            let n = passes.len() as f32;
            for (i, s) in passes.iter().enumerate() {
                let out = work.join(format!("in-{}.png", i + 1));
                self.pass(&input, &out, &req.model, *s, req, &|p| progress((i as f32 + p) / n * 0.95), cancel)?;
                input = out;
            }
            let mut bytes = std::fs::read(&input)?;
            let achieved: u32 = passes.iter().product();
            if achieved != scale {
                let im = image::load_from_memory(&bytes)?;
                let resized = im.resize_exact(w0 * scale, h0 * scale, image::imageops::FilterType::Lanczos3);
                let mut out = std::io::Cursor::new(Vec::new());
                resized.write_to(&mut out, image::ImageFormat::Png)?;
                bytes = out.into_inner();
            }
            let meta = store.import_image_bytes(
                &bytes,
                None,
                Some(src_meta.id.clone()),
                &format!("upscaled x{scale} with {}", req.model),
            )?;
            Ok(meta)
        })();
        let _ = std::fs::remove_dir_all(&work);
        let meta = result?;
        index.insert(key, meta.id.clone());
        atomic_write(&index_path, &serde_json::to_vec(&index)?)?;
        progress(1.0);
        Ok(meta)
    }

    fn pass(
        &self,
        input: &Path,
        output: &Path,
        model: &str,
        scale: u32,
        req: &UpscaleRequest,
        progress: &dyn Fn(f32),
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        let mut cmd = Command::new(&self.binary);
        cmd.arg("-i").arg(input).arg("-o").arg(output);
        cmd.arg("-n").arg(model).arg("-s").arg(scale.to_string());
        cmd.arg("-m").arg(&self.models_dir);
        cmd.arg("-t").arg(req.tile.to_string());
        cmd.arg("-f").arg("png");
        if let Some(g) = req.gpu {
            cmd.arg("-g").arg(g.to_string());
        }
        if req.tta {
            cmd.arg("-x");
        }
        cmd.stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| AppError::Other(format!("could not start upscaler: {e}")))?;
        let stderr = child.stderr.take().unwrap();
        let mut log = String::new();
        // realesrgan prints "12.34%" progress lines on stderr
        for line in BufReader::new(stderr).split(b'\n') {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                return Err(AppError::Other("Upscale cancelled".into()));
            }
            let line = String::from_utf8_lossy(&line.unwrap_or_default()).to_string();
            for part in line.split('\r') {
                if let Some(p) = part.trim().strip_suffix('%').and_then(|x| x.trim().parse::<f32>().ok()) {
                    progress((p / 100.0).clamp(0.0, 1.0));
                } else if !part.trim().is_empty() {
                    log.push_str(part.trim());
                    log.push('\n');
                }
            }
        }
        let status = child.wait()?;
        if !status.success() || !output.exists() {
            let tail: String = log.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(AppError::Other(format!("Upscaler failed ({status}). {tail}")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_passes() {
        assert_eq!(Upscaler::plan("realesrgan-x4plus", 4), vec![4]);
        assert_eq!(Upscaler::plan("realesrgan-x4plus", 2), vec![4]);
        assert_eq!(Upscaler::plan("realesrgan-x4plus", 8), vec![4, 4]);
        assert_eq!(Upscaler::plan("realesrgan-x4plus", 16), vec![4, 4]);
        assert_eq!(Upscaler::plan("realesr-animevideov3", 2), vec![2]);
        assert_eq!(Upscaler::plan("realesr-animevideov3", 8), vec![4, 2]);
        assert_eq!(Upscaler::plan("realesr-animevideov3", 3), vec![3]);
    }

    #[test]
    fn scale_reaches_target_dpi() {
        // a 745 px Scryfall scan is ~300 DPI on a 63 mm card
        assert_eq!(needed_scale(745, 63.0, 600, 4), Some(2));
        assert_eq!(needed_scale(745, 63.0, 1200, 4), Some(4));
        assert_eq!(needed_scale(745, 63.0, 1200, 2), Some(2));
        assert_eq!(needed_scale(2976, 63.0, 1200, 4), None);
        assert_eq!(needed_scale(0, 63.0, 600, 4), None);
    }

    #[test]
    fn auto_swaps_only_upscaled_images() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        let png = |w: u32, h: u32| {
            let mut b = std::io::Cursor::new(Vec::new());
            image::RgbImage::new(w, h).write_to(&mut b, image::ImageFormat::Png).unwrap();
            b.into_inner()
        };
        let low = store.import_image_bytes(&png(745, 1040), None, None, "").unwrap();
        let up = store.import_image_bytes(&png(1490, 2080), None, Some(low.id.clone()), "upscaled x2 with realesrgan-x4plus").unwrap();
        let mut p = store.new_project("t").unwrap();
        p.cards.push(crate::model::CardEntry {
            id: "a".into(),
            name: "A".into(),
            qty: 1,
            front: low.id.clone(),
            back: None,
            original_front: None,
            original_back: None,
            source: None,
            builtin_bleed_mm: None,
            is_token: false,
            design_id: None,
            meta: None,
        });
        // off: nothing pending, nothing swapped
        assert!(pending(&store, &p, 600).is_empty());
        p.upscale.auto = true;
        assert_eq!(pending(&store, &p, 600), vec![PendingUpscale { image_id: low.id.clone(), scale: 2 }]);
        assert_eq!(apply_auto(&store, &p, 600).cards[0].front, low.id);
        let mut idx = HashMap::new();
        idx.insert(format!("{}:realesrgan-x4plus:2", low.id), up.id.clone());
        atomic_write(&store.root.join("upscales.json"), &serde_json::to_vec(&idx).unwrap()).unwrap();
        assert!(pending(&store, &p, 600).is_empty());
        let applied = apply_auto(&store, &p, 600);
        assert_eq!(applied.cards[0].front, up.id);
        assert_eq!(applied.cards[0].id, "a");
        assert_eq!(lookup(&store, &low.id, "realesrgan-x4plus", 2), Some(up.id));
    }
}
