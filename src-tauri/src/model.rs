//! Shared data model. Everything here is serialized to the frontend as camelCase JSON
//! and persisted to disk as project / preset / profile files.

use serde::{Deserialize, Serialize};

/// A card game supported by the image banks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Game {
    Mtg,
    Pokemon,
    Yugioh,
    Fab,
    Lorcana,
    Onepiece,
    Swu,
    Digimon,
    Riftbound,
    Custom,
}

impl Game {
    pub const BANKS: [Game; 9] = [
        Game::Mtg,
        Game::Pokemon,
        Game::Yugioh,
        Game::Fab,
        Game::Lorcana,
        Game::Onepiece,
        Game::Swu,
        Game::Digimon,
        Game::Riftbound,
    ];
}

/// A single row of the deck: one artwork printed `qty` times.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardEntry {
    pub id: String,
    pub name: String,
    pub qty: u32,
    /// Image library id (sha256) of the front.
    pub front: String,
    /// Image library id of the back, when it is a double-faced card or has a custom back.
    #[serde(default)]
    pub back: Option<String>,
    /// Original front before upscaling, so the user can revert.
    #[serde(default)]
    pub original_front: Option<String>,
    #[serde(default)]
    pub original_back: Option<String>,
    #[serde(default)]
    pub source: Option<CardSource>,
    /// Per-card bleed override in mm already present in the artwork. `None` = auto-detect.
    #[serde(default)]
    pub builtin_bleed_mm: Option<f32>,
    #[serde(default)]
    pub is_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSource {
    pub game: Game,
    pub card_id: String,
    #[serde(default)]
    pub set_code: String,
    #[serde(default)]
    pub number: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeMm {
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Margins {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BleedMode {
    /// Stretch the outermost pixel row/column outward.
    Extend,
    /// Mirror the image across its edges.
    Mirror,
    /// Fill with the average edge colour.
    Solid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CutGuideStyle {
    None,
    /// Short marks outside the card at each corner.
    Crop,
    /// Full-length lines across the sheet along every cut.
    Lines,
    /// Small L-shaped marks on each card corner.
    Corners,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutGuides {
    pub style: CutGuideStyle,
    /// `#rrggbb`
    pub color: String,
    pub width_pt: f32,
    pub length_mm: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DuplexFlip {
    /// Flip on the long edge (most printers' default duplex).
    LongEdge,
    ShortEdge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Duplex {
    pub enabled: bool,
    pub flip: DuplexFlip,
    pub offset_x_mm: f32,
    pub offset_y_mm: f32,
    /// Image used for cards without their own back.
    #[serde(default)]
    pub default_back: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSettings {
    pub page_preset: String,
    pub page_size: SizeMm,
    pub orientation: Orientation,
    pub margins: Margins,
    pub spacing_x_mm: f32,
    pub spacing_y_mm: f32,
    pub card_preset: String,
    pub card_size: SizeMm,
    pub corner_radius_mm: f32,
    pub bleed_mm: f32,
    pub bleed_mode: BleedMode,
    /// 0 = automatic fit.
    pub columns: u32,
    pub rows: u32,
    pub center: bool,
    pub cut_guides: CutGuides,
    pub duplex: Duplex,
    pub registration_marks: bool,
    /// Draw guides on top of the artwork instead of only in the gutters.
    pub guides_over_art: bool,
}

impl Default for LayoutSettings {
    fn default() -> Self {
        Self {
            page_preset: "letter".into(),
            page_size: SizeMm { width: 215.9, height: 279.4 },
            orientation: Orientation::Portrait,
            margins: Margins { top: 4.0, right: 4.0, bottom: 4.0, left: 4.0 },
            spacing_x_mm: 0.0,
            spacing_y_mm: 0.0,
            card_preset: "standard".into(),
            card_size: SizeMm { width: 63.0, height: 88.0 },
            corner_radius_mm: 3.0,
            bleed_mm: 1.0,
            bleed_mode: BleedMode::Extend,
            columns: 0,
            rows: 0,
            center: true,
            cut_guides: CutGuides {
                style: CutGuideStyle::Crop,
                color: "#000000".into(),
                width_pt: 0.5,
                length_mm: 4.0,
            },
            duplex: Duplex {
                enabled: false,
                flip: DuplexFlip::LongEdge,
                offset_x_mm: 0.0,
                offset_y_mm: 0.0,
                default_back: None,
            },
            registration_marks: false,
            guides_over_art: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub cards: Vec<CardEntry>,
    pub layout: LayoutSettings,
    #[serde(default)]
    pub print_profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub updated_at: String,
    pub card_count: u32,
    pub thumb: Option<String>,
}

// ---------- Colour / print profiles ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RenderingIntent {
    Perceptual,
    RelativeColorimetric,
    Saturation,
    AbsoluteColorimetric,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputColorSpace {
    Rgb,
    Cmyk,
}

/// A tone curve as control points in 0..=1, sorted by x. Empty = identity.
pub type Curve = Vec<[f32; 2]>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adjustments {
    /// -1..1
    pub brightness: f32,
    /// -1..1
    pub contrast: f32,
    /// -1..1 (‑1 = greyscale)
    pub saturation: f32,
    /// -1..1
    pub vibrance: f32,
    /// 0.1..3, 1 = neutral
    pub gamma: f32,
    /// Input black / white points, 0..1
    pub levels_black: f32,
    pub levels_white: f32,
    /// Per channel multipliers, 1 = neutral (simple white balance)
    pub red: f32,
    pub green: f32,
    pub blue: f32,
    #[serde(default)]
    pub curve_master: Curve,
    #[serde(default)]
    pub curve_red: Curve,
    #[serde(default)]
    pub curve_green: Curve,
    #[serde(default)]
    pub curve_blue: Curve,
    /// Unsharp mask amount 0..2 (0 = off)
    pub sharpen: f32,
}

impl Default for Adjustments {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            vibrance: 0.0,
            gamma: 1.0,
            levels_black: 0.0,
            levels_white: 1.0,
            red: 1.0,
            green: 1.0,
            blue: 1.0,
            curve_master: vec![],
            curve_red: vec![],
            curve_green: vec![],
            curve_blue: vec![],
            sharpen: 0.0,
        }
    }
}

impl Adjustments {
    pub fn is_identity(&self) -> bool {
        *self == Adjustments::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintProfile {
    pub id: String,
    pub name: String,
    /// Id of a colour profile: `builtin:srgb`, `builtin:p3`, `builtin:adobergb`,
    /// `builtin:naive-cmyk` or the file name of an imported ICC profile.
    pub output_icc: String,
    pub output_space: OutputColorSpace,
    pub intent: RenderingIntent,
    pub black_point_compensation: bool,
    /// Embed the output profile in exports (tagging). Turn off when the printer driver
    /// must receive already-converted values with colour management disabled.
    pub embed_profile: bool,
    pub dpi: u32,
    pub adjustments: Adjustments,
    /// Total ink limit in percent for CMYK (e.g. 300). 400 = no limit.
    #[serde(default = "default_ink_limit")]
    pub ink_limit: f32,
    #[serde(default)]
    pub notes: String,
}

fn default_ink_limit() -> f32 {
    400.0
}

impl Default for PrintProfile {
    fn default() -> Self {
        Self {
            id: "default".into(),
            name: "Home inkjet (sRGB)".into(),
            output_icc: "builtin:srgb".into(),
            output_space: OutputColorSpace::Rgb,
            intent: RenderingIntent::Perceptual,
            black_point_compensation: true,
            embed_profile: true,
            dpi: 600,
            adjustments: Adjustments::default(),
            ink_limit: 400.0,
            notes: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IccInfo {
    pub id: String,
    pub name: String,
    pub space: OutputColorSpace,
    pub builtin: bool,
}

/// A saved layout template ("preset").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPreset {
    pub id: String,
    pub name: String,
    pub layout: LayoutSettings,
}

// ---------- Image library ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub id: String,
    pub file: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub source_url: Option<String>,
    /// False when the Rust decoder cannot read the format (e.g. AVIF); the UI converts it.
    pub decodable: bool,
    #[serde(default)]
    pub derived_from: Option<String>,
    #[serde(default)]
    pub note: String,
}

// ---------- Export ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Pdf,
    Png,
    Tiff,
    Zip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PdfCompression {
    Lossless,
    Jpeg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub format: ExportFormat,
    pub path: String,
    /// Overrides the print profile DPI when set.
    #[serde(default)]
    pub dpi: Option<u32>,
    #[serde(default = "default_compression")]
    pub compression: PdfCompression,
    #[serde(default = "default_jpeg_quality")]
    pub jpeg_quality: u8,
    /// 16 bits per channel for PNG / TIFF.
    #[serde(default)]
    pub sixteen_bit: bool,
    /// Also write a Silhouette cut file (SVG + DXF) next to the export.
    #[serde(default)]
    pub cut_file: bool,
}

fn default_compression() -> PdfCompression {
    PdfCompression::Lossless
}
fn default_jpeg_quality() -> u8 {
    95
}
