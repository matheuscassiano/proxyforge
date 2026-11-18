import { useRef, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FlipHorizontal2, GripVertical, ImagePlus, Layers, Minus, Plus, Trash2 } from "lucide-react";
import { cardDpi, useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { translate, type Key } from "../lib/i18n-core";
import { api, errorText, fileUrl } from "../lib/ipc";
import { moveEntry } from "../lib/deck";
import { detectBleedMm } from "../lib/units";
import type { CardEntry } from "../lib/types";
import { usePageMap } from "./usePageMap";
import { cx, IconButton } from "./ui";

const IMAGE_FILTER = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "avif"] }];

export async function pickImage(): Promise<string | null> {
  const s = useApp.getState();
  const path = await open({ multiple: false, filters: IMAGE_FILTER });
  if (!path || Array.isArray(path)) return null;
  try {
    const [entry] = await api.importImages([path], s.project!.layout.cardSize);
    await s.ensureImages([entry.front]);
    return entry.front;
  } catch (e) {
    s.toast("error", errorText(e));
    return null;
  }
}

/** Remove every card from the deck (undoable). */
export async function clearDeck() {
  const s = useApp.getState();
  const p = s.project;
  if (!p?.cards.length) return;
  const n = p.cards.reduce((a, c) => a + c.qty, 0);
  const tr = (k: Key, v?: Record<string, string | number>) => translate(s.lang, k, v);
  if (!(await ask(tr("confirmClear", { n }), { kind: "warning" }))) return;
  s.update((x) => ({ ...x, cards: [] }));
  s.select(null);
  s.toast("info", tr("deckCleared", { n }), { label: tr("undo"), run: () => useApp.getState().undo() });
}

