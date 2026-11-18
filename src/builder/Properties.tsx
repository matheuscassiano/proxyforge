import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Bold,
  Circle,
  Copy,
  Expand,
  FlipHorizontal2,
  Image as ImageIcon,
  Italic,
  Paintbrush,
  Plus,
  Square,
  Star,
  Trash2,
  Type,
  Upload,
} from "lucide-react";
import { useApp } from "../lib/store";
import { errorText, fileUrl } from "../lib/ipc";
import { BUNDLED, loadUserFonts, type UserFont } from "./fonts";
import type { BlendMode, CardDesign, Fill, ImageLayer, Layer, ShapeLayer, Stroke, TextLayer } from "./types";
import { Button, cx, IconButton, NumberField, Section, Segmented, Select, Slider, TextField, Toggle } from "../components/ui";
import { invoke } from "@tauri-apps/api/core";

// ------------------------------------------------------------------ colour with alpha

function splitHex(c: string): [string, number] {
  const h = c.startsWith("#") ? c.slice(1) : c;
  const rgb = h.length >= 6 ? `#${h.slice(0, 6)}` : "#000000";
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [rgb, a];
}
const joinHex = (rgb: string, a: number) => (a >= 0.999 ? rgb : `${rgb}${Math.round(a * 255).toString(16).padStart(2, "0")}`);

export function ColorField({ label, value, onChange }: { label?: string; value: string; onChange: (v: string) => void }) {
  const [rgb, a] = splitHex(value);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label && <span className="text-xs font-medium text-fg-2">{label}</span>}
      <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-surface-2 px-1.5">
        <input type="color" aria-label={label ?? "Cor"} value={rgb} onChange={(e) => onChange(joinHex(e.target.value, a))} className="h-5 w-7 cursor-pointer rounded border-0 bg-transparent p-0" />
        <input
          aria-label="Hex"
          className="w-[62px] bg-transparent font-mono text-[11px] outline-none"
          value={rgb}
          onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && onChange(joinHex(e.target.value, a))}
        />
        <input
          type="range"
          aria-label="Opacidade da cor"
          min={0}
          max={1}
          step={0.01}
          value={a}
          onChange={(e) => onChange(joinHex(rgb, parseFloat(e.target.value)))}
          className="h-1 min-w-0 flex-1 accent-[var(--color-accent)]"
        />
        <span className="w-8 text-right font-mono text-[10px] text-fg-3">{Math.round(a * 100)}%</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ fill / stroke / shadow editors

