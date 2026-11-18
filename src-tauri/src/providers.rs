//! Card image banks. Every request goes through Rust (no CORS), is rate limited per host
//! and results/images are cached on disk so they work offline afterwards.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, OnceCell};

use crate::error::{AppError, AppResult};
use crate::model::Game;

pub const USER_AGENT: &str = concat!("ProxyForge/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardResult {
    pub game: Game,
    pub id: String,
    pub name: String,
    pub set_code: String,
    pub set_name: String,
    pub number: String,
    pub image_url: String,
    pub thumb_url: String,
    pub back_image_url: Option<String>,
    pub is_token: bool,
    pub lang: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub results: Vec<CardResult>,
    pub total: Option<u32>,
    pub has_more: bool,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub game: Game,
    pub name: &'static str,
    pub source: &'static str,
    pub beta: bool,
}

pub fn games() -> Vec<GameInfo> {
    use Game::*;
    vec![
        GameInfo { game: Mtg, name: "Magic: The Gathering", source: "Scryfall", beta: false },
        GameInfo { game: Pokemon, name: "Pokémon TCG", source: "TCGdex", beta: false },
        GameInfo { game: Yugioh, name: "Yu-Gi-Oh!", source: "YGOPRODeck", beta: false },
        GameInfo { game: Fab, name: "Flesh and Blood", source: "the-fab-cube dataset", beta: false },
        GameInfo { game: Lorcana, name: "Disney Lorcana", source: "Lorcast", beta: false },
        GameInfo { game: Onepiece, name: "One Piece Card Game", source: "OPTCG API", beta: false },
        GameInfo { game: Swu, name: "Star Wars: Unlimited", source: "SWU-DB", beta: false },
        GameInfo { game: Digimon, name: "Digimon Card Game", source: "digimoncard.io", beta: false },
        GameInfo { game: Riftbound, name: "Riftbound", source: "Riftcodex", beta: true },
    ]
}

pub struct Providers {
    client: reqwest::Client,
    last_hit: Mutex<HashMap<String, Instant>>,
    cache_dir: PathBuf,
    fab: OnceCell<Vec<CardResult>>,
    onepiece: OnceCell<Vec<CardResult>>,
}

const PAGE: usize = 60;

