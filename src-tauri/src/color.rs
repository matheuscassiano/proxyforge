//! Colour management: tone/colour adjustments, ICC transforms (RGB and CMYK output),
//! soft proofing and the built-in profiles.

use std::path::{Path, PathBuf};

use lcms2::{
    CIExyY, CIExyYTRIPLE, ColorSpaceSignature, Flags, InfoType, Intent, Locale, PixelFormat, Profile, ToneCurve,
    Transform,
};
use rayon::prelude::*;

use crate::error::{AppError, AppResult};
use crate::imaging::Rgb16;
use crate::model::{Adjustments, Curve, IccInfo, OutputColorSpace, PrintProfile, RenderingIntent};

pub const SRGB: &str = "builtin:srgb";
pub const P3: &str = "builtin:p3";
pub const ADOBE: &str = "builtin:adobergb";
pub const NAIVE_CMYK: &str = "builtin:naive-cmyk";

pub fn builtin_profiles() -> Vec<IccInfo> {
    vec![
        IccInfo { id: SRGB.into(), name: "sRGB IEC61966-2.1".into(), space: OutputColorSpace::Rgb, builtin: true },
        IccInfo { id: P3.into(), name: "Display P3".into(), space: OutputColorSpace::Rgb, builtin: true },
        IccInfo { id: ADOBE.into(), name: "Adobe RGB (1998) compatible".into(), space: OutputColorSpace::Rgb, builtin: true },
        IccInfo {
            id: NAIVE_CMYK.into(),
            name: "Generic CMYK (uncalibrated)".into(),
            space: OutputColorSpace::Cmyk,
            builtin: true,
        },
    ]
}

fn srgb_curve() -> AppResult<ToneCurve> {
    Ok(ToneCurve::new_parametric(4, &[2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045])?)
}

fn d65() -> CIExyY {
    CIExyY { x: 0.3127, y: 0.3290, Y: 1.0 }
}

fn rgb_profile(prim: [(f64, f64); 3], curve: &ToneCurve) -> AppResult<Profile> {
    let p = |(x, y): (f64, f64)| CIExyY { x, y, Y: 1.0 };
    let triple = CIExyYTRIPLE { Red: p(prim[0]), Green: p(prim[1]), Blue: p(prim[2]) };
    Ok(Profile::new_rgb(&d65(), &triple, &[curve, curve, curve])?)
}

/// Load a profile by id. Imported profiles live in `icc_dir` as files named by id.
pub fn load_profile(id: &str, icc_dir: &Path) -> AppResult<Option<Profile>> {
    Ok(Some(match id {
        SRGB => Profile::new_srgb(),
        P3 => rgb_profile([(0.680, 0.320), (0.265, 0.690), (0.150, 0.060)], &srgb_curve()?)?,
        ADOBE => rgb_profile([(0.64, 0.33), (0.21, 0.71), (0.15, 0.06)], &ToneCurve::new(563.0 / 256.0))?,
        NAIVE_CMYK => return Ok(None),
        other => {
            let path = icc_path(icc_dir, other)?;
            let bytes = std::fs::read(&path)
                .map_err(|_| AppError::NotFound(format!("ICC profile '{other}' not found")))?;
            Profile::new_icc(&bytes)?
        }
    }))
}

fn icc_path(icc_dir: &Path, id: &str) -> AppResult<PathBuf> {
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(AppError::Invalid("bad profile id".into()));
    }
    Ok(icc_dir.join(id))
}

pub fn profile_space(p: &Profile) -> AppResult<OutputColorSpace> {
    match p.color_space() {
        ColorSpaceSignature::RgbData => Ok(OutputColorSpace::Rgb),
        ColorSpaceSignature::CmykData => Ok(OutputColorSpace::Cmyk),
        other => Err(AppError::Color(format!("unsupported profile colour space {other:?}; use an RGB or CMYK output profile"))),
    }
}

