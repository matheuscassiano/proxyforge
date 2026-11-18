import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Link2, Loader2, Search, SlidersHorizontal, Upload } from "lucide-react";
import { useApp } from "../../lib/store";
import { useT } from "../../lib/i18n";
import { api, errorText, onProgress } from "../../lib/ipc";
import type { CardResult, Game } from "../../lib/types";
import { Button, Chip, cx, ProgressBar, Segmented, Select, TextField, Toggle } from "../ui";

const LANGS = ["", "en", "pt", "es", "fr", "de", "it", "ja", "ko", "ru", "zhs", "zht"] as const;

function useStored<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) ?? initial;
    } catch {
      return initial;
    }
  });
  return [
    v,
    (x) => {
      setV(x);
      try {
        localStorage.setItem(key, x);
      } catch {
        /* ignore */
      }
    },
  ];
}

/** Magic search filters, turned into Scryfall syntax. */
interface MtgFilters {
  colors: string;
  exactColors: boolean;
  mv: string;
  type: string;
  rarity: string;
  set: string;
  promos: boolean;
  digital: boolean;
}
const NO_FILTERS: MtgFilters = { colors: "", exactColors: false, mv: "", type: "", rarity: "", set: "", promos: true, digital: false };

export function mtgQuery(q: string, f: MtgFilters): string {
  const parts = [q.trim()];
  const cl = f.colors.replace(/[MC]/g, "").toLowerCase();
  if (f.colors.includes("C")) parts.push("c:c");
  else if (f.colors.includes("M") && !cl) parts.push("c:m");
  if (cl) parts.push(f.exactColors ? `c=${cl}` : `c>=${cl}`);
  if (f.mv) parts.push(f.mv === "7" ? "mv>=7" : `mv=${f.mv}`);
  if (f.type.trim()) parts.push(`t:"${f.type.trim()}"`);
  if (f.rarity) parts.push(`r:${f.rarity}`);
  if (f.set.trim()) parts.push(`s:${f.set.trim().toLowerCase()}`);
  if (!f.promos) parts.push("-is:promo");
  if (!f.digital) parts.push("-is:digital");
  return parts.filter(Boolean).join(" ");
}

type Tab = "search" | "decklist" | "upload";

export function CardsPanel() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("search");
  return (
    <>
      <div className="flex flex-col gap-3.5 px-4 pt-4.5 pb-3.5">
        <h2 className="text-base font-semibold">{t("addCards")}</h2>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "search", label: t("search") },
            { value: "decklist", label: t("decklist") },
            { value: "upload", label: t("upload") },
          ]}
        />
      </div>
      {tab === "search" && <SearchTab />}
      {tab === "decklist" && <DecklistTab />}
      {tab === "upload" && <UploadTab />}
    </>
  );
}

function useGame(): [Game, (g: Game) => void] {
  const [game, setGame] = useState<Game>(() => {
    try {
      return (localStorage.getItem("game") as Game) || "mtg";
    } catch {
      return "mtg";
    }
  });
  return [
    game,
    (g) => {
      setGame(g);
      try {
        localStorage.setItem("game", g);
      } catch {
        /* ignore */
      }
    },
  ];
}

const SHORT: Record<string, string> = {
  mtg: "MTG",
  pokemon: "Pokémon",
  yugioh: "Yu-Gi-Oh!",
  fab: "FaB",
  lorcana: "Lorcana",
  onepiece: "One Piece",
  swu: "SWU",
  digimon: "Digimon",
  riftbound: "Riftbound",
};

