import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FlipHorizontal2, ImagePlus, Layers, Minus, Plus, Trash2, Undo2 } from "lucide-react";
import { cardDpi, useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { api, errorText, fileUrl } from "../lib/ipc";
import { detectBleedMm } from "../lib/units";
import type { CardEntry, GridInfo } from "../lib/types";
import { cx, IconButton, NumberField } from "./ui";

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

export function DeckPanel() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const images = useApp((s) => s.images);
  const selected = useApp((s) => s.selectedCard);
  const profiles = useApp((s) => s.profiles);
  const { update, select } = useApp.getState();
  const [grid, setGrid] = useState<GridInfo | null>(null);
  const total = project.cards.reduce((a, c) => a + c.qty, 0);
  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const target = profile?.dpi ?? 600;

  useEffect(() => {
    api.gridInfo(project.layout, total).then(setGrid).catch(() => setGrid(null));
  }, [project.layout, total]);

  const setCard = (id: string, fn: (c: CardEntry) => CardEntry | null) =>
    update((p) => ({ ...p, cards: p.cards.map((c) => (c.id === id ? fn(c) : c)).filter(Boolean) as CardEntry[] }));

  const sel = project.cards.find((c) => c.id === selected);
  const back = project.layout.duplex.defaultBack;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="flex flex-1 flex-col gap-0.5">
          <h2 className="text-base font-semibold">{t("deck")}</h2>
          <span className="text-[11px] text-fg-3">
            {total} {t("cardsUnique", { u: project.cards.length, p: grid?.pages ?? 0 })}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {project.cards.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Layers className="text-fg-3" />
            <p className="text-sm font-medium">{t("emptyDeckTitle")}</p>
            <p className="text-xs leading-relaxed text-fg-3">{t("emptyDeckBody")}</p>
          </div>
        )}
        {project.cards.map((c) => {
          const im = images[c.front];
          const bleed = c.builtinBleedMm ?? (im ? detectBleedMm(im.meta.width, im.meta.height, project.layout.cardSize.width, project.layout.cardSize.height) : 0);
          const dpi = cardDpi(im?.meta, project.layout.cardSize.width, bleed);
          const low = dpi > 0 && dpi < target;
          return (
            <div
              key={c.id}
              onClick={() => select(c.id === selected ? null : c.id)}
              className={cx("group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5", c.id === selected ? "bg-surface-2" : "hover:bg-surface-2/60")}
            >
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

      {sel && (
        <div className="flex flex-col gap-3 border-t border-line p-4">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-xs font-semibold">{sel.name}</span>
            {sel.originalFront && (
              <IconButton icon={Undo2} label={t("revert")} onClick={() => setCard(sel.id, (x) => ({ ...x, front: x.originalFront!, back: x.originalBack ?? x.back, originalFront: null, originalBack: null }))} />
            )}
            <IconButton icon={Trash2} label={t("delete")} onClick={() => { setCard(sel.id, () => null); select(null); }} />
          </div>
          <div className="flex gap-2">
            <Face label={t("fronts")} id={sel.front} />
            <Face
              label={t("backs")}
              id={sel.back ?? null}
              onPick={async () => {
                const id = await pickImage();
                if (id) setCard(sel.id, (x) => ({ ...x, back: id }));
              }}
              onClear={sel.back ? () => setCard(sel.id, (x) => ({ ...x, back: null })) : undefined}
            />
          </div>
          <NumberField
            label={`${t("bleed")} (artwork)`}
            value={sel.builtinBleedMm ?? 0}
            unit="mm"
            min={0}
            max={10}
            onChange={(v) => setCard(sel.id, (x) => ({ ...x, builtinBleedMm: v || null }))}
          />
        </div>
      )}

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

function Face({ label, id, onPick, onClear }: { label: string; id: string | null; onPick?: () => void; onClear?: () => void }) {
  const images = useApp((s) => s.images);
  const im = id ? images[id] : undefined;
  return (
    <div className="flex flex-1 flex-col gap-1">
      <button
        disabled={!onPick}
        onClick={onPick}
        className="flex aspect-[63/88] items-center justify-center overflow-hidden rounded bg-surface-3 text-fg-3 enabled:hover:text-fg"
      >
        {im ? <img src={fileUrl(im.thumb)} alt={label} className="h-full w-full object-cover" /> : <ImagePlus size={16} />}
      </button>
      <div className="flex items-center justify-between text-[10px] text-fg-3">
        <span>{label}</span>
        {im && <span className="font-mono">{im.meta.width}×{im.meta.height}</span>}
        {onClear && (
          <button className="text-fg-3 hover:text-bad" onClick={onClear}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}