export function FillEditor({ value, onChange, allowNone = true }: { value: Fill; onChange: (f: Fill) => void; allowNone?: boolean }) {
  const kinds = [...(allowNone ? [{ value: "none", label: "Nenhum" }] : []), { value: "solid", label: "Sólido" }, { value: "linear", label: "Linear" }, { value: "radial", label: "Radial" }] as { value: Fill["kind"]; label: string }[];
  const stops = value.kind === "linear" || value.kind === "radial" ? value.stops : [];
  const setKind = (k: Fill["kind"]) => {
    const first = value.kind === "solid" ? value.color : stops[0]?.color ?? "#f28c28";
    const last = stops[stops.length - 1]?.color ?? "#1c1917";
    if (k === "none") onChange({ kind: "none" });
    else if (k === "solid") onChange({ kind: "solid", color: first });
    else if (k === "linear") onChange({ kind: "linear", angle: value.kind === "linear" ? value.angle : 180, stops: stops.length ? stops : [{ offset: 0, color: first }, { offset: 1, color: last }] });
    else onChange({ kind: "radial", stops: stops.length ? stops : [{ offset: 0, color: first }, { offset: 1, color: last }] });
  };
  return (
    <div className="flex flex-col gap-2.5">
      <Segmented value={value.kind} onChange={setKind} options={kinds} />
      {value.kind === "solid" && <ColorField value={value.color} onChange={(c) => onChange({ kind: "solid", color: c })} />}
      {(value.kind === "linear" || value.kind === "radial") && (
        <>
          <div className="h-4 rounded" style={{ background: `linear-gradient(90deg, ${value.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(",")})` }} />
          {value.kind === "linear" && (
            <Slider label="Ângulo" value={value.angle} min={0} max={360} step={1} format={(v) => `${Math.round(v)}°`} onChange={(v) => onChange({ ...value, angle: v })} />
          )}
          {value.stops.map((s, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <ColorField value={s.color} onChange={(c) => onChange({ ...value, stops: value.stops.map((x, j) => (j === i ? { ...x, color: c } : x)) })} />
              </div>
              <NumberField className="w-16" value={Math.round(s.offset * 100)} unit="%" step={1} min={0} max={100} onChange={(v) => onChange({ ...value, stops: value.stops.map((x, j) => (j === i ? { ...x, offset: v / 100 } : x)) })} />
              <IconButton icon={Trash2} label="Remover cor" disabled={value.stops.length <= 2} onClick={() => onChange({ ...value, stops: value.stops.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <Button size="sm" icon={Plus} onClick={() => onChange({ ...value, stops: [...value.stops, { offset: 1, color: value.stops[value.stops.length - 1].color }] })}>
            Adicionar cor
          </Button>
        </>
      )}
    </div>
  );
}

function StrokeEditor({ value, onChange, label = "Contorno" }: { value: Stroke | null; onChange: (s: Stroke | null) => void; label?: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Toggle checked={!!value} onChange={(v) => onChange(v ? { color: "#1c1917", width: 0.3, dash: 0 } : null)} label={label} />
      {value && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-[2]">
            <ColorField value={value.color} onChange={(c) => onChange({ ...value, color: c })} />
          </div>
          <NumberField className="flex-1" label="Espessura" unit="mm" value={value.width} min={0} max={10} step={0.05} onChange={(w) => onChange({ ...value, width: w })} />
          <NumberField className="flex-1" label="Traço" unit="mm" value={value.dash ?? 0} min={0} max={10} step={0.1} onChange={(dash) => onChange({ ...value, dash })} />
        </div>
      )}
    </div>
  );
}

function ShadowEditor({ layer, set }: { layer: Layer; set: (p: Partial<Layer>) => void }) {
  const s = layer.shadow;
  return (
    <div className="flex flex-col gap-2.5">
      <Toggle checked={!!s} onChange={(v) => set({ shadow: v ? { color: "#000000aa", blur: 1, x: 0, y: 0.4 } : null })} label="Sombra" />
      {s && (
        <>
          <ColorField value={s.color} onChange={(c) => set({ shadow: { ...s, color: c } })} />
          <div className="flex gap-2">
            <NumberField className="flex-1" label="Desfoque" unit="mm" value={s.blur} min={0} max={20} step={0.1} onChange={(v) => set({ shadow: { ...s, blur: v } })} />
            <NumberField className="flex-1" label="X" unit="mm" value={s.x} min={-20} max={20} step={0.1} onChange={(v) => set({ shadow: { ...s, x: v } })} />
            <NumberField className="flex-1" label="Y" unit="mm" value={s.y} min={-20} max={20} step={0.1} onChange={(v) => set({ shadow: { ...s, y: v } })} />
          </div>
        </>
      )}
    </div>
  );
}

const BLENDS: { value: BlendMode; label: string }[] = [
  { value: "source-over", label: "Normal" },
  { value: "multiply", label: "Multiplicar" },
  { value: "screen", label: "Tela" },
  { value: "overlay", label: "Sobrepor" },
  { value: "soft-light", label: "Luz suave" },
  { value: "hard-light", label: "Luz forte" },
  { value: "color-dodge", label: "Subexposição de cor" },
  { value: "color-burn", label: "Superexposição de cor" },
  { value: "darken", label: "Escurecer" },
  { value: "lighten", label: "Clarear" },
  { value: "difference", label: "Diferença" },
  { value: "luminosity", label: "Luminosidade" },
];

// ------------------------------------------------------------------ image picker

function ImagePicker({ layer, set }: { layer: ImageLayer; set: (p: Partial<ImageLayer>) => void }) {
  const project = useApp((s) => s.project)!;
  const images = useApp((s) => s.images);
  const { ensureImages, toast } = useApp.getState();
  const [showDeck, setShowDeck] = useState(false);
  const im = layer.imageId ? images[layer.imageId] : undefined;
  useEffect(() => {
    if (layer.imageId) ensureImages([layer.imageId]);
  }, [layer.imageId, ensureImages]);
  const pickFile = async () => {
    const path = await open({ multiple: false, filters: [{ name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"] }] });
    if (!path || Array.isArray(path)) return;
    try {
      const meta = await invoke<{ id: string }>("import_image_file", { path });
      await ensureImages([meta.id]);
      set({ imageId: meta.id, zoom: 1, offsetX: 0, offsetY: 0 });
    } catch (e) {
      toast("error", errorText(e));
    }
  };
  const deckIds = [...new Set(project.cards.flatMap((c) => [c.originalFront ?? c.front, c.front]).filter(Boolean))].slice(0, 60);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <div className="flex h-11 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-3 text-fg-3">
          {im ? <img src={fileUrl(im.thumb)} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={16} />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs font-medium">{im ? im.meta.note || "Imagem" : "Sem imagem"}</span>
          <span className="text-[11px] text-fg-3">{im ? `${im.meta.width}×${im.meta.height} px` : "Escolha um arquivo ou uma carta"}</span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" icon={Upload} className="flex-1" onClick={pickFile}>
          Arquivo
        </Button>
        <Button
          size="sm"
          className="flex-1"
          onClick={() => {
            setShowDeck(!showDeck);
            ensureImages(deckIds);
          }}
        >
          Do deck
        </Button>
        {layer.imageId && <IconButton icon={Trash2} label="Remover imagem" onClick={() => set({ imageId: null })} />}
      </div>
      {showDeck && (
        <div className="grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto">
          {deckIds.map((id) =>
            images[id] ? (
              <button key={id} onClick={() => set({ imageId: id, zoom: 1, offsetX: 0, offsetY: 0 })} className={cx("aspect-[63/88] overflow-hidden rounded", id === layer.imageId && "ring-2 ring-accent")}>
                <img src={fileUrl(images[id].thumb)} alt="" className="h-full w-full object-cover" />
              </button>
            ) : null,
          )}
          {!deckIds.length && <p className="col-span-4 text-[11px] text-fg-3">O deck ainda não tem cartas.</p>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ fonts

function FontSelect({ value, onChange }: { value: string; onChange: (f: string) => void }) {
  const [user, setUser] = useState<UserFont[]>([]);
  const toast = useApp((s) => s.toast);
  const [custom, setCustom] = useState("");
  useEffect(() => {
    invoke<UserFont[]>("list_fonts")
      .then(async (f) => {
        await loadUserFonts(f);
        setUser(f);
      })
      .catch(() => setUser([]));
  }, []);
  const known = new Set([...BUNDLED.map((f) => f.family), ...user.map((u) => u.family)]);
  const options = [
    ...BUNDLED.map((f) => ({ value: f.family, label: f.family.replace(" Variable", "") })),
    ...user.map((u) => ({ value: u.family, label: `${u.family} (importada)` })),
    ...(!known.has(value) ? [{ value, label: `${value} (sistema)` }] : []),
  ];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Select label="Fonte" value={value} onChange={onChange} options={options} />
        </div>
        <IconButton
          icon={Upload}
          label="Importar fonte (.ttf, .otf, .woff2)"
          className="h-8 w-8 border border-line bg-surface-2"
          onClick={async () => {
            const path = await open({ multiple: false, filters: [{ name: "Fontes", extensions: ["ttf", "otf", "woff", "woff2"] }] });
            if (!path || Array.isArray(path)) return;
            try {
              const f = await invoke<UserFont>("import_font", { path });
              await loadUserFonts([f]);
              setUser((u) => [...u.filter((x) => x.path !== f.path), f]);
              onChange(f.family);
            } catch (e) {
              toast("error", errorText(e));
            }
          }}
        />
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.trim()) onChange(custom.trim());
          setCustom("");
        }}
      >
        <input
          aria-label="Fonte instalada no sistema"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Ou digite uma fonte instalada…"
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 text-[11px] outline-none placeholder:text-fg-3 focus:border-accent"
        />
      </form>
      <p className="truncate text-[13px] text-fg-2" style={{ fontFamily: `"${value}"` }}>
        Aa Bb Cc — Dragão de Fogo 0123
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ main panel

const SYMBOLS = ["{W}", "{U}", "{B}", "{R}", "{G}", "{C}", "{T}", "{X}", "{1}", "{2}", "{3}"];

interface Props {
  design: CardDesign;
  layer: Layer | null;
  setLayer: (id: string, patch: Partial<Layer>) => void;
  setDesign: (patch: Partial<CardDesign>) => void;
  duplicate: () => void;
  remove: () => void;
  reorder: (dir: 1 | -1) => void;
  focusText: number;
  designs: CardDesign[];
}

export function Properties({ design, layer, setLayer, setDesign, duplicate, remove, reorder, focusText, designs }: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusText) textRef.current?.focus();
  }, [focusText]);

  if (!layer) return <DesignProps design={design} setDesign={setDesign} designs={designs} />;
  const set = (p: Partial<Layer>) => setLayer(layer.id, p);
  const W = design.width + 2 * design.bleed;
  const H = design.height + 2 * design.bleed;
  const Icon = layer.kind === "text" ? Type : layer.kind === "image" ? ImageIcon : layer.kind === "ellipse" ? Circle : layer.kind === "polygon" ? Star : Square;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 pt-4.5 pb-3">
        <Icon size={16} className="text-accent" />
        <input aria-label="Nome da camada" value={layer.name} onChange={(e) => set({ name: e.target.value })} className="min-w-0 flex-1 rounded bg-transparent text-[15px] font-semibold outline-none focus:bg-surface-2" />
        <IconButton icon={ArrowUp} label="Trazer para frente" onClick={() => reorder(1)} />
        <IconButton icon={ArrowDown} label="Enviar para trás" onClick={() => reorder(-1)} />
        <IconButton icon={Copy} label="Duplicar (⌘D)" onClick={duplicate} />
        <IconButton icon={Trash2} label="Excluir (Delete)" onClick={remove} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {layer.kind === "text" && (
          <Section title="Texto">
            <textarea
              ref={textRef}
              aria-label="Texto"
              value={layer.text}
              onChange={(e) => set({ text: e.target.value } as Partial<TextLayer>)}
              rows={5}
              className="resize-y rounded-md border border-line bg-surface-2 p-2.5 text-[13px] leading-relaxed outline-none focus:border-accent"
            />
            <div className="flex flex-wrap gap-1">
              {SYMBOLS.map((s) => (
                <button key={s} onClick={() => set({ text: `${layer.text}${s}` } as Partial<TextLayer>)} className="h-6 rounded border border-line bg-surface-2 px-1.5 font-mono text-[10px] text-fg-2 hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-fg-3">**negrito**, *itálico*, {"{R}"} símbolos, Enter quebra linha.</p>
            <FontSelect value={layer.font} onChange={(font) => set({ font } as Partial<TextLayer>)} />
            <div className="flex items-end gap-2">
              <NumberField className="flex-1" label="Tamanho" unit="pt" value={layer.size} min={2} max={200} step={0.5} onChange={(size) => set({ size } as Partial<TextLayer>)} />
              <IconButton icon={Bold} label="Negrito" active={layer.weight === 700} className="h-8 w-8" onClick={() => set({ weight: layer.weight === 700 ? 400 : 700 } as Partial<TextLayer>)} />
              <IconButton icon={Italic} label="Itálico" active={layer.italic} className="h-8 w-8" onClick={() => set({ italic: !layer.italic } as Partial<TextLayer>)} />
              <div className="w-28">
                <ColorField value={layer.color} onChange={(color) => set({ color } as Partial<TextLayer>)} />
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex rounded-md bg-surface-2 p-[3px]">
                {(
                  [
                    ["left", AlignLeft],
                    ["center", AlignCenter],
                    ["right", AlignRight],
                    ["justify", AlignJustify],
                  ] as const
                ).map(([a, I]) => (
                  <IconButton key={a} icon={I} label={a} active={layer.align === a} onClick={() => set({ align: a } as Partial<TextLayer>)} />
                ))}
              </div>
              <Segmented
                className="flex-1"
                value={layer.vAlign}
                onChange={(vAlign) => set({ vAlign } as Partial<TextLayer>)}
                options={[
                  { value: "top", label: "Topo" },
                  { value: "middle", label: "Meio" },
                  { value: "bottom", label: "Base" },
                ]}
              />
            </div>
            <div className="flex gap-2">
              <NumberField className="flex-1" label="Entrelinha" value={layer.lineHeight} min={0.6} max={3} step={0.05} onChange={(lineHeight) => set({ lineHeight } as Partial<TextLayer>)} />
              <NumberField className="flex-1" label="Espaçamento" unit="em" value={layer.letterSpacing} min={-0.2} max={1} step={0.01} onChange={(letterSpacing) => set({ letterSpacing } as Partial<TextLayer>)} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <Toggle checked={layer.autoFit} onChange={(autoFit) => set({ autoFit } as Partial<TextLayer>)} label="Ajustar ao quadro" />
              <Toggle checked={layer.uppercase} onChange={(uppercase) => set({ uppercase } as Partial<TextLayer>)} label="Maiúsculas" />
            </div>
            <StrokeEditor label="Contorno do texto" value={layer.stroke} onChange={(stroke) => set({ stroke } as Partial<TextLayer>)} />
            <span className="text-xs font-medium text-fg-2">Fundo da caixa</span>
            <FillEditor value={layer.background} onChange={(background) => set({ background } as Partial<TextLayer>)} />
            {layer.background.kind !== "none" && (
              <div className="flex gap-2">
                <NumberField className="flex-1" label="Margem interna" unit="mm" value={layer.padding} min={0} max={20} step={0.1} onChange={(padding) => set({ padding } as Partial<TextLayer>)} />
                <NumberField className="flex-1" label="Cantos" unit="mm" value={layer.radius} min={0} max={30} step={0.1} onChange={(radius) => set({ radius } as Partial<TextLayer>)} />
              </div>
            )}
          </Section>
        )}

        {layer.kind === "image" && (
          <Section title="Imagem">
            <ImagePicker layer={layer} set={set as (p: Partial<ImageLayer>) => void} />
            <Segmented
              value={layer.fit}
              onChange={(fit) => set({ fit } as Partial<ImageLayer>)}
              options={[
                { value: "cover", label: "Cobrir" },
                { value: "contain", label: "Conter" },
                { value: "stretch", label: "Esticar" },
              ]}
            />
            <Slider label="Zoom da imagem" value={layer.zoom} min={0.2} max={4} format={(v) => `${Math.round(v * 100)}%`} onChange={(zoom) => set({ zoom } as Partial<ImageLayer>)} />
            <Slider label="Posição horizontal" value={layer.offsetX} min={-1} max={1} format={(v) => v.toFixed(2)} onChange={(offsetX) => set({ offsetX } as Partial<ImageLayer>)} />
            <Slider label="Posição vertical" value={layer.offsetY} min={-1} max={1} format={(v) => v.toFixed(2)} onChange={(offsetY) => set({ offsetY } as Partial<ImageLayer>)} />
            <div className="flex items-end gap-2">
              <NumberField className="flex-1" label="Cantos" unit="mm" value={layer.radius} min={0} max={40} step={0.1} onChange={(radius) => set({ radius } as Partial<ImageLayer>)} />
              <IconButton icon={FlipHorizontal2} label="Espelhar" active={layer.flipX} className="h-8 w-8" onClick={() => set({ flipX: !layer.flipX } as Partial<ImageLayer>)} />
            </div>
            <StrokeEditor value={layer.stroke} onChange={(stroke) => set({ stroke } as Partial<ImageLayer>)} />
          </Section>
        )}
        {layer.kind === "image" && (
          <Section
            title="Filtros"
            right={
              <button className="text-[11px] text-fg-2 hover:text-fg" onClick={() => set({ filters: { brightness: 1, contrast: 1, saturate: 1, hue: 0, grayscale: 0, sepia: 0, blur: 0 } } as Partial<ImageLayer>)}>
                Redefinir
              </button>
            }
          >
            {(
              [
                ["brightness", "Brilho", 0, 2],
                ["contrast", "Contraste", 0, 2],
                ["saturate", "Saturação", 0, 2],
                ["hue", "Matiz", -180, 180],
                ["grayscale", "Preto e branco", 0, 1],
                ["sepia", "Sépia", 0, 1],
                ["blur", "Desfoque (mm)", 0, 3],
              ] as const
            ).map(([k, label, min, max]) => (
              <Slider
                key={k}
                label={label}
                value={layer.filters[k]}
                min={min}
                max={max}
                format={(v) => (k === "hue" ? `${Math.round(v)}°` : v.toFixed(2))}
                onChange={(v) => set({ filters: { ...layer.filters, [k]: v } } as Partial<ImageLayer>)}
              />
            ))}
          </Section>
        )}

        {(layer.kind === "rect" || layer.kind === "ellipse" || layer.kind === "polygon") && (
          <Section title="Forma">
            <Segmented
              value={layer.kind}
              onChange={(kind) => set({ kind } as Partial<ShapeLayer>)}
              options={[
                { value: "rect", label: "Retângulo" },
                { value: "ellipse", label: "Elipse" },
                { value: "polygon", label: "Polígono" },
              ]}
            />
            {layer.kind === "rect" && <NumberField label="Cantos arredondados" unit="mm" value={layer.radius} min={0} max={50} step={0.1} onChange={(radius) => set({ radius } as Partial<ShapeLayer>)} />}
            {layer.kind === "polygon" && (
              <div className="flex items-end gap-3">
                <NumberField className="flex-1" label="Lados / pontas" value={layer.sides} min={3} max={24} step={1} onChange={(sides) => set({ sides: Math.round(sides) } as Partial<ShapeLayer>)} />
                <Toggle checked={layer.star} onChange={(star) => set({ star } as Partial<ShapeLayer>)} label="Estrela" />
              </div>
            )}
            <span className="text-xs font-medium text-fg-2">Preenchimento</span>
            <FillEditor value={layer.fill} onChange={(fill) => set({ fill } as Partial<ShapeLayer>)} />
            <StrokeEditor value={layer.stroke} onChange={(stroke) => set({ stroke } as Partial<ShapeLayer>)} />
          </Section>
        )}

        <Section title="Posição e tamanho">
          <div className="flex gap-2">
            <NumberField className="flex-1" label="X" unit="mm" value={layer.x} step={0.1} onChange={(x) => set({ x })} />
            <NumberField className="flex-1" label="Y" unit="mm" value={layer.y} step={0.1} onChange={(y) => set({ y })} />
          </div>
          <div className="flex gap-2">
            <NumberField className="flex-1" label="Largura" unit="mm" value={layer.w} min={0.5} step={0.1} onChange={(w) => set({ w })} />
            <NumberField className="flex-1" label="Altura" unit="mm" value={layer.h} min={0.5} step={0.1} onChange={(h) => set({ h })} />
            <NumberField className="w-20" label="Giro" unit="°" value={layer.rotation} min={-180} max={180} step={1} onChange={(rotation) => set({ rotation })} />
          </div>
          <div className="flex gap-1">
            <IconButton icon={AlignCenterVertical} label="Centralizar na horizontal" onClick={() => set({ x: (W - layer.w) / 2 })} />
            <IconButton icon={AlignCenterHorizontal} label="Centralizar na vertical" onClick={() => set({ y: (H - layer.h) / 2 })} />
            <IconButton icon={Expand} label="Ocupar a carta toda (com sangria)" onClick={() => set({ x: 0, y: 0, w: W, h: H, rotation: 0 })} />
            <IconButton
              icon={Paintbrush}
              label="Ajustar à área de corte"
              onClick={() => set({ x: design.bleed, y: design.bleed, w: design.width, h: design.height, rotation: 0 })}
            />
          </div>
        </Section>

        <Section title="Aparência">
          <Slider label="Opacidade" value={layer.opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(opacity) => set({ opacity })} />
          <Select label="Mesclagem" value={layer.blend ?? "source-over"} onChange={(blend) => set({ blend })} options={BLENDS} />
          <ShadowEditor layer={layer} set={set} />
        </Section>
      </div>
    </>
  );
}

function DesignProps({ design, setDesign, designs }: { design: CardDesign; setDesign: (p: Partial<CardDesign>) => void; designs: CardDesign[] }) {
  const info = useApp((s) => s.info);
  const presets = info?.cardPresets ?? [];
  return (
    <>
      <div className="border-b border-line px-4 pt-4.5 pb-3">
        <h2 className="text-[15px] font-semibold">Carta</h2>
        <p className="text-[11px] text-fg-3">Clique numa camada para editar. Arraste para mover, alças para redimensionar e girar.</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <TextField label="Nome" value={design.name} onChange={(name) => setDesign({ name })} />
        <Section title="Tamanho">
          <Select
            label="Formato"
            value={presets.find((p) => p.width === design.width && p.height === design.height)?.id ?? "custom"}
            onChange={(id) => {
              const p = presets.find((x) => x.id === id);
              if (p) setDesign({ width: p.width, height: p.height });
            }}
            options={[...presets.map((p) => ({ value: p.id, label: `${p.name.split(" (")[0]} · ${p.width}×${p.height}` })), { value: "custom", label: "Personalizado" }]}
          />
          <div className="flex gap-2">
            <NumberField className="flex-1" label="Largura" unit="mm" value={design.width} min={20} max={300} onChange={(width) => setDesign({ width })} />
            <NumberField className="flex-1" label="Altura" unit="mm" value={design.height} min={20} max={300} onChange={(height) => setDesign({ height })} />
          </div>
          <div className="flex gap-2">
            <NumberField className="flex-1" label="Sangria" unit="mm" value={design.bleed} min={0} max={10} onChange={(bleed) => setDesign({ bleed })} />
            <NumberField className="flex-1" label="Margem segura" unit="mm" value={design.safe} min={0} max={15} onChange={(safe) => setDesign({ safe })} />
          </div>
          <p className="text-[11px] leading-relaxed text-fg-3">Mudar o tamanho não reposiciona as camadas. Linhas: vermelha = sangria, azul = corte, verde = área segura.</p>
        </Section>
        <Section title="Verso">
          <Select
            label="Usar outro design como verso"
            value={design.backId ?? ""}
            onChange={(v) => setDesign({ backId: v || null })}
            options={[{ value: "", label: "Sem verso (usa o verso padrão)" }, ...designs.filter((d) => d.id !== design.id).map((d) => ({ value: d.id, label: d.name }))]}
          />
        </Section>
      </div>
    </>
  );
}
