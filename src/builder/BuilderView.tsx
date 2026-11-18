import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  Circle,
  Copy,
  Eye,
  EyeOff,
  Grid2x2Check,
  Image as ImageIcon,
  ImageDown,
  Loader2,
  Lock,
  LockOpen,
  Magnet,
  Maximize,
  Plus,
  Redo2,
  Square,
  Star,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useApp } from "../lib/store";
import { api, errorText } from "../lib/ipc";
import type { CardEntry } from "../lib/types";
import { Button, cx, IconButton } from "../components/ui";
import { ResizeHandle } from "../components/ResizeHandle";
import { CanvasEditor } from "./CanvasEditor";
import { Properties } from "./Properties";
import { exportPng, loadAssets, renderDesign } from "./render";
import { loadBundledFonts } from "./fonts";
import { cloneLayer, createDesign, newLayer } from "./templates";
import type { CardDesign, Layer } from "./types";
import { NewCardWizard } from "./NewCardWizard";
import { TcgPanel } from "./TcgPanel";
import { capture, detach, resetOverrides } from "./tcg/sync";
import { profileFor } from "./tcg/registry";
import { useBi } from "./bi";
import { FileDown, FileUp, FolderDown, Link2 } from "lucide-react";

const KIND_ICON = { text: Type, image: ImageIcon, rect: Square, ellipse: Circle, polygon: Star } as const;