pub fn describe(p: &Profile) -> String {
    p.info(InfoType::Description, Locale::none()).unwrap_or_else(|| "Unnamed profile".into())
}

/// Validate and inspect an ICC file before importing it.
pub fn inspect_icc(bytes: &[u8]) -> AppResult<(String, OutputColorSpace)> {
    let p = Profile::new_icc(bytes)?;
    Ok((describe(&p), profile_space(&p)?))
}

fn intent(i: RenderingIntent) -> Intent {
    match i {
        RenderingIntent::Perceptual => Intent::Perceptual,
        RenderingIntent::RelativeColorimetric => Intent::RelativeColorimetric,
        RenderingIntent::Saturation => Intent::Saturation,
        RenderingIntent::AbsoluteColorimetric => Intent::AbsoluteColorimetric,
    }
}

// ---------------------------------------------------------------- adjustments

/// Monotone cubic interpolation (Fritsch–Carlson) through curve points.
fn eval_curve(points: &Curve, x: f32) -> f32 {
    if points.len() < 2 {
        return x;
    }
    let n = points.len();
    if x <= points[0][0] {
        return points[0][1];
    }
    if x >= points[n - 1][0] {
        return points[n - 1][1];
    }
    let mut k = 0;
    while k < n - 2 && x > points[k + 1][0] {
        k += 1;
    }
    let slope = |i: usize| -> f32 {
        let d = |a: usize, b: usize| (points[b][1] - points[a][1]) / (points[b][0] - points[a][0]).max(1e-6);
        if i == 0 {
            d(0, 1)
        } else if i == n - 1 {
            d(n - 2, n - 1)
        } else {
            let (a, b) = (d(i - 1, i), d(i, i + 1));
            if a * b <= 0.0 { 0.0 } else { 2.0 / (1.0 / a + 1.0 / b) }
        }
    };
    let (x0, y0) = (points[k][0], points[k][1]);
    let (x1, y1) = (points[k + 1][0], points[k + 1][1]);
    let h = (x1 - x0).max(1e-6);
    let t = (x - x0) / h;
    let (m0, m1) = (slope(k) * h, slope(k + 1) * h);
    let t2 = t * t;
    let t3 = t2 * t;
    (2.0 * t3 - 3.0 * t2 + 1.0) * y0 + (t3 - 2.0 * t2 + t) * m0 + (-2.0 * t3 + 3.0 * t2) * y1 + (t3 - t2) * m1
}

/// Build 16-bit lookup tables for the per-channel part of the adjustments.
fn build_luts(a: &Adjustments) -> [Vec<u16>; 3] {
    let mult = [a.red, a.green, a.blue];
    let curves = [&a.curve_red, &a.curve_green, &a.curve_blue];
    let lw = (a.levels_white - a.levels_black).max(1e-3);
    let gamma = a.gamma.clamp(0.05, 5.0);
    let contrast = (1.0 + a.contrast).max(0.0);
    let mut luts: [Vec<u16>; 3] = [vec![0; 65536], vec![0; 65536], vec![0; 65536]];
    for (c, lut) in luts.iter_mut().enumerate() {
        for (i, slot) in lut.iter_mut().enumerate() {
            let mut v = i as f32 / 65535.0;
            v = ((v - a.levels_black) / lw).clamp(0.0, 1.0);
            v = v.powf(1.0 / gamma);
            v += a.brightness * 0.5;
            v = (v - 0.5) * contrast + 0.5;
            v *= mult[c];
            v = v.clamp(0.0, 1.0);
            v = eval_curve(&a.curve_master, v).clamp(0.0, 1.0);
            v = eval_curve(curves[c], v).clamp(0.0, 1.0);
            *slot = (v * 65535.0 + 0.5) as u16;
        }
    }
    luts
}

