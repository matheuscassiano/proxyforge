//! Turning a source artwork into a print-ready card bitmap: bleed detection, cropping,
//! high-quality resampling, bleed generation. Works in 16-bit RGB to avoid banding
//! before colour management.

use std::path::Path;

use fast_image_resize::{images::Image as FrImage, PixelType, ResizeAlg, ResizeOptions, Resizer, FilterType};
use image::{DynamicImage, GenericImageView};

use crate::error::{AppError, AppResult};
use crate::model::{BleedMode, DarkenMode, EdgeDarken, SizeMm};

/// Interleaved 16-bit RGB image.
#[derive(Clone)]
pub struct Rgb16 {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u16>,
}

impl Rgb16 {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height, data: vec![0; (width * height * 3) as usize] }
    }
    #[inline]
    pub fn idx(&self, x: u32, y: u32) -> usize {
        ((y * self.width + x) * 3) as usize
    }
    pub fn to_rgb8(&self) -> Vec<u8> {
        self.data.iter().map(|v| (v >> 8) as u8).collect()
    }
}

pub fn decode_file(path: &Path) -> AppResult<DynamicImage> {
    let bytes = std::fs::read(path)?;
    decode_bytes(&bytes)
}

pub fn decode_bytes(bytes: &[u8]) -> AppResult<DynamicImage> {
    image::load_from_memory(bytes).map_err(|e| AppError::Image(e.to_string()))
}

/// Estimate how many millimetres of bleed are already present in an artwork, from its
/// aspect ratio compared to the trimmed card. Returns 0 when it looks like a trimmed card.
pub fn detect_bleed_mm(width: u32, height: u32, card: SizeMm) -> f32 {
    if width == 0 || height == 0 {
        return 0.0;
    }
    let r = width as f32 / height as f32;
    let (cw, ch) = (card.width, card.height);
    // (cw + 2b) / (ch + 2b) = r  =>  b = (r*ch - cw) / (2 (1 - r))
    if (1.0 - r).abs() < 1e-4 {
        return 0.0;
    }
    let b = (r * ch - cw) / (2.0 * (1.0 - r));
    if !(0.4..=8.0).contains(&b) {
        return 0.0;
    }
    // Snap to common values (MPC uses 1/8in = 3.175mm)
    let snaps = [1.0_f32, 2.0, 3.0, 3.175, 3.5, 4.0, 5.0];
    let best = snaps
        .iter()
        .copied()
        .min_by(|a, c| (b - a).abs().partial_cmp(&(b - c).abs()).unwrap())
        .unwrap();
    if (b - best).abs() < 0.12 { best } else { (b * 10.0).round() / 10.0 }
}

/// Effective DPI of an image when printed at the given physical size (mm, incl. bleed).
pub fn effective_dpi(width_px: u32, width_mm: f32) -> f32 {
    width_px as f32 / (width_mm / crate::layout::MM_PER_INCH)
}