impl Providers {
    pub fn new(cache_dir: PathBuf) -> AppResult<Self> {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(60))
            .build()?;
        Ok(Self { client, last_hit: Mutex::new(HashMap::new()), cache_dir, fab: OnceCell::new(), onepiece: OnceCell::new() })
    }

    async fn throttle(&self, url: &str) {
        let host = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
        let gap = match host.as_str() {
            "api.scryfall.com" => Duration::from_millis(110),
            "db.ygoprodeck.com" => Duration::from_millis(60),
            h if h.starts_with("images.") || h.starts_with("cards.") || h.starts_with("assets.") || h.starts_with("cdn.") => {
                Duration::from_millis(20)
            }
            _ => Duration::from_millis(120),
        };
        let wait = {
            let mut m = self.last_hit.lock().await;
            let now = Instant::now();
            let next = m.get(&host).map(|t| *t + gap).unwrap_or(now);
            let start = next.max(now);
            m.insert(host, start);
            start.saturating_duration_since(now)
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    async fn get_json(&self, url: &str) -> AppResult<(u16, Value)> {
        self.throttle(url).await;
        let r = self.client.get(url).header("Accept", "application/json").send().await?;
        let status = r.status().as_u16();
        let v = r.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, v))
    }

    pub async fn get_bytes(&self, url: &str) -> AppResult<Vec<u8>> {
        self.throttle(url).await;
        let r = self.client.get(url).header("Accept", "image/png,image/webp,image/avif,image/*,*/*").send().await?;
        if !r.status().is_success() {
            return Err(AppError::Http(format!("{} returned {}", url, r.status())));
        }
        Ok(r.bytes().await?.to_vec())
    }

    /// Download a dataset once and cache it for a week.
    async fn dataset(&self, name: &str, urls: &[&str]) -> AppResult<Vec<Value>> {
        let path = self.cache_dir.join(format!("{name}.json"));
        let fresh = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(7 * 24 * 3600))
            .unwrap_or(false);
        if !fresh {
            let mut all = vec![];
            let mut ok = true;
            for u in urls {
                match self.get_json(u).await {
                    Ok((200, Value::Array(a))) => all.extend(a),
                    _ => ok = false,
                }
            }
            if ok && !all.is_empty() {
                crate::store::atomic_write(&path, &serde_json::to_vec(&all)?)?;
                return Ok(all);
            }
        }
        let b = std::fs::read(&path).map_err(|_| AppError::Http(format!("could not download the {name} card list")))?;
        Ok(serde_json::from_slice(&b)?)
    }

    pub async fn search(&self, game: Game, query: &str, page: u32, all_prints: bool) -> AppResult<SearchPage> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(SearchPage { results: vec![], total: Some(0), has_more: false, source: "" });
        }
        match game {
            Game::Mtg => self.scryfall(q, page, all_prints).await,
            Game::Pokemon => self.tcgdex(q, page).await,
            Game::Yugioh => self.ygo(q, page).await,
            Game::Fab => self.fab(q, page).await,
            Game::Lorcana => self.lorcast(q, page).await,
            Game::Onepiece => self.onepiece(q, page).await,
            Game::Swu => self.swu(q, page).await,
            Game::Digimon => self.digimon(q, page).await,
            Game::Riftbound => self.riftbound(q, page).await,
            Game::Custom => Ok(SearchPage { results: vec![], total: Some(0), has_more: false, source: "" }),
        }
    }

    /// Best match for a decklist line.
    pub async fn resolve(&self, game: Game, name: &str, set: Option<&str>, number: Option<&str>) -> AppResult<Option<CardResult>> {
        if game == Game::Mtg {
            return self.scryfall_named(name, set, number).await;
        }
        if game == Game::Yugioh && name.chars().all(|c| c.is_ascii_digit()) {
            let (s, v) = self.get_json(&format!("https://db.ygoprodeck.com/api/v7/cardinfo.php?id={name}")).await?;
            if s != 200 {
                return Ok(None);
            }
            return Ok(ygo_results(&v).into_iter().find(|c| c.id == name).or_else(|| ygo_results(&v).into_iter().next()));
        }
        let page = self.search(game, name, 0, true).await?;
        let lname = normalize(name);
        let mut candidates: Vec<CardResult> = page.results.into_iter().filter(|c| normalize(&c.name) == lname || normalize(&c.name).starts_with(&format!("{lname} -"))).collect();
        if candidates.is_empty() {
            return Ok(None);
        }
        if let Some(s) = set {
            let s = s.to_lowercase();
            if let Some(i) = candidates.iter().position(|c| c.set_code.to_lowercase() == s && number.is_none_or(|n| eq_num(&c.number, n))) {
                return Ok(Some(candidates.swap_remove(i)));
            }
        }
        if let Some(n) = number {
            if let Some(i) = candidates.iter().position(|c| eq_num(&c.number, n)) {
                return Ok(Some(candidates.swap_remove(i)));
            }
        }
        Ok(Some(candidates.swap_remove(0)))
    }

    // ------------------------------------------------------------- MTG / Scryfall

    async fn scryfall(&self, q: &str, page: u32, all_prints: bool) -> AppResult<SearchPage> {
        let mut url = reqwest::Url::parse("https://api.scryfall.com/cards/search").unwrap();
        url.query_pairs_mut()
            .append_pair("q", q)
            .append_pair("unique", if all_prints { "prints" } else { "cards" })
            .append_pair("include_extras", "true")
            .append_pair("page", &(page + 1).to_string());
        let (status, v) = self.get_json(url.as_str()).await?;
        if status == 404 {
            return Ok(SearchPage { results: vec![], total: Some(0), has_more: false, source: "Scryfall" });
        }
        if status != 200 {
            return Err(AppError::Http(v["details"].as_str().unwrap_or("Scryfall error").to_string()));
        }
        let results = v["data"].as_array().map(|a| a.iter().filter_map(scryfall_card).collect()).unwrap_or_default();
        Ok(SearchPage {
            results,
            total: v["total_cards"].as_u64().map(|x| x as u32),
            has_more: v["has_more"].as_bool().unwrap_or(false),
            source: "Scryfall",
        })
    }

    async fn scryfall_named(&self, name: &str, set: Option<&str>, number: Option<&str>) -> AppResult<Option<CardResult>> {
        if let (Some(s), Some(n)) = (set, number) {
            let url = format!("https://api.scryfall.com/cards/{}/{}", s.to_lowercase(), urlencode(n));
            let (st, v) = self.get_json(&url).await?;
            if st == 200 {
                return Ok(scryfall_card(&v));
            }
        }
        let mut url = reqwest::Url::parse("https://api.scryfall.com/cards/named").unwrap();
        url.query_pairs_mut().append_pair("fuzzy", name);
        if let Some(s) = set {
            url.query_pairs_mut().append_pair("set", &s.to_lowercase());
        }
        let (st, v) = self.get_json(url.as_str()).await?;
        if st == 200 {
            return Ok(scryfall_card(&v));
        }
        if set.is_some() {
            return Box::pin(self.scryfall_named(name, None, None)).await;
        }
        Ok(None)
    }

    // ------------------------------------------------------------- Pokémon / TCGdex

    async fn tcgdex(&self, q: &str, page: u32) -> AppResult<SearchPage> {
        let mut url = reqwest::Url::parse("https://api.tcgdex.net/v2/en/cards").unwrap();
        url.query_pairs_mut()
            .append_pair("name", q)
            .append_pair("pagination:page", &(page + 1).to_string())
            .append_pair("pagination:itemsPerPage", &PAGE.to_string());
        let (_, v) = self.get_json(url.as_str()).await?;
        let results: Vec<CardResult> = v
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        let img = c["image"].as_str()?;
                        let id = c["id"].as_str()?.to_string();
                        let set = id.rsplit_once('-').map(|(s, _)| s.to_string()).unwrap_or_default();
                        Some(CardResult {
                            game: Game::Pokemon,
                            name: s(&c["name"]),
                            set_code: set.clone(),
                            set_name: set,
                            number: s(&c["localId"]),
                            image_url: format!("{img}/high.png"),
                            thumb_url: format!("{img}/low.webp"),
                            back_image_url: None,
                            is_token: false,
                            lang: "en".into(),
                            id,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let has_more = results.len() >= PAGE;
        Ok(SearchPage { results, total: None, has_more, source: "TCGdex" })
    }

    // ------------------------------------------------------------- Yu-Gi-Oh! / YGOPRODeck

    async fn ygo(&self, q: &str, page: u32) -> AppResult<SearchPage> {
        let mut url = reqwest::Url::parse("https://db.ygoprodeck.com/api/v7/cardinfo.php").unwrap();
        url.query_pairs_mut()
            .append_pair("fname", q)
            .append_pair("num", &PAGE.to_string())
            .append_pair("offset", &(page as usize * PAGE).to_string());
        let (status, v) = self.get_json(url.as_str()).await?;
        if status != 200 {
            return Ok(SearchPage { results: vec![], total: Some(0), has_more: false, source: "YGOPRODeck" });
        }
        Ok(SearchPage {
            results: ygo_results(&v),
            total: v["meta"]["total_rows"].as_u64().map(|x| x as u32),
            has_more: v["meta"]["pages_remaining"].as_u64().unwrap_or(0) > 0,
            source: "YGOPRODeck",
        })
    }

    // ------------------------------------------------------------- FaB / the-fab-cube dataset

    async fn fab(&self, q: &str, page: u32) -> AppResult<SearchPage> {
        let all = self
            .fab
            .get_or_try_init(|| async {
                let raw = self
                    .dataset(
                        "fab-cards",
                        &["https://raw.githubusercontent.com/the-fab-cube/flesh-and-blood-cards/develop/json/english/card.json"],
                    )
                    .await?;
                Ok::<_, AppError>(fab_results(&raw))
            })
            .await?;
        Ok(local_search(all, q, page, "the-fab-cube"))
    }

    // ------------------------------------------------------------- Lorcana / Lorcast

    async fn lorcast(&self, q: &str, page: u32) -> AppResult<SearchPage> {
        let mut url = reqwest::Url::parse("https://api.lorcast.com/v0/cards/search").unwrap();
        url.query_pairs_mut().append_pair("q", q);
        let (_, v) = self.get_json(url.as_str()).await?;
        let all: Vec<CardResult> = v["results"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        let large = c["image_uris"]["digital"]["large"].as_str()?;
                        let small = c["image_uris"]["digital"]["small"].as_str().unwrap_or(large);
                        let version = c["version"].as_str().unwrap_or("");
                        let name = if version.is_empty() { s(&c["name"]) } else { format!("{} - {}", s(&c["name"]), version) };
                        Some(CardResult {
                            game: Game::Lorcana,
                            id: s(&c["id"]),
                            name,
                            set_code: s(&c["set"]["code"]),
                            set_name: s(&c["set"]["name"]),
                            number: s(&c["collector_number"]),
                            image_url: large.into(),
                            thumb_url: small.into(),
                            back_image_url: None,
                            is_token: false,
                            lang: s(&c["lang"]),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(paginate(all, page, "Lorcast"))
    }

    // ------------------------------------------------------------- One Piece / OPTCG API

    async fn onepiece(&self, q: &str, page: u32) -> AppResult<SearchPage> {
        let all = self
            .onepiece
            .get_or_try_init(|| async {
                let raw = self
                    .dataset("onepiece-cards", &["https://optcgapi.com/api/allSetCards/", "https://optcgapi.com/api/allSTCards/"])
                    .await?;
                let mut seen = std::collections::HashSet::new();
                Ok::<_, AppError>(
                    raw.iter()
                        .filter_map(|c| {
                            let img = c["card_image"].as_str()?.to_string();
                            if !seen.insert(img.clone()) {
                                return None;
                            }
                            let id = s(&c["card_image_id"]);
                            Some(CardResult {
                                game: Game::Onepiece,
                                id: id.clone(),
                                name: s(&c["card_name"]),
                                set_code: s(&c["set_id"]),
                                set_name: s(&c["set_name"]),
                                number: s(&c["card_set_id"]),
                                thumb_url: img.clone(),
                                image_url: img,
                                back_image_url: None,
                                is_token: false,
                                lang: "en".into(),
                            })
                        })
                        .collect(),
                )
            })
            .await?;
        Ok(local_search(all, q, page, "OPTCG API"))
    }

    // ------------------------------------------------------------- Star Wars Unlimited / SWU-DB

    async fn swu(&self, q: &str, page: u32) -> AppResult<SearchPage> {
        let mut url = reqwest::Url::parse("https://api.swu-db.com/cards/search").unwrap();
        url.query_pairs_mut().append_pair("q", q);
        let (_, v) = self.get_json(url.as_str()).await?;
        let all: Vec<CardResult> = v["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        let front = c["FrontArt"].as_str()?.to_string();
                        let sub = c["Subtitle"].as_str().unwrap_or("");
                        let name = if sub.is_empty() { s(&c["Name"]) } else { format!("{}, {}", s(&c["Name"]), sub) };
                        Some(CardResult {
                            game: Game::Swu,
                            id: format!("{}-{}", s(&c["Set"]), s(&c["Number"])),
                            name,
                            set_code: s(&c["Set"]),
                            set_name: s(&c["Set"]),
                            number: s(&c["Number"]),
                            thumb_url: front.clone(),
                            image_url: front,
                            back_image_url: c["BackArt"].as_str().map(str::to_string),
                            is_token: s(&c["Type"]).eq_ignore_ascii_case("token"),
                            lang: "en".into(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(paginate(all, page, "SWU-DB"))
    }

    // ------------------------------------------------------------- Digimon / digimoncard.io

    async fn digimon(&self, q: &str, page: u32) -> AppResult<SearchPage> {
        let mut url = reqwest::Url::parse("https://digimoncard.io/api-public/search").unwrap();
        url.query_pairs_mut().append_pair("n", q);
        let (_, v) = self.get_json(url.as_str()).await?;
        let all: Vec<CardResult> = v
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        let id = c["id"].as_str()?.to_string();
                        let img = format!("https://images.digimoncard.io/images/cards/{id}.jpg");
                        Some(CardResult {
                            game: Game::Digimon,
                            name: s(&c["name"]),
                            set_code: id.split('-').next().unwrap_or("").to_string(),
                            set_name: s(&c["series"]),
                            number: id.clone(),
                            thumb_url: img.clone(),
                            image_url: img,
                            back_image_url: None,
                            is_token: false,
                            lang: "en".into(),
                            id,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(paginate(all, page, "digimoncard.io"))
    }

    // ------------------------------------------------------------- Riftbound / Riftcodex

    async fn riftbound(&self, q: &str, page: u32) -> AppResult<SearchPage> {
        let mut url = reqwest::Url::parse("https://api.riftcodex.com/cards/name").unwrap();
        url.query_pairs_mut().append_pair("fuzzy", q);
        let (_, v) = self.get_json(url.as_str()).await?;
        let all: Vec<CardResult> = v["items"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        let img = c["media"]["image_url"].as_str()?.to_string();
                        Some(CardResult {
                            game: Game::Riftbound,
                            id: s(&c["riftbound_id"]),
                            name: s(&c["name"]),
                            set_code: s(&c["set"]["set_id"]),
                            set_name: s(&c["set"]["label"]),
                            number: c["collector_number"].to_string().trim_matches('"').to_string(),
                            thumb_url: img.clone(),
                            image_url: img,
                            back_image_url: None,
                            is_token: s(&c["classification"]["type"]).eq_ignore_ascii_case("token"),
                            lang: "en".into(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(paginate(all, page, "Riftcodex"))
    }
}

fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn normalize(x: &str) -> String {
    x.to_lowercase().chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn eq_num(a: &str, b: &str) -> bool {
    a.trim_start_matches('0').eq_ignore_ascii_case(b.trim_start_matches('0'))
}

fn urlencode(x: &str) -> String {
    x.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn paginate(all: Vec<CardResult>, page: u32, source: &'static str) -> SearchPage {
    let total = all.len();
    let start = (page as usize * PAGE).min(total);
    let end = (start + PAGE).min(total);
    SearchPage { results: all[start..end].to_vec(), total: Some(total as u32), has_more: end < total, source }
}

fn local_search(all: &[CardResult], q: &str, page: u32, source: &'static str) -> SearchPage {
    let nq = normalize(q);
    let terms: Vec<&str> = nq.split_whitespace().collect();
    let mut hits: Vec<CardResult> = all
        .iter()
        .filter(|c| {
            let n = normalize(&c.name);
            terms.iter().all(|t| n.contains(t)) || c.number.eq_ignore_ascii_case(q.trim())
        })
        .cloned()
        .collect();
    // exact / prefix matches first
    hits.sort_by_key(|c| {
        let n = normalize(&c.name);
        if n == nq { 0 } else if n.starts_with(&nq) { 1 } else { 2 }
    });
    paginate(hits, page, source)
}

pub fn scryfall_card(c: &Value) -> Option<CardResult> {
    let faces = c["card_faces"].as_array();
    let (img, thumb, back) = if let Some(u) = c["image_uris"].as_object() {
        (u.get("png")?.as_str()?.to_string(), u.get("normal").and_then(|x| x.as_str()).unwrap_or("").to_string(), None)
    } else {
        let f = faces?;
        let front = &f.first()?["image_uris"];
        let back = f.get(1).and_then(|b| b["image_uris"]["png"].as_str()).map(str::to_string);
        (front["png"].as_str()?.to_string(), front["normal"].as_str().unwrap_or("").to_string(), back)
    };
    let layout = c["layout"].as_str().unwrap_or("");
    Some(CardResult {
        game: Game::Mtg,
        id: s(&c["id"]),
        name: s(&c["name"]),
        set_code: s(&c["set"]).to_uppercase(),
        set_name: s(&c["set_name"]),
        number: s(&c["collector_number"]),
        image_url: img,
        thumb_url: thumb,
        back_image_url: back,
        is_token: matches!(layout, "token" | "double_faced_token" | "emblem"),
        lang: s(&c["lang"]),
    })
}

fn ygo_results(v: &Value) -> Vec<CardResult> {
    let mut out = vec![];
    for c in v["data"].as_array().into_iter().flatten() {
        let set = c["card_sets"].get(0);
        for im in c["card_images"].as_array().into_iter().flatten() {
            out.push(CardResult {
                game: Game::Yugioh,
                id: s(&im["id"]),
                name: s(&c["name"]),
                set_code: set.map(|x| s(&x["set_code"])).unwrap_or_default(),
                set_name: set.map(|x| s(&x["set_name"])).unwrap_or_default(),
                number: s(&im["id"]),
                image_url: s(&im["image_url"]),
                thumb_url: s(&im["image_url_small"]),
                back_image_url: None,
                is_token: s(&c["type"]).contains("Token"),
                lang: "en".into(),
            });
        }
    }
    out
}

fn fab_results(raw: &[Value]) -> Vec<CardResult> {
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for c in raw {
        let pitch = s(&c["pitch"]);
        let colour = match pitch.as_str() {
            "1" => " (red)",
            "2" => " (yellow)",
            "3" => " (blue)",
            _ => "",
        };
        let name = format!("{}{}", s(&c["name"]), colour);
        let is_token = c["types"].as_array().is_some_and(|t| t.iter().any(|x| x.as_str() == Some("Token")));
        for p in c["printings"].as_array().into_iter().flatten() {
            let Some(img) = p["image_url"].as_str() else { continue };
            if !seen.insert(img.to_string()) {
                continue;
            }
            out.push(CardResult {
                game: Game::Fab,
                id: s(&p["unique_id"]),
                name: name.clone(),
                set_code: s(&p["set_id"]),
                set_name: s(&p["set_id"]),
                number: s(&p["id"]),
                image_url: img.to_string(),
                thumb_url: img.replace("/large/", "/small/"),
                back_image_url: None,
                is_token,
                lang: "en".into(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scryfall_single_and_double_faced() {
        let single = json!({"id":"x","name":"Lightning Bolt","set":"2x2","set_name":"Double Masters 2022","collector_number":"117","lang":"en","layout":"normal",
            "image_uris":{"png":"https://c/png.png","normal":"https://c/n.jpg"}});
        let c = scryfall_card(&single).unwrap();
        assert_eq!(c.set_code, "2X2");
        assert_eq!(c.image_url, "https://c/png.png");
        assert!(c.back_image_url.is_none());

        let dfc = json!({"id":"y","name":"Delver of Secrets // Insectile Aberration","set":"isd","collector_number":"51","layout":"transform",
            "card_faces":[{"image_uris":{"png":"https://f.png","normal":"https://f.jpg"}},{"image_uris":{"png":"https://b.png"}}]});
        let d = scryfall_card(&dfc).unwrap();
        assert_eq!(d.image_url, "https://f.png");
        assert_eq!(d.back_image_url.as_deref(), Some("https://b.png"));
    }

    #[test]
    fn ygo_alt_arts_become_results() {
        let v = json!({"data":[{"name":"Dark Magician","type":"Normal Monster","card_sets":[{"set_code":"CT13-EN003","set_name":"Tin"}],
            "card_images":[{"id":46986414,"image_url":"https://i/1.jpg","image_url_small":"https://i/s1.jpg"},{"id":36996508,"image_url":"https://i/2.jpg","image_url_small":"https://i/s2.jpg"}]}]});
        let r = ygo_results(&v);
        assert_eq!(r.len(), 2);
        assert_eq!(r[1].id, "36996508");
    }

    #[test]
    fn fab_printings_with_pitch() {
        let raw = vec![json!({"name":"Snatch","pitch":"1","types":["Generic","Action"],"printings":[
            {"unique_id":"u1","id":"WTR163","set_id":"WTR","image_url":"https://x/media/cards/large/WTR163.webp"},
            {"unique_id":"u2","id":"WTR163","set_id":"WTR","image_url":"https://x/media/cards/large/WTR163.webp"}]})];
        let r = fab_results(&raw);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name, "Snatch (red)");
        assert!(r[0].thumb_url.contains("/small/"));
    }

    #[test]
    fn local_search_ranks_exact_first() {
        let mk = |n: &str| CardResult {
            game: Game::Fab, id: n.into(), name: n.into(), set_code: String::new(), set_name: String::new(), number: String::new(),
            image_url: String::new(), thumb_url: String::new(), back_image_url: None, is_token: false, lang: String::new(),
        };
        let all = vec![mk("Big Snatch"), mk("Snatch"), mk("Snatcher")];
        let p = local_search(&all, "snatch", 0, "t");
        assert_eq!(p.results[0].name, "Snatch");
        assert_eq!(p.results.len(), 3);
    }

    #[test]
    fn pagination() {
        let mk = |i: usize| CardResult {
            game: Game::Swu, id: i.to_string(), name: i.to_string(), set_code: String::new(), set_name: String::new(), number: String::new(),
            image_url: String::new(), thumb_url: String::new(), back_image_url: None, is_token: false, lang: String::new(),
        };
        let p = paginate((0..130).map(mk).collect(), 2, "t");
        assert_eq!(p.results.len(), 10);
        assert!(!p.has_more);
    }

    /// Live smoke test against every bank: `cargo test -- --ignored live_banks`
    #[tokio::test]
    #[ignore]
    async fn live_banks() {
        let dir = tempfile::tempdir().unwrap();
        let p = Providers::new(dir.path().to_path_buf()).unwrap();
        for (g, q) in [
            (Game::Mtg, "lightning bolt"),
            (Game::Pokemon, "pikachu"),
            (Game::Yugioh, "dark magician"),
            (Game::Fab, "snatch"),
            (Game::Lorcana, "elsa"),
            (Game::Onepiece, "zoro"),
            (Game::Swu, "luke"),
            (Game::Digimon, "agumon"),
            (Game::Riftbound, "jinx"),
        ] {
            let r = p.search(g, q, 0, true).await.unwrap();
            assert!(!r.results.is_empty(), "{g:?} returned nothing");
            let bytes = p.get_bytes(&r.results[0].image_url).await.unwrap();
            assert!(bytes.len() > 5000, "{g:?} image too small");
            println!("{g:?}: {} results, first = {} ({} bytes)", r.results.len(), r.results[0].name, bytes.len());
        }
        let r = p.resolve(Game::Mtg, "Lightning Bolt", Some("2X2"), Some("117")).await.unwrap().unwrap();
        assert_eq!(r.number, "117");
    }
}
