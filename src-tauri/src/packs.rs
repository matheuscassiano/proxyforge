//! Asset packs for the card builder: frames, symbols and fonts for each TCG.
//!
//! Nothing proprietary ships with ProxyForge. A pack manifest (embedded JSON under
//! `packs/manifests/`) only lists URLs of community-hosted files; they are downloaded into
//! `<appData>/packs/<id>/` on demand (when a card first needs them) or all at once with
//! `install`. A pack can also be installed offline from a `.zip` holding `pack.json` + files.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::providers::Providers;
use crate::store::{atomic_write, sha256_hex};

const BUILTIN: &[&str] = &[
    include_str!("../../packs/manifests/mtg.json"),
    include_str!("../../packs/manifests/pokemon.json"),
    include_str!("../../packs/manifests/fab.json"),
];

/// Hosts the builder may pull remote assets from (set symbols, card scans, art crops).
const ASSET_HOSTS: &[&str] = &[
    "svgs.scryfall.io",
    "cards.scryfall.io",
    "api.scryfall.com",
    "assets.tcgdex.net",
    "raw.githubusercontent.com",
    "storage.googleapis.com",
    "d2wlb52bya4y8z.cloudfront.net",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFont {
    pub family: String,
    pub file: String,
    #[serde(default = "default_weight")]
    pub weight: u16,
    #[serde(default = "default_style")]
    pub style: String,
}
fn default_weight() -> u16 {
    400
}
fn default_style() -> String {
    "normal".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFile {
    pub path: String,
    /// Absolute URL; when absent the file is fetched from `baseUrl + path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub id: String,
    pub game: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub version: u32,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub fonts: Vec<PackFont>,
    pub files: Vec<PackFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    #[serde(flatten)]
    pub manifest: PackManifest,
    pub dir: String,
    pub installed_files: usize,
    pub total_files: usize,
    pub total_bytes: u64,
    pub complete: bool,
}

pub struct Packs {
    root: PathBuf,
    manifests: Mutex<HashMap<String, PackManifest>>,
}

/// Reject absolute paths, `..` and anything that is not a plain relative path.
pub fn safe_rel(path: &str) -> AppResult<PathBuf> {
    let p = Path::new(path);
    if path.is_empty() || p.is_absolute() || path.contains('\\') {
        return Err(AppError::Invalid(format!("invalid pack path '{path}'")));
    }
    for c in p.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(AppError::Invalid(format!("invalid pack path '{path}'")));
        }
    }
    Ok(p.to_path_buf())
}

fn safe_pack_id(id: &str) -> AppResult<&str> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Invalid(format!("invalid pack id '{id}'")));
    }
    Ok(id)
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

impl PackManifest {
    pub fn validate(&self) -> AppResult<()> {
        safe_pack_id(&self.id)?;
        for f in &self.files {
            safe_rel(&f.path)?;
            if f.url.is_none() && self.base_url.is_empty() {
                return Err(AppError::Invalid(format!("pack file '{}' has no URL", f.path)));
            }
        }
        for f in &self.fonts {
            safe_rel(&f.file)?;
        }
        Ok(())
    }

    pub fn url_for(&self, f: &PackFile) -> String {
        f.url.clone().unwrap_or_else(|| format!("{}{}", self.base_url, encode_path(&f.path)))
    }
}