/// Replace transparent pixels (rounded corners of digital scans) with the average colour
/// of the opaque border so bleed generation does not spread transparency.
fn flatten_alpha(img: &DynamicImage) -> image::ImageBuffer<image::Rgb<u16>, Vec<u16>> {
    let rgba = img.to_rgba16();
    let (w, h) = rgba.dimensions();
    let band_x = (w / 40).max(2);
    let band_y = (h / 40).max(2);
    let mut sum = [0u64; 3];
    let mut n = 0u64;
    let has_alpha = img.color().has_alpha();
    if has_alpha {
        for y in 0..h {
            for x in 0..w {
                let border = x < band_x || y < band_y || x >= w - band_x || y >= h - band_y;
                if !border {
                    continue;
                }
                let p = rgba.get_pixel(x, y).0;
                if p[3] > 60000 {
                    sum[0] += p[0] as u64;
                    sum[1] += p[1] as u64;
                    sum[2] += p[2] as u64;
                    n += 1;
                }
            }
        }
    }
    let bg = if n > 0 {
        [(sum[0] / n) as f32, (sum[1] / n) as f32, (sum[2] / n) as f32]
    } else {
        [65535.0; 3]
    };
    let mut out = image::ImageBuffer::<image::Rgb<u16>, Vec<u16>>::new(w, h);
    // Transparent rounded corners: continue the nearest opaque pixel of the same row
    // (then column) instead of a flat average, so the generated bleed keeps the border.
    let opaque = |p: &image::Rgba<u16>| p.0[3] > 60000;
    let mut fill: Vec<Option<[f32; 3]>> = vec![None; (w * h) as usize];
    if has_alpha {
        for y in 0..h {
            let first = (0..(w / 8).max(band_x).min(w)).find(|&x| opaque(rgba.get_pixel(x, y)));
            let last = (w.saturating_sub((w / 8).max(band_x))..w).rev().find(|&x| opaque(rgba.get_pixel(x, y)));
            if let Some(f) = first {
                let p = rgba.get_pixel(f, y).0;
                for x in 0..f {
                    fill[(y * w + x) as usize] = Some([p[0] as f32, p[1] as f32, p[2] as f32]);
                }
            }
            if let Some(l) = last {
                let p = rgba.get_pixel(l, y).0;
                for x in l + 1..w {
                    fill[(y * w + x) as usize] = Some([p[0] as f32, p[1] as f32, p[2] as f32]);
                }
            }
        }
        for x in 0..w {
            let first = (0..(h / 8).max(band_y).min(h)).find(|&y| opaque(rgba.get_pixel(x, y)));
            let last = (h.saturating_sub((h / 8).max(band_y))..h).rev().find(|&y| opaque(rgba.get_pixel(x, y)));
            if let Some(f) = first {
                let p = rgba.get_pixel(x, f).0;
                for y in 0..f {
                    let i = (y * w + x) as usize;
                    fill[i].get_or_insert([p[0] as f32, p[1] as f32, p[2] as f32]);
                }
            }
            if let Some(l) = last {
                let p = rgba.get_pixel(x, l).0;
                for y in l + 1..h {
                    let i = (y * w + x) as usize;
                    fill[i].get_or_insert([p[0] as f32, p[1] as f32, p[2] as f32]);
                }
            }
        }
    }
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p.0[3] as f32 / 65535.0;
        let bg = fill[(y * w + x) as usize].unwrap_or(bg);
        let px = [
            (p.0[0] as f32 * a + bg[0] * (1.0 - a)) as u16,
            (p.0[1] as f32 * a + bg[1] * (1.0 - a)) as u16,
            (p.0[2] as f32 * a + bg[2] * (1.0 - a)) as u16,
        ];
        out.put_pixel(x, y, image::Rgb(px));
    }
    out
}

/// How a card bitmap is built, besides its size.
#[derive(Debug, Clone, Copy, Default)]
pub struct CardProcess {
    pub mode: BleedMode,
    /// Drop the artwork's own bleed and generate it again with `mode`.
    pub regenerate: bool,
    pub darken: Option<EdgeDarken>,
}

impl Default for BleedMode {
    fn default() -> Self {
        BleedMode::Extend
    }
}

/// Produce the card bitmap covering trim + `bleed_mm` on every side at `dpi`.
pub fn prepare_card(
    src: &DynamicImage,
    card: SizeMm,
    builtin_bleed_mm: f32,
    bleed_mm: f32,
    process: CardProcess,
    dpi: u32,
) -> AppResult<Rgb16> {
    let mut out = prepare_inner(src, card, builtin_bleed_mm, bleed_mm, process, dpi)?;
    if let Some(d) = process.darken.filter(|d| d.enabled && d.amount > 0.0) {
        darken(&mut out, &d, bleed_mm, dpi);
    }
    Ok(out)
}