export function DeckPanel() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const images = useApp((s) => s.images);
  const selected = useApp((s) => s.selectedCard);
  const profiles = useApp((s) => s.profiles);
  const width = useApp((s) => s.paneWidths.right);
  const { update, openCard } = useApp.getState();
  const pages = usePageMap();
  const total = project.cards.reduce((a, c) => a + c.qty, 0);
  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const target = profile?.dpi ?? 600;

  const setCard = (id: string, fn: (c: CardEntry) => CardEntry | null) =>
    update((p) => ({ ...p, cards: p.cards.map((c) => (c.id === id ? fn(c) : c)).filter(Boolean) as CardEntry[] }));

  const back = project.layout.duplex.defaultBack;

  // ----- drag to reorder rows (pointer events: HTML5 DnD is taken by the OS file drop)
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; y: number; moved: boolean } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const rowIndexAt = (clientY: number) => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length - 1;
  };
  const onGripDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { from: i, y: e.clientY, moved: false };
  };
  const onGripMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < 4) return;
    d.moved = true;
    setDragFrom(d.from);
    setDropAt(rowIndexAt(e.clientY));
  };
  const onGripUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && dropAt !== null && dropAt !== d.from) update((p) => ({ ...p, cards: moveEntry(p.cards, d.from, dropAt) }));
    setDragFrom(null);
    setDropAt(null);
  };

  return (
    <aside style={{ width }} className="flex shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-base font-semibold">{t("deck")}</h2>
          <span className="truncate text-[11px] text-fg-3">
            {total} {t("cardsUnique", { u: project.cards.length, p: pages.length })}
          </span>
        </div>
        {project.cards.length > 0 && (
          <button
            onClick={clearDeck}
            className="flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2 text-[11px] font-medium text-fg-2 hover:bg-bad/15 hover:text-bad"
            title={t("clearDeck")}
          >
            <Trash2 size={13} /> {t("clear")}
          </button>
        )}
      </div>

      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {project.cards.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Layers className="text-fg-3" />
            <p className="text-sm font-medium">{t("emptyDeckTitle")}</p>
            <p className="text-xs leading-relaxed text-fg-3">{t("emptyDeckBody")}</p>
          </div>
        )}
        {project.cards.map((c, i) => {
          const im = images[c.front];
          const bleed = c.builtinBleedMm ?? (im ? detectBleedMm(im.meta.width, im.meta.height, project.layout.cardSize.width, project.layout.cardSize.height) : 0);
          const dpi = cardDpi(im?.meta, project.layout.cardSize.width, bleed);
          const low = dpi > 0 && dpi < target;
          const before = dragFrom !== null && dropAt === i && dropAt < dragFrom;
          const after = dragFrom !== null && dropAt === i && dropAt > dragFrom;
          return (
            <div
              key={c.id}
              data-row
              onClick={() => openCard(c.id)}
              className={cx(
                "group relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 pl-0.5",
                c.id === selected ? "bg-surface-2" : "hover:bg-surface-2/60",
                dragFrom === i && "opacity-40",
                before && "shadow-[inset_0_2px_0_var(--color-accent)]",
                after && "shadow-[inset_0_-2px_0_var(--color-accent)]",
              )}
            >
              <span
                role="button"
                aria-label={t("dragToReorder")}
                title={t("dragToReorder")}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => onGripDown(e, i)}
                onPointerMove={onGripMove}
                onPointerUp={onGripUp}
                onPointerCancel={onGripUp}
                className="flex h-8 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-fg-3 opacity-0 group-hover:opacity-100 active:cursor-grabbing"
              >
                <GripVertical size={13} />
              </span>
              {im ? (
                <img src={fileUrl(im.thumb)} alt="" className="h-[42px] w-[30px] shrink-0 rounded-[2px] object-cover" draggable={false} />
              ) : (
                <div className="h-[42px] w-[30px] shrink-0 rounded-[2px] bg-surface-3" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium">{c.name}</span>
                <span className="flex items-center gap-1 truncate text-[11px] text-fg-3">
                  {c.source ? `${c.source.setCode}${c.source.number ? ` · #${c.source.number}` : ""}` : t("upload")}
                  {c.back && ` · ${t("dfc")}`}
                  {c.isToken && ` · ${t("token")}`}
                  {low && (
                    <span className="ml-1 inline-flex items-center gap-0.5 text-accent" title={`${dpi} DPI`}>
                      <AlertTriangle size={10} /> {dpi}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center rounded-md bg-surface-2" onClick={(e) => e.stopPropagation()}>
                <button aria-label="Decrease" className="flex h-6 w-6 items-center justify-center text-fg-3 hover:text-fg" onClick={() => setCard(c.id, (x) => (x.qty <= 1 ? null : { ...x, qty: x.qty - 1 }))}>
                  <Minus size={13} />
                </button>
                <span className="min-w-[18px] text-center font-mono text-xs font-semibold">{c.qty}</span>
                <button aria-label="Increase" className="flex h-6 w-6 items-center justify-center text-fg-3 hover:text-fg" onClick={() => setCard(c.id, (x) => ({ ...x, qty: x.qty + 1 }))}>
                  <Plus size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2.5 border-t border-line p-4">
        <button
          onClick={async () => {
            const id = await pickImage();
            if (id) update((p) => ({ ...p, layout: { ...p.layout, duplex: { ...p.layout.duplex, defaultBack: id, enabled: true } } }));
          }}
          className="flex h-[42px] w-[30px] shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-surface-3 text-fg-3 hover:text-fg"
          title={t("chooseBack")}
        >
          {back && images[back] ? <img src={fileUrl(images[back].thumb)} alt="" className="h-full w-full object-cover" /> : <ImagePlus size={14} />}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs font-medium">{t("defaultBack")}</span>
          <span className="truncate text-[11px] text-fg-3">
            {project.layout.duplex.enabled
              ? `${t("duplex")} · ${t(project.layout.duplex.flip)} · ${project.layout.duplex.offsetXMm} / ${project.layout.duplex.offsetYMm} mm`
              : `${t("duplex")}: off`}
          </span>
        </div>
        {back && (
          <IconButton
            icon={FlipHorizontal2}
            label={t("removeBack")}
            onClick={() => update((p) => ({ ...p, layout: { ...p.layout, duplex: { ...p.layout.duplex, defaultBack: null } } }))}
          />
        )}
      </div>
    </aside>
  );
}
