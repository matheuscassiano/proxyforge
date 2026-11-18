//! Page geometry: where every card, cut mark and registration mark goes, in millimetres.
//! Origin is the top-left corner of the page, y grows downward.

use serde::Serialize;

use crate::model::{CardGuideStyle, DuplexFlip, GuideCorner, GuidePlacement, LayoutSettings, Orientation, PageGuideStyle, SizeMm};

pub const MM_PER_INCH: f32 = 25.4;
pub const PT_PER_MM: f32 = 72.0 / MM_PER_INCH;

pub fn mm_to_px(mm: f32, dpi: u32) -> u32 {
    (mm / MM_PER_INCH * dpi as f32).round().max(1.0) as u32
}

pub fn px_to_mm(px: u32, dpi: u32) -> f32 {
    px as f32 / dpi as f32 * MM_PER_INCH
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RectMm {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl RectMm {
    pub fn right(&self) -> f32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }
}

/// A guide stroke: an open polyline in mm (arcs are flattened).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidePath {
    pub pts: Vec<[f32; 2]>,
    /// Hidden where it crosses artwork unless guides are drawn over the art.
    pub clipped: bool,
}

impl GuidePath {
    fn line(x1: f32, y1: f32, x2: f32, y2: f32, clipped: bool) -> Self {
        GuidePath { pts: vec![[x1, y1], [x2, y2]], clipped }
    }
}

/// One position on the sheet.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    /// Trim box: the final card after cutting.
    pub card: RectMm,
    /// Card + bleed. This is the area covered by artwork.
    pub art: RectMm,
    pub row: u32,
    pub col: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grid {
    pub page: SizeMm,
    pub columns: u32,
    pub rows: u32,
    pub slots: Vec<Slot>,
    pub guides: Vec<GuidePath>,
    /// Filled rectangles (registration marks), in mm.
    pub reg_marks: Vec<RectMm>,
    /// Bounding box of all art, useful for the UI.
    pub content: RectMm,
}

impl Grid {
    pub fn per_page(&self) -> usize {
        self.slots.len()
    }
}

/// Page size after orientation is applied.
pub fn oriented_page(s: &LayoutSettings) -> SizeMm {
    let (a, b) = (s.page_size.width, s.page_size.height);
    let (short, long) = if a <= b { (a, b) } else { (b, a) };
    match s.orientation {
        Orientation::Portrait => SizeMm { width: short, height: long },
        Orientation::Landscape => SizeMm { width: long, height: short },
    }
}

/// Area that must stay free of artwork when registration marks are enabled (mm from the edge).
pub fn reg_clear(s: &LayoutSettings) -> f32 {
    let r = &s.registration;
    r.inset_mm.max(0.0) + r.square_mm.max(r.thickness_mm).max(0.0) + 3.0
}

