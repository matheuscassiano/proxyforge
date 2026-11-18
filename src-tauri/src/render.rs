//! Rendering a project to print files: PDF (vector guides, ICC/CMYK), streamed PNG/TIFF
//! pages, card-image ZIPs, Silhouette cut files, live previews and a colour test chart.

use std::collections::HashMap;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use image::DynamicImage;
use miniz_oxide::deflate::compress_to_vec_zlib;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, TextStr};

use crate::color::{self, ColorPipeline, Pixels};
use crate::error::{AppError, AppResult};
use crate::imaging::{self, Rgb16};
use crate::layout::{self, Grid, RectMm, PT_PER_MM};
use crate::model::*;
use crate::store::Store;

// ------------------------------------------------------------------ decoded image cache

struct DecodedCache {
    map: HashMap<String, Arc<DynamicImage>>,
    order: Vec<String>,
    bytes: usize,
}

const CACHE_BUDGET: usize = 768 * 1024 * 1024;

static DECODED: Lazy<Mutex<DecodedCache>> =
    Lazy::new(|| Mutex::new(DecodedCache { map: HashMap::new(), order: vec![], bytes: 0 }));

pub fn decoded(store: &Store, id: &str) -> AppResult<Arc<DynamicImage>> {
    if let Some(img) = DECODED.lock().map.get(id).cloned() {
        return Ok(img);
    }
    let meta = store.image_meta(id)?;
    if !meta.decodable {
        return Err(AppError::Image(format!(
            "image {id} is in a format that must be converted first (open the project in the app to convert it)"
        )));
    }
    let img = Arc::new(imaging::decode_file(&store.images.join(&meta.file))?);
    let size = img.as_bytes().len();
    let mut c = DECODED.lock();
    while c.bytes + size > CACHE_BUDGET && !c.order.is_empty() {
        let old = c.order.remove(0);
        if let Some(o) = c.map.remove(&old) {
            c.bytes -= o.as_bytes().len();
        }
    }
    c.bytes += size;
    c.order.push(id.to_string());
    c.map.insert(id.to_string(), img.clone());
    Ok(img)
}

// ------------------------------------------------------------------ planning

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Front,
    Back,
}

/// Where an artwork comes from (edge darkening can target each kind).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CardKind {
    #[default]
    Bank,
    Upload,
    Back,
}

#[derive(Debug, Clone)]
pub struct PlacedCard {
    pub slot: usize,
    pub image: String,
    pub builtin_bleed: Option<f32>,
    pub kind: CardKind,
}

fn front_kind(c: &CardEntry) -> CardKind {
    if c.source.is_some() { CardKind::Bank } else { CardKind::Upload }
}

#[derive(Debug, Clone)]
pub struct PagePlan {
    pub side: Side,
    pub grid: Grid,
    pub cards: Vec<PlacedCard>,
}

pub fn plan(p: &Project) -> AppResult<Vec<PagePlan>> {
    let grid = layout::compute_grid(&p.layout);
    let per = grid.per_page();
    if per == 0 {
        return Err(AppError::Invalid("No card fits on the page: reduce margins, bleed or card size.".into()));
    }
    let instances = layout::expand_instances(&p.cards.iter().map(|c| c.qty).collect::<Vec<_>>());
    let d = &p.layout.duplex;
    let back_grid = layout::mirror_for_back(&grid, &p.layout);
    let mut out = vec![];
    for chunk in instances.chunks(per) {
        let fronts = chunk
            .iter()
            .enumerate()
            .map(|(slot, &ci)| PlacedCard {
                slot,
                image: p.cards[ci].front.clone(),
                builtin_bleed: p.cards[ci].builtin_bleed_mm,
                kind: front_kind(&p.cards[ci]),
            })
            .collect();
        out.push(PagePlan { side: Side::Front, grid: grid.clone(), cards: fronts });
        if d.enabled {
            let backs = chunk
                .iter()
                .enumerate()
                .filter_map(|(slot, &ci)| {
                    let c = &p.cards[ci];
                    let img = c.back.clone().or_else(|| d.default_back.clone())?;
                    Some(PlacedCard { slot, image: img, builtin_bleed: None, kind: CardKind::Back })
                })
                .collect();
            out.push(PagePlan { side: Side::Back, grid: back_grid.clone(), cards: backs });
        }
    }
    Ok(out)
}

/// Pages shown in the live view: the export plan without sheets that would print nothing
/// (e.g. back pages when duplex is on but no card has a back). The export keeps them so
/// duplex printers still alternate front / back.
pub fn preview_plan(p: &Project) -> AppResult<Vec<PagePlan>> {
    Ok(plan(p)?.into_iter().filter(|pg| !pg.cards.is_empty()).collect())
}

/// One card position on a previewed page, for hit-testing in the UI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotMap {
    pub card_id: String,
    /// Index of this copy in the flattened deck (all copies of all cards, in order).
    pub instance: usize,
    /// Trim box in mm, already mirrored on back pages.
    pub rect: RectMm,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMap {
    pub side: Side,
    pub slots: Vec<SlotMap>,
}

/// Where each card copy sits on every page of `preview_plan`, in the same order.
pub fn page_map(p: &Project) -> AppResult<Vec<PageMap>> {
    let per = layout::compute_grid(&p.layout).per_page();
    let instances = layout::expand_instances(&p.cards.iter().map(|c| c.qty).collect::<Vec<_>>());
    let mut sheet = 0usize;
    let mut out = vec![];
    for (i, page) in plan(p)?.into_iter().enumerate() {
        if page.side == Side::Front && i > 0 {
            sheet += 1;
        }
        if page.cards.is_empty() {
            continue;
        }
        let slots = page
            .cards
            .iter()
            .map(|pc| {
                let instance = sheet * per + pc.slot;
                SlotMap { card_id: p.cards[instances[instance]].id.clone(), instance, rect: page.grid.slots[pc.slot].card }
            })
            .collect();
        out.push(PageMap { side: page.side, slots });
    }
    Ok(out)
}

// ------------------------------------------------------------------ cards

pub struct CardBitmap {
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels,
}

fn card_process(l: &LayoutSettings, kind: CardKind) -> imaging::CardProcess {
    let d = l.edge_darken;
    let darken_this = d.enabled
        && match kind {
            CardKind::Bank => d.bank,
            CardKind::Upload => d.uploads,
            CardKind::Back => d.backs,
        };
    imaging::CardProcess { mode: l.bleed_mode, regenerate: l.builtin_bleed == BuiltinBleed::Regenerate, darken: darken_this.then_some(d) }
}

fn prepare_rgb(store: &Store, image: &str, builtin: Option<f32>, kind: CardKind, l: &LayoutSettings, dpi: u32) -> AppResult<Rgb16> {
    let process = card_process(l, kind);
    // Previews re-render on every edit; keep their resized cards so only changed inputs
    // (artwork, card size, bleed, DPI) trigger a new resample.
    let key = (dpi <= PREVIEW_CACHE_MAX_DPI).then(|| {
        format!(
            "{image}|{:?}|{}x{}|{}|{:?}|{}|{:?}|{dpi}",
            builtin, l.card_size.width, l.card_size.height, l.bleed_mm, l.bleed_mode, process.regenerate, process.darken
        )
    });
    if let Some(k) = &key {
        if let Some(hit) = PREPARED.lock().get(k) {
            return Ok((*hit).clone());
        }
    }
    let src = decoded(store, image)?;
    let b = builtin.unwrap_or_else(|| imaging::detect_bleed_mm(src.width(), src.height(), l.card_size));
    let out = imaging::prepare_card(&src, l.card_size, b, l.bleed_mm, process, dpi)?;
    if let Some(k) = key {
        PREPARED.lock().put(k, Arc::new(out.clone()));
    }
    Ok(out)
}

/// Prepared cards are cached up to this DPI (live preview and the print loupe).
const PREVIEW_CACHE_MAX_DPI: u32 = 1200;

/// Small byte-bounded LRU of prepared preview cards.
struct PreparedCache {
    map: HashMap<String, Arc<Rgb16>>,
    order: Vec<String>,
    bytes: usize,
}

