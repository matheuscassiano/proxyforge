//! Local AI upscaling with Real-ESRGAN (ncnn/Vulkan build, MIT) shipped next to the app.
//! Runs on the GPU through Vulkan / MoltenVK; `-g -1` forces CPU.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::model::ImageMeta;
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
        let mut index: HashMap<String, String> =
            std::fs::read(&index_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
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
}