impl Packs {
    pub fn open(root: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&root)?;
        let mut map = HashMap::new();
        for raw in BUILTIN {
            let m: PackManifest = serde_json::from_str(raw)?;
            m.validate()?;
            map.insert(m.id.clone(), m);
        }
        // Packs installed from zip files keep their manifest on disk.
        if let Ok(rd) = std::fs::read_dir(&root) {
            for e in rd.flatten() {
                let mf = e.path().join("pack.json");
                if let Ok(b) = std::fs::read(&mf) {
                    if let Ok(m) = serde_json::from_slice::<PackManifest>(&b) {
                        if m.validate().is_ok() && !map.contains_key(&m.id) {
                            map.insert(m.id.clone(), m);
                        }
                    }
                }
            }
        }
        Ok(Self { root, manifests: Mutex::new(map) })
    }

    fn dir(&self, id: &str) -> AppResult<PathBuf> {
        Ok(self.root.join(safe_pack_id(id)?))
    }

    pub fn manifest(&self, id: &str) -> AppResult<PackManifest> {
        self.manifests.lock().get(id).cloned().ok_or_else(|| AppError::NotFound(format!("unknown pack '{id}'")))
    }

    pub fn list(&self) -> AppResult<Vec<PackStatus>> {
        let mut v: Vec<PackManifest> = self.manifests.lock().values().cloned().collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v.into_iter().map(|m| self.status(m)).collect()
    }

    fn status(&self, m: PackManifest) -> AppResult<PackStatus> {
        let dir = self.dir(&m.id)?;
        let installed = m.files.iter().filter(|f| dir.join(&f.path).is_file()).count();
        let total = m.files.len();
        Ok(PackStatus {
            dir: dir.to_string_lossy().to_string(),
            installed_files: installed,
            total_files: total,
            total_bytes: m.files.iter().map(|f| f.size).sum(),
            complete: installed == total,
            manifest: m,
        })
    }

    /// Local path of a pack file inside the pack folder (never outside it).
    fn local(&self, id: &str, path: &str) -> AppResult<PathBuf> {
        Ok(self.dir(id)?.join(safe_rel(path)?))
    }

    /// Bytes of a pack file, downloading it first when it is listed but not on disk yet.
    pub async fn read(&self, providers: &Providers, id: &str, path: &str) -> AppResult<Vec<u8>> {
        let local = self.local(id, path)?;
        if let Ok(b) = std::fs::read(&local) {
            return Ok(b);
        }
        let m = self.manifest(id)?;
        let f = m
            .files
            .iter()
            .find(|f| f.path == path)
            .ok_or_else(|| AppError::NotFound(format!("'{path}' is not part of pack '{id}'")))?;
        let bytes = providers.get_bytes(&m.url_for(f)).await?;
        if let Some(parent) = local.parent() {
            std::fs::create_dir_all(parent)?;
        }
        atomic_write(&local, &bytes)?;
        Ok(bytes)
    }

    /// Download every missing file. `progress(done, total)` is called after each file.
    pub async fn install(
        &self,
        providers: Arc<Providers>,
        id: &str,
        cancel: Arc<AtomicBool>,
        progress: impl Fn(usize, usize),
    ) -> AppResult<PackStatus> {
        let m = self.manifest(id)?;
        let dir = self.dir(id)?;
        let missing: Vec<PackFile> = m.files.iter().filter(|f| !dir.join(&f.path).is_file()).cloned().collect();
        let total = missing.len();
        let mut set = tokio::task::JoinSet::new();
        let sem = Arc::new(tokio::sync::Semaphore::new(6));
        for f in missing {
            let url = m.url_for(&f);
            let dest = dir.join(safe_rel(&f.path)?);
            let providers = providers.clone();
            let sem = sem.clone();
            let cancel = cancel.clone();
            set.spawn(async move {
                let _permit = sem.acquire_owned().await.map_err(|e| AppError::Other(e.to_string()))?;
                if cancel.load(Ordering::Relaxed) {
                    return Err(AppError::Other("cancelled".into()));
                }
                let bytes = providers.get_bytes(&url).await?;
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                atomic_write(&dest, &bytes)?;
                Ok::<_, AppError>(())
            });
        }
        let mut done = 0;
        let mut first_err = None;
        while let Some(r) = set.join_next().await {
            done += 1;
            match r {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
                Err(e) => {
                    if first_err.is_none() {
                        first_err = Some(AppError::Other(e.to_string()));
                    }
                }
            }
            progress(done, total);
        }
        let status = self.status(m)?;
        match first_err {
            Some(e) if cancel.load(Ordering::Relaxed) => Err(e),
            Some(e) if !status.complete && status.installed_files == 0 => Err(e),
            _ => Ok(status),
        }
    }

    pub fn remove(&self, id: &str) -> AppResult<()> {
        let dir = self.dir(id)?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        // A zip-installed pack disappears with its folder; built-ins stay available.
        let builtin = BUILTIN.iter().any(|raw| serde_json::from_str::<PackManifest>(raw).map(|m| m.id == id).unwrap_or(false));
        if !builtin {
            self.manifests.lock().remove(id);
        }
        Ok(())
    }

    /// Install a pack from a zip with `pack.json` at its root (offline / custom packs).
    pub fn install_zip(&self, zip_path: &Path) -> AppResult<PackStatus> {
        let file = std::fs::File::open(zip_path)?;
        let mut zip = zip::ZipArchive::new(file)?;
        let mut manifest: PackManifest = {
            let mut entry = zip.by_name("pack.json").map_err(|_| AppError::Invalid("the zip has no pack.json".into()))?;
            let mut s = String::new();
            entry.read_to_string(&mut s)?;
            serde_json::from_str(&s)?
        };
        if manifest.base_url.is_empty() {
            manifest.base_url = "file://local/".into();
        }
        manifest.validate()?;
        let dir = self.dir(&manifest.id)?;
        std::fs::create_dir_all(&dir)?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            if entry.is_dir() {
                continue;
            }
            let Some(name) = entry.enclosed_name() else { continue };
            let rel = safe_rel(&name.to_string_lossy().replace('\\', "/"))?;
            let dest = dir.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut buf = vec![];
            entry.read_to_end(&mut buf)?;
            atomic_write(&dest, &buf)?;
        }
        atomic_write(&dir.join("pack.json"), &serde_json::to_vec_pretty(&manifest)?)?;
        self.manifests.lock().insert(manifest.id.clone(), manifest.clone());
        self.status(manifest)
    }
}