impl PreparedCache {
    const BUDGET: usize = 256 * 1024 * 1024;
    fn get(&mut self, k: &str) -> Option<Arc<Rgb16>> {
        let v = self.map.get(k).cloned()?;
        if let Some(i) = self.order.iter().position(|x| x == k) {
            let key = self.order.remove(i);
            self.order.push(key);
        }
        Some(v)
    }
    fn put(&mut self, k: String, v: Arc<Rgb16>) {
        let size = v.data.len() * 2;
        while self.bytes + size > Self::BUDGET && !self.order.is_empty() {
            let old = self.order.remove(0);
            if let Some(o) = self.map.remove(&old) {
                self.bytes -= o.data.len() * 2;
            }
        }
        if self.map.insert(k.clone(), v).is_none() {
            self.bytes += size;
            self.order.push(k);
        }
    }
}

static PREPARED: Lazy<Mutex<PreparedCache>> =
    Lazy::new(|| Mutex::new(PreparedCache { map: HashMap::new(), order: vec![], bytes: 0 }));

pub fn render_card(
    store: &Store,
    pc: &PlacedCard,
    l: &LayoutSettings,
    dpi: u32,
    pipe: &ColorPipeline,
) -> AppResult<CardBitmap> {
    let mut rgb = prepare_rgb(store, &pc.image, pc.builtin_bleed, pc.kind, l, dpi)?;
    let (w, h) = (rgb.width, rgb.height);
    let pixels = pipe.convert(&mut rgb);
    Ok(CardBitmap { width: w, height: h, pixels })
}

pub type Progress<'a> = &'a (dyn Fn(f32, &str) + Sync);

fn check_cancel(c: &AtomicBool) -> AppResult<()> {
    if c.load(Ordering::Relaxed) {
        Err(AppError::Other("Export cancelled".into()))
    } else {
        Ok(())
    }
}

// ------------------------------------------------------------------ colours

fn parse_hex(s: &str) -> [u8; 3] {
    let s = s.trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(s.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    if s.len() >= 6 { [p(0), p(2), p(4)] } else { [0, 0, 0] }
}

/// Convert an sRGB colour to output-space bytes (BE for 16-bit).
fn color_bytes(pipe: &ColorPipeline, rgb: [u8; 3]) -> Vec<u8> {
    let mut img = Rgb16::new(1, 1);
    img.data = rgb.iter().map(|v| *v as u16 * 257).collect();
    // guides should not be affected by tonal adjustments
    let saved = crate::model::Adjustments::default();
    let _ = saved;
    pipe.convert(&mut img).to_be_bytes()
}

fn black_bytes(pipe: &ColorPipeline) -> Vec<u8> {
    match (pipe.space, pipe.sixteen) {
        (OutputColorSpace::Cmyk, false) => vec![0, 0, 0, 255],
        (OutputColorSpace::Cmyk, true) => vec![0, 0, 0, 0, 0, 0, 255, 255],
        _ => color_bytes(pipe, [0, 0, 0]),
    }
}

fn paper_bytes(pipe: &ColorPipeline) -> Vec<u8> {
    let bpp = (if pipe.space == OutputColorSpace::Cmyk { 4 } else { 3 }) * if pipe.sixteen { 2 } else { 1 };
    vec![if pipe.space == OutputColorSpace::Cmyk { 0 } else { 255 }; bpp]
}

// ------------------------------------------------------------------ raster compositor

/// A card bitmap placed into a destination rectangle. The rectangle comes from rounding the
/// slot's mm edges, so neighbouring cards share the exact same pixel edge. The bitmap may
/// differ by a pixel from the rectangle; edge pixels are repeated (or cropped) to fill it, so
/// no paper shows through between adjacent cards.
struct Blit<'a> {
    x: i64,
    y: i64,
    /// destination size
    w: u32,
    h: u32,
    /// source bitmap size
    bw: u32,
    bh: u32,
    bytes: &'a [u8],
}

struct FillRect {
    x0: i64,
    y0: i64,
    x1: i64,
    y1: i64,
    color: Vec<u8>,
}

struct Canvas<'a> {
    w: u32,
    h: u32,
    bpp: usize,
    bg: Vec<u8>,
    blits: Vec<Blit<'a>>,
    /// Anti-aliased cut guides, blended over the artwork.
    guides: Option<GuideLayer>,
    /// Registration marks (sharp, pixel aligned), drawn last.
    rects: Vec<FillRect>,
}

/// Rows of guide coverage rendered at a time.
const GUIDE_TILE: u32 = 64;

/// Cut guides stroked with tiny-skia into a coverage mask, one horizontal tile at a time
/// (pages are written row by row, so only one tile is alive), then blended into each row.
struct GuideLayer {
    /// Paths hidden where they cross artwork.
    clipped: Vec<tiny_skia::Path>,
    free: Vec<tiny_skia::Path>,
    stroke: tiny_skia::Stroke,
    /// Artwork boxes (px) the clipped paths must avoid.
    arts: Vec<(f32, f32, f32, f32)>,
    color: Vec<u8>,
    sixteen: bool,
    tile: Mutex<Option<(u32, Vec<u8>)>>,
}

/// Dash pattern for guides of the given width, in the same unit.
pub fn guide_dash(width: f32, mm: f32) -> (f32, f32) {
    let d = (width * 4.0).max(1.5 * mm);
    (d, d * 0.6)
}

impl GuideLayer {
    fn new(page: &PagePlan, l: &LayoutSettings, dpi: u32, color: Vec<u8>, sixteen: bool) -> Option<Self> {
        let guides = &page.grid.guides;
        if guides.is_empty() {
            return None;
        }
        let px = |mm: f32| mm / layout::MM_PER_INCH * dpi as f32;
        let to_path = |g: &layout::GuidePath| {
            let mut pb = tiny_skia::PathBuilder::new();
            let mut it = g.pts.iter();
            let first = it.next()?;
            pb.move_to(px(first[0]), px(first[1]));
            for p in it {
                pb.line_to(px(p[0]), px(p[1]));
            }
            pb.finish()
        };
        let (mut clipped, mut free) = (vec![], vec![]);
        for g in guides {
            if let Some(p) = to_path(g) {
                if g.clipped && !l.guides_over_art { clipped.push(p) } else { free.push(p) }
            }
        }
        let width = (l.cut_guides.width_pt / 72.0 * dpi as f32).max(1.0);
        let mut stroke = tiny_skia::Stroke { width, line_cap: tiny_skia::LineCap::Butt, line_join: tiny_skia::LineJoin::Miter, ..Default::default() };
        if l.cut_guides.dashed {
            let (d, g) = guide_dash(width, px(1.0));
            stroke.dash = tiny_skia::StrokeDash::new(vec![d, g], 0.0);
        }
        let arts = page
            .cards
            .iter()
            .map(|pc| {
                let a = page.grid.slots[pc.slot].art;
                (px(a.x), px(a.y), px(a.right()), px(a.bottom()))
            })
            .collect();
        Some(GuideLayer { clipped, free, stroke, arts, color, sixteen, tile: Mutex::new(None) })
    }

    fn render_tile(&self, w: u32, h: u32, t: u32) -> Vec<u8> {
        let y0 = t * GUIDE_TILE;
        let th = GUIDE_TILE.min(h - y0);
        let Some(mut pm) = tiny_skia::Pixmap::new(w, th) else { return vec![0; (w * th) as usize] };
        let ts = tiny_skia::Transform::from_translate(0.0, -(y0 as f32));
        let mut paint = tiny_skia::Paint::default();
        paint.set_color(tiny_skia::Color::BLACK);
        paint.anti_alias = true;
        if !self.clipped.is_empty() {
            // mask = page minus artwork (even-odd: the art boxes never overlap)
            let mask = if self.arts.is_empty() {
                None
            } else {
                let mut pb = tiny_skia::PathBuilder::new();
                if let Some(r) = tiny_skia::Rect::from_xywh(-1.0, -1.0, w as f32 + 2.0, h as f32 + 2.0) {
                    pb.push_rect(r);
                }
                for &(x0, y, x1, y1) in &self.arts {
                    if let Some(r) = tiny_skia::Rect::from_ltrb(x0, y, x1, y1) {
                        pb.push_rect(r);
                    }
                }
                pb.finish().and_then(|path| {
                    let mut m = tiny_skia::Mask::new(w, th)?;
                    m.fill_path(&path, tiny_skia::FillRule::EvenOdd, false, ts);
                    Some(m)
                })
            };
            for p in &self.clipped {
                pm.stroke_path(p, &paint, &self.stroke, ts, mask.as_ref());
            }
        }
        for p in &self.free {
            pm.stroke_path(p, &paint, &self.stroke, ts, None);
        }
        pm.data().chunks_exact(4).map(|px| px[3]).collect()
    }