function SearchTab() {
  const t = useT();
  const info = useApp((s) => s.info);
  const project = useApp((s) => s.project)!;
  const [game, setGame] = useGame();
  const [q, setQ] = useState("");
  const [allPrints, setAllPrints] = useState(true);
  const [lang, setLang] = useStored<string>("cardLang", "");
  const [filters, setFilters] = useState<MtgFilters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [setFilter, setSetFilter] = useState("");
  const activeFilters = game === "mtg" ? JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) : !!setFilter.trim();
  const [results, setResults] = useState<CardResult[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = async (p = 0) => {
    if (!q.trim()) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const query = game === "mtg" ? mtgQuery(q, filters) : q;
      const r = await api.searchCards(game, query, p, allPrints, { lang: lang || null });
      if (my !== seq.current) return;
      setResults(p === 0 ? r.results : [...results, ...r.results]);
      setHasMore(r.hasMore);
      setTotal(r.total ?? null);
      setSource(r.source);
      setPage(p);
    } catch (e) {
      if (my === seq.current) setError(errorText(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    setResults([]);
    if (q.trim()) run(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, allPrints, lang, filters]);

  const addedCount = (r: CardResult) =>
    project.cards.filter((c) => c.source?.game === r.game && c.source?.cardId === r.id).reduce((a, c) => a + c.qty, 0);

  const add = async (r: CardResult) => {
    setAdding(r.id);
    try {
      const entry = await api.fetchCard(r);
      await useApp.getState().addCards([entry]);
    } catch (e) {
      useApp.getState().toast("error", errorText(e));
    } finally {
      setAdding(null);
    }
  };

  const games = info?.games ?? [];
  return (
    <>
      <div className="flex flex-col gap-3 px-4 pb-3">
        <div className="flex flex-wrap gap-1.5">
          {games.map((g) => (
            <Chip key={g.game} active={g.game === game} onClick={() => setGame(g.game)} title={`${g.name} · ${g.source}${g.beta ? " · beta" : ""}`}>
              {SHORT[g.game] ?? g.name}
            </Chip>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(0);
          }}
          className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 focus-within:border-accent"
        >
          <Search size={16} className="text-fg-3" />
          <input
            aria-label={t("search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-3"
          />
          {loading && <Loader2 size={14} className="animate-spin text-fg-3" />}
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
            title={t("filters")}
            className={cx("relative rounded p-1", showFilters || activeFilters ? "text-accent" : "text-fg-3 hover:text-fg")}
          >
            <SlidersHorizontal size={14} />
            {activeFilters && <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
          </button>
        </form>
        <div className="flex items-center gap-3">
          {game === "mtg" && <Toggle checked={allPrints} onChange={setAllPrints} label={t("allPrints")} />}
          {(game === "mtg" || game === "pokemon") && (
            <select
              aria-label={t("cardLanguage")}
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="ml-auto h-7 rounded-md border border-line bg-surface-2 px-1.5 text-[11px] text-fg-2 outline-none"
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l ? l.toUpperCase() : t("langDefault")}
                </option>
              ))}
            </select>
          )}
        </div>
        {showFilters && game === "mtg" && (
          <div className="flex flex-col gap-2.5 rounded-md border border-line bg-surface-2/60 p-2.5">
            <div className="flex flex-wrap gap-1">
              {["W", "U", "B", "R", "G", "C", "M"].map((c) => (
                <Chip
                  key={c}
                  active={filters.colors.includes(c)}
                  onClick={() => setFilters({ ...filters, colors: filters.colors.includes(c) ? filters.colors.replace(c, "") : filters.colors + c })}
                >
                  {c}
                </Chip>
              ))}
              <Chip active={filters.exactColors} onClick={() => setFilters({ ...filters, exactColors: !filters.exactColors })} title={t("exactColorsHint")}>
                {t("exactColors")}
              </Chip>
            </div>
            <div className="flex gap-2">
              <Select
                className="flex-1"
                label={t("manaValue")}
                value={filters.mv}
                onChange={(v) => setFilters({ ...filters, mv: v })}
                options={["", "0", "1", "2", "3", "4", "5", "6", "7"].map((v) => ({ value: v, label: v === "" ? t("any") : v === "7" ? "7+" : v }))}
              />
              <Select
                className="flex-1"
                label={t("rarity")}
                value={filters.rarity}
                onChange={(v: string) => setFilters({ ...filters, rarity: v })}
                options={(["", "common", "uncommon", "rare", "mythic"] as const).map((v) => ({ value: v, label: v ? t(`rarity_${v}`) : t("any") }))}
              />
            </div>
            <div className="flex gap-2">
              <TextField className="flex-1" label={t("cardType")} value={filters.type} onChange={(v) => setFilters({ ...filters, type: v })} placeholder="creature, goblin…" />
              <TextField className="w-20" label={t("setCode")} value={filters.set} onChange={(v) => setFilters({ ...filters, set: v })} placeholder="2x2" />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <Toggle checked={filters.promos} onChange={(v) => setFilters({ ...filters, promos: v })} label={t("includePromos")} />
              <Toggle checked={filters.digital} onChange={(v) => setFilters({ ...filters, digital: v })} label={t("includeDigital")} />
            </div>
            {activeFilters && (
              <button className="self-start text-[11px] font-medium text-accent" onClick={() => setFilters(NO_FILTERS)}>
                {t("clearFilters")}
              </button>
            )}
          </div>
        )}
        {showFilters && game !== "mtg" && (
          <TextField label={t("setCode")} value={setFilter} onChange={setSetFilter} placeholder="SV1, OP01…" />
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {error && <p className="text-xs text-bad">{error}</p>}
        {total !== null && !error && (
          <p className="text-[11px] text-fg-3">
            {total} {t("results")} · {source}
          </p>
        )}
        {!loading && total === 0 && <p className="text-xs text-fg-3">{t("noResults")}</p>}
        <div className="grid grid-cols-3 gap-2.5">
          {results.filter((r) => game === "mtg" || !setFilter.trim() || r.setCode.toLowerCase().startsWith(setFilter.trim().toLowerCase())).map((r) => {
            const n = addedCount(r);
            return (
              <button
                key={`${r.id}-${r.imageUrl}`}
                onClick={() => add(r)}
                disabled={adding === r.id}
                title={`${r.name} · ${r.setName}`}
                className="group flex flex-col gap-1.5 text-left"
              >
                <div className={cx("relative aspect-[63/88] w-full overflow-hidden rounded-md bg-surface-3", n > 0 && "ring-2 ring-accent")}>
                  <img src={r.thumbUrl || r.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]" draggable={false} />
                  {n > 0 && <span className="absolute right-1.5 bottom-1.5 rounded bg-accent px-1.5 text-[10px] font-bold text-on-accent">×{n}</span>}
                  {adding === r.id && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <Loader2 size={18} className="animate-spin" />
                    </span>
                  )}
                </div>
                <span className="truncate text-[11px] font-medium">{r.name}</span>
                <span className="-mt-1 truncate font-mono text-[10px] text-fg-3">
                  {r.setCode}
                  {r.number && r.number !== r.id ? ` · ${r.number}` : ""}
                </span>
              </button>
            );
          })}
        </div>
        {hasMore && (
          <Button variant="secondary" onClick={() => run(page + 1)} disabled={loading}>
            {t("loadMore")}
          </Button>
        )}
      </div>
    </>
  );
}

function DecklistTab() {
  const t = useT();
  const info = useApp((s) => s.info);
  const [game, setGame] = useGame();
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ p: number; m: string } | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [lang, setLang] = useStored<string>("importLang", "");
  const [tokens, setTokens] = useStored<"1" | "0">("importTokens", "0");
  const opts = { lang: lang || null, tokens: tokens === "1" };

  useEffect(() => {
    const un = onProgress((e) => e.task === "import" && setProgress({ p: e.progress, m: e.message }));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const finish = async (r: { entries: import("../../lib/types").CardEntry[]; missing: string[] }) => {
    await useApp.getState().addCards(r.entries);
    setMissing(r.missing);
    useApp.getState().toast("success", `+${r.entries.reduce((a, e) => a + e.qty, 0)} ${t("cards").toLowerCase()}`);
  };

  const importText = async () => {
    setBusy(true);
    setMissing([]);
    try {
      await finish(await api.importDecklist(game, text, "text", opts));
    } catch (e) {
      useApp.getState().toast("error", errorText(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const importUrl = async () => {
    setBusy(true);
    setMissing([]);
    try {
      await finish(await api.importDeckUrl(url, opts));
    } catch (e) {
      useApp.getState().toast("error", errorText(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const loadFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Decklist", extensions: ["txt", "dek", "ydk", "xml", "csv"] }] });
    if (!path || Array.isArray(path)) return;
    const { readTextFile } = await import("./readText");
    setText(await readTextFile(path));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
      <Select
        label="Game"
        value={game}
        onChange={setGame}
        options={(info?.games ?? []).map((g) => ({ value: g.game, label: g.name }))}
      />
      <textarea
        aria-label={t("paste")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"4 Lightning Bolt (2X2) 117\n2 Counterspell lang:ja\n…\n\n.ydk, CSV and MPC Autofill XML also work"}
        className="min-h-[220px] flex-1 resize-none rounded-md border border-line bg-surface-2 p-2.5 font-mono text-xs leading-relaxed outline-none placeholder:text-fg-3 focus:border-accent"
      />
      <div className="flex items-end gap-3">
        {(game === "mtg" || game === "pokemon") && (
          <Select
            className="w-32"
            label={t("cardLanguage")}
            value={lang}
            onChange={setLang}
            options={LANGS.map((l) => ({ value: l, label: l ? l.toUpperCase() : t("langDefault") }))}
          />
        )}
        {game === "mtg" && <Toggle checked={tokens === "1"} onChange={(v) => setTokens(v ? "1" : "0")} label={t("importTokens")} />}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={loadFile} disabled={busy}>
          {t("choose")}
        </Button>
        <Button variant="primary" className="flex-1" onClick={importText} disabled={busy || !text.trim()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          {t("import")}
        </Button>
      </div>
      {progress && (
        <div className="flex flex-col gap-1.5">
          <ProgressBar value={progress.p} />
          <div className="flex justify-between text-[11px] text-fg-3">
            <span className="truncate">{progress.m}</span>
            <button className="text-fg-2 hover:text-fg" onClick={() => api.cancelTask()}>
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
        <span className="text-xs font-medium text-fg-2">{t("importUrl")}</span>
        <div className="flex gap-2">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 focus-within:border-accent">
            <Link2 size={14} className="text-fg-3" />
            <input aria-label={t("importUrl")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://archidekt.com/decks/…" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-fg-3" />
          </div>
          <Button onClick={importUrl} disabled={busy || !url.trim()}>
            {t("import")}
          </Button>
        </div>
      </div>
      {missing.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-bad/10 p-2.5 text-xs">
          <span className="font-semibold text-bad">
            {t("missing")} ({missing.length})
          </span>
          {missing.map((m) => (
            <span key={m} className="text-fg-2">
              {m}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function UploadTab() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    const paths = await open({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "avif"] }] });
    if (!paths) return;
    setBusy(true);
    try {
      const entries = await api.importImages(Array.isArray(paths) ? paths : [paths], project.layout.cardSize);
      await useApp.getState().addCards(entries);
    } catch (e) {
      useApp.getState().toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-1 flex-col px-4 pb-4">
      <button
        onClick={choose}
        disabled={busy}
        className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-line p-6 text-center text-fg-2 hover:border-accent hover:text-fg"
      >
        {busy ? <Loader2 className="animate-spin" /> : <Upload size={28} />}
        <span className="text-sm font-medium text-fg">{t("choose")}</span>
        <span className="text-xs leading-relaxed text-fg-3">{t("uploadHint")}</span>
      </button>
    </div>
  );
}
