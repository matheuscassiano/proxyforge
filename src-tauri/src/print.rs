//! Direct printing: list the system printers and send a rendered PDF to one of them.
//!
//! macOS and Linux go through CUPS (`lpstat` / `lp`). Windows asks PowerShell for the
//! printers and hands the PDF to the default PDF application with the `PrintTo` verb,
//! which needs a PDF reader that supports it (Edge, Acrobat, SumatraPDF…).

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sides {
    OneSided,
    LongEdge,
    ShortEdge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOptions {
    pub printer: String,
    #[serde(default = "one")]
    pub copies: u32,
    /// Overrides the print profile DPI when set.
    #[serde(default)]
    pub dpi: Option<u32>,
    /// CUPS page ranges, e.g. "1-4,7". Empty or missing prints everything.
    #[serde(default)]
    pub pages: Option<String>,
    pub sides: Sides,
}

fn one() -> u32 {
    1
}

fn run(cmd: &mut Command) -> AppResult<String> {
    let out = cmd.output().map_err(|e| AppError::Other(format!("could not run {:?}: {e}", cmd.get_program())))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Other(if err.is_empty() { format!("{:?} failed", cmd.get_program()) } else { err }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Parse `lpstat -e` (one queue name per line) and `lpstat -d` ("system default destination: X").
pub fn parse_cups(names: &str, default: &str) -> Vec<PrinterInfo> {
    let def = default.split_once(':').map(|(_, d)| d.trim()).unwrap_or("");
    names
        .lines()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| PrinterInfo { name: n.to_string(), is_default: n == def })
        .collect()
}

/// Accept only page ranges like "1-3,5" so nothing odd reaches the print command.
pub fn valid_ranges(s: &str) -> bool {
    !s.is_empty()
        && s.split(',').all(|part| {
            let mut it = part.trim().splitn(2, '-');
            let ok = |x: Option<&str>| x.is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()));
            match (it.next(), it.next()) {
                (a, None) => ok(a),
                (a, b) => ok(a) && ok(b),
            }
        })
}

pub fn list_printers() -> AppResult<Vec<PrinterInfo>> {
    if cfg!(windows) {
        let names = run(Command::new("powershell").args(["-NoProfile", "-Command", "Get-Printer | Select-Object -ExpandProperty Name"]))?;
        let def = run(Command::new("powershell").args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_Printer -Filter 'Default=True').Name",
        ]))
        .unwrap_or_default();
        let def = def.trim();
        Ok(names
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| PrinterInfo { name: n.into(), is_default: n == def })
            .collect())
    } else {
        // `lpstat -e` exits non-zero when no printer is configured: treat as an empty list.
        let names = run(Command::new("lpstat").arg("-e").env("LC_ALL", "C")).unwrap_or_default();
        let def = run(Command::new("lpstat").arg("-d").env("LC_ALL", "C")).unwrap_or_default();
        Ok(parse_cups(&names, &def))
    }
}

/// Arguments for `lp`, kept separate so they can be tested.
pub fn lp_args(pdf: &Path, o: &PrintOptions) -> AppResult<Vec<String>> {
    let mut a = vec!["-d".into(), o.printer.clone(), "-n".into(), o.copies.clamp(1, 999).to_string()];
    // Cards must print at 100%: never let the driver fit the page to the paper.
    for opt in ["print-scaling=none", "fit-to-page=false"] {
        a.push("-o".into());
        a.push(opt.into());
    }
    a.push("-o".into());
    a.push(
        match o.sides {
            Sides::OneSided => "sides=one-sided",
            Sides::LongEdge => "sides=two-sided-long-edge",
            Sides::ShortEdge => "sides=two-sided-short-edge",
        }
        .into(),
    );
    if let Some(r) = o.pages.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        if !valid_ranges(r) {
            return Err(AppError::Invalid(format!("Invalid page range: {r}")));
        }
        a.push("-o".into());
        a.push(format!("page-ranges={}", r.replace(' ', "")));
    }
    a.push("--".into());
    a.push(pdf.to_string_lossy().to_string());
    Ok(a)
}

/// Send a PDF to the printer. Returns the job description printed by the system.
pub fn send(pdf: &Path, o: &PrintOptions) -> AppResult<String> {
    if o.printer.trim().is_empty() {
        return Err(AppError::Invalid("Choose a printer.".into()));
    }
    if cfg!(windows) {
        // PowerShell single-quoted strings: double any quote inside.
        let q = |s: &str| s.replace('\'', "''");
        let script = format!(
            "for ($i = 0; $i -lt {}; $i++) {{ Start-Process -FilePath '{}' -Verb PrintTo -ArgumentList '\"{}\"' -Wait }}",
            o.copies.clamp(1, 999),
            q(&pdf.to_string_lossy()),
            q(&o.printer)
        );
        run(Command::new("powershell").args(["-NoProfile", "-Command", &script]))
    } else {
        run(Command::new("lp").args(lp_args(pdf, o)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cups_output() {
        let p = parse_cups("Epson_ET_8550\nHP_LaserJet\n\n", "system default destination: HP_LaserJet\n");
        assert_eq!(p.len(), 2);
        assert!(!p[0].is_default);
        assert!(p[1].is_default);
        assert!(parse_cups("", "no system default destination").is_empty());
    }

    #[test]
    fn page_ranges() {
        assert!(valid_ranges("1-3,5"));
        assert!(valid_ranges("7"));
        assert!(!valid_ranges("1-"));
        assert!(!valid_ranges("a"));
        assert!(!valid_ranges("1;rm"));
    }

    #[test]
    fn lp_arguments() {
        let o = PrintOptions { printer: "HP".into(), copies: 2, dpi: None, pages: Some("1-2".into()), sides: Sides::LongEdge };
        let a = lp_args(Path::new("/tmp/x.pdf"), &o).unwrap();
        assert_eq!(&a[..4], ["-d", "HP", "-n", "2"]);
        assert!(a.contains(&"sides=two-sided-long-edge".to_string()));
        assert!(a.contains(&"page-ranges=1-2".to_string()));
        assert_eq!(a.last().unwrap(), "/tmp/x.pdf");
        let bad = PrintOptions { pages: Some("x".into()), ..o };
        assert!(lp_args(Path::new("/tmp/x.pdf"), &bad).is_err());
    }
}