/// Remote asset (set symbol, card scan) from an allow-listed host, cached on disk.
pub async fn fetch_asset(providers: &Providers, cache_dir: &Path, url: &str) -> AppResult<Vec<u8>> {
    let parsed = reqwest::Url::parse(url).map_err(|_| AppError::Invalid("invalid URL".into()))?;
    if parsed.scheme() != "https" || !parsed.host_str().is_some_and(|h| ASSET_HOSTS.contains(&h)) {
        return Err(AppError::Invalid(format!("host not allowed for builder assets: {url}")));
    }
    let dir = cache_dir.join("assets");
    let path = dir.join(&sha256_hex(url.as_bytes())[..32]);
    if let Ok(b) = std::fs::read(&path) {
        return Ok(b);
    }
    let bytes = providers.get_bytes(url).await?;
    std::fs::create_dir_all(&dir)?;
    atomic_write(&path, &bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn builtin_manifests_are_valid() {
        for raw in BUILTIN {
            let m: PackManifest = serde_json::from_str(raw).unwrap();
            m.validate().unwrap();
            assert!(!m.files.is_empty(), "{} has files", m.id);
            for f in &m.fonts {
                assert!(m.files.iter().any(|x| x.path == f.file), "{}: font {} listed in files", m.id, f.file);
            }
        }
    }

    #[test]
    fn rejects_traversal() {
        assert!(safe_rel("../x.png").is_err());
        assert!(safe_rel("/etc/passwd").is_err());
        assert!(safe_rel("a/../../b").is_err());
        assert!(safe_rel("img/frames/m15/new/w.png").is_ok());
        assert!(safe_pack_id("../mtg").is_err());
    }

    #[test]
    fn encodes_spaces() {
        let m: PackManifest = serde_json::from_str(BUILTIN[2]).unwrap();
        let f = m.files.iter().find(|f| f.path.contains(' ')).unwrap();
        assert!(!m.url_for(f).contains(' '));
    }

    #[test]
    fn installs_from_zip() {
        let tmp = tempfile::tempdir().unwrap();
        let packs = Packs::open(tmp.path().join("packs")).unwrap();
        let zpath = tmp.path().join("p.zip");
        {
            let f = std::fs::File::create(&zpath).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let opt = zip::write::SimpleFileOptions::default();
            z.start_file("pack.json", opt).unwrap();
            z.write_all(br#"{"id":"custom1","game":"custom","name":"Custom","version":1,"files":[{"path":"frames/a.png"}]}"#).unwrap();
            z.start_file("frames/a.png", opt).unwrap();
            z.write_all(b"png").unwrap();
            z.finish().unwrap();
        }
        let st = packs.install_zip(&zpath).unwrap();
        assert!(st.complete);
        assert_eq!(std::fs::read(packs.local("custom1", "frames/a.png").unwrap()).unwrap(), b"png");
        assert!(packs.local("custom1", "../pack.json").is_err());
        packs.remove("custom1").unwrap();
        assert!(packs.manifest("custom1").is_err());
    }
}