fn prepare_inner(src: &DynamicImage, card: SizeMm, builtin_bleed_mm: f32, bleed_mm: f32, process: CardProcess, dpi: u32) -> AppResult<Rgb16> {
    let mode = process.mode;
    let (sw, sh) = src.dimensions();
    let b_src = builtin_bleed_mm.max(0.0);
    let avail = if process.regenerate { 0.0 } else { b_src.min(bleed_mm.max(0.0)) };
    // Region of the source to keep: trim + `avail` mm on each side.
    let src_full_w = card.width + 2.0 * b_src;
    let src_full_h = card.height + 2.0 * b_src;
    let inset_x = ((b_src - avail) / src_full_w * sw as f32).round() as u32;
    let inset_y = ((b_src - avail) / src_full_h * sh as f32).round() as u32;
    let crop_w = sw.saturating_sub(2 * inset_x).max(1);
    let crop_h = sh.saturating_sub(2 * inset_y).max(1);

    let flat = flatten_alpha(src);
    let cropped = if inset_x > 0 || inset_y > 0 {
        image::imageops::crop_imm(&flat, inset_x, inset_y, crop_w, crop_h).to_image()
    } else {
        flat
    };

    let dst_w = crate::layout::mm_to_px(card.width + 2.0 * avail, dpi);
    let dst_h = crate::layout::mm_to_px(card.height + 2.0 * avail, dpi);
    let resized = resize_rgb16(&cropped, dst_w, dst_h)?;

    let pad = bleed_mm - avail;
    if pad <= 0.001 {
        return Ok(resized);
    }
    let total_w = crate::layout::mm_to_px(card.width + 2.0 * bleed_mm, dpi);
    let total_h = crate::layout::mm_to_px(card.height + 2.0 * bleed_mm, dpi);
    let px = (total_w.saturating_sub(dst_w)) / 2;
    let py = (total_h.saturating_sub(dst_h)) / 2;
    Ok(add_bleed(&resized, px, py, mode))
}

pub fn resize_rgb16(
    src: &image::ImageBuffer<image::Rgb<u16>, Vec<u16>>,
    w: u32,
    h: u32,
) -> AppResult<Rgb16> {
    let (sw, sh) = src.dimensions();
    if sw == w && sh == h {
        return Ok(Rgb16 { width: w, height: h, data: src.as_raw().clone() });
    }
    let bytes: Vec<u8> = bytemuck_u16_to_u8(src.as_raw());
    let src_img = FrImage::from_vec_u8(sw, sh, bytes, PixelType::U16x3)
        .map_err(|e| AppError::Image(e.to_string()))?;
    let mut dst = FrImage::new(w, h, PixelType::U16x3);
    let mut resizer = Resizer::new();
    let opts = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    resizer
        .resize(&src_img, &mut dst, &opts)
        .map_err(|e| AppError::Image(e.to_string()))?;
    let data = u8_to_u16(dst.buffer());
    Ok(Rgb16 { width: w, height: h, data })
}

fn bytemuck_u16_to_u8(v: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 2);
    for x in v {
        out.extend_from_slice(&x.to_ne_bytes());
    }
    out
}

fn u8_to_u16(v: &[u8]) -> Vec<u16> {
    v.chunks_exact(2).map(|c| u16::from_ne_bytes([c[0], c[1]])).collect()
}

/// Grow an image by `px`/`py` pixels on each side.
pub fn add_bleed(src: &Rgb16, px: u32, py: u32, mode: BleedMode) -> Rgb16 {
    match mode {
        BleedMode::Stretch => return stretch_bleed(src, px, py),
        BleedMode::Blur => return blur_bleed(src, px, py),
        _ => {}
    }
    let (w, h) = (src.width, src.height);
    let nw = w + 2 * px;
    let nh = h + 2 * py;
    let mut out = Rgb16::new(nw, nh);
    let solid = if mode == BleedMode::Solid { Some(edge_average(src)) } else { None };

    let map = |d: i64, size: u32| -> u32 {
        let s = size as i64;
        match mode {
            BleedMode::Mirror => {
                // reflect without repeating the edge pixel
                let mut v = d;
                if s == 1 {
                    return 0;
                }
                let period = 2 * (s - 1);
                v = v.rem_euclid(period);
                if v >= s { (period - v) as u32 } else { v as u32 }
            }
            _ => d.clamp(0, s - 1) as u32,
        }
    };

    for y in 0..nh {
        let sy = y as i64 - py as i64;
        let in_y = sy >= 0 && sy < h as i64;
        let dst_row = (y * nw * 3) as usize;
        if let (Some(c), false) = (solid, in_y) {
            for x in 0..nw as usize {
                out.data[dst_row + x * 3..dst_row + x * 3 + 3].copy_from_slice(&c);
            }
            continue;
        }
        let ry = map(sy, h);
        let src_row = (ry * w * 3) as usize;
        // interior
        let d0 = dst_row + (px * 3) as usize;
        out.data[d0..d0 + (w * 3) as usize].copy_from_slice(&src.data[src_row..src_row + (w * 3) as usize]);
        // left/right
        for i in 0..px {
            let lx = i as i64 - px as i64;
            let rx = w as i64 + i as i64;
            let (l, r) = if let Some(c) = solid {
                (c, c)
            } else {
                let a = src_row + (map(lx, w) * 3) as usize;
                let b = src_row + (map(rx, w) * 3) as usize;
                (
                    [src.data[a], src.data[a + 1], src.data[a + 2]],
                    [src.data[b], src.data[b + 1], src.data[b + 2]],
                )
            };
            let li = dst_row + (i * 3) as usize;
            out.data[li..li + 3].copy_from_slice(&l);
            let ri = dst_row + ((px + w + i) * 3) as usize;
            out.data[ri..ri + 3].copy_from_slice(&r);
        }
    }
    out
}

