//! Turning a source artwork into a print-ready card bitmap: bleed detection, cropping,
//! high-quality resampling, bleed generation. Works in 16-bit RGB to avoid banding
//! before colour management.

use std::path::Path;

use fast_image_resize::{images::Image as FrImage, PixelType, ResizeAlg, ResizeOptions, Resizer, FilterType};
use image::{DynamicImage, GenericImageView};

use crate::error::{AppError, AppResult};
use crate::model::{BleedMode, SizeMm};

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
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p.0[3] as f32 / 65535.0;
        let px = [
            (p.0[0] as f32 * a + bg[0] * (1.0 - a)) as u16,
            (p.0[1] as f32 * a + bg[1] * (1.0 - a)) as u16,
            (p.0[2] as f32 * a + bg[2] * (1.0 - a)) as u16,
        ];
        out.put_pixel(x, y, image::Rgb(px));
    }
    out
}

/// Produce the card bitmap covering trim + `bleed_mm` on every side at `dpi`.
pub fn prepare_card(
    src: &DynamicImage,
    card: SizeMm,
    builtin_bleed_mm: f32,
    bleed_mm: f32,
    mode: BleedMode,
    dpi: u32,
) -> AppResult<Rgb16> {
    let (sw, sh) = src.dimensions();
    let b_src = builtin_bleed_mm.max(0.0);
    let avail = b_src.min(bleed_mm.max(0.0));
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
        let out = prepare_card(&src, card, 0.0, 2.0, BleedMode::Mirror, 254).unwrap();
        assert_eq!(out.width, crate::layout::mm_to_px(67.0, 254));
        assert_eq!(out.height, crate::layout::mm_to_px(92.0, 254));
    }

    #[test]
    fn prepare_crops_excess_builtin_bleed() {
        let card = SizeMm { width: 63.0, height: 88.0 };
        let src = DynamicImage::new_rgb8(694, 944); // ~3mm bleed at 254 dpi-ish
        let out = prepare_card(&src, card, 3.0, 1.0, BleedMode::Extend, 300).unwrap();
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
    fn transparent_corners_get_border_colour() {
        let mut img = image::RgbaImage::from_pixel(40, 40, image::Rgba([10, 20, 30, 255]));
        img.put_pixel(0, 0, image::Rgba([255, 255, 255, 0]));
        let flat = flatten_alpha(&DynamicImage::ImageRgba8(img));
        let p = flat.get_pixel(0, 0).0;
        assert!((p[0] as i32 - 10 * 257).abs() < 300);
    }
}