/// Compute the grid for the front side.
pub fn compute_grid(s: &LayoutSettings) -> Grid {
    let page = oriented_page(s);
    let bleed = s.bleed_mm.max(0.0);
    let cw = s.card_size.width.max(1.0);
    let ch = s.card_size.height.max(1.0);
    // Cell = card + bleed on both sides. With zero spacing, neighbouring bleeds would
    // overlap the neighbour's trim area, so the effective pitch always includes bleed.
    let cell_w = cw + 2.0 * bleed;
    let cell_h = ch + 2.0 * bleed;

    let mut m = s.margins;
    if s.registration_marks {
        let clear = reg_clear(s);
        m.top = m.top.max(clear);
        m.left = m.left.max(clear);
        m.bottom = m.bottom.max(clear);
        m.right = m.right.max(clear);
    }
    let avail_w = (page.width - m.left - m.right).max(0.0);
    let avail_h = (page.height - m.top - m.bottom).max(0.0);
    let sx = s.spacing_x_mm.max(0.0);
    let sy = s.spacing_y_mm.max(0.0);

    let fit = |avail: f32, cell: f32, gap: f32| -> u32 {
        if avail < cell {
            0
        } else {
            (((avail + gap) / (cell + gap)) + 1e-4).floor() as u32
        }
    };
    let auto_cols = fit(avail_w, cell_w, sx);
    let auto_rows = fit(avail_h, cell_h, sy);
    let columns = if s.columns > 0 { s.columns.min(auto_cols.max(1)) } else { auto_cols };
    let rows = if s.rows > 0 { s.rows.min(auto_rows.max(1)) } else { auto_rows };

    let used_w = columns as f32 * cell_w + columns.saturating_sub(1) as f32 * sx;
    let used_h = rows as f32 * cell_h + rows.saturating_sub(1) as f32 * sy;
    let (ox, oy) = if s.center {
        (m.left + (avail_w - used_w) / 2.0, m.top + (avail_h - used_h) / 2.0)
    } else {
        (m.left, m.top)
    };

    let mut slots = Vec::with_capacity((columns * rows) as usize);
    for r in 0..rows {
        for c in 0..columns {
            let ax = ox + c as f32 * (cell_w + sx);
            let ay = oy + r as f32 * (cell_h + sy);
            slots.push(Slot {
                art: RectMm { x: ax, y: ay, w: cell_w, h: cell_h },
                card: RectMm { x: ax + bleed, y: ay + bleed, w: cw, h: ch },
                row: r,
                col: c,
            });
        }
    }
    let content = RectMm { x: ox, y: oy, w: used_w, h: used_h };
    let guides = cut_guides(s, page, &slots, Face::Front);
    let reg_marks = if s.registration_marks { registration_marks(s, page) } else { vec![] };
    Grid { page, columns, rows, slots, guides, reg_marks, content }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Face {
    Front,
    Back,
}

/// Mirror the grid for the back side so each back lands behind its front after flipping.
pub fn mirror_for_back(g: &Grid, s: &LayoutSettings) -> Grid {
    let (flip, offset_x, offset_y) = (s.duplex.flip, s.duplex.offset_x_mm, s.duplex.offset_y_mm);
    let pw = g.page.width;
    let ph = g.page.height;
    let mirror = |r: RectMm| -> RectMm {
        match flip {
            DuplexFlip::LongEdge => RectMm { x: pw - r.x - r.w + offset_x, y: r.y + offset_y, ..r },
            DuplexFlip::ShortEdge => RectMm { x: r.x + offset_x, y: ph - r.y - r.h + offset_y, ..r },
        }
    };
    let slots: Vec<Slot> = g.slots.iter().map(|sl| Slot { card: mirror(sl.card), art: mirror(sl.art), row: sl.row, col: sl.col }).collect();
    Grid {
        page: g.page,
        columns: g.columns,
        rows: g.rows,
        guides: cut_guides(s, g.page, &slots, Face::Back),
        slots,
        // the cutter reads the front only
        reg_marks: vec![],
        content: mirror(g.content),
    }
}

/// Points of a quarter arc around (cx, cy), from angle a0 to a0 + 90° (radians, y down).
fn arc(cx: f32, cy: f32, r: f32, a0: f32, out: &mut Vec<[f32; 2]>) {
    const STEPS: usize = 8;
    for i in 0..=STEPS {
        let a = a0 + std::f32::consts::FRAC_PI_2 * i as f32 / STEPS as f32;
        out.push([cx + r * a.cos(), cy + r * a.sin()]);
    }
}

/// Closed trim outline of a card, with rounded corners when `r > 0`.
fn outline(c: RectMm, r: f32) -> Vec<[f32; 2]> {
    let r = r.min(c.w / 2.0).min(c.h / 2.0).max(0.0);
    let (x0, y0, x1, y1) = (c.x, c.y, c.right(), c.bottom());
    if r <= 0.0 {
        return vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    }
    use std::f32::consts::PI;
    let mut p = vec![];
    arc(x0 + r, y0 + r, r, PI, &mut p);
    arc(x1 - r, y0 + r, r, 1.5 * PI, &mut p);
    arc(x1 - r, y1 - r, r, 0.0, &mut p);
    arc(x0 + r, y1 - r, r, 0.5 * PI, &mut p);
    p.push(p[0]);
    p
}

fn cut_guides(s: &LayoutSettings, page: SizeMm, slots: &[Slot], face: Face) -> Vec<GuidePath> {
    let mut out = Vec::new();
    if slots.is_empty() {
        return out;
    }
    let g = &s.cut_guides;
    let (mut page_style, mut card_style) = g.styles();
    let (show_card, show_page) = match face {
        Face::Front => (g.faces.card_front, g.faces.page_front),
        Face::Back => (g.faces.card_back, g.faces.page_back),
    };
    if !show_page {
        page_style = PageGuideStyle::None;
    }
    if !show_card {
        card_style = CardGuideStyle::None;
    }
    let len = g.length_mm.max(0.5);
    let gap = g.offset_mm.max(0.0);
    // Unique x/y cut positions (card edges).
    let mut xs: Vec<f32> = slots.iter().flat_map(|sl| [sl.card.x, sl.card.right()]).collect();
    let mut ys: Vec<f32> = slots.iter().flat_map(|sl| [sl.card.y, sl.card.bottom()]).collect();
    dedup_sorted(&mut xs);
    dedup_sorted(&mut ys);
    let top = slots.iter().map(|s| s.art.y).fold(f32::MAX, f32::min);
    let bottom = slots.iter().map(|s| s.art.bottom()).fold(f32::MIN, f32::max);
    let left = slots.iter().map(|s| s.art.x).fold(f32::MAX, f32::min);
    let right = slots.iter().map(|s| s.art.right()).fold(f32::MIN, f32::max);

    match page_style {
        PageGuideStyle::None => {}
        PageGuideStyle::Crop => {
            for &x in &xs {
                if top - gap > 0.0 {
                    out.push(GuidePath::line(x, (top - gap - len).max(0.0), x, top - gap, true));
                }
                if bottom + gap < page.height {
                    out.push(GuidePath::line(x, bottom + gap, x, (bottom + gap + len).min(page.height), true));
                }
            }
            for &y in &ys {
                if left - gap > 0.0 {
                    out.push(GuidePath::line((left - gap - len).max(0.0), y, left - gap, y, true));
                }
                if right + gap < page.width {
                    out.push(GuidePath::line(right + gap, y, (right + gap + len).min(page.width), y, true));
                }
            }
        }
        PageGuideStyle::Full => {
            for &x in &xs {
                out.push(GuidePath::line(x, 0.0, x, page.height, true));
            }
            for &y in &ys {
                out.push(GuidePath::line(0.0, y, page.width, y, true));
            }
        }
    }

    let radius = if g.corner == GuideCorner::Round { s.corner_radius_mm.max(0.0) } else { 0.0 };
    match card_style {
        CardGuideStyle::None => {}
        CardGuideStyle::Outline => {
            for sl in slots {
                out.push(GuidePath { pts: outline(sl.card, radius), clipped: false });
            }
        }
        CardGuideStyle::Corners => {
            for sl in slots {
                corner_marks(&mut out, sl.card, len, gap, g.placement, radius);
            }
        }
    }
    out
}

fn corner_marks(out: &mut Vec<GuidePath>, c: RectMm, len: f32, gap: f32, placement: GuidePlacement, radius: f32) {
    use std::f32::consts::PI;
    let (x0, y0, x1, y1) = (c.x, c.y, c.right(), c.bottom());
    // (corner x, corner y, direction into the card on x, on y, arc start angle)
    for (cx, cy, dx, dy, a0) in [(x0, y0, 1.0, 1.0, PI), (x1, y0, -1.0, 1.0, 1.5 * PI), (x1, y1, -1.0, -1.0, 0.0), (x0, y1, 1.0, -1.0, 0.5 * PI)] {
        match placement {
            GuidePlacement::Inside => {
                let r = radius.min(len * 0.9);
                if r > 0.0 {
                    // leg along y, quarter arc of the card's rounded corner, leg along x
                    let mut pts = vec![[cx, cy + dy * len]];
                    let mut a = vec![];
                    arc(cx + dx * r, cy + dy * r, r, a0, &mut a);
                    // arc() runs clockwise from a0; orient it from the y-leg to the x-leg
                    if (a[0][1] - (cy + dy * r)).abs() > 1e-3 {
                        a.reverse();
                    }
                    pts.extend(a);
                    pts.push([cx + dx * len, cy]);
                    out.push(GuidePath { pts, clipped: false });
                } else {
                    out.push(GuidePath { pts: vec![[cx, cy + dy * len], [cx, cy], [cx + dx * len, cy]], clipped: false });
                }
            }
            GuidePlacement::Outside => {
                // continue both trim lines away from the card
                out.push(GuidePath::line(cx, cy - dy * gap, cx, cy - dy * (gap + len), true));
                out.push(GuidePath::line(cx - dx * gap, cy, cx - dx * (gap + len), cy, true));
            }
            GuidePlacement::Centered => {
                let h = len / 2.0;
                out.push(GuidePath::line(cx, cy - h, cx, cy + h, false));
                out.push(GuidePath::line(cx - h, cy, cx + h, cy, false));
            }
        }
    }
}

fn dedup_sorted(v: &mut Vec<f32>) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v.dedup_by(|a, b| (*a - *b).abs() < 0.01);
}

