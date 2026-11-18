//! Decklist parsing: plain text (MTGA/MTGO/Moxfield/PTCGL/generic), Yu-Gi-Oh! `.ydk`,
//! MPC Autofill XML, and URL import from Archidekt / Moxfield.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckLine {
    pub qty: u32,
    pub name: String,
    pub set: Option<String>,
    pub number: Option<String>,
    pub section: String,
    /// Direct image URL (MPC Autofill).
    #[serde(default)]
    pub image_url: Option<String>,
    #[serde(default)]
    pub back_image_url: Option<String>,
    /// Card language from a `lang:xx` clause or a CSV column.
    #[serde(default)]
    pub lang: Option<String>,
}

static QTY: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(?i)(\d+)\s*x?\s+(.+)$").unwrap());
static PAREN_SET: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(.+?)\s+[\(\[]([A-Za-z0-9]{2,6})[\)\]](?:\s+([A-Za-z0-9\-★†]+))?\s*$").unwrap());
static TRAILING_SET: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(.+?)\s+([A-Z][A-Z0-9]{1,5})\s+([A-Za-z]{0,4}\d+[a-z]?)$").unwrap());
static LANG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\s+lang:([a-z]{2,3})\b").unwrap());
static SECTION: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(?i)(deck|main(board)?|sideboard|side|commander|companion|maybeboard|tokens?|pok[eé]mon|trainer|energy|leader|base|extra)\s*:?\s*(\d+)?\s*$").unwrap()
});

pub fn parse_text(text: &str) -> Vec<DeckLine> {
    let mut out: Vec<DeckLine> = vec![];
    let mut section = "main".to_string();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") || line.starts_with('#') {
            if let Some(rest) = line.strip_prefix("//") {
                let r = rest.trim();
                if SECTION.is_match(r) {
                    section = r.trim_end_matches(':').to_lowercase();
                }
            }
            continue;
        }
        if let Some(c) = SECTION.captures(line) {
            section = c.get(1).unwrap().as_str().to_lowercase();
            continue;
        }
        let line = line.replace("*F*", "").replace("*E*", "").replace(" *CMDR*", "");
        let lang = LANG.captures(&line).map(|c| c[1].to_lowercase());
        let line = LANG.replace_all(&line, "").to_string();
        let (qty, rest) = match QTY.captures(line.trim()) {
            Some(c) => (c[1].parse().unwrap_or(1), c[2].trim().to_string()),
            None => (1, line.trim().to_string()),
        };
        let (name, set, number) = if let Some(c) = PAREN_SET.captures(&rest) {
            (c[1].trim().to_string(), Some(c[2].to_uppercase()), c.get(3).map(|m| m.as_str().to_string()))
        } else if let Some(c) = TRAILING_SET.captures(&rest) {
            (c[1].trim().to_string(), Some(c[2].to_string()), Some(c[3].to_string()))
        } else {
            (rest, None, None)
        };
        if name.is_empty() || qty == 0 {
            continue;
        }
        // merge duplicates
        if let Some(e) = out.iter_mut().find(|e| e.name == name && e.set == set && e.number == number && e.section == section && e.lang == lang) {
            e.qty += qty;
        } else {
            out.push(DeckLine { qty, name, set, number, section: section.clone(), image_url: None, back_image_url: None, lang });
        }
    }
    out
}

/// Split one CSV record (RFC 4180 quoting, `,` or `;` separator).
fn csv_fields(line: &str, sep: char) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            c if c == sep && !quoted => out.push(std::mem::take(&mut cur).trim().to_string()),
            c => cur.push(c),
        }
    }
    out.push(cur.trim().to_string());
    out
}

/// The text looks like a CSV export with a header row naming a card column.
pub fn looks_like_csv(text: &str) -> bool {
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_lowercase();
    (first.contains(',') || first.contains(';')) && (first.contains("name") || first.contains("card"))
}