/// Source coordinate for destination `d` (may be negative / past the end) when the outer
/// `band` pixels of each side are stretched over band + pad.
fn stretch_coord(d: i64, size: u32, pad: u32, band: u32) -> u32 {
    let s = size as i64;
    let (pad, band) = (pad as i64, band.min(size / 2).max(1) as i64);
    let v = if d < band {
        // [-pad, band) -> [0, band)
        ((d + pad) as f32 * band as f32 / (band + pad) as f32).floor() as i64
    } else if d >= s - band {
        let k = d - (s - band);
        s - band + (k as f32 * band as f32 / (band + pad) as f32).floor() as i64
    } else {
        d
    };
    v.clamp(0, s - 1) as u32
}

fn stretch_bleed(src: &Rgb16, px: u32, py: u32) -> Rgb16 {
    let (w, h) = (src.width, src.height);
    let (nw, nh) = (w + 2 * px, h + 2 * py);
    // the outer ~1.5% of the card is stretched: thin enough to stay in the border
    let bx = (w / 64).max(px.min(w / 8)).max(1);
    let by = (h / 64).max(py.min(h / 8)).max(1);
    let mut out = Rgb16::new(nw, nh);
    let xs: Vec<u32> = (0..nw).map(|x| stretch_coord(x as i64 - px as i64, w, px, bx)).collect();
    for y in 0..nh {
        let sy = stretch_coord(y as i64 - py as i64, h, py, by);
        for (x, &sx) in xs.iter().enumerate() {
            let si = src.idx(sx, sy);
            let di = out.idx(x as u32, y);
            out.data[di..di + 3].copy_from_slice(&src.data[si..si + 3]);
        }
    }
    out
}

/// Extend the edge pixels outward, averaging a span along the edge that grows with the
/// distance from the artwork, so single-pixel details do not turn into long streaks.
fn blur_bleed(src: &Rgb16, px: u32, py: u32) -> Rgb16 {
    let mut out = add_bleed(src, px, py, BleedMode::Extend);
    let (w, h) = (src.width, src.height);
    // prefix sums of the four edge lines
    let line = |pts: &mut dyn Iterator<Item = (u32, u32)>| -> Vec<[u64; 3]> {
        let mut acc = vec![[0u64; 3]];
        for (x, y) in pts {
            let i = src.idx(x, y);
            let l = *acc.last().unwrap();
            acc.push([l[0] + src.data[i] as u64, l[1] + src.data[i + 1] as u64, l[2] + src.data[i + 2] as u64]);
        }
        acc
    };
    let left = line(&mut (0..h).map(|y| (0, y)));
    let right = line(&mut (0..h).map(|y| (w - 1, y)));
    let top = line(&mut (0..w).map(|x| (x, 0)));
    let bottom = line(&mut (0..w).map(|x| (x, h - 1)));
    let mean = |acc: &Vec<[u64; 3]>, c: i64, r: i64, n: u32| -> [u16; 3] {
        let a = (c - r).clamp(0, n as i64 - 1) as usize;
        let b = (c + r).clamp(0, n as i64 - 1) as usize + 1;
        let k = (b - a) as u64;
        [((acc[b][0] - acc[a][0]) / k) as u16, ((acc[b][1] - acc[a][1]) / k) as u16, ((acc[b][2] - acc[a][2]) / k) as u16]
    };
    let nw = w + 2 * px;
    for y in 0..h + 2 * py {
        let sy = y as i64 - py as i64;
        for x in 0..nw {
            let sx = x as i64 - px as i64;
            let inx = sx >= 0 && sx < w as i64;
            let iny = sy >= 0 && sy < h as i64;
            let v = match (inx, iny) {
                (true, true) => continue,
                (false, true) => {
                    let d = if sx < 0 { -sx } else { sx - w as i64 + 1 };
                    mean(if sx < 0 { &left } else { &right }, sy, d, h)
                }
                (true, false) => {
                    let d = if sy < 0 { -sy } else { sy - h as i64 + 1 };
                    mean(if sy < 0 { &top } else { &bottom }, sx, d, w)
                }
                (false, false) => continue, // corners: plain extension of the corner pixel
            };
            let i = out.idx(x, y);
            out.data[i..i + 3].copy_from_slice(&v);
        }
    }
    out
}

