//! Page geometry: where every card, cut mark and registration mark goes, in millimetres.
//! Origin is the top-left corner of the page, y grows downward.

use serde::Serialize;

use crate::model::{CutGuideStyle, DuplexFlip, LayoutSettings, Orientation, SizeMm};

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

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMm {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
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
    pub cut_lines: Vec<LineMm>,
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

/// Silhouette "Type 1" registration marks need these clear zones (mm from the page edge).
pub const REG_INSET: f32 = 10.0;
pub const REG_SQUARE: f32 = 5.0;
pub const REG_LEG: f32 = 20.0;
pub const REG_THICK: f32 = 1.0;
/// Area that must stay free of artwork when registration marks are enabled.
const REG_CLEAR: f32 = REG_INSET + REG_SQUARE + 3.0;

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
        m.top = m.top.max(REG_CLEAR);
        m.left = m.left.max(REG_CLEAR);
        m.bottom = m.bottom.max(REG_CLEAR);
        m.right = m.right.max(REG_CLEAR);
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
    let cut_lines = cut_guides(s, page, &slots, columns, rows);
    let reg_marks = if s.registration_marks { registration_marks(page) } else { vec![] };
    Grid { page, columns, rows, slots, cut_lines, reg_marks, content }
}

/// Mirror the grid for the back side so each back lands behind its front after flipping.
pub fn mirror_for_back(g: &Grid, flip: DuplexFlip, offset_x: f32, offset_y: f32) -> Grid {
    let pw = g.page.width;
    let ph = g.page.height;
    let mirror = |r: RectMm| -> RectMm {
        match flip {
            DuplexFlip::LongEdge => RectMm { x: pw - r.x - r.w + offset_x, y: r.y + offset_y, ..r },
            DuplexFlip::ShortEdge => RectMm { x: r.x + offset_x, y: ph - r.y - r.h + offset_y, ..r },
        }
    };
    Grid {
        page: g.page,
        columns: g.columns,
        rows: g.rows,
        slots: g
            .slots
            .iter()
            .map(|s| Slot { card: mirror(s.card), art: mirror(s.art), row: s.row, col: s.col })
            .collect(),
        // Guides are only useful on the front; registration marks too (the cutter reads the front).
        cut_lines: vec![],
        reg_marks: vec![],
        content: mirror(g.content),
    }
}

fn cut_guides(s: &LayoutSettings, page: SizeMm, slots: &[Slot], cols: u32, rows: u32) -> Vec<LineMm> {
    let mut out = Vec::new();
    if slots.is_empty() {
        return out;
    }
    let len = s.cut_guides.length_mm.max(0.5);
    let gap = 1.0_f32; // distance kept between a crop mark and the art
    // Unique x/y cut positions (card edges).
    let mut xs: Vec<f32> = slots.iter().flat_map(|sl| [sl.card.x, sl.card.right()]).collect();
    let mut ys: Vec<f32> = slots.iter().flat_map(|sl| [sl.card.y, sl.card.bottom()]).collect();
    dedup_sorted(&mut xs);
    dedup_sorted(&mut ys);
    let top = slots.iter().map(|s| s.art.y).fold(f32::MAX, f32::min);
    let bottom = slots.iter().map(|s| s.art.bottom()).fold(f32::MIN, f32::max);
    let left = slots.iter().map(|s| s.art.x).fold(f32::MAX, f32::min);
    let right = slots.iter().map(|s| s.art.right()).fold(f32::MIN, f32::max);

    match s.cut_guides.style {
        CutGuideStyle::None => {}
        CutGuideStyle::Crop => {
            for &x in &xs {
                out.push(LineMm { x1: x, y1: (top - gap - len).max(0.0), x2: x, y2: top - gap });
                out.push(LineMm { x1: x, y1: bottom + gap, x2: x, y2: (bottom + gap + len).min(page.height) });
            }
            for &y in &ys {
                out.push(LineMm { x1: (left - gap - len).max(0.0), y1: y, x2: left - gap, y2: y });
                out.push(LineMm { x1: right + gap, y1: y, x2: (right + gap + len).min(page.width), y2: y });
            }
            // Inner gutters: when there is spacing, add short marks between cards too.
            if s.spacing_x_mm > 0.0 || s.spacing_y_mm > 0.0 || s.guides_over_art {
                for sl in slots {
                    corner_marks(&mut out, sl.card, len.min(3.0));
                }
            }
        }
        CutGuideStyle::Lines => {
            for &x in &xs {
                out.push(LineMm { x1: x, y1: 0.0, x2: x, y2: page.height });
            }
            for &y in &ys {
                out.push(LineMm { x1: 0.0, y1: y, x2: page.width, y2: y });
            }
        }
        CutGuideStyle::Corners => {
            for sl in slots {
                corner_marks(&mut out, sl.card, len.min(4.0));
            }
        }
    }
    let _ = (cols, rows);
    out
}