/// Silhouette Studio "Type 1" marks: filled square top-left, L-shapes top-right and bottom-left.
pub fn registration_marks(s: &LayoutSettings, page: SizeMm) -> Vec<RectMm> {
    let r = &s.registration;
    let (i, sq, leg, t) = (r.inset_mm.max(0.0), r.square_mm.max(0.5), r.length_mm.max(1.0), r.thickness_mm.max(0.1));
    let (w, h) = (page.width, page.height);
    vec![
        RectMm { x: i, y: i, w: sq, h: sq },
        // top-right L
        RectMm { x: w - i - leg, y: i, w: leg, h: t },
        RectMm { x: w - i - t, y: i, w: t, h: leg },
        // bottom-left L
        RectMm { x: i, y: h - i - t, w: leg, h: t },
        RectMm { x: i, y: h - i - leg, w: t, h: leg },
    ]
}

/// Expand a deck into a flat list of card instances (index into `cards`).
pub fn expand_instances(qtys: &[u32]) -> Vec<usize> {
    qtys.iter().enumerate().flat_map(|(i, q)| std::iter::repeat_n(i, *q as usize)).collect()
}

pub fn page_count(instances: usize, per_page: usize) -> usize {
    if per_page == 0 { 0 } else { instances.div_ceil(per_page) }
}