pub fn apply_adjustments(img: &mut Rgb16, a: &Adjustments) {
    if a.is_identity() {
        return;
    }
    let luts = build_luts(a);
    let sat = a.saturation;
    let vib = a.vibrance;
    let row_len = (img.width * 3) as usize;
    img.data.par_chunks_mut(row_len).for_each(|row| {
        for px in row.chunks_exact_mut(3) {
            let mut r = luts[0][px[0] as usize] as f32;
            let mut g = luts[1][px[1] as usize] as f32;
            let mut b = luts[2][px[2] as usize] as f32;
            if sat != 0.0 || vib != 0.0 {
                let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                let max = r.max(g).max(b);
                let min = r.min(g).min(b);
                let cur_sat = if max > 0.0 { (max - min) / max } else { 0.0 };
                // vibrance boosts low-saturation pixels more than saturated ones
                let f = 1.0 + sat + vib * (1.0 - cur_sat);
                r = l + (r - l) * f;
                g = l + (g - l) * f;
                b = l + (b - l) * f;
            }
            px[0] = r.clamp(0.0, 65535.0) as u16;
            px[1] = g.clamp(0.0, 65535.0) as u16;
            px[2] = b.clamp(0.0, 65535.0) as u16;
        }
    });
    if a.sharpen > 0.0 {
        unsharp(img, a.sharpen);
    }
}

/// 3×3 Gaussian unsharp mask.
fn unsharp(img: &mut Rgb16, amount: f32) {
    let (w, h) = (img.width as usize, img.height as usize);
    if w < 3 || h < 3 {
        return;
    }
    let src = img.data.clone();
    let k = [1.0, 2.0, 1.0, 2.0, 4.0, 2.0, 1.0, 2.0, 1.0];
    img.data.par_chunks_mut(w * 3).enumerate().for_each(|(y, row)| {
        if y == 0 || y == h - 1 {
            return;
        }
        for x in 1..w - 1 {
            for c in 0..3 {
                let mut s = 0.0;
                let mut ki = 0;
                for dy in [-1i64, 0, 1] {
                    for dx in [-1i64, 0, 1] {
                        let i = (((y as i64 + dy) as usize * w + (x as i64 + dx) as usize) * 3) + c;
                        s += src[i] as f32 * k[ki];
                        ki += 1;
                    }
                }
                let blur = s / 16.0;
                let o = src[(y * w + x) * 3 + c] as f32;
                row[x * 3 + c] = (o + (o - blur) * amount).clamp(0.0, 65535.0) as u16;
            }
        }
    });
}

// ---------------------------------------------------------------- output conversion

pub enum Pixels {
    Rgb8(Vec<u8>),
    Rgb16(Vec<u16>),
    Cmyk8(Vec<u8>),
    Cmyk16(Vec<u16>),
}

impl Pixels {
    pub fn channels(&self) -> u8 {
        match self {
            Pixels::Rgb8(_) | Pixels::Rgb16(_) => 3,
            _ => 4,
        }
    }
    pub fn is_16(&self) -> bool {
        matches!(self, Pixels::Rgb16(_) | Pixels::Cmyk16(_))
    }
    /// Raw bytes, 16-bit values big-endian (what PDF, PNG and TIFF-BE expect).
    pub fn to_be_bytes(&self) -> Vec<u8> {
        match self {
            Pixels::Rgb8(v) | Pixels::Cmyk8(v) => v.clone(),
            Pixels::Rgb16(v) | Pixels::Cmyk16(v) => v.iter().flat_map(|x| x.to_be_bytes()).collect(),
        }
    }
}

enum Kind {
    /// Input is already in output space (sRGB → sRGB without adjustments needed).
    Identity,
    Rgb8(Transform<[u16; 3], [u8; 3]>),
    Rgb16(Transform<[u16; 3], [u16; 3]>),
    Cmyk8(Transform<[u16; 3], [u8; 4]>),
    Cmyk16(Transform<[u16; 3], [u16; 4]>),
    Naive,
}

