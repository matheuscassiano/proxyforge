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

#[derive(Debug, Clone)]
pub struct PlacedCard {
    pub slot: usize,
    pub image: String,
    pub builtin_bleed: Option<f32>,
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
    let back_grid = layout::mirror_for_back(&grid, d.flip, d.offset_x_mm, d.offset_y_mm);
    let mut out = vec![];
    for chunk in instances.chunks(per) {
        let fronts = chunk
            .iter()
            .enumerate()
            .map(|(slot, &ci)| PlacedCard {
                slot,
                image: p.cards[ci].front.clone(),
                builtin_bleed: p.cards[ci].builtin_bleed_mm,
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
                    Some(PlacedCard { slot, image: img, builtin_bleed: None })
                })
                .collect();
            out.push(PagePlan { side: Side::Back, grid: back_grid.clone(), cards: backs });
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ cards

pub struct CardBitmap {
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels,
}

fn prepare_rgb(store: &Store, image: &str, builtin: Option<f32>, l: &LayoutSettings, dpi: u32) -> AppResult<Rgb16> {
    let src = decoded(store, image)?;
    let b = builtin.unwrap_or_else(|| imaging::detect_bleed_mm(src.width(), src.height(), l.card_size));
    imaging::prepare_card(&src, l.card_size, b, l.bleed_mm, l.bleed_mode, dpi)
}

pub fn render_card(
    store: &Store,
    pc: &PlacedCard,
    l: &LayoutSettings,
    dpi: u32,
    pipe: &ColorPipeline,
) -> AppResult<CardBitmap> {
    let mut rgb = prepare_rgb(store, &pc.image, pc.builtin_bleed, l, dpi)?;
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

struct Blit<'a> {
    x: i64,
    y: i64,
    w: u32,
    h: u32,
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
    rects: Vec<FillRect>,
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
            if yi < b.y || yi >= b.y + b.h as i64 {
                continue;
            }
            let sy = (yi - b.y) as usize;
            let x0 = b.x.max(0);
            let x1 = (b.x + b.w as i64).min(self.w as i64);
            if x1 <= x0 {
                continue;
            }
            let sx = (x0 - b.x) as usize;
            let n = (x1 - x0) as usize;
            let src = &b.bytes[(sy * b.w as usize + sx) * bpp..(sy * b.w as usize + sx + n) * bpp];
            buf[x0 as usize * bpp..x1 as usize * bpp].copy_from_slice(src);
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

fn guide_rects(grid: &Grid, l: &LayoutSettings, dpi: u32, guide: &[u8], black: &[u8]) -> Vec<FillRect> {
    let t = ((l.cut_guides.width_pt / 72.0 * dpi as f32).round() as i64).max(1);
    let mut out = vec![];
    for line in &grid.cut_lines {
        let (x1, y1, x2, y2) = (mm_px(line.x1, dpi), mm_px(line.y1, dpi), mm_px(line.x2, dpi), mm_px(line.y2, dpi));
        if y1 == y2 {
            out.push(FillRect { x0: x1.min(x2), x1: x1.max(x2), y0: y1 - t / 2, y1: y1 - t / 2 + t, color: guide.to_vec() });
        } else {
            out.push(FillRect { x0: x1 - t / 2, x1: x1 - t / 2 + t, y0: y1.min(y2), y1: y1.max(y2), color: guide.to_vec() });
        }
    }
    for r in &grid.reg_marks {
        out.push(FillRect {
            x0: mm_px(r.x, dpi),
            y0: mm_px(r.y, dpi),
            x1: mm_px(r.right(), dpi),
            y1: mm_px(r.bottom(), dpi),
            color: black.to_vec(),
        });
    }
    out
}

/// Draw guides under the artwork unless the user asked for them on top.
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
            Blit { x: mm_px(art.x, dpi), y: mm_px(art.y, dpi), w: bmp.width, h: bmp.height, bytes }
        })
        .collect();
    let guide = color_bytes(pipe, parse_hex(&l.cut_guides.color));
    let black = black_bytes(pipe);
    let mut rects = if page.side == Side::Front { guide_rects(&page.grid, l, dpi, &guide, &black) } else { vec![] };
    if !l.guides_over_art {
        // keep guide pixels only where they do not overlap art
        let arts: Vec<(i64, i64, i64, i64)> = page
            .grid
            .slots
            .iter()
            .map(|s| (mm_px(s.art.x, dpi), mm_px(s.art.y, dpi), mm_px(s.art.right(), dpi), mm_px(s.art.bottom(), dpi)))
            .collect();
        rects.retain(|r| {
            r.color == black || !arts.iter().any(|a| r.x0 >= a.0 && r.x1 <= a.2 && r.y0 >= a.1 && r.y1 <= a.3)
        });
    }
    Canvas { w: pw, h: ph, bpp, bg: paper_bytes(pipe), blits, rects }
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
    let pages = plan(project)?;
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
    let pc = PlacedCard { slot: 0, image: image.into(), builtin_bleed: None };
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
            content.save_state();
            content.transform([art.w * k, 0.0, 0.0, art.h * k, art.x * k, ph_pt - art.bottom() * k]);
            content.x_object(Name(name.as_bytes()));
            content.restore_state();
        }

        if page.side == Side::Front {
            let [r, g, b] = parse_hex(&l.cut_guides.color);
            content.save_state();
            content.set_line_width(l.cut_guides.width_pt.max(0.1));
            if cmyk {
                let c = color::naive_cmyk([r as u16 * 257, g as u16 * 257, b as u16 * 257]);
                content.set_stroke_cmyk(c[0] as f32 / 65535.0, c[1] as f32 / 65535.0, c[2] as f32 / 65535.0, c[3] as f32 / 65535.0);
            } else {
                content.set_stroke_rgb(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
            }
            for line in &page.grid.cut_lines {
                content.move_to(line.x1 * k, ph_pt - line.y1 * k);
                content.line_to(line.x2 * k, ph_pt - line.y2 * k);
                content.stroke();
            }
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
            let pc = PlacedCard { slot: 0, image: img, builtin_bleed: card.builtin_bleed_mm };
            let bmp = render_card(store, &pc, &project.layout, dpi, &pipe)?;
            let safe: String = card.name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect();
            let canvas = Canvas {
                w: bmp.width,
                h: bmp.height,
                bpp: bmp.pixels.channels() as usize * if bmp.pixels.is_16() { 2 } else { 1 },
                bg: vec![],
                blits: vec![],
                rects: vec![],
            };
            let bytes = bmp.pixels.to_be_bytes();
            let canvas = Canvas { blits: vec![Blit { x: 0, y: 0, w: bmp.width, h: bmp.height, bytes: &bytes }], bg: paper_bytes(&pipe), ..canvas };
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

    #[test]
    fn cancellation_stops_export() {
        let (d, s, p) = setup(3);
        let r = export_pdf(&s, &p, &PrintProfile::default(), &opts(&d.path().join("x.pdf"), ExportFormat::Pdf), &|_, _| {}, &AtomicBool::new(true));
        assert!(r.is_err());
    }
}