/// CSV exports from Moxfield, Archidekt, ManaBox, Deckbox, Dragon Shield and similar:
/// a header row with a quantity column (Count / Quantity / Qty), a name column, and
/// optional set, collector number and language columns.
pub fn parse_csv(text: &str) -> Vec<DeckLine> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let Some(header) = lines.next() else { return vec![] };
    let sep = if header.matches(';').count() > header.matches(',').count() { ';' } else { ',' };
    let cols: Vec<String> = csv_fields(header, sep).into_iter().map(|c| c.to_lowercase()).collect();
    let find = |names: &[&str]| cols.iter().position(|c| names.iter().any(|n| c == n));
    let qty_i = find(&["count", "quantity", "qty", "amount"]);
    let Some(name_i) = find(&["name", "card name", "card", "cardname"]) else { return vec![] };
    let set_i = find(&["edition", "set code", "set", "edition code", "setcode", "set_code"]);
    let num_i = find(&["collector number", "card number", "collector_number", "number", "collectornumber", "cn"]);
    let lang_i = find(&["language", "lang"]);
    let section_i = find(&["board", "section", "category"]);
    let mut out: Vec<DeckLine> = vec![];
    for l in lines {
        let f = csv_fields(l, sep);
        let get = |i: Option<usize>| i.and_then(|i| f.get(i)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let Some(name) = get(Some(name_i)) else { continue };
        let qty = get(qty_i).and_then(|q| q.parse::<u32>().ok()).unwrap_or(1);
        if qty == 0 {
            continue;
        }
        let set = get(set_i).map(|s| s.to_uppercase()).filter(|s| s.len() <= 6 && s.chars().all(|c| c.is_ascii_alphanumeric()));
        let lang = get(lang_i).map(|l| lang_code(&l));
        let section = get(section_i).map(|s| s.to_lowercase()).unwrap_or_else(|| "main".into());
        out.push(DeckLine { qty, name, set, number: get(num_i), section, image_url: None, back_image_url: None, lang });
    }
    out
}

/// ISO-ish code for a language column value ("English", "Portuguese", "pt", "JP"…).
fn lang_code(v: &str) -> String {
    let l = v.to_lowercase();
    let map = [
        ("english", "en"), ("portuguese", "pt"), ("spanish", "es"), ("french", "fr"), ("german", "de"), ("italian", "it"),
        ("japanese", "ja"), ("jp", "ja"), ("korean", "ko"), ("kr", "ko"), ("russian", "ru"), ("chinese simplified", "zhs"),
        ("simplified chinese", "zhs"), ("chinese traditional", "zht"), ("traditional chinese", "zht"), ("cs", "zhs"), ("ct", "zht"),
    ];
    map.iter().find(|(k, _)| l == *k).map(|(_, c)| c.to_string()).unwrap_or(l)
}

/// Yu-Gi-Oh! `.ydk`: passcodes one per line under #main / #extra / !side.
pub fn parse_ydk(text: &str) -> Vec<DeckLine> {
    let mut out: Vec<DeckLine> = vec![];
    let mut section = "main".to_string();
    for l in text.lines().map(str::trim) {
        if let Some(s) = l.strip_prefix('#').or_else(|| l.strip_prefix('!')) {
            if !s.starts_with("created") {
                section = s.to_lowercase();
            }
            continue;
        }
        if l.is_empty() || !l.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let code = l.trim_start_matches('0').to_string();
        if let Some(e) = out.iter_mut().find(|e| e.name == code && e.section == section) {
            e.qty += 1;
        } else {
            out.push(DeckLine { qty: 1, name: code, set: None, number: None, section: section.clone(), image_url: None, back_image_url: None, lang: None });
        }
    }
    out
}