/// Everything needed to convert prepared sRGB artwork into the print profile's output space.
pub struct ColorPipeline {
    kind: Kind,
    pub space: OutputColorSpace,
    pub sixteen: bool,
    pub adjustments: Adjustments,
    pub ink_limit: f32,
    /// ICC bytes to embed (None when tagging is disabled or not applicable).
    pub icc: Option<Vec<u8>>,
    pub profile_name: String,
}

impl ColorPipeline {
    pub fn new(pp: &PrintProfile, icc_dir: &Path, sixteen: bool) -> AppResult<Self> {
        let src = Profile::new_srgb();
        let out = load_profile(&pp.output_icc, icc_dir)?;
        let flags = if pp.black_point_compensation { Flags::BLACKPOINT_COMPENSATION } else { Flags::default() };
        let it = intent(pp.intent);
        let (kind, space, icc, name) = match out {
            None => (Kind::Naive, OutputColorSpace::Cmyk, None, "Generic CMYK (uncalibrated)".to_string()),
            Some(p) => {
                let space = profile_space(&p)?;
                let name = describe(&p);
                let icc = if pp.embed_profile { Some(p.icc()?) } else { None };
                let kind = match (space, sixteen) {
                    (OutputColorSpace::Rgb, _) if pp.output_icc == SRGB => Kind::Identity,
                    (OutputColorSpace::Rgb, false) => {
                        Kind::Rgb8(Transform::new_flags(&src, PixelFormat::RGB_16, &p, PixelFormat::RGB_8, it, flags)?)
                    }
                    (OutputColorSpace::Rgb, true) => {
                        Kind::Rgb16(Transform::new_flags(&src, PixelFormat::RGB_16, &p, PixelFormat::RGB_16, it, flags)?)
                    }
                    (OutputColorSpace::Cmyk, false) => {
                        Kind::Cmyk8(Transform::new_flags(&src, PixelFormat::RGB_16, &p, PixelFormat::CMYK_8, it, flags)?)
                    }
                    (OutputColorSpace::Cmyk, true) => {
                        Kind::Cmyk16(Transform::new_flags(&src, PixelFormat::RGB_16, &p, PixelFormat::CMYK_16, it, flags)?)
                    }
                };
                (kind, space, icc, name)
            }
        };
        Ok(Self {
            kind,
            space,
            sixteen,
            adjustments: pp.adjustments.clone(),
            ink_limit: pp.ink_limit,
            icc,
            profile_name: name,
        })
    }

    /// Adjust (in place) and convert one card / page bitmap.
    pub fn convert(&self, img: &mut Rgb16) -> Pixels {
        apply_adjustments(img, &self.adjustments);
        let px: &[[u16; 3]] = as_rgb_pixels(&img.data);
        let n = px.len();
        let mut out = match &self.kind {
            Kind::Identity => {
                if self.sixteen {
                    Pixels::Rgb16(img.data.clone())
                } else {
                    Pixels::Rgb8(img.data.iter().map(|v| ((*v as u32 + 128) / 257).min(255) as u8).collect())
                }
            }
            Kind::Rgb8(t) => {
                let mut o = vec![[0u8; 3]; n];
                t.transform_pixels(px, &mut o);
                Pixels::Rgb8(o.into_iter().flatten().collect())
            }
            Kind::Rgb16(t) => {
                let mut o = vec![[0u16; 3]; n];
                t.transform_pixels(px, &mut o);
                Pixels::Rgb16(o.into_iter().flatten().collect())
            }
            Kind::Cmyk8(t) => {
                let mut o = vec![[0u8; 4]; n];
                t.transform_pixels(px, &mut o);
                Pixels::Cmyk8(o.into_iter().flatten().collect())
            }
            Kind::Cmyk16(t) => {
                let mut o = vec![[0u16; 4]; n];
                t.transform_pixels(px, &mut o);
                Pixels::Cmyk16(o.into_iter().flatten().collect())
            }
            Kind::Naive => {
                let v: Vec<u16> = px.par_iter().flat_map_iter(|p| naive_cmyk(*p)).collect();
                if self.sixteen {
                    Pixels::Cmyk16(v)
                } else {
                    Pixels::Cmyk8(v.iter().map(|x| (x >> 8) as u8).collect())
                }
            }
        };
        if self.space == OutputColorSpace::Cmyk && self.ink_limit < 399.0 {
            limit_ink(&mut out, self.ink_limit / 100.0);
        }
        out
    }
}