export function BuilderView() {
  const T = useBi();
  const project = useApp((s) => s.project)!;
  const paneWidths = useApp((s) => s.paneWidths);
  const profiles = useApp((s) => s.profiles);
  const { update, undo, redo, toast, ensureImages } = useApp.getState();
  const past = useApp((s) => s.past.length);
  const future = useApp((s) => s.future.length);
  const designs = (project.designs ?? []) as CardDesign[];
  const [activeId, setActiveId] = useState<string | null>(designs[0]?.id ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState<CardDesign | null>(null);
  const [picker, setPicker] = useState(designs.length === 0);
  const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [focusText, setFocusText] = useState(0);
  const [busy, setBusy] = useState(false);
  const dragLayer = useRef<string | null>(null);

  useEffect(() => {
    loadBundledFonts();
  }, []);

  const stored = designs.find((d) => d.id === activeId) ?? designs[0] ?? null;
  const design = live && live.id === stored?.id ? live : stored;
  const layer = design?.layers.find((l) => l.id === selected) ?? null;

  // ---------------------------------------------------------------- mutations (go through project history)
  const commit = useCallback(
    (next: CardDesign) => {
      setLive(null);
      update((p) => ({
        ...p,
        designs: ((p.designs ?? []) as CardDesign[]).map((d) => {
          if (d.id !== next.id) return d;
          // TCG designs: canvas edits of generated layers become overrides / field values
          const synced = next.tcg ? capture(d, next) : next;
          return { ...synced, updatedAt: new Date().toISOString() };
        }),
      }));
    },
    [update],
  );
  /** Commit a design that is already in sync (no override capture). */
  const commitRaw = useCallback(
    (next: CardDesign) => {
      setLive(null);
      update((p) => ({ ...p, designs: ((p.designs ?? []) as CardDesign[]).map((d) => (d.id === next.id ? { ...next, updatedAt: new Date().toISOString() } : d)) }));
    },
    [update],
  );
  const mutate = (fn: (d: CardDesign) => CardDesign) => design && commit(fn(structuredClone(design)));
  const setLayer = (id: string, patch: Partial<Layer>) => mutate((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) }));
  const addLayer = (kind: Parameters<typeof newLayer>[0]) => {
    if (!design) return;
    const l = newLayer(kind, design);
    mutate((d) => ({ ...d, layers: [...d.layers, l] }));
    setSelected(l.id);
  };
  const removeLayer = (id: string) => {
    mutate((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== id) }));
    setSelected(null);
  };
  const duplicateLayer = (id: string) => {
    if (!design) return;
    const src = design.layers.find((l) => l.id === id);
    if (!src) return;
    const c = cloneLayer(src);
    mutate((d) => {
      const i = d.layers.findIndex((l) => l.id === id);
      const layers = [...d.layers];
      layers.splice(i + 1, 0, c);
      return { ...d, layers };
    });
    setSelected(c.id);
  };
  const reorder = (id: string, dir: 1 | -1) =>
    mutate((d) => {
      const i = d.layers.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.layers.length) return d;
      const layers = [...d.layers];
      [layers[i], layers[j]] = [layers[j], layers[i]];
      return { ...d, layers };
    });
  const moveTo = (id: string, targetId: string) =>
    mutate((d) => {
      const from = d.layers.findIndex((l) => l.id === id);
      const to = d.layers.findIndex((l) => l.id === targetId);
      if (from < 0 || to < 0 || from === to) return d;
      const layers = [...d.layers];
      const [m] = layers.splice(from, 1);
      layers.splice(to, 0, m);
      return { ...d, layers };
    });

  const addDesign = (d: CardDesign) => {
    update((p) => ({ ...p, designs: [...((p.designs ?? []) as CardDesign[]), d] }));
    setActiveId(d.id);
    setSelected(null);
    setPicker(false);
  };
  const createFrom = (templateId: string, color: string) => {
    const l = project.layout.cardSize;
    addDesign(createDesign(templateId, l.width, l.height, 3, color));
  };
  const duplicateDesign = (d: CardDesign) => {
    const copy: CardDesign = { ...structuredClone(d), id: crypto.randomUUID(), name: `${d.name} (cópia)` };
    update((p) => ({ ...p, designs: [...((p.designs ?? []) as CardDesign[]), copy] }));
    setActiveId(copy.id);
  };
  const deleteDesign = (d: CardDesign) => {
    update((p) => ({
      ...p,
      designs: ((p.designs ?? []) as CardDesign[]).filter((x) => x.id !== d.id).map((x) => (x.backId === d.id ? { ...x, backId: null } : x)),
    }));
    setActiveId(designs.find((x) => x.id !== d.id)?.id ?? null);
    setSelected(null);
  };

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
      if (!design || !layer) return;
      const step = e.shiftKey ? 1 : 0.1;
      const mv: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (mv[e.key] && !layer.locked) {
        e.preventDefault();
        setLayer(layer.id, { x: Math.round((layer.x + mv[e.key][0]) * 100) / 100, y: Math.round((layer.y + mv[e.key][1]) * 100) / 100 });
      } else if ((e.key === "Delete" || e.key === "Backspace") && !layer.locked) {
        e.preventDefault();
        removeLayer(layer.id);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateLayer(layer.id);
      } else if (e.key === "Escape") setSelected(null);
      else if (e.key === "Enter" && layer.kind === "text") {
        e.preventDefault();
        setFocusText((x) => x + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- deck / export
  const linkedCard = design ? project.cards.find((c) => c.designId === design.id) : undefined;
  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const exportDpi = Math.min(1200, Math.max(300, profile?.dpi ?? 600));

  const renderToLibrary = async (d: CardDesign) => {
    const blob = await exportPng(d, exportDpi);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return api.importImageData(bytes, `${d.name}.png`);
  };

  const addToDeck = async () => {
    if (!design) return;
    setBusy(true);
    try {
      const front = await renderToLibrary(design);
      const backDesign = design.backId ? designs.find((x) => x.id === design.backId) : undefined;
      const back = backDesign ? await renderToLibrary(backDesign) : null;
      await ensureImages([front.id, back?.id ?? ""].filter(Boolean));
      update((p) => {
        const existing = p.cards.find((c) => c.designId === design.id);
        if (existing) {
          p.cards = p.cards.map((c) =>
            c.designId === design.id ? { ...c, name: design.name, front: front.id, back: back?.id ?? c.back ?? null, builtinBleedMm: design.bleed, originalFront: null } : c,
          );
        } else {
          const entry: CardEntry = {
            id: crypto.randomUUID(),
            name: design.name,
            qty: 1,
            front: front.id,
            back: back?.id ?? null,
            builtinBleedMm: design.bleed,
            isToken: false,
            designId: design.id,
          };
          p.cards.push(entry);
        }
        return p;
      });
      toast("success", linkedCard ? `“${design.name}” atualizada no deck (${exportDpi} DPI)` : `“${design.name}” adicionada ao deck (${exportDpi} DPI)`);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async () => {
    if (!design) return;
    const path = await save({ defaultPath: `${design.name.replace(/[^\w\- ]+/g, "")}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
    if (!path) return;
    setBusy(true);
    try {
      const blob = await exportPng(design, exportDpi);
      await invoke("save_bytes", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-path": encodeURIComponent(path) } });
      toast("success", path);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- cards file / batch export
  const safeName = (n: string) => n.replace(/[^\w\- ]+/g, "").trim() || "card";
  const exportCardsFile = async () => {
    const path = await save({ defaultPath: `${safeName(project.name)}.cards.json`, filters: [{ name: "ProxyForge cards", extensions: ["json"] }] });
    if (!path) return;
    try {
      const body = new TextEncoder().encode(JSON.stringify({ format: "proxyforge-cards", version: 1, designs }, null, 1));
      await invoke("save_bytes", body, { headers: { "x-path": encodeURIComponent(path) } });
      toast("success", T(`${designs.length} cards saved`, `${designs.length} cartas salvas`));
    } catch (e) {
      toast("error", errorText(e));
    }
  };
  const importCardsFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: "ProxyForge cards", extensions: ["json"] }] });
    if (!path || Array.isArray(path)) return;
    try {
      const data = JSON.parse(await invoke<string>("read_text_file", { path }));
      const list = (Array.isArray(data) ? data : data.designs) as CardDesign[];
      if (!Array.isArray(list) || !list.every((d) => d && Array.isArray(d.layers))) throw new Error(T("Not a cards file.", "Não é um arquivo de cartas."));
      const ids = new Map(list.map((d) => [d.id, crypto.randomUUID()]));
      const fresh = list.map((d) => ({ ...d, id: ids.get(d.id)!, backId: d.backId ? (ids.get(d.backId) ?? null) : null, updatedAt: new Date().toISOString() }));
      update((p) => ({ ...p, designs: [...((p.designs ?? []) as CardDesign[]), ...fresh] }));
      if (fresh[0]) setActiveId(fresh[0].id);
      toast("success", T(`${fresh.length} cards imported`, `${fresh.length} cartas importadas`));
    } catch (e) {
      toast("error", errorText(e));
    }
  };
  const exportAllPng = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (!dir || Array.isArray(dir)) return;
    setBusy(true);
    try {
      const used = new Set<string>();
      for (const d of designs) {
        let name = safeName(d.name);
        for (let i = 2; used.has(name); i++) name = `${safeName(d.name)} ${i}`;
        used.add(name);
        const blob = await exportPng(d, exportDpi);
        const path = `${dir.replace(/[\\/]$/, "")}/${name}.png`;
        await invoke("save_bytes", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-path": encodeURIComponent(path) } });
      }
      toast("success", T(`${designs.length} PNGs exported (${exportDpi} DPI)`, `${designs.length} PNGs exportados (${exportDpi} DPI)`));
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- render
  return (
    <>
      <aside style={{ width: paneWidths.builderLeft }} className="flex shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex flex-col gap-3 border-b border-line px-4 pt-4.5 pb-3.5">
          <div className="flex items-center">
            <h2 className="flex-1 text-base font-semibold">{T("Build card", "Criar carta")}</h2>
            <IconButton icon={FileUp} label={T("Import cards file (.json)", "Importar arquivo de cartas (.json)")} onClick={importCardsFile} />
            <IconButton icon={FileDown} label={T("Save all cards to a file (.json)", "Salvar todas as cartas num arquivo (.json)")} onClick={exportCardsFile} disabled={!designs.length} />
            <IconButton icon={FolderDown} label={T("Export every card as PNG to a folder", "Exportar todas as cartas em PNG numa pasta")} onClick={exportAllPng} disabled={!designs.length || busy} />
            <Button size="sm" icon={Plus} onClick={() => setPicker(true)}>
              {T("New", "Nova")}
            </Button>
          </div>
          <div className="grid max-h-[200px] grid-cols-4 gap-2 overflow-y-auto">
            {designs.map((d) => (
              <DesignThumb
                key={d.id}
                design={d.id === design?.id ? design : d}
                active={d.id === design?.id}
                inDeck={project.cards.some((c) => c.designId === d.id)}
                onClick={() => {
                  setActiveId(d.id);
                  setSelected(null);
                }}
              />
            ))}
          </div>
        </div>

        {design && (
          <div className="flex min-h-0 flex-1 flex-col px-2 py-3">
            <div className="flex items-center gap-0.5 px-2 pb-2">
              <h3 className="section-title flex-1">Camadas</h3>
              <IconButton icon={Type} label="Adicionar texto" onClick={() => addLayer("text")} />
              <IconButton icon={ImageIcon} label="Adicionar imagem" onClick={() => addLayer("image")} />
              <IconButton icon={Square} label="Adicionar retângulo" onClick={() => addLayer("rect")} />
              <IconButton icon={Circle} label="Adicionar elipse" onClick={() => addLayer("ellipse")} />
              <IconButton icon={Star} label="Adicionar estrela / polígono" onClick={() => addLayer("polygon")} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
              {[...design.layers].reverse().map((l) => {
                const Icon = KIND_ICON[l.kind];
                const active = l.id === selected;
                return (
                  <div
                    key={l.id}
                    draggable
                    onDragStart={() => (dragLayer.current = l.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => dragLayer.current && moveTo(dragLayer.current, l.id)}
                    onClick={() => setSelected(l.id)}
                    className={cx(
                      "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                      active ? "bg-accent-soft" : "hover:bg-surface-2",
                      !l.visible && "opacity-50",
                    )}
                  >
                    <Icon size={14} className={active ? "text-accent" : "text-fg-2"} />
                    <span className={cx("min-w-0 flex-1 truncate text-xs", active ? "font-semibold text-fg" : "font-medium text-fg-2")}>{l.name}</span>
                    {l.slot && (
                      <span title={T("Generated by the card form", "Gerada pelo formulário da carta")}>
                        <Link2 size={12} className="text-fg-3" />
                      </span>
                    )}
                    <button
                      aria-label={l.visible ? "Ocultar" : "Mostrar"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLayer(l.id, { visible: !l.visible });
                      }}
                      className="text-fg-3 hover:text-fg"
                    >
                      {l.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                    <button
                      aria-label={l.locked ? "Destravar" : "Travar"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLayer(l.id, { locked: !l.locked });
                      }}
                      className={l.locked ? "text-accent" : "text-fg-3 hover:text-fg"}
                    >
                      {l.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2 border-t border-line px-2 pt-3">
              <Button size="sm" icon={Copy} className="flex-1" onClick={() => duplicateDesign(design)}>
                Duplicar
              </Button>
              <Button size="sm" variant="danger" icon={Trash2} className="flex-1" onClick={() => deleteDesign(design)}>
                Excluir
              </Button>
            </div>
          </div>
        )}
      </aside>
      <ResizeHandle pane="builderLeft" side="left" />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
          {design ? (
            <>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <input
                  aria-label="Nome da carta"
                  value={design.name}
                  onChange={(e) => mutate((d) => ({ ...d, name: e.target.value }))}
                  className="w-full truncate rounded bg-transparent text-sm font-semibold outline-none focus:bg-surface-2"
                />
                <span className="truncate text-[11px] text-fg-3">
                  {design.width} × {design.height} mm · sangria {design.bleed} mm · {design.layers.length} camadas{linkedCard ? ` · no deck ×${linkedCard.qty}` : ""}
                </span>
              </div>
              <IconButton icon={Undo2} label="Desfazer (⌘Z)" onClick={undo} disabled={!past} />
              <IconButton icon={Redo2} label="Refazer (⇧⌘Z)" onClick={redo} disabled={!future} />
              <IconButton icon={Grid2x2Check} label="Guias de sangria, corte e área segura" active={guides} onClick={() => setGuides(!guides)} />
              <IconButton icon={Magnet} label="Encaixe (Alt desativa ao arrastar)" active={snap} onClick={() => setSnap(!snap)} />
              <Button icon={ImageDown} onClick={exportFile} disabled={busy}>
                PNG
              </Button>
              <Button variant="primary" icon={busy ? undefined : Plus} onClick={addToDeck} disabled={busy}>
                {busy && <Loader2 size={14} className="animate-spin" />}
                {linkedCard ? "Atualizar no deck" : "Adicionar ao deck"}
              </Button>
            </>
          ) : (
            <span className="flex-1 text-sm text-fg-2">Crie uma carta a partir de um modelo.</span>
          )}
        </header>
        {design ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <CanvasEditor
              design={design}
              selectedId={selected}
              onSelect={setSelected}
              onPreview={setLive}
              onCommit={commit}
              snap={snap}
              guides={guides}
              onEditText={() => setFocusText((x) => x + 1)}
              zoom={zoom}
              setZoom={setZoom}
            />
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-lg border border-line bg-surface/95 px-3 py-1.5 text-[11px] text-fg-2 shadow-xl shadow-black/40">
              {guides && (
                <>
                  <Legend color="#f87171" label="Sangria" />
                  <Legend color="#38bdf8" label="Corte" />
                  <Legend color="#4ade80" label="Área segura" />
                  <div className="h-[18px] w-px bg-line" />
                </>
              )}
              <IconButton icon={ZoomOut} label="Diminuir zoom" onClick={() => setZoom(Math.max(0.25, zoom / 1.25))} />
              <span className="w-10 text-center font-mono text-xs">{Math.round(zoom * 100)}%</span>
              <IconButton icon={ZoomIn} label="Aumentar zoom" onClick={() => setZoom(Math.min(8, zoom * 1.25))} />
              <IconButton icon={Maximize} label="Ajustar à tela" onClick={() => setZoom(1)} />
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-stage">
            <Button variant="primary" icon={Plus} onClick={() => setPicker(true)}>
              Nova carta
            </Button>
          </div>
        )}
      </main>

      <ResizeHandle pane="builderRight" side="right" />
      <aside style={{ width: paneWidths.builderRight }} className="flex shrink-0 flex-col border-l border-line bg-surface">
        {design?.tcg && profileFor(design.tcg.game) && !layer && (
          <TcgPanel
            design={design}
            designs={designs}
            commit={commitRaw}
            setDesign={(patch) => mutate((d) => ({ ...d, ...patch }))}
            selectSlot={(slot) => setSelected(design.layers.find((l) => l.slot === slot)?.id ?? null)}
          />
        )}
        {design && (!design.tcg || layer) && (
          <Properties
            onDetach={
              layer?.slot
                ? () => {
                    const r = detach(design, layer.id);
                    commitRaw(r.design);
                    setSelected(r.newId);
                  }
                : undefined
            }
            onResetSlot={layer?.slot ? () => commitRaw(resetOverrides(design, layer.slot)) : undefined}
            design={design}
            layer={layer}
            designs={designs}
            setLayer={setLayer}
            setDesign={(patch) => mutate((d) => ({ ...d, ...patch }))}
            duplicate={() => layer && duplicateLayer(layer.id)}
            remove={() => layer && removeLayer(layer.id)}
            reorder={(dir) => layer && reorder(layer.id, dir)}
            focusText={focusText}
          />
        )}
      </aside>

      {picker && <NewCardWizard onClose={() => setPicker(false)} canClose={designs.length > 0} onCreate={addDesign} onGeneric={createFrom} />}
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-0.5 w-2.5" style={{ background: color }} />
      {label}
    </span>
  );
}

function DesignThumb({ design, active, inDeck, onClick }: { design: CardDesign; active: boolean; inDeck: boolean; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const key = useMemo(() => JSON.stringify(design.layers) + design.width + design.height + design.bleed, [design]);
  useEffect(() => {
    let alive = true;
    const h = setTimeout(async () => {
      const k = 2.2;
      const c = document.createElement("canvas");
      c.width = Math.round((design.width + 2 * design.bleed) * k);
      c.height = Math.round((design.height + 2 * design.bleed) * k);
      renderDesign(c.getContext("2d")!, design, k, await loadAssets(design));
      if (alive) setUrl(c.toDataURL("image/png"));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <button onClick={onClick} title={design.name} className="flex flex-col gap-1 text-left">
      <div className={cx("relative aspect-[69/94] w-full overflow-hidden rounded bg-surface-3", active && "ring-2 ring-accent")}>
        {url && <img src={url} alt="" className="h-full w-full object-cover" />}
        {inDeck && <span className="absolute right-0.5 bottom-0.5 rounded bg-accent px-1 text-[8px] font-bold text-on-accent">DECK</span>}
      </div>
      <span className={cx("truncate text-[10px]", active ? "text-fg" : "text-fg-2")}>{design.name}</span>
    </button>
  );
}
