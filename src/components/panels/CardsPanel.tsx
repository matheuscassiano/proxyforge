import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Link2, Loader2, Search, Upload } from "lucide-react";
import { useApp } from "../../lib/store";
import { useT } from "../../lib/i18n";
import { api, errorText, onProgress } from "../../lib/ipc";
import type { CardResult, Game } from "../../lib/types";
import { Button, Chip, cx, ProgressBar, Segmented, Select, Toggle } from "../ui";

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
      const r = await api.searchCards(game, q, p, allPrints);
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
  }, [game, allPrints]);

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
        </form>
        {game === "mtg" && <Toggle checked={allPrints} onChange={setAllPrints} label={t("allPrints")} />}
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
          {results.map((r) => {
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
      await finish(await api.importDecklist(game, text, "text"));
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
      await finish(await api.importDeckUrl(url));
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
        placeholder={"4 Lightning Bolt (2X2) 117\n2 Counterspell\n…\n\n.ydk and MPC Autofill XML also work"}
        className="min-h-[220px] flex-1 resize-none rounded-md border border-line bg-surface-2 p-2.5 font-mono text-xs leading-relaxed outline-none placeholder:text-fg-3 focus:border-accent"
      />
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
