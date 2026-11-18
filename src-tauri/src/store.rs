//! Local, file-based storage: image library, projects, layout presets, print profiles,
//! imported ICC profiles and `.pforge` share bundles. Everything lives under the app
//! data directory; nothing leaves the machine.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::model::*;

pub struct Store {
    pub root: PathBuf,
    pub images: PathBuf,
    pub thumbs: PathBuf,
    pub projects: PathBuf,
    pub icc: PathBuf,
    pub cache: PathBuf,
    url_index: Mutex<HashMap<String, String>>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn safe_id(id: &str) -> AppResult<&str> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') || id.contains("..") {
        return Err(AppError::Invalid(format!("invalid id '{id}'")));
    }
    Ok(id)
}

impl Store {
    pub fn open(root: PathBuf) -> AppResult<Self> {
        let s = Self {
            images: root.join("images"),
            thumbs: root.join("images").join("thumbs"),
            projects: root.join("projects"),
            icc: root.join("icc"),
            cache: root.join("cache"),
            url_index: Mutex::new(HashMap::new()),
            root,
        };
        for d in [&s.root, &s.images, &s.thumbs, &s.projects, &s.icc, &s.cache] {
            fs::create_dir_all(d)?;
        }
        let idx_path = s.root.join("url-index.json");
        if let Ok(b) = fs::read(&idx_path) {
            if let Ok(m) = serde_json::from_slice(&b) {
                *s.url_index.lock() = m;
            }
        }
        Ok(s)
    }

    fn save_url_index(&self) -> AppResult<()> {
        let m = self.url_index.lock().clone();
        atomic_write(&self.root.join("url-index.json"), &serde_json::to_vec(&m)?)
    }

    // ------------------------------------------------------------ images

    pub fn image_id_for_url(&self, url: &str) -> Option<String> {
        let id = self.url_index.lock().get(url).cloned()?;
        self.image_meta(&id).ok().map(|m| m.id)
    }