    fn blend_row(&self, w: u32, h: u32, y: u32, buf: &mut [u8], bpp: usize) {
        let t = y / GUIDE_TILE;
        let mut tile = self.tile.lock();
        if tile.as_ref().is_none_or(|(i, _)| *i != t) {
            *tile = Some((t, self.render_tile(w, h, t)));
        }
        let cov = &tile.as_ref().unwrap().1;
        let row = &cov[((y - t * GUIDE_TILE) * w) as usize..((y - t * GUIDE_TILE + 1) * w) as usize];
        for (x, &a) in row.iter().enumerate() {
            if a == 0 {
                continue;
            }
            let px = &mut buf[x * bpp..(x + 1) * bpp];
            if a == 255 {
                px.copy_from_slice(&self.color);
            } else if self.sixteen {
                let a = a as u32 * 257;
                for (d, c) in px.chunks_exact_mut(2).zip(self.color.chunks_exact(2)) {
                    let (b, c) = (u16::from_be_bytes([d[0], d[1]]) as u32, u16::from_be_bytes([c[0], c[1]]) as u32);
                    let v = ((b * (65535 - a) + c * a + 32767) / 65535) as u16;
                    d.copy_from_slice(&v.to_be_bytes());
                }
            } else {
                let a = a as u32;
                for (d, &c) in px.iter_mut().zip(self.color.iter()) {
                    *d = ((*d as u32 * (255 - a) + c as u32 * a + 127) / 255) as u8;
                }
            }
        }
    }
}

impl Canvas<'_> {
    fn row(&self, y: u32, buf: &mut Vec<u8>) {
        let bpp = self.bpp;
        buf.clear();
        buf.reserve(self.w as usize * bpp);
        for _ in 0..self.w {
            buf.extend_from_slice(&self.bg);
        }
        let yi = y as i64;
        for b in &self.blits {
            if yi < b.y || yi >= b.y + b.h as i64 || b.bw == 0 || b.bh == 0 {
                continue;
            }
            let sy = ((yi - b.y) as usize).min(b.bh as usize - 1);
            let x0 = b.x.max(0);
            let x1 = (b.x + b.w as i64).min(self.w as i64);
            if x1 <= x0 {
                continue;
            }
            let row = &b.bytes[sy * b.bw as usize * bpp..(sy + 1) * b.bw as usize * bpp];
            let sx = (x0 - b.x) as usize;
            // part covered by the bitmap: straight copy
            let n = ((x1 - x0) as usize).min((b.bw as usize).saturating_sub(sx));
            if n > 0 {
                buf[x0 as usize * bpp..(x0 as usize + n) * bpp].copy_from_slice(&row[sx * bpp..(sx + n) * bpp]);
            }
            // remainder (rect wider than bitmap by rounding): repeat the last column
            let last = &row[(b.bw as usize - 1) * bpp..b.bw as usize * bpp];
            for x in (x0 as usize + n)..x1 as usize {
                buf[x * bpp..(x + 1) * bpp].copy_from_slice(last);
            }
        }
        if let Some(g) = &self.guides {
            g.blend_row(self.w, self.h, y, buf, bpp);
        }
        for r in &self.rects {
            if yi < r.y0 || yi >= r.y1 {
                continue;
            }
            let x0 = r.x0.max(0) as usize;
            let x1 = (r.x1.min(self.w as i64)).max(0) as usize;
            for x in x0..x1 {
                buf[x * bpp..(x + 1) * bpp].copy_from_slice(&r.color);
            }
        }
    }
}

fn mm_px(mm: f32, dpi: u32) -> i64 {
    (mm / layout::MM_PER_INCH * dpi as f32).round() as i64
}

fn reg_rects(grid: &Grid, dpi: u32, black: &[u8]) -> Vec<FillRect> {
    grid.reg_marks
        .iter()
        .map(|r| FillRect { x0: mm_px(r.x, dpi), y0: mm_px(r.y, dpi), x1: mm_px(r.right(), dpi), y1: mm_px(r.bottom(), dpi), color: black.to_vec() })
        .collect()
}

/// Compose a page: artwork, then guides (clipped away from the art unless drawn over it), then registration marks.
fn build_canvas<'a>(
    page: &PagePlan,
    cards: &'a [(usize, CardBitmap, Vec<u8>)],
    l: &LayoutSettings,
    dpi: u32,
    pipe: &ColorPipeline,
) -> Canvas<'a> {
    let pw = layout::mm_to_px(page.grid.page.width, dpi);
    let ph = layout::mm_to_px(page.grid.page.height, dpi);
    let bpp = (if pipe.space == OutputColorSpace::Cmyk { 4 } else { 3 }) * if pipe.sixteen { 2 } else { 1 };
    let blits = cards
        .iter()
        .map(|(slot, bmp, bytes)| {
            let art: RectMm = page.grid.slots[*slot].art;
            let (x0, y0) = (mm_px(art.x, dpi), mm_px(art.y, dpi));
            let (x1, y1) = (mm_px(art.right(), dpi), mm_px(art.bottom(), dpi));
            Blit {
                x: x0,
                y: y0,
                w: (x1 - x0).max(1) as u32,
                h: (y1 - y0).max(1) as u32,
                bw: bmp.width,
                bh: bmp.height,
                bytes,
            }
        })
        .collect();
    let guide = color_bytes(pipe, parse_hex(&l.cut_guides.color));
    let black = black_bytes(pipe);
    let guides = GuideLayer::new(page, l, dpi, guide, pipe.sixteen);
    let rects = reg_rects(&page.grid, dpi, &black);
    Canvas { w: pw, h: ph, bpp, bg: paper_bytes(pipe), blits, guides, rects }
}

fn render_page_cards(
    store: &Store,
    page: &PagePlan,
    l: &LayoutSettings,
    dpi: u32,
    pipe: &ColorPipeline,
) -> AppResult<Vec<(usize, CardBitmap, Vec<u8>)>> {
    let mut cache: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<(usize, CardBitmap, Vec<u8>)> = vec![];
    for pc in &page.cards {
        if let Some(&i) = cache.get(&pc.image) {
            let (w, h, bytes) = (out[i].1.width, out[i].1.height, out[i].2.clone());
            let pixels = match &out[i].1.pixels {
                Pixels::Rgb8(_) => Pixels::Rgb8(vec![]),
                Pixels::Rgb16(_) => Pixels::Rgb16(vec![]),
                Pixels::Cmyk8(_) => Pixels::Cmyk8(vec![]),
                Pixels::Cmyk16(_) => Pixels::Cmyk16(vec![]),
            };
            out.push((pc.slot, CardBitmap { width: w, height: h, pixels }, bytes));
            continue;
        }
        let bmp = render_card(store, pc, l, dpi, pipe)?;
        let bytes = bmp.pixels.to_be_bytes();
        cache.insert(pc.image.clone(), out.len());
        out.push((pc.slot, bmp, bytes));
    }
    Ok(out)
}

// ------------------------------------------------------------------ preview

/// Render one page as an 8-bit sRGB PNG for the UI, optionally soft-proofed.
pub fn preview_png(
    store: &Store,
    project: &Project,
    pp: &PrintProfile,
    page_index: usize,
    dpi: u32,
    proof: bool,
    gamut_warning: bool,
) -> AppResult<(Vec<u8>, usize)> {
    let pages = preview_plan(project)?;
    let count = pages.len();
    let preview_profile = PrintProfile { output_icc: color::SRGB.into(), embed_profile: false, ..pp.clone() };
    let pipe = ColorPipeline::new(&preview_profile, &store.icc, false)?;
    let page = match pages.get(page_index) {
        Some(p) => p.clone(),
        None => PagePlan {
            side: Side::Front,
            grid: layout::compute_grid(&project.layout),
            cards: vec![],
        },
    };
    let cards = render_page_cards(store, &page, &project.layout, dpi, &pipe)?;
    let canvas = build_canvas(&page, &cards, &project.layout, dpi, &pipe);
    let mut rgb = Vec::with_capacity((canvas.w * canvas.h * 3) as usize);
    let mut row = vec![];
    for y in 0..canvas.h {
        canvas.row(y, &mut row);
        rgb.extend_from_slice(&row);
    }
    if proof {
        color::soft_proof(&mut rgb, pp, &store.icc, gamut_warning)?;
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, canvas.w, canvas.h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(|e| AppError::Image(e.to_string()))?;
        w.write_image_data(&rgb).map_err(|e| AppError::Image(e.to_string()))?;
    }
    Ok((out, count))
}