fn corner_marks(out: &mut Vec<LineMm>, r: RectMm, l: f32) {
    let (x0, y0, x1, y1) = (r.x, r.y, r.right(), r.bottom());
    for (cx, cy, dx, dy) in [(x0, y0, 1.0, 1.0), (x1, y0, -1.0, 1.0), (x0, y1, 1.0, -1.0), (x1, y1, -1.0, -1.0)] {
        out.push(LineMm { x1: cx, y1: cy, x2: cx + dx * l, y2: cy });
        out.push(LineMm { x1: cx, y1: cy, x2: cx, y2: cy + dy * l });
    }
}

fn dedup_sorted(v: &mut Vec<f32>) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v.dedup_by(|a, b| (*a - *b).abs() < 0.01);
}

/// Silhouette Studio "Type 1" marks: filled square top-left, L-shapes top-right and bottom-left.
pub fn registration_marks(page: SizeMm) -> Vec<RectMm> {
    let i = REG_INSET;
    let (w, h) = (page.width, page.height);
    vec![
        RectMm { x: i, y: i, w: REG_SQUARE, h: REG_SQUARE },
        // top-right L
        RectMm { x: w - i - REG_LEG, y: i, w: REG_LEG, h: REG_THICK },
        RectMm { x: w - i - REG_THICK, y: i, w: REG_THICK, h: REG_LEG },
        // bottom-left L
        RectMm { x: i, y: h - i - REG_THICK, w: REG_LEG, h: REG_THICK },
        RectMm { x: i, y: h - i - REG_LEG, w: REG_THICK, h: REG_LEG },
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
        let b = mirror_for_back(&g, DuplexFlip::LongEdge, 0.0, 0.0);
        // front col 0 must land at the same place as back col 0 seen through the paper
        let f0 = g.slots[0].card;
        let b0 = b.slots[0].card;
        assert!((f0.x + b0.right() - g.page.width).abs() < 1e-3);
        assert!((f0.y - b0.y).abs() < 1e-3);
    }

    #[test]
    fn short_edge_duplex_mirrors_rows() {
        let g = compute_grid(&letter());
        let b = mirror_for_back(&g, DuplexFlip::ShortEdge, 0.5, 0.0);
        let f0 = g.slots[0].card;
        let b0 = b.slots[0].card;
        assert!((f0.y + b0.bottom() - g.page.height).abs() < 1e-3);
        assert!((b0.x - (f0.x + 0.5)).abs() < 1e-3);
    }

    #[test]
    fn crop_marks_stay_outside_art() {
        let g = compute_grid(&letter());
        assert!(!g.cut_lines.is_empty());
        for l in &g.cut_lines {
            let inside = g.slots.iter().any(|s| {
                let mx = (l.x1 + l.x2) / 2.0;
                let my = (l.y1 + l.y2) / 2.0;
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
        assert!(g.content.x >= REG_CLEAR - 1e-3);
        assert!(g.content.y >= REG_CLEAR - 1e-3);
    }

    #[test]
    fn instances_and_pages() {
        let inst = expand_instances(&[4, 0, 2]);
        assert_eq!(inst, vec![0, 0, 0, 0, 2, 2]);
        assert_eq!(page_count(19, 9), 3);
        assert_eq!(page_count(0, 9), 0);
    }
}