    /// Store image bytes in the library (deduplicated by content hash).
    pub fn import_image_bytes(
        &self,
        bytes: &[u8],
        source_url: Option<String>,
        derived_from: Option<String>,
        note: &str,
    ) -> AppResult<ImageMeta> {
        let id = sha256_hex(bytes)[..32].to_string();
        if let Ok(meta) = self.image_meta(&id) {
            if let Some(u) = source_url {
                self.url_index.lock().insert(u, id.clone());
                self.save_url_index()?;
            }
            return Ok(meta);
        }
        let format = image::guess_format(bytes).ok();
        let ext = format.and_then(|f| f.extensions_str().first().copied()).unwrap_or("bin");
        let file = format!("{id}.{ext}");
        atomic_write(&self.images.join(&file), bytes)?;

        let decoded = image::load_from_memory(bytes);
        let (decodable, width, height) = match &decoded {
            Ok(img) => (true, img.width(), img.height()),
            Err(_) => (false, 0, 0),
        };
        if let Ok(img) = &decoded {
            let thumb = img.thumbnail(320, 448).to_rgb8();
            let mut out = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&thumb)?;
            atomic_write(&self.thumbs.join(format!("{id}.jpg")), &out)?;
        }
        let meta = ImageMeta { id: id.clone(), file, width, height, source_url: source_url.clone(), decodable, derived_from, note: note.into() };
        atomic_write(&self.images.join(format!("{id}.json")), &serde_json::to_vec_pretty(&meta)?)?;
        if let Some(u) = source_url {
            self.url_index.lock().insert(u, id);
            self.save_url_index()?;
        }
        Ok(meta)
    }

    pub fn import_image_file(&self, path: &Path) -> AppResult<ImageMeta> {
        let bytes = fs::read(path)?;
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        self.import_image_bytes(&bytes, None, None, &name)
    }

    /// Replace a non-decodable image (e.g. AVIF) with a PNG produced by the webview.
    pub fn replace_with_converted(&self, original: &str, png: &[u8]) -> AppResult<ImageMeta> {
        let old = self.image_meta(original)?;
        let meta = self.import_image_bytes(png, None, Some(old.id.clone()), "converted")?;
        if let Some(u) = old.source_url {
            self.url_index.lock().insert(u, meta.id.clone());
            self.save_url_index()?;
        }
        Ok(meta)
    }

    pub fn image_meta(&self, id: &str) -> AppResult<ImageMeta> {
        let id = safe_id(id)?;
        let b = fs::read(self.images.join(format!("{id}.json")))
            .map_err(|_| AppError::NotFound(format!("image {id} not in library")))?;
        Ok(serde_json::from_slice(&b)?)
    }

    pub fn image_path(&self, id: &str) -> AppResult<PathBuf> {
        let m = self.image_meta(id)?;
        Ok(self.images.join(m.file))
    }

    pub fn thumb_path(&self, id: &str) -> AppResult<PathBuf> {
        let id = safe_id(id)?;
        let p = self.thumbs.join(format!("{id}.jpg"));
        if p.exists() { Ok(p) } else { self.image_path(id) }
    }

    // ------------------------------------------------------------ projects

    pub fn new_project(&self, name: &str) -> AppResult<Project> {
        let ts = now();
        let p = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            created_at: ts.clone(),
            updated_at: ts,
            cards: vec![],
            layout: LayoutSettings::default(),
            print_profile_id: Some("default".into()),
            designs: vec![],
            upscale: AutoUpscale::default(),
        };
        self.save_project(&p)?;
        Ok(p)
    }

    pub fn save_project(&self, p: &Project) -> AppResult<Project> {
        let mut p = p.clone();
        safe_id(&p.id)?;
        p.updated_at = now();
        atomic_write(&self.projects.join(format!("{}.json", p.id)), &serde_json::to_vec_pretty(&p)?)?;
        Ok(p)
    }

    pub fn load_project(&self, id: &str) -> AppResult<Project> {
        let id = safe_id(id)?;
        let b = fs::read(self.projects.join(format!("{id}.json")))
            .map_err(|_| AppError::NotFound(format!("project {id} not found")))?;
        Ok(serde_json::from_slice(&b)?)
    }

    pub fn delete_project(&self, id: &str) -> AppResult<()> {
        let id = safe_id(id)?;
        // Move to a trash folder instead of deleting outright.
        let trash = self.root.join("trash");
        fs::create_dir_all(&trash)?;
        let src = self.projects.join(format!("{id}.json"));
        if src.exists() {
            fs::rename(&src, trash.join(format!("{id}.json")))?;
        }
        Ok(())
    }

    pub fn duplicate_project(&self, id: &str) -> AppResult<Project> {
        let mut p = self.load_project(id)?;
        p.id = uuid::Uuid::new_v4().to_string();
        p.name = format!("{} (copy)", p.name);
        p.created_at = now();
        self.save_project(&p)
    }

    pub fn list_projects(&self) -> AppResult<Vec<ProjectSummary>> {
        let mut out = vec![];
        for e in fs::read_dir(&self.projects)? {
            let path = e?.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(b) = fs::read(&path) else { continue };
            let Ok(p) = serde_json::from_slice::<Project>(&b) else { continue };
            out.push(ProjectSummary {
                id: p.id,
                name: p.name,
                updated_at: p.updated_at,
                card_count: p.cards.iter().map(|c| c.qty).sum(),
                thumb: p.cards.iter().take(3).map(|c| c.front.clone()).collect::<Vec<_>>().first().cloned(),
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    // ------------------------------------------------------------ presets & print profiles

    pub fn presets(&self) -> AppResult<Vec<LayoutPreset>> {
        read_json_or(&self.root.join("presets.json"), Vec::new)
    }

    pub fn save_presets(&self, v: &[LayoutPreset]) -> AppResult<()> {
        atomic_write(&self.root.join("presets.json"), &serde_json::to_vec_pretty(v)?)
    }

    pub fn print_profiles(&self) -> AppResult<Vec<PrintProfile>> {
        read_json_or(&self.root.join("print-profiles.json"), || vec![PrintProfile::default()])
    }

    pub fn save_print_profiles(&self, v: &[PrintProfile]) -> AppResult<()> {
        atomic_write(&self.root.join("print-profiles.json"), &serde_json::to_vec_pretty(v)?)
    }

    pub fn print_profile(&self, id: Option<&str>) -> AppResult<PrintProfile> {
        let all = self.print_profiles()?;
        let id = id.unwrap_or("default");
        Ok(all.iter().find(|p| p.id == id).cloned().or_else(|| all.first().cloned()).unwrap_or_default())
    }

    // ------------------------------------------------------------ ICC

    pub fn import_icc(&self, path: &Path) -> AppResult<IccInfo> {
        let bytes = fs::read(path)?;
        let (name, space) = crate::color::inspect_icc(&bytes)?;
        let id = format!("{}.icc", &sha256_hex(&bytes)[..16]);
        atomic_write(&self.icc.join(&id), &bytes)?;
        let mut names: HashMap<String, String> = read_json_or(&self.icc.join("names.json"), HashMap::new)?;
        names.insert(id.clone(), name.clone());
        atomic_write(&self.icc.join("names.json"), &serde_json::to_vec_pretty(&names)?)?;
        Ok(IccInfo { id, name, space, builtin: false })
    }

    pub fn list_icc(&self) -> AppResult<Vec<IccInfo>> {
        let mut out = crate::color::builtin_profiles();
        let names: HashMap<String, String> = read_json_or(&self.icc.join("names.json"), HashMap::new)?;
        for e in fs::read_dir(&self.icc)? {
            let p = e?.path();
            let Some(fname) = p.file_name().map(|f| f.to_string_lossy().to_string()) else { continue };
            if !fname.ends_with(".icc") {
                continue;
            }
            let Ok(bytes) = fs::read(&p) else { continue };
            let Ok((desc, space)) = crate::color::inspect_icc(&bytes) else { continue };
            out.push(IccInfo { name: names.get(&fname).cloned().unwrap_or(desc), id: fname, space, builtin: false });
        }
        Ok(out)
    }

    // ------------------------------------------------------------ fonts

    pub fn fonts_dir(&self) -> PathBuf {
        self.root.join("fonts")
    }

    /// Copy a TTF/OTF into the library and return its family name.
    pub fn import_font(&self, path: &Path) -> AppResult<FontInfo> {
        let bytes = fs::read(path)?;
        let family = font_family(&bytes).ok_or_else(|| AppError::Invalid("not a TrueType/OpenType font".into()))?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("ttf").to_lowercase();
        if !["ttf", "otf", "woff", "woff2"].contains(&ext.as_str()) {
            return Err(AppError::Invalid("use a .ttf, .otf, .woff or .woff2 font".into()));
        }
        fs::create_dir_all(self.fonts_dir())?;
        let file = format!("{}.{ext}", &sha256_hex(&bytes)[..16]);
        let dest = self.fonts_dir().join(&file);
        atomic_write(&dest, &bytes)?;
        Ok(FontInfo { family, path: dest.to_string_lossy().to_string() })
    }

    pub fn list_fonts(&self) -> AppResult<Vec<FontInfo>> {
        let mut out = vec![];
        let Ok(rd) = fs::read_dir(self.fonts_dir()) else { return Ok(out) };
        for e in rd {
            let p = e?.path();
            let Ok(bytes) = fs::read(&p) else { continue };
            if let Some(family) = font_family(&bytes) {
                out.push(FontInfo { family, path: p.to_string_lossy().to_string() });
            }
        }
        out.sort_by(|a, b| a.family.cmp(&b.family));
        Ok(out)
    }

    // ------------------------------------------------------------ share bundles

    /// Write a `.pforge` bundle: project JSON plus every image it references.
    pub fn export_bundle(&self, project_id: &str, dest: &Path) -> AppResult<()> {
        let p = self.load_project(project_id)?;
        let f = fs::File::create(dest)?;
        let mut zip = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("project.json", opts)?;
        zip.write_all(&serde_json::to_vec_pretty(&p)?)?;
        let mut ids: Vec<String> = p
            .cards
            .iter()
            .flat_map(|c| [Some(c.front.clone()), c.back.clone()])
            .flatten()
            .collect();
        if let Some(b) = &p.layout.duplex.default_back {
            ids.push(b.clone());
        }
        ids.sort();
        ids.dedup();
        for id in ids {
            let Ok(meta) = self.image_meta(&id) else { continue };
            zip.start_file(format!("images/{}", meta.file), opts)?;
            zip.write_all(&fs::read(self.images.join(&meta.file))?)?;
            zip.start_file(format!("images/{id}.json"), opts)?;
            zip.write_all(&serde_json::to_vec(&meta)?)?;
        }
        zip.finish()?;
        Ok(())
    }

    pub fn import_bundle(&self, src: &Path) -> AppResult<Project> {
        let f = fs::File::open(src)?;
        let mut zip = zip::ZipArchive::new(f)?;
        let mut project: Option<Project> = None;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let name = entry.name()?.to_string();
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            if name == "project.json" {
                project = Some(serde_json::from_slice(&buf)?);
            } else if name.starts_with("images/") && !name.ends_with(".json") {
                self.import_image_bytes(&buf, None, None, "imported bundle")?;
            }
        }
        let mut p = project.ok_or_else(|| AppError::Invalid("bundle has no project.json".into()))?;
        p.id = uuid::Uuid::new_v4().to_string();
        self.save_project(&p)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    pub family: String,
    pub path: String,
}

/// Family name from the font's `name` table (typographic family preferred).
pub fn font_family(bytes: &[u8]) -> Option<String> {
    let face = ttf_parser::Face::parse(bytes, 0).ok()?;
    let names = face.names();
    let pick = |id: u16| {
        names
            .into_iter()
            .filter(|n| n.name_id == id && n.is_unicode())
            .find_map(|n| n.to_string())
    };
    pick(ttf_parser::name_id::TYPOGRAPHIC_FAMILY).or_else(|| pick(ttf_parser::name_id::FAMILY))
}

fn read_json_or<T: serde::de::DeserializeOwned>(path: &Path, default: impl FnOnce() -> T) -> AppResult<T> {
    match fs::read(path) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(_) => Ok(default()),
    }
}

/// Write via a temp file + rename so a crash never leaves a half-written file.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!("{}.tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(w, h, image::Rgb([200, 10, 10]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn image_library_dedups_and_indexes_urls() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path().to_path_buf()).unwrap();
        let b = png_bytes(10, 14);
        let a = s.import_image_bytes(&b, Some("https://x/a.png".into()), None, "").unwrap();
        let c = s.import_image_bytes(&b, None, None, "").unwrap();
        assert_eq!(a.id, c.id);
        assert!(a.decodable);
        assert_eq!((a.width, a.height), (10, 14));
        assert_eq!(s.image_id_for_url("https://x/a.png"), Some(a.id.clone()));
        assert!(s.thumb_path(&a.id).unwrap().exists());
        // survives reopen
        let s2 = Store::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(s2.image_id_for_url("https://x/a.png"), Some(a.id));
    }

    #[test]
    fn undecodable_bytes_are_flagged() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path().to_path_buf()).unwrap();
        let m = s.import_image_bytes(b"not an image at all", None, None, "").unwrap();
        assert!(!m.decodable);
    }

    #[test]
    fn project_round_trip_and_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path().to_path_buf()).unwrap();
        let img = s.import_image_bytes(&png_bytes(8, 8), None, None, "").unwrap();
        let mut p = s.new_project("Test").unwrap();
        p.cards.push(CardEntry {
            id: "c1".into(),
            name: "Bolt".into(),
            qty: 4,
            front: img.id.clone(),
            back: None,
            original_front: None,
            original_back: None,
            source: None,
            builtin_bleed_mm: None,
            is_token: false,
            design_id: None,
            meta: None,
        });
        s.save_project(&p).unwrap();
        assert_eq!(s.list_projects().unwrap()[0].card_count, 4);

        let bundle = dir.path().join("t.pforge");
        s.export_bundle(&p.id, &bundle).unwrap();
        let other = tempfile::tempdir().unwrap();
        let s2 = Store::open(other.path().to_path_buf()).unwrap();
        let imported = s2.import_bundle(&bundle).unwrap();
        assert_eq!(imported.cards.len(), 1);
        assert!(s2.image_meta(&img.id).is_ok());

        s.delete_project(&p.id).unwrap();
        assert!(s.list_projects().unwrap().is_empty());
    }

    #[test]
    fn rejects_path_traversal_ids() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path().to_path_buf()).unwrap();
        assert!(s.load_project("../etc/passwd").is_err());
        assert!(s.image_meta("a/b").is_err());
    }
}