/// MPC Autofill XML order file. Images are Google Drive file ids.
pub fn parse_mpc_xml(text: &str) -> AppResult<Vec<DeckLine>> {
    let card_re = Regex::new(r"(?s)<card>(.*?)</card>").unwrap();
    let tag = |body: &str, t: &str| -> Option<String> {
        Regex::new(&format!(r"(?s)<{t}>(.*?)</{t}>")).unwrap().captures(body).map(|c| c[1].trim().to_string())
    };
    let section = |name: &str| -> Option<String> {
        Regex::new(&format!(r"(?s)<{name}>(.*?)</{name}>")).unwrap().captures(text).map(|c| c[1].to_string())
    };
    let fronts = section("fronts").ok_or_else(|| AppError::Invalid("not an MPC Autofill XML file (no <fronts>)".into()))?;
    let backs = section("backs").unwrap_or_default();
    let common_back = section("cardback").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let drive = |id: &str| format!("https://drive.google.com/uc?export=download&id={id}");

    let mut back_by_slot = std::collections::HashMap::new();
    for c in card_re.captures_iter(&backs) {
        let body = &c[1];
        if let (Some(id), Some(slots)) = (tag(body, "id"), tag(body, "slots")) {
            for s in slots.split(',') {
                back_by_slot.insert(s.trim().to_string(), id.clone());
            }
        }
    }
    let mut out = vec![];
    for c in card_re.captures_iter(&fronts) {
        let body = &c[1];
        let Some(id) = tag(body, "id") else { continue };
        let slots = tag(body, "slots").unwrap_or_default();
        let slot_list: Vec<&str> = slots.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        let name = tag(body, "name").unwrap_or_else(|| id.clone());
        let name = name.rsplit_once('.').map(|(n, _)| n.to_string()).unwrap_or(name);
        let back = slot_list.first().and_then(|s| back_by_slot.get(*s).cloned()).or_else(|| common_back.clone());
        out.push(DeckLine {
            qty: slot_list.len().max(1) as u32,
            name,
            set: None,
            number: None,
            section: "main".into(),
            image_url: Some(drive(&id)),
            back_image_url: back.map(|b| drive(&b)),
            lang: None,
        });
    }
    Ok(out)
}

/// Turn an Archidekt or Moxfield deck URL into the public JSON API URL.
pub fn deck_api_url(url: &str) -> AppResult<(String, &'static str)> {
    let arch = Regex::new(r"archidekt\.com/(?:api/)?decks/(\d+)").unwrap();
    let mox = Regex::new(r"moxfield\.com/decks/([A-Za-z0-9_\-]+)").unwrap();
    if let Some(c) = arch.captures(url) {
        return Ok((format!("https://archidekt.com/api/decks/{}/", &c[1]), "archidekt"));
    }
    if let Some(c) = mox.captures(url) {
        return Ok((format!("https://api2.moxfield.com/v3/decks/all/{}", &c[1]), "moxfield"));
    }
    Err(AppError::Invalid("Paste an Archidekt or Moxfield deck link.".into()))
}