fn as_rgb_pixels(v: &[u16]) -> &[[u16; 3]] {
    // SAFETY: [u16; 3] has the same layout as three consecutive u16 and alignment of u16.
    let n = v.len() / 3;
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const [u16; 3], n) }
}

/// Simple UCR/GCR conversion used when no CMYK ICC profile is available.
pub fn naive_cmyk(p: [u16; 3]) -> [u16; 4] {
    let r = p[0] as f32 / 65535.0;
    let g = p[1] as f32 / 65535.0;
    let b = p[2] as f32 / 65535.0;
    let k = 1.0 - r.max(g).max(b);
    if k >= 0.9999 {
        return [0, 0, 0, 65535];
    }
    let c = (1.0 - r - k) / (1.0 - k);
    let m = (1.0 - g - k) / (1.0 - k);
    let y = (1.0 - b - k) / (1.0 - k);
    let to = |v: f32| (v.clamp(0.0, 1.0) * 65535.0) as u16;
    [to(c), to(m), to(y), to(k)]
}

fn limit_ink(px: &mut Pixels, limit: f32) {
    fn apply<T: Copy + Into<f32>>(v: &mut [T], max: f32, from: impl Fn(f32) -> T, limit: f32) {
        for p in v.chunks_exact_mut(4) {
            let c: f32 = p[0].into() / max;
            let m: f32 = p[1].into() / max;
            let y: f32 = p[2].into() / max;
            let k: f32 = p[3].into() / max;
            let total = c + m + y + k;
            if total > limit {
                // keep black, scale chromatic inks
                let room = (limit - k).max(0.0);
                let cmy = c + m + y;
                let f = if cmy > 0.0 { (room / cmy).min(1.0) } else { 1.0 };
                p[0] = from(c * f * max);
                p[1] = from(m * f * max);
                p[2] = from(y * f * max);
            }
        }
    }
    match px {
        Pixels::Cmyk8(v) => apply(v, 255.0, |x| x.round() as u8, limit),
        Pixels::Cmyk16(v) => apply(v, 65535.0, |x| x.round() as u16, limit),
        _ => {}
    }
}