/// Card and page presets offered by the UI.
pub fn card_presets() -> Vec<(&'static str, &'static str, f32, f32)> {
    vec![
        ("standard", "Standard (MTG, Pokémon, FaB, Lorcana, SWU, One Piece)", 63.0, 88.0),
        ("japanese", "Japanese / Yu-Gi-Oh!", 59.0, 86.0),
        ("mini", "Mini American", 41.0, 63.0),
        ("mini-euro", "Mini Euro", 44.0, 68.0),
        ("tarot", "Tarot", 70.0, 120.0),
        ("square", "Square", 70.0, 70.0),
        ("oversized", "Oversized / Planechase", 88.9, 127.0),
    ]
}

pub fn page_presets() -> Vec<(&'static str, &'static str, f32, f32)> {
    vec![
        ("letter", "Letter", 215.9, 279.4),
        ("legal", "Legal", 215.9, 355.6),
        ("tabloid", "Tabloid", 279.4, 431.8),
        ("a4", "A4", 210.0, 297.0),
        ("a3", "A3", 297.0, 420.0),
        ("a3plus", "A3+ / Super B", 329.0, 483.0),
        ("cardstock-12x12", "12 × 12 in (Cricut)", 304.8, 304.8),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn letter() -> LayoutSettings {
        LayoutSettings::default()
    }

    #[test]
    fn unit_conversion() {
        assert_eq!(mm_to_px(25.4, 300), 300);
        assert_eq!(mm_to_px(63.0, 1200), 2976);
        assert!((px_to_mm(300, 300) - 25.4).abs() < 1e-4);
    }

    #[test]
    fn letter_fits_three_by_three_standard_cards() {
        let g = compute_grid(&letter());
        assert_eq!((g.columns, g.rows), (3, 3));
        assert_eq!(g.per_page(), 9);
        // centred: left gap == right gap
        let l = g.content.x;
        let r = g.page.width - g.content.right();
        assert!((l - r).abs() < 0.01);
    }

    #[test]
    fn a4_landscape_fits_four_by_two() {
        let mut s = letter();
        s.page_size = SizeMm { width: 210.0, height: 297.0 };
        s.orientation = Orientation::Landscape;
        s.bleed_mm = 0.0;
        let g = compute_grid(&s);
        assert_eq!(g.page.width, 297.0);
        assert_eq!((g.columns, g.rows), (4, 2));
    }

    #[test]
    fn bleed_reduces_capacity_when_tight() {
        let mut s = letter();
        s.bleed_mm = 3.0;
        // rows: 3 * (88 + 6) = 282 > 279.4 - 8 -> only 2 rows
        let g = compute_grid(&s);
        assert_eq!((g.columns, g.rows), (3, 2));
        assert!(g.slots.iter().all(|sl| (sl.art.w - 69.0).abs() < 1e-4));
    }

    #[test]
    fn trim_box_is_inside_art_box() {
        let g = compute_grid(&letter());
        for s in &g.slots {
            assert!(s.card.x > s.art.x && s.card.right() < s.art.right());
            assert!((s.card.w - 63.0).abs() < 1e-4);
        }
    }

    #[test]
    fn manual_columns_are_capped_to_fit() {
        let mut s = letter();
        s.columns = 10;
        let g = compute_grid(&s);
        assert_eq!(g.columns, 3);
    }

    #[test]
    fn long_edge_duplex_mirrors_columns() {
        let g = compute_grid(&letter());
        let b = mirror_for_back(&g, &letter());
        // front col 0 must land at the same place as back col 0 seen through the paper
        let f0 = g.slots[0].card;
        let b0 = b.slots[0].card;
        assert!((f0.x + b0.right() - g.page.width).abs() < 1e-3);
        assert!((f0.y - b0.y).abs() < 1e-3);
    }

    #[test]
    fn short_edge_duplex_mirrors_rows() {
        let g = compute_grid(&letter());
        let mut s = letter();
        s.duplex.flip = DuplexFlip::ShortEdge;
        s.duplex.offset_x_mm = 0.5;
        let b = mirror_for_back(&g, &s);
        let f0 = g.slots[0].card;
        let b0 = b.slots[0].card;
        assert!((f0.y + b0.bottom() - g.page.height).abs() < 1e-3);
        assert!((b0.x - (f0.x + 0.5)).abs() < 1e-3);
    }

    #[test]
    fn crop_marks_stay_outside_art() {
        let g = compute_grid(&letter());
        assert!(!g.guides.is_empty());
        for l in &g.guides {
            let inside = g.slots.iter().any(|s| {
                let mx = (l.pts[0][0] + l.pts[1][0]) / 2.0;
                let my = (l.pts[0][1] + l.pts[1][1]) / 2.0;
                mx > s.art.x + 0.01 && mx < s.art.right() - 0.01 && my > s.art.y + 0.01 && my < s.art.bottom() - 0.01
            });
            assert!(!inside, "crop mark {l:?} overlaps art");
        }
    }

    #[test]
    fn registration_marks_force_clear_margins() {
        let mut s = letter();
        s.registration_marks = true;
        let g = compute_grid(&s);
        assert_eq!(g.reg_marks.len(), 5);
        assert!(g.content.x >= reg_clear(&s) - 1e-3);
        assert!(g.content.y >= reg_clear(&s) - 1e-3);
        s.registration.inset_mm = 5.0;
        s.registration.length_mm = 8.9;
        let g = compute_grid(&s);
        assert!((g.reg_marks[1].w - 8.9).abs() < 1e-4);
        assert!((g.reg_marks[0].x - 5.0).abs() < 1e-4);
    }

    #[test]
    fn legacy_styles_map_to_page_and_card_guides() {
        let mut s = letter();
        s.cut_guides.page_style = None;
        s.cut_guides.card_style = None;
        s.cut_guides.style = CutGuideStyle::Corners;
        assert_eq!(s.cut_guides.styles(), (PageGuideStyle::None, CardGuideStyle::Corners));
        s.cut_guides.style = CutGuideStyle::Lines;
        assert_eq!(s.cut_guides.styles(), (PageGuideStyle::Full, CardGuideStyle::None));
        // old JSON without the new fields still loads
        let mut v = serde_json::to_value(&s).unwrap();
        let cg = v["cutGuides"].as_object_mut().unwrap();
        for k in ["pageStyle", "cardStyle", "placement", "corner", "dashed", "offsetMm", "faces"] {
            cg.remove(k);
        }
        v.as_object_mut().unwrap().remove("registration");
        let back: LayoutSettings = serde_json::from_value(v).unwrap();
        assert_eq!(back.cut_guides.offset_mm, 1.0);
        assert!(back.cut_guides.faces.card_front && !back.cut_guides.faces.card_back);
        assert_eq!(back.registration, RegistrationMarks::default());
    }

    #[test]
    fn card_guides_follow_style_placement_and_corner() {
        let mut s = letter();
        s.cut_guides.page_style = Some(PageGuideStyle::None);
        s.cut_guides.card_style = Some(CardGuideStyle::Corners);
        let g = compute_grid(&s);
        assert_eq!(g.guides.len(), 9 * 4);
        assert!(g.guides.iter().all(|p| p.pts.len() == 3 && !p.clipped));
        s.cut_guides.corner = GuideCorner::Round;
        let g = compute_grid(&s);
        assert!(g.guides[0].pts.len() > 3, "round corners are flattened arcs");
        // first point on the y-leg, last on the x-leg, both on the trim lines
        let c = g.slots[0].card;
        let p = &g.guides[0].pts;
        assert!((p[0][0] - c.x).abs() < 1e-3 && (p.last().unwrap()[1] - c.y).abs() < 1e-3);
        s.cut_guides.placement = GuidePlacement::Outside;
        let g = compute_grid(&s);
        assert_eq!(g.guides.len(), 9 * 8);
        assert!(g.guides.iter().all(|p| p.clipped));
        s.cut_guides.card_style = Some(CardGuideStyle::Outline);
        let g = compute_grid(&s);
        assert_eq!(g.guides.len(), 9);
        assert_eq!(g.guides[0].pts.first(), g.guides[0].pts.last());
    }

    #[test]
    fn faces_choose_guides_on_backs() {
        let mut s = letter();
        let g = compute_grid(&s);
        assert!(mirror_for_back(&g, &s).guides.is_empty());
        s.cut_guides.faces.page_back = true;
        assert!(!mirror_for_back(&g, &s).guides.is_empty());
        s.cut_guides.faces.page_front = false;
        assert!(compute_grid(&s).guides.is_empty());
    }

    #[test]
    fn instances_and_pages() {
        let inst = expand_instances(&[4, 0, 2]);
        assert_eq!(inst, vec![0, 0, 0, 0, 2, 2]);
        assert_eq!(page_count(19, 9), 3);
        assert_eq!(page_count(0, 9), 0);
    }
}