pub fn parse_deck_json(kind: &str, v: &Value) -> Vec<DeckLine> {
    let mut out = vec![];
    match kind {
        "archidekt" => {
            for c in v["cards"].as_array().into_iter().flatten() {
                let cats: Vec<String> = c["categories"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_lowercase)).collect();
                if cats.iter().any(|x| x == "maybeboard") {
                    continue;
                }
                let card = &c["card"];
                out.push(DeckLine {
                    qty: c["quantity"].as_u64().unwrap_or(1) as u32,
                    name: card["oracleCard"]["name"].as_str().unwrap_or("").to_string(),
                    set: card["edition"]["editioncode"].as_str().map(str::to_uppercase),
                    number: card["collectorNumber"].as_str().map(str::to_string),
                    section: cats.first().cloned().unwrap_or_else(|| "main".into()),
                    image_url: None,
                    back_image_url: None,
                    lang: None,
                });
            }
        }
        "moxfield" => {
            if let Some(boards) = v["boards"].as_object() {
                for (board, b) in boards {
                    if board == "maybeboard" {
                        continue;
                    }
                    for (_, c) in b["cards"].as_object().into_iter().flatten() {
                        out.push(DeckLine {
                            qty: c["quantity"].as_u64().unwrap_or(1) as u32,
                            name: c["card"]["name"].as_str().unwrap_or("").to_string(),
                            set: c["card"]["set"].as_str().map(str::to_uppercase),
                            number: c["card"]["cn"].as_str().map(str::to_string),
                            section: board.clone(),
                            image_url: None,
                            back_image_url: None,
                            lang: None,
                        });
                    }
                }
            }
        }
        _ => {}
    }
    out.retain(|l| !l.name.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_exports() {
        let moxfield = "\"Count\",\"Tradelist Count\",\"Name\",\"Edition\",\"Condition\",\"Language\",\"Foil\",\"Collector Number\"\n\"4\",\"0\",\"Lightning Bolt\",\"2x2\",\"Near Mint\",\"Japanese\",\"\",\"117\"\n\"1\",\"0\",\"Fire // Ice\",\"mh2\",\"\",\"English\",\"\",\"290\"";
        assert!(looks_like_csv(moxfield));
        let l = parse_csv(moxfield);
        assert_eq!(l.len(), 2);
        assert_eq!((l[0].qty, l[0].name.as_str(), l[0].set.as_deref(), l[0].number.as_deref(), l[0].lang.as_deref()), (4, "Lightning Bolt", Some("2X2"), Some("117"), Some("ja")));
        assert_eq!(l[1].name, "Fire // Ice");
        let manabox = "Name;Set code;Collector number;Quantity\nCounterspell;CMR;395;2";
        let l = parse_csv(manabox);
        assert_eq!((l[0].qty, l[0].set.as_deref()), (2, Some("CMR")));
        assert!(!looks_like_csv("4 Lightning Bolt\n2 Counterspell"));
    }

    #[test]
    fn lang_clause() {
        let l = parse_text("4 Lightning Bolt lang:ja\n2 Lightning Bolt");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].lang.as_deref(), Some("ja"));
        assert_eq!(l[0].name, "Lightning Bolt");
        assert_eq!(l[1].lang, None);
    }

    #[test]
    fn mtga_export() {
        let t = "Deck\n4 Lightning Bolt (2X2) 117\n2 Counterspell (MH2) 267\n\nSideboard\n1 Pyroblast (ICE) 213 *F*\n";
        let d = parse_text(t);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0], DeckLine { qty: 4, name: "Lightning Bolt".into(), set: Some("2X2".into()), number: Some("117".into()), section: "deck".into(), image_url: None, back_image_url: None, lang: None });
        assert_eq!(d[2].section, "sideboard");
        assert_eq!(d[2].number.as_deref(), Some("213"));
    }

    #[test]
    fn plain_and_x_quantities() {
        let d = parse_text("4x Brainstorm\nPonder\n// comment\n3 Island\n1 Island");
        assert_eq!(d[0].qty, 4);
        assert_eq!(d[1].qty, 1);
        assert_eq!(d[2].qty, 4, "duplicates merge");
    }

    #[test]
    fn ptcgl_format() {
        let t = "Pokémon: 2\n4 Pikachu ex SVI 57\n2 Iono PAL 185\nEnergy: 1\n8 Basic Lightning Energy SVE 4\n";
        let d = parse_text(t);
        assert_eq!(d[0].name, "Pikachu ex");
        assert_eq!(d[0].set.as_deref(), Some("SVI"));
        assert_eq!(d[0].number.as_deref(), Some("57"));
        assert_eq!(d[2].section, "energy");
    }

    #[test]
    fn names_with_numbers_are_not_split() {
        let d = parse_text("1 Borborygmos Enraged\n1 Ugin, the Spirit Dragon\n");
        assert_eq!(d[1].name, "Ugin, the Spirit Dragon");
        assert!(d[1].set.is_none());
    }

    #[test]
    fn ydk() {
        let t = "#created by x\n#main\n46986414\n46986414\n#extra\n0123\n!side\n46986414\n";
        let d = parse_ydk(t);
        assert_eq!(d[0].qty, 2);
        assert_eq!(d[1].section, "extra");
        assert_eq!(d[1].name, "123");
        assert_eq!(d[2].section, "side");
    }

    #[test]
    fn mpc_xml() {
        let x = "<order><details><quantity>3</quantity></details><fronts><card><id>abc</id><slots>0,1</slots><name>Bolt.png</name></card>\
                 <card><id>def</id><slots>2</slots><name>Island.jpg</name></card></fronts><backs><card><id>bk</id><slots>2</slots></card></backs><cardback>cb</cardback></order>";
        let d = parse_mpc_xml(x).unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].qty, 2);
        assert_eq!(d[0].name, "Bolt");
        assert!(d[0].back_image_url.as_deref().unwrap().ends_with("id=cb"));
        assert!(d[1].back_image_url.as_deref().unwrap().ends_with("id=bk"));
    }

    #[test]
    fn deck_urls() {
        assert_eq!(deck_api_url("https://archidekt.com/decks/123456/izzet").unwrap().1, "archidekt");
        assert!(deck_api_url("https://moxfield.com/decks/AbC_12-x").unwrap().0.ends_with("AbC_12-x"));
        assert!(deck_api_url("https://example.com").is_err());
    }
}