/// Push near-black pixels toward solid black, everywhere or in a band along the edges.
pub fn darken(img: &mut Rgb16, d: &EdgeDarken, bleed_mm: f32, dpi: u32) {
    let (w, h) = (img.width, img.height);
    let t = d.threshold.clamp(0.02, 1.0);
    let amount = d.amount.clamp(0.0, 1.0);
    let band = crate::layout::mm_to_px(d.edge_width_mm.max(0.1) + bleed_mm.max(0.0), dpi) as f32;
    let fade = (band * 0.25).max(1.0);
    for y in 0..h {
        for x in 0..w {
            let weight = match d.mode {
                DarkenMode::DarkenAll => 1.0,
                DarkenMode::ContrastEdges => {
                    let e = x.min(y).min(w - 1 - x).min(h - 1 - y) as f32;
                    if e >= band {
                        continue;
                    }
                    ((band - e) / fade).min(1.0)
                }
            };
            let i = img.idx(x, y);
            let (r, g, b) = (img.data[i] as f32, img.data[i + 1] as f32, img.data[i + 2] as f32);
            let lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 65535.0;
            if lum >= t {
                continue;
            }
            // 1 at the threshold, falling steeply toward 0 for darker pixels
            let f = (lum / t).powf(amount * weight * 3.0);
            img.data[i] = (r * f) as u16;
            img.data[i + 1] = (g * f) as u16;
            img.data[i + 2] = (b * f) as u16;
        }
    }
}