/// A small part of a page at print resolution (the preview loupe), as an 8-bit sRGB PNG.
/// Only the cards under the region are rendered.
pub fn region_png(
    store: &Store,
    project: &Project,
    pp: &PrintProfile,
    page_index: usize,
    rect: RectMm,
    dpi: u32,
    proof: bool,
) -> AppResult<Vec<u8>> {
    let pages = preview_plan(project)?;
    let mut page = pages.get(page_index).cloned().ok_or_else(|| AppError::Invalid("no such page".into()))?;
    let hit = |a: RectMm| a.x < rect.right() && a.right() > rect.x && a.y < rect.bottom() && a.bottom() > rect.y;
    page.cards.retain(|pc| hit(page.grid.slots[pc.slot].art));
    let preview_profile = PrintProfile { output_icc: color::SRGB.into(), embed_profile: false, ..pp.clone() };
    let pipe = ColorPipeline::new(&preview_profile, &store.icc, false)?;
    let cards = render_page_cards(store, &page, &project.layout, dpi, &pipe)?;
    let canvas = build_canvas(&page, &cards, &project.layout, dpi, &pipe);
    let x0 = mm_px(rect.x, dpi).clamp(0, canvas.w as i64) as usize;
    let x1 = mm_px(rect.right(), dpi).clamp(0, canvas.w as i64) as usize;
    let y0 = mm_px(rect.y, dpi).clamp(0, canvas.h as i64) as u32;
    let y1 = mm_px(rect.bottom(), dpi).clamp(0, canvas.h as i64) as u32;
    if x1 <= x0 || y1 <= y0 {
        return Err(AppError::Invalid("region outside the page".into()));
    }
    let (w, h) = ((x1 - x0) as u32, y1 - y0);
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    let mut row = vec![];
    for y in y0..y1 {
        canvas.row(y, &mut row);
        rgb.extend_from_slice(&row[x0 * 3..x1 * 3]);
    }
    if proof {
        color::soft_proof(&mut rgb, pp, &store.icc, false)?;
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut wr = enc.write_header().map_err(|e| AppError::Image(e.to_string()))?;
        wr.write_image_data(&rgb).map_err(|e| AppError::Image(e.to_string()))?;
    }
    Ok(out)
}

/// A single card rendered with the full pipeline (for the card inspector).
pub fn card_preview_png(
    store: &Store,
    image: &str,
    l: &LayoutSettings,
    pp: &PrintProfile,
    dpi: u32,
    proof: bool,
) -> AppResult<Vec<u8>> {
    let preview_profile = PrintProfile { output_icc: color::SRGB.into(), embed_profile: false, ..pp.clone() };
    let pipe = ColorPipeline::new(&preview_profile, &store.icc, false)?;
    let pc = PlacedCard { slot: 0, image: image.into(), builtin_bleed: None, kind: CardKind::Bank };
    let bmp = render_card(store, &pc, l, dpi, &pipe)?;
    let mut rgb = bmp.pixels.to_be_bytes();
    if proof {
        color::soft_proof(&mut rgb, pp, &store.icc, false)?;
    }
    let img = image::RgbImage::from_raw(bmp.width, bmp.height, rgb).ok_or_else(|| AppError::Image("bad buffer".into()))?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)?;
    Ok(out.into_inner())
}

// ------------------------------------------------------------------ PDF