/// Soft-proof an 8-bit sRGB preview in place: simulate how it prints on `pp`.
pub fn soft_proof(rgb: &mut [u8], pp: &PrintProfile, icc_dir: &Path, gamut_warning: bool) -> AppResult<()> {
    let proof = load_profile(&pp.output_icc, icc_dir)?;
    let srgb = Profile::new_srgb();
    match proof {
        Some(p) => {
            let mut flags = Flags::SOFT_PROOFING;
            if gamut_warning {
                flags = flags | Flags::GAMUT_CHECK;
            }
            if pp.black_point_compensation {
                flags = flags | Flags::BLACKPOINT_COMPENSATION;
            }
            let t: Transform<[u8; 3], [u8; 3]> = Transform::new_proofing(
                &srgb,
                PixelFormat::RGB_8,
                &srgb,
                PixelFormat::RGB_8,
                &p,
                Intent::RelativeColorimetric,
                intent(pp.intent),
                flags,
            )?;
            let n = rgb.len() / 3;
            // SAFETY: same layout argument as `as_rgb_pixels`.
            let px = unsafe { std::slice::from_raw_parts_mut(rgb.as_mut_ptr() as *mut [u8; 3], n) };
            t.transform_in_place(px);
        }
        None => {
            // Naive CMYK round trip is lossless except clipping; simulate paper by slight
            // contrast reduction so the preview is not misleading.
            for v in rgb.iter_mut() {
                *v = (20.0 + *v as f32 * (235.0 / 255.0)) as u8;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_adjustments_do_nothing() {
        let mut img = Rgb16::new(2, 2);
        img.data = vec![1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10, 20, 30];
        let before = img.data.clone();
        apply_adjustments(&mut img, &Adjustments::default());
        assert_eq!(img.data, before);
    }

    #[test]
    fn brightness_raises_values() {
        let mut img = Rgb16::new(1, 1);
        img.data = vec![30000, 30000, 30000];
        let a = Adjustments { brightness: 0.2, ..Default::default() };
        apply_adjustments(&mut img, &a);
        assert!(img.data[0] > 30000);
    }

    #[test]
    fn desaturate_makes_grey() {
        let mut img = Rgb16::new(1, 1);
        img.data = vec![60000, 10000, 10000];
        let a = Adjustments { saturation: -1.0, ..Default::default() };
        apply_adjustments(&mut img, &a);
        assert!((img.data[0] as i32 - img.data[1] as i32).abs() < 2);
    }

    #[test]
    fn curve_through_identity_points() {
        let c = vec![[0.0, 0.0], [0.5, 0.5], [1.0, 1.0]];
        for x in [0.1, 0.3, 0.77] {
            assert!((eval_curve(&c, x) - x).abs() < 1e-3);
        }
        let s = vec![[0.0, 0.0], [0.25, 0.15], [0.75, 0.85], [1.0, 1.0]];
        assert!(eval_curve(&s, 0.25) < 0.2);
    }

    #[test]
    fn naive_cmyk_primaries() {
        assert_eq!(naive_cmyk([0, 0, 0]), [0, 0, 0, 65535]);
        assert_eq!(naive_cmyk([65535, 65535, 65535]), [0, 0, 0, 0]);
        let red = naive_cmyk([65535, 0, 0]);
        assert_eq!(red[0], 0);
        assert_eq!(red[1], 65535);
    }

    #[test]
    fn ink_limit_caps_total() {
        let mut p = Pixels::Cmyk8(vec![255, 255, 255, 255]);
        limit_ink(&mut p, 3.0);
        if let Pixels::Cmyk8(v) = p {
            let total: u32 = v.iter().map(|x| *x as u32).sum();
            assert!(total <= 3 * 255 + 2, "{total}");
            assert_eq!(v[3], 255);
        }
    }

    #[test]
    fn pipeline_srgb_to_p3_changes_saturated_red() {
        let dir = std::env::temp_dir();
        let pp = PrintProfile { output_icc: P3.into(), ..Default::default() };
        let pipe = ColorPipeline::new(&pp, &dir, false).unwrap();
        let mut img = Rgb16::new(1, 1);
        img.data = vec![65535, 0, 0];
        match pipe.convert(&mut img) {
            Pixels::Rgb8(v) => assert!(v[0] < 255 || v[1] > 0, "{v:?}"),
            _ => panic!("expected rgb8"),
        }
        assert!(pipe.icc.is_some());
    }

    #[test]
    fn naive_pipeline_outputs_cmyk() {
        let dir = std::env::temp_dir();
        let pp = PrintProfile { output_icc: NAIVE_CMYK.into(), output_space: OutputColorSpace::Cmyk, ..Default::default() };
        let pipe = ColorPipeline::new(&pp, &dir, false).unwrap();
        let mut img = Rgb16::new(1, 1);
        img.data = vec![0, 0, 0];
        match pipe.convert(&mut img) {
            Pixels::Cmyk8(v) => assert_eq!(v, vec![0, 0, 0, 255]),
            _ => panic!(),
        }
    }

    #[test]
    fn soft_proof_runs() {
        let dir = std::env::temp_dir();
        let pp = PrintProfile { output_icc: ADOBE.into(), ..Default::default() };
        let mut px = vec![200u8, 30, 30, 10, 200, 10];
        soft_proof(&mut px, &pp, &dir, false).unwrap();
    }
}
