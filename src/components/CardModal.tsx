import { useEffect, useMemo, useState } from "react";
import { Check, FileImage, ImagePlus, Layers, Loader2, Trash2, Undo2, X } from "lucide-react";
import { cardDpi, useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { api, errorText, fileUrl } from "../lib/ipc";
import { detectBleedMm } from "../lib/units";
import type { CardEntry, CardResult } from "../lib/types";
import { pickImage } from "./DeckPanel";
import { Button, Chip, cx, Modal, NumberField, TextField, Toggle } from "./ui";

type Tab = "settings" | "prints" | "versions";

/** Details of one deck card: settings, alternative prints and image versions. */
export function CardModal() {
  const t = useT();
  const id = useApp((s) => s.cardModal)!;
  const project = useApp((s) => s.project)!;
  const images = useApp((s) => s.images);
  const { update, openCard } = useApp.getState();
  const card = project.cards.find((c) => c.id === id);
  const [tab, setTab] = useState<Tab>("settings");

  // the card can disappear (deleted, undo, moved into another entry)
  useEffect(() => {
    if (!card) openCard(null);
  }, [card, openCard]);
  if (!card) return null;

  const im = images[card.front];
  const { cardSize } = project.layout;
  const bleed = card.builtinBleedMm ?? (im ? detectBleedMm(im.meta.width, im.meta.height, cardSize.width, cardSize.height) : 0);
  const dpi = cardDpi(im?.meta, cardSize.width, bleed);
  const setCard = (fn: (c: CardEntry) => CardEntry) => update((p) => ({ ...p, cards: p.cards.map((c) => (c.id === id ? fn(c) : c)) }));
  const close = () => openCard(null);

  const sub = [
    card.source ? card.source.game.toUpperCase() : t("upload"),
    card.source?.setCode,
    card.source?.number && `#${card.source.number}`,
    card.back && t("dfc"),
    `${card.qty}×`,
    dpi ? `${dpi} DPI` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Modal
      title={card.name}
      subtitle={sub}
      width={760}
      onClose={close}
      leading={im ? <img src={fileUrl(im.thumb)} alt="" className="h-[50px] w-9 shrink-0 rounded-[3px] object-cover" /> : <div className="h-[50px] w-9 shrink-0 rounded-[3px] bg-surface-3" />}
      tabs={
        <div role="tablist" className="flex gap-1 border-b border-line px-5">
          {(["settings", "prints", "versions"] as Tab[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cx("-mb-px border-b-2 px-3 py-2.5 text-xs font-semibold", tab === k ? "border-accent text-accent" : "border-transparent text-fg-2 hover:text-fg")}
            >
              {t(k === "settings" ? "cardSettings" : k === "prints" ? "prints" : "versions")}
            </button>
          ))}
        </div>
      }
      footer={
        <>
          <Button
            icon={Trash2}
            className="text-bad"
            onClick={() => {
              update((p) => ({ ...p, cards: p.cards.filter((c) => c.id !== id) }));
              useApp.getState().select(null);
              close();
            }}
          >
            {t("removeCard")}
          </Button>
          {card.originalFront && (
            <Button icon={Undo2} onClick={() => setCard((x) => ({ ...x, front: x.originalFront!, back: x.originalBack ?? x.back, originalFront: null, originalBack: null }))}>
              {t("revert")}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="primary" icon={Check} onClick={close}>
            {t("done")}
          </Button>
        </>
      }
    >
      {tab === "settings" && <SettingsTab card={card} setCard={setCard} />}
      {tab === "prints" && <PrintsTab card={card} setCard={setCard} />}
      {tab === "versions" && <VersionsTab card={card} setCard={setCard} />}
    </Modal>
  );
}

interface TabProps {
  card: CardEntry;
  setCard: (fn: (c: CardEntry) => CardEntry) => void;
}

function Thumb({ id, label, onClick, active }: { id?: string | null; label: string; onClick?: () => void; active?: boolean }) {
  const images = useApp((s) => s.images);
  const im = id ? images[id] : undefined;
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      title={label}
      className={cx(
        "flex aspect-[63/88] w-full items-center justify-center overflow-hidden rounded bg-surface-3 text-fg-3 enabled:hover:text-fg",
        active && "ring-2 ring-accent",
      )}
    >
      {im ? <img src={fileUrl(im.thumb)} alt={label} className="h-full w-full object-cover" draggable={false} /> : <ImagePlus size={16} />}
    </button>
  );
}

function SettingsTab({ card, setCard }: TabProps) {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const images = useApp((s) => s.images);
  const { update } = useApp.getState();
  const [name, setName] = useState(card.name);
  const [backPicker, setBackPicker] = useState(false);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [asDefault, setAsDefault] = useState(false);
  const [removeFront, setRemoveFront] = useState(true);
  const others = project.cards.filter((c) => c.id !== card.id);
  const front = images[card.front];
  const back = card.back ? images[card.back] : undefined;

  const applyAsBack = () => {
    const n = targets.size + (asDefault ? 1 : 0);
    if (!n) return;
    update((p) => {
      const cards = p.cards
        .map((c) => (targets.has(c.id) ? { ...c, back: card.front } : c))
        .filter((c) => !(removeFront && c.id === card.id));
      const duplex = { ...p.layout.duplex, enabled: true, defaultBack: asDefault ? card.front : p.layout.duplex.defaultBack };
      return { ...p, cards, layout: { ...p.layout, duplex } };
    });
    useApp.getState().toast("success", t("backApplied", { n }));
    if (removeFront) useApp.getState().openCard(null);
    setTargets(new Set());
    setAsDefault(false);
  };

  return (
    <div className="flex gap-5">
      <div className="flex w-[220px] shrink-0 flex-col gap-2.5">
        <div className="flex gap-2.5">
          <div className="flex flex-1 flex-col gap-1">
            <Thumb
              id={card.front}
              label={t("fronts")}
              onClick={async () => {
                const img = await pickImage();
                if (img) setCard((x) => ({ ...x, front: img, originalFront: null, originalBack: null, builtinBleedMm: null }));
              }}
            />
            <span className="truncate text-[10px] text-fg-3">
              {t("fronts")}
              {front && ` · ${front.meta.width}×${front.meta.height}`}
            </span>
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Thumb id={card.back} label={t("backs")} onClick={() => setBackPicker((v) => !v)} active={backPicker} />
            <span className="truncate text-[10px] text-fg-3">
              {t("backs")}
              {back ? ` · ${back.meta.width}×${back.meta.height}` : project.layout.duplex.defaultBack ? ` · ${t("defaultBack")}` : ""}
            </span>
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            icon={FileImage}
            className="flex-1 justify-center"
            onClick={async () => {
              const img = await pickImage();
              if (img) setCard((x) => ({ ...x, back: img }));
            }}
          >
            {t("file")}
          </Button>
          <Button size="sm" icon={Layers} className={cx("flex-1 justify-center", backPicker && "text-accent")} disabled={!others.length} onClick={() => setBackPicker((v) => !v)}>
            {t("fromDeck")}
          </Button>
          {card.back && <Button size="sm" icon={X} aria-label={t("removeBack")} onClick={() => setCard((x) => ({ ...x, back: null }))} />}
        </div>
        {backPicker && (
          <div className="grid max-h-[220px] grid-cols-4 gap-1.5 overflow-y-auto rounded-md bg-surface-2 p-1.5">
            {others.map((o) => (
              <Thumb
                key={o.id}
                id={o.front}
                label={o.name}
                active={card.back === o.front}
                onClick={() => {
                  setCard((x) => ({ ...x, back: o.front }));
                  update((p) => ({ ...p, layout: { ...p.layout, duplex: { ...p.layout.duplex, enabled: true } } }), { history: false });
                  setBackPicker(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <section className="flex flex-col gap-2.5">
          <h3 className="section-title">{t("card")}</h3>
          <div className="flex gap-2.5">
            <div className="flex-1" onBlur={() => name.trim() && name !== card.name && setCard((x) => ({ ...x, name: name.trim() }))}>
              <TextField label={t("name")} value={name} onChange={setName} />
            </div>
            <NumberField className="w-[90px]" label={t("copies")} value={card.qty} min={1} max={999} step={1} onChange={(v) => setCard((x) => ({ ...x, qty: Math.max(1, Math.round(v)) }))} />
            <NumberField className="w-[100px]" label={t("artBleed")} unit="mm" value={card.builtinBleedMm ?? 0} min={0} max={10} onChange={(v) => setCard((x) => ({ ...x, builtinBleedMm: v || null }))} />
          </div>
          <Toggle checked={card.isToken} onChange={(v) => setCard((x) => ({ ...x, isToken: v }))} label={t("token")} />
        </section>

        <section className="flex flex-col gap-2.5">
          <h3 className="section-title">{t("useAsBackOf")}</h3>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={asDefault} onClick={() => setAsDefault(!asDefault)}>
              {t("defaultBack")}
            </Chip>
            {others.map((o) => (
              <Chip
                key={o.id}
                active={targets.has(o.id)}
                onClick={() =>
                  setTargets((s) => {
                    const n = new Set(s);
                    if (n.has(o.id)) n.delete(o.id);
                    else n.add(o.id);
                    return n;
                  })
                }
              >
                {o.name}
              </Chip>
            ))}
          </div>
          <Toggle checked={removeFront} onChange={setRemoveFront} label={t("removeFromFronts")} />
          <div>
            <Button variant="primary" size="sm" disabled={!targets.size && !asDefault} onClick={applyAsBack}>
              {t("applyBack", { n: targets.size + (asDefault ? 1 : 0) })}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function PrintsTab({ card, setCard }: TabProps) {
  const t = useT();
  const [results, setResults] = useState<CardResult[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const src = card.source;
  const query = src ? (src.game === "mtg" ? `!"${card.name}"` : card.name) : "";

  useEffect(() => {
    if (!src) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .searchCards(src.game, query, page, true)
      .then((r) => {
        if (!alive) return;
        setResults((prev) => (page === 1 ? r.results : [...prev, ...r.results]));
        setHasMore(r.hasMore);
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [src, query, page]);

  if (!src) return <p className="rounded-md bg-surface-2 p-3 text-xs text-fg-2">{t("noPrintsUpload")}</p>;

  const choose = async (r: CardResult) => {
    setBusy(r.id);
    try {
      const e = await api.fetchCard(r);
      await useApp.getState().ensureImages([e.front, e.back ?? ""].filter(Boolean));
      setCard((x) => ({ ...x, front: e.front, back: e.back ?? x.back, source: e.source, builtinBleedMm: e.builtinBleedMm ?? null, originalFront: null, originalBack: null }));
    } catch (err) {
      useApp.getState().toast("error", errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="grid grid-cols-5 gap-2.5">
        {results.map((r) => {
          const current = r.id === src.cardId;
          return (
            <button
              key={r.id}
              onClick={() => !current && choose(r)}
              className={cx("group flex flex-col gap-1 text-left", current && "cursor-default")}
              title={`${r.setName} · #${r.number}`}
            >
              <span className={cx("relative block aspect-[63/88] overflow-hidden rounded bg-surface-3", current ? "ring-2 ring-accent" : "group-hover:ring-2 group-hover:ring-fg-3")}>
                <img src={r.thumbUrl} alt={r.name} loading="lazy" className="h-full w-full object-cover" />
                {busy === r.id && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 size={16} className="animate-spin text-accent" />
                  </span>
                )}
              </span>
              <span className="truncate font-mono text-[10px] text-fg-3">
                {r.setCode} · #{r.number}
                {current && ` · ${t("inUse")}`}
              </span>
            </button>
          );
        })}
      </div>
      {loading && <Loader2 size={16} className="mx-auto animate-spin text-accent" />}
      {!loading && !results.length && !error && <p className="text-xs text-fg-3">{t("noResults")}</p>}
      {hasMore && !loading && (
        <Button size="sm" className="self-center" onClick={() => setPage((p) => p + 1)}>
          {t("loadMore")}
        </Button>
      )}
    </div>
  );
}

function VersionsTab({ card, setCard }: TabProps) {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const images = useApp((s) => s.images);
  const { cardSize } = project.layout;

  // current artwork, then what it was made from, back to the original
  const chain = useMemo(() => {
    const out: string[] = [];
    let id: string | null | undefined = card.front;
    while (id && !out.includes(id)) {
      out.push(id);
      id = images[id]?.meta.derivedFrom;
    }
    if (card.originalFront && !out.includes(card.originalFront)) out.push(card.originalFront);
    return out;
  }, [card.front, card.originalFront, images]);

  useEffect(() => {
    useApp.getState().ensureImages(chain);
  }, [chain]);

  const original = card.originalFront ?? chain[chain.length - 1];
  return (
    <div className="flex flex-col gap-2">
      {chain.map((v) => {
        const im = images[v];
        const b = card.builtinBleedMm ?? (im ? detectBleedMm(im.meta.width, im.meta.height, cardSize.width, cardSize.height) : 0);
        const dpi = cardDpi(im?.meta, cardSize.width, b);
        const inUse = v === card.front;
        return (
          <div key={v} className={cx("flex items-center gap-3 rounded-md p-2", inUse ? "bg-accent-soft" : "bg-surface-2")}>
            {im ? <img src={fileUrl(im.thumb)} alt="" className="h-[56px] w-10 rounded-[2px] object-cover" /> : <div className="h-[56px] w-10 rounded-[2px] bg-surface-3" />}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-xs font-semibold">{v === original ? t("versionOriginal") : im?.meta.note || t("versionUpscaled")}</span>
              <span className="font-mono text-[11px] text-fg-3">
                {im ? `${im.meta.width}×${im.meta.height} px · ${dpi} DPI` : "…"}
              </span>
            </div>
            {inUse ? (
              <span className="text-[11px] font-semibold text-accent">{t("inUse")}</span>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  setCard((x) =>
                    v === original
                      ? { ...x, front: v, back: x.originalBack ?? x.back, originalFront: null, originalBack: null }
                      : { ...x, front: v, originalFront: x.originalFront ?? original },
                  )
                }
              >
                {t("useVersion")}
              </Button>
            )}
          </div>
        );
      })}
      {chain.length === 1 && <p className="text-xs text-fg-3">{t("noVersions")}</p>}
    </div>
  );
}