/// Vector cut guides and registration marks. Guides outside the art are clipped with an
/// even-odd path (page minus every art box) unless guides are drawn over the art.
fn draw_pdf_guides(content: &mut Content, page: &PagePlan, l: &LayoutSettings, cmyk: bool) {
    let k = PT_PER_MM;
    let ph_pt = page.grid.page.height * k;
    let pw_pt = page.grid.page.width * k;
    let guides = &page.grid.guides;
    if !guides.is_empty() {
        let [r, g, b] = parse_hex(&l.cut_guides.color);
        content.save_state();
        let width = l.cut_guides.width_pt.max(0.1);
        content.set_line_width(width);
        if l.cut_guides.dashed {
            let (d, g) = guide_dash(width, k);
            content.set_dash_pattern([d, g], 0.0);
        }
        if cmyk {
            let c = color::naive_cmyk([r as u16 * 257, g as u16 * 257, b as u16 * 257]);
            content.set_stroke_cmyk(c[0] as f32 / 65535.0, c[1] as f32 / 65535.0, c[2] as f32 / 65535.0, c[3] as f32 / 65535.0);
        } else {
            content.set_stroke_rgb(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
        }
        let stroke = |content: &mut Content, gp: &layout::GuidePath| {
            let mut it = gp.pts.iter();
            if let Some(p) = it.next() {
                content.move_to(p[0] * k, ph_pt - p[1] * k);
                for p in it {
                    content.line_to(p[0] * k, ph_pt - p[1] * k);
                }
                content.stroke();
            }
        };
        let clip = !l.guides_over_art;
        let clipped: Vec<_> = guides.iter().filter(|g| clip && g.clipped).collect();
        if !clipped.is_empty() {
            content.save_state();
            content.rect(-1.0, -1.0, pw_pt + 2.0, ph_pt + 2.0);
            for pc in &page.cards {
                let a = page.grid.slots[pc.slot].art;
                content.rect(a.x * k, ph_pt - a.bottom() * k, a.w * k, a.h * k);
            }
            content.clip_even_odd();
            content.end_path();
            for gp in clipped {
                stroke(content, gp);
            }
            content.restore_state();
        }
        for gp in guides.iter().filter(|g| !(clip && g.clipped)) {
            stroke(content, gp);
        }
        content.restore_state();
    }
    if !page.grid.reg_marks.is_empty() {
        content.save_state();
        if cmyk {
            content.set_fill_cmyk(0.0, 0.0, 0.0, 1.0);
        } else {
            content.set_fill_rgb(0.0, 0.0, 0.0);
        }
        for m in &page.grid.reg_marks {
            content.rect(m.x * k, ph_pt - m.bottom() * k, m.w * k, m.h * k);
            content.fill_nonzero();
        }
        content.restore_state();
    }
}

/// Overlap between abutting card images in the PDF (points). 0.2pt = 0.07mm.
const SEAM_OVERLAP_PT: f32 = 0.2;

struct RefAlloc(i32);
impl RefAlloc {
    fn next(&mut self) -> Ref {
        self.0 += 1;
        Ref::new(self.0)
    }
}

pub fn export_pdf(
    store: &Store,
    project: &Project,
    pp: &PrintProfile,
    opts: &ExportOptions,
    progress: Progress,
    cancel: &AtomicBool,
) -> AppResult<PathBuf> {
    let dpi = opts.dpi.unwrap_or(pp.dpi).clamp(72, 4800);
    let pipe = ColorPipeline::new(pp, &store.icc, false)?;
    let pages = plan(project)?;
    let l = &project.layout;
    let mut pdf = Pdf::new();
    let mut ids = RefAlloc(0);
    let catalog = ids.next();
    let tree = ids.next();
    let cmyk = pipe.space == OutputColorSpace::Cmyk;
    let n = if cmyk { 4 } else { 3 };

    // ICC profile stream, shared by all images.
    let icc_ref = if let Some(icc) = &pipe.icc {
        let r = ids.next();
        let compressed = compress_to_vec_zlib(icc, 6);
        let mut s = pdf.icc_profile(r, &compressed);
        s.n(n);
        s.filter(Filter::FlateDecode);
        if cmyk {
            s.alternate().device_cmyk();
        } else {
            s.alternate().device_rgb();
        }
        s.finish();
        Some(r)
    } else {
        None
    };

    let mut image_refs: HashMap<(String, u8), (Ref, u32, u32)> = HashMap::new();
    let mut page_refs = vec![];
    let total = pages.len() as f32;
    let k = PT_PER_MM;

    for (pi, page) in pages.iter().enumerate() {
        check_cancel(cancel)?;
        progress(pi as f32 / total, &format!("Rendering page {} of {}", pi + 1, pages.len()));
        let ph_pt = page.grid.page.height * k;
        let pw_pt = page.grid.page.width * k;
        let mut content = Content::new();
        let mut xobjects: Vec<(String, Ref)> = vec![];
        // calibration rotation around the page centre
        let rot = l.rotation_deg.clamp(-10.0, 10.0);
        if rot.abs() > 1e-4 {
            let (s, c) = (-rot.to_radians()).sin_cos();
            let (cx, cy) = (pw_pt / 2.0, ph_pt / 2.0);
            content.save_state();
            content.transform([c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
        }

        for pc in &page.cards {
            check_cancel(cancel)?;
            let key = (pc.image.clone(), if page.side == Side::Front { 0 } else { 1 });
            let (img_ref, _, _) = match image_refs.get(&key) {
                Some(v) => *v,
                None => {
                    let bmp = render_card(store, pc, l, dpi, &pipe)?;
                    let r = ids.next();
                    write_image(&mut pdf, r, &bmp, icc_ref, opts)?;
                    image_refs.insert(key.clone(), (r, bmp.width, bmp.height));
                    (r, bmp.width, bmp.height)
                }
            };
            let name = format!("Im{}", img_ref.get());
            if !xobjects.iter().any(|(n2, _)| *n2 == name) {
                xobjects.push((name.clone(), img_ref));
            }
            let art = page.grid.slots[pc.slot].art;
            // Grow each image by a hair on the sides that touch a neighbour. PDF viewers and
            // RIPs anti-alias image edges, which shows a thin white line where two images
            // merely abut. The overlap lands in the bleed / cut area, never on the trim.
            let (ox, oy) = (
                if l.spacing_x_mm <= 0.0 { SEAM_OVERLAP_PT } else { 0.0 },
                if l.spacing_y_mm <= 0.0 { SEAM_OVERLAP_PT } else { 0.0 },
            );
            content.save_state();
            content.transform([
                art.w * k + 2.0 * ox,
                0.0,
                0.0,
                art.h * k + 2.0 * oy,
                art.x * k - ox,
                ph_pt - art.bottom() * k - oy,
            ]);
            content.x_object(Name(name.as_bytes()));
            content.restore_state();
        }

        draw_pdf_guides(&mut content, page, l, cmyk);
        if rot.abs() > 1e-4 {
            content.restore_state();
        }

        let page_ref = ids.next();
        let content_ref = ids.next();
        let data = compress_to_vec_zlib(&content.finish(), 6);
        pdf.stream(content_ref, &data).filter(Filter::FlateDecode);
        let mut pg = pdf.page(page_ref);
        pg.media_box(Rect::new(0.0, 0.0, pw_pt, ph_pt));
        pg.trim_box(Rect::new(0.0, 0.0, pw_pt, ph_pt));
        pg.parent(tree);
        pg.contents(content_ref);
        {
            let mut res = pg.resources();
            let mut xo = res.x_objects();
            for (name, r) in &xobjects {
                xo.pair(Name(name.as_bytes()), *r);
            }
        }
        pg.finish();
        page_refs.push(page_ref);
    }

    pdf.pages(tree).kids(page_refs.iter().copied()).count(page_refs.len() as i32);
    {
        let mut cat = pdf.catalog(catalog);
        cat.pages(tree);
        if let (Some(icc), true) = (icc_ref, cmyk) {
            let mut intents = cat.output_intents();
            let mut oi = intents.push();
            oi.subtype(pdf_writer::types::OutputIntentSubtype::PDFX);
            oi.output_condition_identifier(TextStr(&pipe.profile_name));
            oi.info(TextStr(&pipe.profile_name));
            oi.dest_output_profile(icc);
        }
    }
    let info_ref = ids.next();
    pdf.document_info(info_ref)
        .title(TextStr(&project.name))
        .creator(TextStr("ProxyForge"))
        .producer(TextStr("ProxyForge (pdf-writer)"));

    progress(0.99, "Writing file");
    let path = PathBuf::from(&opts.path);
    fs::write(&path, pdf.finish())?;
    if opts.cut_file {
        write_cut_files(project, &path)?;
    }
    progress(1.0, "Done");
    Ok(path)
}

fn write_image(pdf: &mut Pdf, r: Ref, bmp: &CardBitmap, icc: Option<Ref>, opts: &ExportOptions) -> AppResult<()> {
    let (data, filter) = match (&bmp.pixels, opts.compression) {
        (Pixels::Rgb8(v), PdfCompression::Jpeg) => {
            let mut out = Vec::new();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, opts.jpeg_quality.clamp(50, 100));
            enc.encode(v, bmp.width, bmp.height, image::ExtendedColorType::Rgb8)?;
            (out, Filter::DctDecode)
        }
        (px, _) => (compress_to_vec_zlib(&px.to_be_bytes(), 6), Filter::FlateDecode),
    };
    let mut img = pdf.image_xobject(r, &data);
    img.filter(filter);
    img.width(bmp.width as i32);
    img.height(bmp.height as i32);
    img.bits_per_component(if bmp.pixels.is_16() { 16 } else { 8 });
    match icc {
        Some(icc) => img.color_space().icc_based(icc),
        None if bmp.pixels.channels() == 4 => img.color_space().device_cmyk(),
        None => img.color_space().device_rgb(),
    }
    img.interpolate(false);
    img.finish();
    Ok(())
}

// ------------------------------------------------------------------ PNG / TIFF pages

pub fn export_raster(
    store: &Store,
    project: &Project,
    pp: &PrintProfile,
    opts: &ExportOptions,
    progress: Progress,
    cancel: &AtomicBool,
) -> AppResult<Vec<PathBuf>> {
    let dpi = opts.dpi.unwrap_or(pp.dpi).clamp(72, 4800);
    let pipe = ColorPipeline::new(pp, &store.icc, opts.sixteen_bit)?;
    if opts.format == ExportFormat::Png && pipe.space == OutputColorSpace::Cmyk {
        return Err(AppError::Invalid("PNG cannot store CMYK. Choose TIFF or PDF for this print profile.".into()));
    }
    let pages = plan(project)?;
    let base = PathBuf::from(&opts.path);
    let stem = base.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "page".into());
    let dir = base.parent().map(Path::to_path_buf).unwrap_or_default();
    let ext = if opts.format == ExportFormat::Png { "png" } else { "tif" };
    let mut written = vec![];
    for (pi, page) in pages.iter().enumerate() {
        check_cancel(cancel)?;
        progress(pi as f32 / pages.len() as f32, &format!("Rendering page {} of {}", pi + 1, pages.len()));
        let cards = render_page_cards(store, page, &project.layout, dpi, &pipe)?;
        let canvas = build_canvas(page, &cards, &project.layout, dpi, &pipe);
        let side = if page.side == Side::Back { "-back" } else { "" };
        let path = dir.join(format!("{stem}-{:02}{side}.{ext}", pi + 1));
        match opts.format {
            ExportFormat::Png => write_png(&path, &canvas, &pipe, dpi)?,
            _ => write_tiff(&path, &canvas, &pipe, dpi)?,
        }
        written.push(path);
    }
    if opts.cut_file {
        write_cut_files(project, &base)?;
    }
    progress(1.0, "Done");
    Ok(written)
}

fn write_png(path: &Path, c: &Canvas, pipe: &ColorPipeline, dpi: u32) -> AppResult<()> {
    let f = BufWriter::new(fs::File::create(path)?);
    let mut info = png::Info::with_size(c.w, c.h);
    info.color_type = png::ColorType::Rgb;
    info.bit_depth = if pipe.sixteen { png::BitDepth::Sixteen } else { png::BitDepth::Eight };
    let ppm = (dpi as f32 / 0.0254).round() as u32;
    info.pixel_dims = Some(png::PixelDimensions { xppu: ppm, yppu: ppm, unit: png::Unit::Meter });
    if let Some(icc) = &pipe.icc {
        info.icc_profile = Some(std::borrow::Cow::Owned(icc.clone()));
    }
    let enc = png::Encoder::with_info(f, info).map_err(|e| AppError::Image(e.to_string()))?;
    let mut w = enc.write_header().map_err(|e| AppError::Image(e.to_string()))?;
    let mut sw = w.stream_writer().map_err(|e| AppError::Image(e.to_string()))?;
    let mut row = vec![];
    for y in 0..c.h {
        c.row(y, &mut row);
        sw.write_all(&row)?;
    }
    sw.finish().map_err(|e| AppError::Image(e.to_string()))?;
    Ok(())
}

fn write_tiff(path: &Path, c: &Canvas, pipe: &ColorPipeline, dpi: u32) -> AppResult<()> {
    use tiff::encoder::{colortype, Rational, TiffEncoder};
    use tiff::tags::{ResolutionUnit, Tag};
    let f = BufWriter::new(fs::File::create(path)?);
    let mut enc = TiffEncoder::new(f).map_err(|e| AppError::Image(e.to_string()))?;
    enc = enc.with_compression(tiff::encoder::Compression::Deflate(tiff::encoder::DeflateLevel::Balanced));
    let rows_per_strip = 64u32;
    let terr = |e: tiff::TiffError| AppError::Image(e.to_string());
    let mut row = vec![];

    macro_rules! write_with {
        ($ct:ty, $conv:expr) => {{
            let mut img = enc.new_image::<$ct>(c.w, c.h).map_err(terr)?;
            img.rows_per_strip(rows_per_strip).map_err(terr)?;
            img.resolution(ResolutionUnit::Inch, Rational { n: dpi, d: 1 });
            if let Some(icc) = &pipe.icc {
                img.encoder().write_tag(Tag::IccProfile, &icc[..]).map_err(terr)?;
            }
            let mut y = 0;
            while y < c.h {
                let end = (y + rows_per_strip).min(c.h);
                let mut strip: Vec<u8> = Vec::new();
                for yy in y..end {
                    c.row(yy, &mut row);
                    strip.extend_from_slice(&row);
                }
                let data = $conv(strip);
                img.write_strip(&data).map_err(terr)?;
                y = end;
            }
            img.finish().map_err(terr)?;
        }};
    }
    let as8 = |v: Vec<u8>| v;
    let as16 = |v: Vec<u8>| -> Vec<u16> { v.chunks_exact(2).map(|b| u16::from_be_bytes([b[0], b[1]])).collect() };

    match (pipe.space, pipe.sixteen) {
        (OutputColorSpace::Rgb, false) => write_with!(colortype::RGB8, as8),
        (OutputColorSpace::Rgb, true) => write_with!(colortype::RGB16, as16),
        (OutputColorSpace::Cmyk, false) => write_with!(colortype::CMYK8, as8),
        (OutputColorSpace::Cmyk, true) => write_with!(colortype::CMYK16, as16),
    }
    Ok(())
}

// ------------------------------------------------------------------ ZIP of card images

pub fn export_zip(
    store: &Store,
    project: &Project,
    pp: &PrintProfile,
    opts: &ExportOptions,
    progress: Progress,
    cancel: &AtomicBool,
) -> AppResult<PathBuf> {
    let dpi = opts.dpi.unwrap_or(pp.dpi).clamp(72, 4800);
    let pipe = ColorPipeline::new(pp, &store.icc, opts.sixteen_bit)?;
    let path = PathBuf::from(&opts.path);
    let mut zip = zip::ZipWriter::new(fs::File::create(&path)?);
    let zopts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let total = project.cards.len().max(1) as f32;
    for (i, card) in project.cards.iter().enumerate() {
        check_cancel(cancel)?;
        progress(i as f32 / total, &format!("Card {} of {}", i + 1, project.cards.len()));
        let faces = [(Some(card.front.clone()), "front"), (card.back.clone(), "back")];
        for (img, face) in faces {
            let Some(img) = img else { continue };
            let kind = if face == "back" { CardKind::Back } else { front_kind(card) };
            let pc = PlacedCard { slot: 0, image: img, builtin_bleed: card.builtin_bleed_mm, kind };
            let bmp = render_card(store, &pc, &project.layout, dpi, &pipe)?;
            let safe: String = card.name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
            let canvas = Canvas {
                w: bmp.width,
                h: bmp.height,
                bpp: bmp.pixels.channels() as usize * if bmp.pixels.is_16() { 2 } else { 1 },
                bg: vec![],
                blits: vec![],
                guides: None,
                rects: vec![],
            };
            let bytes = bmp.pixels.to_be_bytes();
            let canvas = Canvas {
                blits: vec![Blit { x: 0, y: 0, w: bmp.width, h: bmp.height, bw: bmp.width, bh: bmp.height, bytes: &bytes }],
                bg: paper_bytes(&pipe),
                ..canvas
            };
            let tmp = store.cache.join(format!("zip-{}.tmp", uuid::Uuid::new_v4()));
            let ext = if pipe.space == OutputColorSpace::Cmyk {
                write_tiff(&tmp, &canvas, &pipe, dpi)?;
                "tif"
            } else {
                write_png(&tmp, &canvas, &pipe, dpi)?;
                "png"
            };
            zip.start_file(format!("{:03}-{}-{face}.{ext}", i + 1, safe.trim()), zopts)?;
            zip.write_all(&fs::read(&tmp)?)?;
            let _ = fs::remove_file(tmp);
        }
    }
    zip.finish()?;
    progress(1.0, "Done");
    Ok(path)
}

// ------------------------------------------------------------------ cut files

pub fn write_cut_files(project: &Project, base: &Path) -> AppResult<()> {
    let grid = layout::compute_grid(&project.layout);
    let (w, h) = (grid.page.width, grid.page.height);
    let r = project.layout.corner_radius_mm.max(0.0);
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}mm\" height=\"{h}mm\" viewBox=\"0 0 {w} {h}\">\n<g id=\"registration\" fill=\"#000\">\n"
    );
    for m in &grid.reg_marks {
        svg += &format!("  <rect x=\"{:.3}\" y=\"{:.3}\" width=\"{:.3}\" height=\"{:.3}\"/>\n", m.x, m.y, m.w, m.h);
    }
    svg += "</g>\n<g id=\"cut\" fill=\"none\" stroke=\"#ff0000\" stroke-width=\"0.1\">\n";
    for s in &grid.slots {
        let c = s.card;
        svg += &format!(
            "  <rect x=\"{:.3}\" y=\"{:.3}\" width=\"{:.3}\" height=\"{:.3}\" rx=\"{r:.3}\" ry=\"{r:.3}\"/>\n",
            c.x, c.y, c.w, c.h
        );
    }
    svg += "</g>\n</svg>\n";
    fs::write(base.with_extension("cut.svg"), svg)?;

    // DXF R12-compatible LWPOLYLINE rectangles with rounded corners (bulge = tan(90°/4)).
    let bulge = (std::f32::consts::FRAC_PI_8).tan();
    let mut dxf = String::from("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n");
    for s in &grid.slots {
        let c = s.card;
        let (x0, x1) = (c.x, c.right());
        let (y0, y1) = (h - c.bottom(), h - c.y);
        let pts: Vec<(f32, f32, f32)> = if r > 0.0 {
            vec![
                (x0 + r, y0, 0.0),
                (x1 - r, y0, bulge),
                (x1, y0 + r, 0.0),
                (x1, y1 - r, bulge),
                (x1 - r, y1, 0.0),
                (x0 + r, y1, bulge),
                (x0, y1 - r, 0.0),
                (x0, y0 + r, bulge),
            ]
        } else {
            vec![(x0, y0, 0.0), (x1, y0, 0.0), (x1, y1, 0.0), (x0, y1, 0.0)]
        };
        dxf += &format!("0\nLWPOLYLINE\n8\nCUT\n90\n{}\n70\n1\n", pts.len());
        for (x, y, b) in pts {
            dxf += &format!("10\n{x:.4}\n20\n{y:.4}\n");
            if b != 0.0 {
                dxf += &format!("42\n{b:.6}\n");
            }
        }
    }
    dxf += "0\nENDSEC\n0\nEOF\n";
    fs::write(base.with_extension("cut.dxf"), dxf)?;
    Ok(())
}