fn edge_average(img: &Rgb16) -> [u16; 3] {
    let mut s = [0u64; 3];
    let mut n = 0u64;
    let (w, h) = (img.width, img.height);
    let mut add = |x: u32, y: u32| {
        let i = img.idx(x, y);
        s[0] += img.data[i] as u64;
        s[1] += img.data[i + 1] as u64;
        s[2] += img.data[i + 2] as u64;
        n += 1;
    };
    for x in 0..w {
        add(x, 0);
        add(x, h - 1);
    }
    for y in 0..h {
        add(0, y);
        add(w - 1, y);
    }
    [(s[0] / n) as u16, (s[1] / n) as u16, (s[2] / n) as u16]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_mpc_bleed() {
        // MPC 1/8" bleed: 69.35 x 94.35 mm
        let card = SizeMm { width: 63.0, height: 88.0 };
        let w = (69.35 / 25.4 * 800.0) as u32;
        let h = (94.35 / 25.4 * 800.0) as u32;
        assert_eq!(detect_bleed_mm(w, h, card), 3.175);
    }

    #[test]
    fn trimmed_scan_has_no_bleed() {
        let card = SizeMm { width: 63.0, height: 88.0 };
        assert_eq!(detect_bleed_mm(745, 1040, card), 0.0);
        assert_eq!(detect_bleed_mm(1000, 1000, card), 0.0);
    }

    #[test]
    fn prepare_adds_requested_bleed() {
        let src = DynamicImage::new_rgb8(63, 88);
        let card = SizeMm { width: 63.0, height: 88.0 };
        let out = prepare_card(&src, card, 0.0, 2.0, CardProcess { mode: BleedMode::Mirror, ..Default::default() }, 254).unwrap();
        assert_eq!(out.width, crate::layout::mm_to_px(67.0, 254));
        assert_eq!(out.height, crate::layout::mm_to_px(92.0, 254));
    }

    #[test]
    fn prepare_crops_excess_builtin_bleed() {
        let card = SizeMm { width: 63.0, height: 88.0 };
        let src = DynamicImage::new_rgb8(694, 944); // ~3mm bleed at 254 dpi-ish
        let out = prepare_card(&src, card, 3.0, 1.0, CardProcess::default(), 300).unwrap();
        assert_eq!(out.width, crate::layout::mm_to_px(65.0, 300));
    }

    #[test]
    fn extend_and_mirror_fill_edges() {
        let mut img = Rgb16::new(2, 1);
        img.data = vec![100, 100, 100, 200, 200, 200];
        let e = add_bleed(&img, 2, 1, BleedMode::Extend);
        assert_eq!(e.width, 6);
        assert_eq!(e.height, 3);
        assert_eq!(e.data[0], 100); // left padding copies first pixel
        assert_eq!(e.data[e.idx(5, 0)], 200);
        let m = add_bleed(&img, 1, 0, BleedMode::Mirror);
        // [200 | 100 200 | 100]
        assert_eq!(m.data[m.idx(0, 0)], 200);
        assert_eq!(m.data[m.idx(3, 0)], 100);
    }

    #[test]
    fn regenerate_drops_builtin_bleed() {
        let card = SizeMm { width: 63.0, height: 88.0 };
        let mut src = image::RgbImage::from_pixel(694, 944, image::Rgb([255, 0, 0]));
        // trim area green; the 3mm built-in bleed stays red
        let b = (3.0_f32 / 69.0 * 694.0).round() as u32;
        let by = (3.0_f32 / 94.0 * 944.0).round() as u32;
        for y in by..944 - by {
            for x in b..694 - b {
                src.put_pixel(x, y, image::Rgb([0, 255, 0]));
            }
        }
        let src = DynamicImage::ImageRgb8(src);
        let p = CardProcess { regenerate: true, ..Default::default() };
        let out = prepare_card(&src, card, 3.0, 1.0, p, 300);
        let out = out.unwrap();
        let i = out.idx(0, out.height / 2);
        assert!(out.data[i + 1] > out.data[i], "bleed comes from the trimmed (green) art");
    }

    #[test]
    fn stretch_and_blur_fill_without_paper() {
        let mut img = Rgb16::new(40, 30);
        for (i, v) in img.data.iter_mut().enumerate() {
            *v = (i as u16 % 3) * 20000 + 1000;
        }
        for mode in [BleedMode::Stretch, BleedMode::Blur] {
            let out = add_bleed(&img, 5, 4, mode);
            assert_eq!((out.width, out.height), (50, 38));
            assert!(out.data.iter().all(|&v| v >= 1000), "{mode:?} left unfilled pixels");
        }
        // stretch keeps the centre untouched
        let out = add_bleed(&img, 5, 4, BleedMode::Stretch);
        assert_eq!(out.data[out.idx(25, 19)..out.idx(25, 19) + 3], img.data[img.idx(20, 15)..img.idx(20, 15) + 3]);
    }

    #[test]
    fn darken_only_near_edges() {
        let mut img = Rgb16::new(100, 100);
        img.data.iter_mut().for_each(|v| *v = 6000);
        let d = EdgeDarken { enabled: true, amount: 1.0, edge_width_mm: 1.0, ..Default::default() };
        darken(&mut img, &d, 0.0, 254);
        assert!(img.data[img.idx(0, 50)] < 1000);
        assert_eq!(img.data[img.idx(50, 50)], 6000);
    }

    #[test]
    fn transparent_corners_get_border_colour() {
        let mut img = image::RgbaImage::from_pixel(40, 40, image::Rgba([10, 20, 30, 255]));
        img.put_pixel(0, 0, image::Rgba([255, 255, 255, 0]));
        let flat = flatten_alpha(&DynamicImage::ImageRgba8(img));
        let p = flat.get_pixel(0, 0).0;
        assert!((p[0] as i32 - 10 * 257).abs() < 300);
        // a rounded corner continues the neighbouring border, not the average
        let mut img = image::RgbaImage::from_pixel(80, 80, image::Rgba([200, 200, 200, 255]));
        for y in 0..80 {
            for x in 0..4 {
                img.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
            }
        }
        img.put_pixel(0, 0, image::Rgba([255, 255, 255, 0]));
        img.put_pixel(1, 0, image::Rgba([255, 255, 255, 0]));
        let flat = flatten_alpha(&DynamicImage::ImageRgba8(img));
        assert!(flat.get_pixel(0, 0).0[0] < 2000);
    }
}