// ------------------------------------------------------------------ test chart

/// Colour test chart: grey ramp, RGB/CMY ramps, skin tones and smooth gradients.
pub fn test_chart_pdf(store: &Store, pp: &PrintProfile, layout: &LayoutSettings, path: &Path) -> AppResult<()> {
    let page = layout::oriented_page(layout);
    let dpi = 300;
    let w = layout::mm_to_px(page.width - 20.0, dpi);
    let h = layout::mm_to_px(page.height - 20.0, dpi);
    let mut img = Rgb16::new(w, h);
    let rows: Vec<Box<dyn Fn(f32) -> [f32; 3]>> = vec![
        Box::new(|t| [t, t, t]),
        Box::new(|t| [t, 0.0, 0.0]),
        Box::new(|t| [0.0, t, 0.0]),
        Box::new(|t| [0.0, 0.0, t]),
        Box::new(|t| [1.0 - t, 1.0, 1.0]),
        Box::new(|t| [1.0, 1.0 - t, 1.0]),
        Box::new(|t| [1.0, 1.0, 1.0 - t]),
        Box::new(|t| {
            let skins = [[0.98, 0.84, 0.72], [0.91, 0.72, 0.58], [0.78, 0.57, 0.42], [0.55, 0.38, 0.26], [0.36, 0.24, 0.17], [0.24, 0.16, 0.12]];
            skins[((t * 5.999) as usize).min(5)]
        }),
        Box::new(|t| hsv(t, 1.0, 1.0)),
        Box::new(|t| hsv(t, 0.5, 1.0)),
        Box::new(|t| hsv(t, 1.0, 0.5)),
    ];
    let steps = 11u32;
    let band_h = h / (rows.len() as u32 + 1);
    for y in 0..h {
        let band = (y / band_h) as usize;
        for x in 0..w {
            let tx = x as f32 / (w - 1) as f32;
            let c = if band < rows.len() {
                let t = ((tx * steps as f32).floor() / (steps - 1) as f32).min(1.0);
                rows[band](t)
            } else {
                hsv(tx, 1.0 - (y % band_h) as f32 / band_h as f32, 1.0)
            };
            let i = img.idx(x, y);
            img.data[i] = (c[0] * 65535.0) as u16;
            img.data[i + 1] = (c[1] * 65535.0) as u16;
            img.data[i + 2] = (c[2] * 65535.0) as u16;
        }
    }
    let pipe = ColorPipeline::new(pp, &store.icc, false)?;
    let pixels = pipe.convert(&mut img);
    let bmp = CardBitmap { width: w, height: h, pixels };
    let mut pdf = Pdf::new();
    let (cat, tree, pg, cont, im) = (Ref::new(1), Ref::new(2), Ref::new(3), Ref::new(4), Ref::new(5));
    let icc_ref = pipe.icc.as_ref().map(|icc| {
        let r = Ref::new(6);
        let mut s = pdf.icc_profile(r, icc);
        s.n(bmp.pixels.channels() as i32);
        s.finish();
        r
    });
    let opts = ExportOptions {
        format: ExportFormat::Pdf,
        path: String::new(),
        dpi: None,
        compression: PdfCompression::Lossless,
        jpeg_quality: 95,
        sixteen_bit: false,
        cut_file: false,
    };
    write_image(&mut pdf, im, &bmp, icc_ref, &opts)?;
    pdf.catalog(cat).pages(tree);
    pdf.pages(tree).kids([pg]).count(1);
    let k = PT_PER_MM;
    let mut c = Content::new();
    c.transform([(page.width - 20.0) * k, 0.0, 0.0, (page.height - 20.0) * k, 10.0 * k, 10.0 * k]);
    c.x_object(Name(b"Im1"));
    let data = c.finish();
    pdf.stream(cont, &data);
    let mut p = pdf.page(pg);
    p.media_box(Rect::new(0.0, 0.0, page.width * k, page.height * k));
    p.parent(tree);
    p.contents(cont);
    p.resources().x_objects().pair(Name(b"Im1"), im);
    p.finish();
    fs::write(path, pdf.finish())?;
    Ok(())
}

fn hsv(h: f32, s: f32, v: f32) -> [f32; 3] {
    let h6 = (h.fract() * 6.0).max(0.0);
    let i = h6.floor() as i32;
    let f = h6 - i as f32;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - s * f), v * (1.0 - s * (1.0 - f)));
    match i % 6 {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

/// Duplex calibration sheet: front and back with a crosshair grid to measure misalignment.
pub fn duplex_calibration_pdf(layout_s: &LayoutSettings, path: &Path) -> AppResult<()> {
    let page = layout::oriented_page(layout_s);
    let k = PT_PER_MM;
    let (pw, ph) = (page.width * k, page.height * k);
    let mut pdf = Pdf::new();
    let (cat, tree) = (Ref::new(1), Ref::new(2));
    pdf.catalog(cat).pages(tree);
    let mut kids = vec![];
    for side in 0..2 {
        let pg = Ref::new(3 + side * 2);
        let cont = Ref::new(4 + side * 2);
        kids.push(pg);
        let mut c = Content::new();
        c.set_line_width(0.3);
        let (ox, oy) = if side == 1 { (layout_s.duplex.offset_x_mm, layout_s.duplex.offset_y_mm) } else { (0.0, 0.0) };
        // crosshairs at the centre and near each corner, ruler ticks every mm
        for (cx, cy) in [(0.5, 0.5), (0.2, 0.2), (0.8, 0.2), (0.2, 0.8), (0.8, 0.8)] {
            let x = page.width * cx;
            let y = page.height * cy;
            let x = if side == 1 && layout_s.duplex.flip == DuplexFlip::LongEdge { page.width - x } else { x } + ox;
            let y = if side == 1 && layout_s.duplex.flip == DuplexFlip::ShortEdge { page.height - y } else { y } + oy;
            if side == 0 {
                c.set_stroke_rgb(0.0, 0.0, 0.0);
            } else {
                c.set_stroke_rgb(0.85, 0.1, 0.1);
            }
            c.move_to((x - 15.0) * k, ph - y * k);
            c.line_to((x + 15.0) * k, ph - y * k);
            c.move_to(x * k, ph - (y - 15.0) * k);
            c.line_to(x * k, ph - (y + 15.0) * k);
            c.stroke();
            for i in -10..=10 {
                let t = if i % 5 == 0 { 2.5 } else { 1.2 };
                c.move_to((x + i as f32) * k, ph - (y - t) * k);
                c.line_to((x + i as f32) * k, ph - (y + t) * k);
                c.move_to((x - t) * k, ph - (y + i as f32) * k);
                c.line_to((x + t) * k, ph - (y + i as f32) * k);
            }
            c.stroke();
        }
        let data = c.finish();
        pdf.stream(cont, &data);
        let mut p = pdf.page(pg);
        p.media_box(Rect::new(0.0, 0.0, pw, ph));
        p.parent(tree);
        p.contents(cont);
        p.finish();
    }
    pdf.pages(tree).kids(kids).count(2);
    fs::write(path, pdf.finish())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(n_cards: u32) -> (tempfile::TempDir, Store, Project) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        let img = image::RgbImage::from_fn(63, 88, |x, y| image::Rgb([(x * 4) as u8, (y * 2) as u8, 128]));
        let mut b = std::io::Cursor::new(Vec::new());
        img.write_to(&mut b, image::ImageFormat::Png).unwrap();
        let meta = store.import_image_bytes(&b.into_inner(), None, None, "").unwrap();
        let mut p = store.new_project("t").unwrap();
        p.cards.push(CardEntry {
            id: "a".into(),
            name: "A".into(),
            qty: n_cards,
            front: meta.id.clone(),
            back: Some(meta.id),
            original_front: None,
            original_back: None,
            source: None,
            builtin_bleed_mm: None,
            is_token: false,
            design_id: None,
            meta: None,
        });
        (dir, store, p)
    }

    fn opts(path: &Path, format: ExportFormat) -> ExportOptions {
        ExportOptions {
            format,
            path: path.to_string_lossy().to_string(),
            dpi: Some(150),
            compression: PdfCompression::Lossless,
            jpeg_quality: 90,
            sixteen_bit: false,
            cut_file: true,
        }
    }

    #[test]
    fn plan_paginates_and_adds_backs() {
        let (_d, _s, mut p) = setup(10);
        assert_eq!(plan(&p).unwrap().len(), 2);
        p.layout.duplex.enabled = true;
        let pages = plan(&p).unwrap();
        assert_eq!(pages.len(), 4);
        assert_eq!(pages[1].side, Side::Back);
        assert_eq!(pages[1].cards.len(), 9);
    }

    #[test]
    fn preview_hides_blank_back_pages() {
        let (_d, _s, mut p) = setup(10);
        p.layout.duplex.enabled = true;
        p.cards[0].back = None;
        p.layout.duplex.default_back = None;
        assert_eq!(plan(&p).unwrap().len(), 4, "export keeps the alternation");
        let pages = preview_plan(&p).unwrap();
        assert_eq!(pages.len(), 2);
        assert!(pages.iter().all(|pg| pg.side == Side::Front));
        let map = page_map(&p).unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(map[1].slots[0].instance, 9);
        assert_eq!(map[1].slots.len(), 1);

        // one card with a back brings its back page back
        let extra = p.cards[0].clone();
        p.cards.push(CardEntry { id: "b".into(), qty: 1, back: Some(extra.front.clone()), ..extra });
        let map = page_map(&p).unwrap();
        assert_eq!(map.len(), 3);
        assert_eq!(map[2].side, Side::Back);
        assert_eq!(map[2].slots.len(), 1);
        assert_eq!(map[2].slots[0].card_id, "b");
        assert_eq!(map[2].slots[0].instance, 10);
        assert_eq!(preview_plan(&p).unwrap().len(), 3);
    }

    #[test]
    fn page_map_mirrors_back_slots() {
        let (_d, _s, mut p) = setup(2);
        p.layout.duplex.enabled = true;
        let map = page_map(&p).unwrap();
        assert_eq!(map.len(), 2);
        let (f, b) = (&map[0].slots[0], &map[1].slots[0]);
        assert_eq!(f.instance, b.instance);
        assert_ne!(f.rect.x, b.rect.x);
    }

    #[test]
    fn pdf_has_pages_media_box_and_dedup_images() {
        let (d, s, p) = setup(10);
        let out = d.path().join("out.pdf");
        let pp = PrintProfile::default();
        export_pdf(&s, &p, &pp, &opts(&out, ExportFormat::Pdf), &|_, _| {}, &AtomicBool::new(false)).unwrap();
        let doc = lopdf::Document::load(&out).unwrap();
        assert_eq!(doc.get_pages().len(), 2);
        let images = doc.objects.values().filter(|o| matches!(o.as_stream().map(|s| s.dict.get(b"Subtype").ok().and_then(|v| v.as_name().ok()) ), Ok(Some(b"Image")))).count();
        assert_eq!(images, 1, "same artwork must be embedded once");
        let (_, page) = doc.get_pages().into_iter().next().unwrap();
        let mb = doc.get_dictionary(page).unwrap().get(b"MediaBox").unwrap().as_array().unwrap().clone();
        let w = mb[2].as_float().unwrap();
        assert!((w - 612.0).abs() < 0.5, "letter width in pt, got {w}");
        assert!(out.with_extension("cut.svg").exists());
        assert!(out.with_extension("cut.dxf").exists());
    }

    #[test]
    fn cmyk_pdf_uses_device_cmyk() {
        let (d, s, p) = setup(1);
        let out = d.path().join("cmyk.pdf");
        let pp = PrintProfile { output_icc: color::NAIVE_CMYK.into(), output_space: OutputColorSpace::Cmyk, ..Default::default() };
        export_pdf(&s, &p, &pp, &opts(&out, ExportFormat::Pdf), &|_, _| {}, &AtomicBool::new(false)).unwrap();
        let bytes = fs::read(&out).unwrap();
        assert!(bytes.windows(10).any(|w| w == b"DeviceCMYK"));
    }

    #[test]
    fn png_and_tiff_pages() {
        let (d, s, p) = setup(3);
        let pp = PrintProfile::default();
        let png = export_raster(&s, &p, &pp, &opts(&d.path().join("p.png"), ExportFormat::Png), &|_, _| {}, &AtomicBool::new(false)).unwrap();
        let img = image::open(&png[0]).unwrap();
        assert_eq!(img.width(), layout::mm_to_px(215.9, 150));
        let mut o = opts(&d.path().join("p.tif"), ExportFormat::Tiff);
        o.sixteen_bit = true;
        let pp_cmyk = PrintProfile { output_icc: color::NAIVE_CMYK.into(), output_space: OutputColorSpace::Cmyk, ..Default::default() };
        let tif = export_raster(&s, &p, &pp_cmyk, &o, &|_, _| {}, &AtomicBool::new(false)).unwrap();
        assert!(fs::metadata(&tif[0]).unwrap().len() > 1000);
        let mut o = opts(&d.path().join("p.png"), ExportFormat::Png);
        o.cut_file = false;
        assert!(export_raster(&s, &p, &pp_cmyk, &o, &|_, _| {}, &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn preview_and_zip_and_charts() {
        let (d, s, p) = setup(2);
        let pp = PrintProfile::default();
        let (png, count) = preview_png(&s, &p, &pp, 0, 40, true, false).unwrap();
        assert_eq!(count, 1);
        assert!(image::load_from_memory(&png).is_ok());
        export_zip(&s, &p, &pp, &opts(&d.path().join("c.zip"), ExportFormat::Zip), &|_, _| {}, &AtomicBool::new(false)).unwrap();
        test_chart_pdf(&s, &pp, &p.layout, &d.path().join("chart.pdf")).unwrap();
        duplex_calibration_pdf(&p.layout, &d.path().join("dup.pdf")).unwrap();
        assert_eq!(lopdf::Document::load(d.path().join("dup.pdf")).unwrap().get_pages().len(), 2);
    }

    /// Adjacent cards must touch with no paper-white seam, at any preview DPI.
    #[test]
    fn no_white_seam_between_adjacent_cards() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_path_buf()).unwrap();
        let img = image::RgbImage::from_pixel(745, 1040, image::Rgb([20, 20, 20]));
        let mut b = std::io::Cursor::new(Vec::new());
        img.write_to(&mut b, image::ImageFormat::Png).unwrap();
        let meta = store.import_image_bytes(&b.into_inner(), None, None, "").unwrap();
        let mut p = store.new_project("seam").unwrap();
        p.cards.push(CardEntry {
            id: "a".into(), name: "A".into(), qty: 9, front: meta.id, back: None, original_front: None,
            original_back: None, source: None, builtin_bleed_mm: None, is_token: false, design_id: None, meta: None,
        });
        p.layout.cut_guides.style = CutGuideStyle::None;
        p.layout.cut_guides.page_style = Some(PageGuideStyle::None);
        p.layout.cut_guides.card_style = Some(CardGuideStyle::None);
        for bleed in [0.0, 1.0, 0.7] {
            for mode in [BleedMode::Extend, BleedMode::Mirror, BleedMode::Solid, BleedMode::Stretch, BleedMode::Blur] {
                p.layout.bleed_mm = bleed;
                p.layout.bleed_mode = mode;
                let grid = layout::compute_grid(&p.layout);
                for dpi in [37, 41, 53, 61, 77, 96, 113, 150] {
                    let (png, _) = preview_png(&store, &p, &PrintProfile::default(), 0, dpi, false, false).unwrap();
                    let im = image::load_from_memory(&png).unwrap().to_rgb8();
                    let x0 = mm_px(grid.content.x, dpi) as u32;
                    let y0 = mm_px(grid.content.y, dpi) as u32;
                    let x1 = mm_px(grid.content.right(), dpi) as u32;
                    let y1 = mm_px(grid.content.bottom(), dpi) as u32;
                    for y in y0..y1 {
                        for x in x0..x1 {
                            let px = im.get_pixel(x, y).0;
                            assert!(px[0] < 200, "white seam at ({x},{y}) dpi={dpi} bleed={bleed} mode={mode:?}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn cancellation_stops_export() {
        let (d, s, p) = setup(3);
        let r = export_pdf(&s, &p, &PrintProfile::default(), &opts(&d.path().join("x.pdf"), ExportFormat::Pdf), &|_, _| {}, &AtomicBool::new(true));
        assert!(r.is_err());
    }
}
