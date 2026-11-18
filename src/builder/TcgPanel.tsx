// Right panel for TCG designs: the structured card form (Card Conjurer-style tabs), asset pack
// status, import by name / pasted text, "from a real card" masks and export options.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Download, Loader2, Plus, Search, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useApp } from "../lib/store";
import { api, errorText, onProgress } from "../lib/ipc";
import type { CardResult } from "../lib/types";
import { Button, cx, IconButton, NumberField, ProgressBar, Section, Select, Slider, TextField, Toggle } from "../components/ui";
import { DesignProps, ImagePicker } from "./Properties";
import { useBi } from "./bi";
import { formatBytes, installPack, usePacks } from "./packs";
import { changeCardType, profileFor } from "./tcg/registry";
import { setFields, withBaseVisibility } from "./tcg/sync";
import type { FieldDef, TcgProfile } from "./tcg/types";
import { str } from "./tcg/types";
import { urlAsset } from "./assets";
import type { CardDesign, FieldValue, ImageLayer, RealMask, TcgState } from "./types";

type Tab = "card" | "frame" | "art" | "set" | "collector" | "import" | "export";

interface Props {
  design: CardDesign;
  designs: CardDesign[];
  commit: (d: CardDesign) => void;
  setDesign: (p: Partial<CardDesign>) => void;
  selectSlot: (slot: string) => void;
}

export function TcgPanel({ design, designs, commit, setDesign, selectSlot }: Props) {
  const T = useBi();
  const tcg = design.tcg!;
  const profile = profileFor(tcg.game)!;
  const type = profile.cardTypes.find((t) => t.id === tcg.cardType) ?? profile.cardTypes[0];
  const [tab, setTab] = useState<Tab>("card");
  const fields = tcg.fields;
  const set = (patch: Record<string, FieldValue>) => commit(setFields(design, patch));
  const visible = (fd: FieldDef) => (fd.tab ?? "card") === tab && (!fd.when || fd.when({ ...fields, _type: tcg.cardType }));
  const tabs: { id: Tab; label: string }[] = [
    { id: "card", label: T("Card", "Carta") },
    { id: "frame", label: T("Frame", "Moldura") },
    { id: "art", label: T("Art", "Arte") },
    { id: "set", label: T("Set", "Coleção") },
    { id: "collector", label: T("Collector", "Rodapé") },
    { id: "import", label: T("Import", "Importar") },
    { id: "export", label: T("Design", "Design") },
  ];

  return (
    <>
      <div className="flex flex-col gap-2.5 border-b border-line px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-accent uppercase">{profile.name}</span>
          {tcg.base && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-fg-2">{T("Real card base", "Base: carta real")}</span>}
        </div>
        <Select
          label={T("Card type", "Tipo de carta")}
          value={tcg.cardType}
          onChange={(v) => commit(changeCardType(design, v))}
          options={profile.cardTypes.map((t) => ({ value: t.id, label: T.l(t.label) }))}
        />
        <PackBanner profile={profile} />
      </div>
      <div role="tablist" className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line px-2 py-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx("shrink-0 rounded-md px-2.5 py-1 text-xs font-medium", tab === t.id ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2")}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "export" ? (
        <DesignProps design={design} setDesign={setDesign} designs={designs} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {tab === "import" ? (
            <ImportTab design={design} profile={profile} commit={commit} />
          ) : (
            <>
              {type.fields.filter(visible).map((fd) => (
                <FieldEditor key={fd.key} def={fd} value={fields[fd.key]} onChange={(v) => set({ [fd.key]: v })} profile={profile} game={tcg.game} />
              ))}
              {tab === "art" && (
                <>
                  <Button size="sm" onClick={() => selectSlot("art")}>
                    {T("Adjust art on the canvas (zoom, pan)", "Ajustar a arte no canvas (zoom, posição)")}
                  </Button>
                  {tcg.game === "mtg" && <ArtSearch name={str(fields.name)} onPick={(art, artist) => set({ art, ...(artist ? { artist } : {}) })} />}
                </>
              )}
              {!type.fields.some(visible) && tab !== "art" && <p className="text-[11px] text-fg-3">{T("Nothing to set here for this card type.", "Nada para ajustar aqui neste tipo de carta.")}</p>}
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- pack status

function PackBanner({ profile }: { profile: TcgProfile }) {
  const T = useBi();
  const packs = usePacks();
  const toast = useApp((s) => s.toast);
  const pack = packs.find((p) => p.id === profile.packId);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    const un = onProgress((e) => e.task === "pack" && setProgress(e.progress >= 1 ? null : e.progress));
    return () => {
      un.then((f) => f());
    };
  }, []);
  if (!pack) return null;
  if (pack.complete) return <p className="text-[11px] text-ok">{T("Official frames and fonts installed (offline).", "Molduras e fontes oficiais instaladas (offline).")}</p>;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-2.5">
      <p className="text-[11px] leading-relaxed text-fg-2">
        {T(
          `Frames and fonts download as cards use them (${pack.installedFiles}/${pack.totalFiles} files). Download all ${formatBytes(pack.totalBytes)} to work offline.`,
          `Molduras e fontes baixam conforme o uso (${pack.installedFiles}/${pack.totalFiles} arquivos). Baixe tudo (${formatBytes(pack.totalBytes)}) para usar offline.`,
        )}
      </p>
      {progress !== null ? (
        <ProgressBar value={progress} />
      ) : (
        <Button
          size="sm"
          icon={Download}
          onClick={async () => {
            setProgress(0);
            try {
              await installPack(pack.id);
            } catch (e) {
              toast("error", errorText(e));
            } finally {
              setProgress(null);
            }
          }}
        >
          {T("Download pack", "Baixar pacote")}
        </Button>
      )}
      <p className="text-[10px] text-fg-3">{T("Source", "Fonte")}: {pack.source}</p>
    </div>
  );
}

// ---------------------------------------------------------------- fields

function SymbolPalette({ profile, onInsert }: { profile: TcgProfile; onInsert: (code: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {profile.symbols.map((s) => (
        <button key={s.code} onClick={() => onInsert(s.code)} title={s.label} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-2 hover:border-accent hover:text-fg">
          {s.code}
        </button>
      ))}
    </div>
  );
}

function RichArea({ value, onChange, profile, label, help, rows = 4 }: { value: string; onChange: (v: string) => void; profile: TcgProfile; label: string; help?: string; rows?: number }) {
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  const insert = (code: string) => {
    const s = el?.selectionStart ?? value.length;
    const e = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, s) + code + value.slice(e));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + code.length, s + code.length);
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-2">{label}</span>
      <textarea
        ref={setEl}
        aria-label={label}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="resize-y rounded-md border border-line bg-surface-2 p-2 text-[12.5px] leading-relaxed outline-none focus:border-accent"
      />
      <SymbolPalette profile={profile} onInsert={insert} />
      {help && <p className="text-[10.5px] text-fg-3">{help}</p>}
    </div>
  );
}

function FieldEditor({ def, value, onChange, profile, game }: { def: FieldDef; value: FieldValue | undefined; onChange: (v: FieldValue) => void; profile: TcgProfile; game: string }) {
  const T = useBi();
  const label = T.l(def.label);
  switch (def.kind) {
    case "text":
    case "set":
      return <TextField label={label} value={str(value)} onChange={onChange} placeholder={def.placeholder} />;
    case "cost":
      return (
        <div className="flex flex-col gap-1.5">
          <TextField label={label} value={str(value)} onChange={onChange} placeholder={def.placeholder} />
          <SymbolPalette profile={profile} onInsert={(c) => onChange(str(value) + c)} />
        </div>
      );
    case "rich":
      return <RichArea label={label} value={str(value)} onChange={onChange} profile={profile} help={def.help ? T.l(def.help) : undefined} />;
    case "number":
      return <NumberField label={label} value={Number(value) || 0} min={0} max={99} step={1} onChange={onChange} />;
    case "toggle":
      return <Toggle label={label} checked={value === true} onChange={onChange} />;
    case "select":
      return <Select label={label} value={str(value, def.options?.[0]?.value ?? "")} onChange={onChange} options={(def.options ?? []).map((o) => ({ value: o.value, label: T.l(o.label) }))} />;
    case "image":
      return (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-fg-2">{label}</span>
          <ImagePicker layer={{ imageId: (value as string) || null } as ImageLayer} set={(p) => onChange((p.imageId as string | null) ?? null)} />
        </div>
      );
    case "list":
      return <ListEditor def={def} value={Array.isArray(value) ? value : []} onChange={onChange} profile={profile} game={game} />;
  }
}

function ListEditor({ def, value, onChange, profile, game }: { def: FieldDef; value: Record<string, string>[]; onChange: (v: FieldValue) => void; profile: TcgProfile; game: string }) {
  const T = useBi();
  const max = def.max ?? 4;
  const upd = (i: number, k: string, v: string) => onChange(value.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <Section
      title={T.l(def.label)}
      right={
        value.length < max ? (
          <IconButton icon={Plus} label={T("Add", "Adicionar")} onClick={() => onChange([...value, Object.fromEntries((def.item ?? []).map((x) => [x.key, ""]))])} />
        ) : undefined
      }
    >
      {value.map((row, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 p-2.5">
          <div className="flex items-center gap-1">
            <span className="flex-1 text-[11px] font-semibold text-fg-3">#{i + 1}</span>
            <IconButton icon={ArrowUp} label={T("Move up", "Subir")} onClick={() => move(i, -1)} disabled={i === 0} />
            <IconButton icon={ArrowDown} label={T("Move down", "Descer")} onClick={() => move(i, 1)} disabled={i === value.length - 1} />
            <IconButton icon={Trash2} label={T("Remove", "Remover")} onClick={() => onChange(value.filter((_, j) => j !== i))} />
          </div>
          {(def.item ?? []).map((it) =>
            it.kind === "rich" ? (
              <RichArea key={it.key} label={T.l(it.label)} value={row[it.key] ?? ""} onChange={(v) => upd(i, it.key, v)} profile={profile} rows={3} />
            ) : (
              <div key={it.key} className="flex flex-col gap-1">
                <TextField label={T.l(it.label)} value={row[it.key] ?? ""} onChange={(v) => upd(i, it.key, v)} placeholder={it.placeholder} />
                {it.key === "cost" && game !== "fab" && <SymbolPalette profile={profile} onInsert={(c) => upd(i, it.key, (row[it.key] ?? "") + c)} />}
              </div>
            ),
          )}
        </div>
      ))}
      {!value.length && <p className="text-[11px] text-fg-3">{T("None yet.", "Nenhum ainda.")}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- art search (Scryfall art crops)

function ArtSearch({ name, onPick }: { name: string; onPick: (art: string, artist?: string) => void }) {
  const T = useBi();
  const toast = useApp((s) => s.toast);
  const [q, setQ] = useState(name);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<CardResult[]>([]);
  const run = async () => {
    setBusy(true);
    try {
      setHits((await api.searchCards("mtg", q, 0, true)).results.slice(0, 24));
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={T("Art from a printing", "Arte de uma impressão")}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <TextField className="flex-1" value={q} onChange={setQ} placeholder={T("Card name", "Nome da carta")} />
        <Button size="sm" icon={busy ? undefined : Search} disabled={busy}>
          {busy && <Loader2 size={13} className="animate-spin" />}
          {T("Search", "Buscar")}
        </Button>
      </form>
      <div className="grid grid-cols-3 gap-1.5">
        {hits.map((h) => (
          <button
            key={h.id}
            title={`${h.setName} #${h.number}`}
            onClick={async () => {
              try {
                const raw = await invoke<Record<string, any>>("card_details", { game: "mtg", id: h.id });
                const face = raw.card_faces?.[0] ?? raw;
                const crop = face.image_uris?.art_crop ?? raw.image_uris?.art_crop;
                if (crop) onPick(urlAsset(crop), face.artist ?? raw.artist);
              } catch (e) {
                toast("error", errorText(e));
              }
            }}
            className="aspect-[63/88] overflow-hidden rounded hover:ring-2 hover:ring-accent"
          >
            <img src={h.thumbUrl} alt={h.name} className="h-full w-full object-cover" loading="lazy" />
          </button>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- import tab

function ImportTab({ design, profile, commit }: { design: CardDesign; profile: TcgProfile; commit: (d: CardDesign) => void }) {
  const T = useBi();
  const toast = useApp((s) => s.toast);
  const tcg = design.tcg!;
  const [paste, setPaste] = useState("");
  const apply = (cardType: string | undefined, fields: Record<string, FieldValue>, name?: string) => {
    const typed = cardType && cardType !== tcg.cardType ? changeCardType(design, cardType) : design;
    commit(setFields({ ...typed, name: name || typed.name }, fields));
  };
  return (
    <>
      <CardSearch
        game={tcg.game}
        onPick={async (hit, asBase) => {
          const raw = await invoke<unknown>("card_details", { game: tcg.game, id: hit.id });
          const imp = profile.fromApi?.(raw);
          if (!imp) throw new Error(T("This card could not be read.", "Não foi possível ler esta carta."));
          let base = tcg.base ?? null;
          if (asBase) {
            const entry = await api.fetchCard(hit);
            base = { imageId: entry.front, sourceName: `${hit.name} · ${hit.setCode} ${hit.number}`, masks: profile.realMasks?.(imp.cardType) ?? [] };
          }
          const typed = imp.cardType !== tcg.cardType ? changeCardType(design, imp.cardType) : design;
          const overrides = asBase ? withBaseVisibility(typed.tcg!.overrides, true) : typed.tcg!.overrides;
          const next = setFields({ ...typed, name: imp.name, tcg: { ...typed.tcg!, base, overrides } }, imp.fields);
          commit(next);
          toast("success", asBase ? T("Real card set as the base. Edit the fields and masks.", "Carta real definida como base. Edite os campos e as máscaras.") : T("Fields filled from the card.", "Campos preenchidos a partir da carta."));
        }}
      />
      {profile.parsePaste && (
        <Section title={T("Paste card text", "Colar texto da carta")}>
          <textarea
            aria-label={T("Card text", "Texto da carta")}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={6}
            placeholder={"Shivan Dragon {4}{R}{R}\nCreature — Dragon\nFlying\n{R}: Shivan Dragon gets +1/+0 until end of turn.\n5/5"}
            className="resize-y rounded-md border border-line bg-surface-2 p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-accent"
          />
          <Button
            size="sm"
            icon={Wand2}
            disabled={!paste.trim()}
            onClick={() => {
              const p = profile.parsePaste!(paste);
              if (!p?.fields) return toast("error", T("Could not read that text.", "Não deu para ler esse texto."));
              apply(p.cardType, p.fields, p.name);
              toast("success", T("Fields filled from the text.", "Campos preenchidos a partir do texto."));
            }}
          >
            {T("Fill fields", "Preencher campos")}
          </Button>
        </Section>
      )}
      {tcg.base && <RealBaseEditor design={design} commit={commit} />}
    </>
  );
}

function CardSearch({ game, onPick }: { game: TcgState["game"]; onPick: (hit: CardResult, asBase: boolean) => Promise<void> }) {
  const T = useBi();
  const toast = useApp((s) => s.toast);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [hits, setHits] = useState<CardResult[]>([]);
  const [sel, setSel] = useState<CardResult | null>(null);
  const run = async () => {
    setBusy("search");
    try {
      setHits((await api.searchCards(game, q, 0, game === "mtg")).results.slice(0, 30));
      setSel(null);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const go = async (asBase: boolean) => {
    if (!sel) return;
    setBusy(asBase ? "base" : "fill");
    try {
      await onPick(sel, asBase);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title={T("Import a real card", "Importar uma carta real")}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) run();
        }}
      >
        <TextField className="flex-1" value={q} onChange={setQ} placeholder={T("Card name", "Nome da carta")} autoFocus />
        <Button size="sm" icon={busy === "search" ? undefined : Search} disabled={!!busy}>
          {busy === "search" && <Loader2 size={13} className="animate-spin" />}
          {T("Search", "Buscar")}
        </Button>
      </form>
      {hits.length > 0 && (
        <div className="grid max-h-72 grid-cols-3 gap-1.5 overflow-y-auto">
          {hits.map((h) => (
            <button key={h.id + h.number} title={`${h.name} · ${h.setName} #${h.number}`} onClick={() => setSel(h)} className={cx("aspect-[63/88] overflow-hidden rounded", sel?.id === h.id ? "ring-2 ring-accent" : "hover:ring-1 hover:ring-line")}>
              <img src={h.thumbUrl} alt={h.name} className="h-full w-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {sel && (
        <div className="flex flex-col gap-2">
          <p className="truncate text-[11px] text-fg-2">
            {sel.name} · {sel.setName} #{sel.number}
          </p>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" icon={busy === "fill" ? undefined : Wand2} disabled={!!busy} onClick={() => go(false)}>
              {busy === "fill" && <Loader2 size={13} className="animate-spin" />}
              {T("Fill fields", "Preencher campos")}
            </Button>
            <Button size="sm" className="flex-1" variant="primary" icon={busy === "base" ? undefined : Sparkles} disabled={!!busy} onClick={() => go(true)}>
              {busy === "base" && <Loader2 size={13} className="animate-spin" />}
              {T("Use as base", "Usar como base")}
            </Button>
          </div>
          <p className="text-[10.5px] leading-relaxed text-fg-3">
            {T(
              "“Use as base” keeps the real scan and only repaints the masked areas with your text.",
              "“Usar como base” mantém o scan real e só repinta as áreas mascaradas com o seu texto.",
            )}
          </p>
        </div>
      )}
    </Section>
  );
}

function RealBaseEditor({ design, commit }: { design: CardDesign; commit: (d: CardDesign) => void }) {
  const T = useBi();
  const info = useApp((s) => s.info);
  const toast = useApp((s) => s.toast);
  const tcg = design.tcg!;
  const base = tcg.base!;
  const [busy, setBusy] = useState(false);
  const profile = profileFor(tcg.game)!;
  const setBase = (b: typeof base | null) => commit({ ...design, tcg: { ...tcg, base: b } });
  const setMask = (i: number, p: Partial<RealMask>) => setBase({ ...base, masks: base.masks.map((m, j) => (j === i ? { ...m, ...p } : m)) });
  const hiddenFrame = useMemo(() => tcg.overrides.frame?.visible === false, [tcg.overrides]);
  return (
    <Section title={T("Real card base", "Base de carta real")}>
      <p className="text-[11px] text-fg-2">{base.sourceName}</p>
      <Toggle
        checked={hiddenFrame}
        onChange={(hide) => commit({ ...design, tcg: { ...tcg, overrides: withBaseVisibility(tcg.overrides, hide) } })}
        label={T("Hide generated frame and art (show the scan)", "Ocultar moldura e arte geradas (mostrar o scan)")}
      />
      {base.masks.map((m, i) => (
        <div key={m.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 p-2.5">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs font-semibold">{m.label}</span>
            <IconButton icon={Trash2} label={T("Remove mask", "Remover máscara")} onClick={() => setBase({ ...base, masks: base.masks.filter((_, j) => j !== i) })} />
          </div>
          <Select
            label={T("Fill", "Preenchimento")}
            value={m.fill}
            onChange={(fill) => setMask(i, { fill, sample: fill === "clone" ? (m.sample ?? { x: m.x, y: Math.max(0, m.y - m.h - 0.01), w: m.w, h: m.h }) : m.sample })}
            options={[
              { value: "auto", label: T("Average edge colour", "Cor média da borda") },
              { value: "clone", label: T("Clone a clean area", "Clonar área limpa") },
              { value: "color", label: T("Solid colour", "Cor sólida") },
              { value: "keep", label: T("Keep the scan", "Manter o scan") },
            ]}
          />
          {m.fill === "color" && (
            <label className="flex items-center gap-2 text-xs text-fg-2">
              {T("Colour", "Cor")}
              <input type="color" value={m.color ?? "#ffffff"} onChange={(e) => setMask(i, { color: e.target.value })} />
            </label>
          )}
          <div className="grid grid-cols-2 gap-2">
            {(["x", "y", "w", "h"] as const).map((k) => (
              <NumberField key={k} label={k.toUpperCase()} unit="%" value={Math.round(m[k] * 1000) / 10} min={0} max={100} step={0.1} onChange={(v) => setMask(i, { [k]: v / 100 })} />
            ))}
          </div>
          {m.fill === "clone" && m.sample && (
            <Slider label={T("Clone source (vertical)", "Origem do clone (vertical)")} value={m.sample.y} min={0} max={1 - m.sample.h} onChange={(y) => setMask(i, { sample: { ...m.sample!, y } })} format={(v) => `${Math.round(v * 100)}%`} />
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={Plus} onClick={() => setBase({ ...base, masks: [...base.masks, { id: crypto.randomUUID(), label: T("Mask", "Máscara"), x: 0.3, y: 0.4, w: 0.4, h: 0.1, fill: "auto" }] })}>
          {T("Add mask", "Adicionar máscara")}
        </Button>
        <Button size="sm" onClick={() => setBase({ ...base, masks: profile.realMasks?.(tcg.cardType) ?? [] })}>
          {T("Default masks", "Máscaras padrão")}
        </Button>
        {info?.upscalerAvailable && (
          <Button
            size="sm"
            icon={busy ? undefined : Sparkles}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const meta = await api.upscaleImage({ imageId: base.imageId, model: "realesrgan-x4plus", scale: 4, tile: 0, tta: false });
                setBase({ ...base, imageId: meta.id });
                toast("success", T("Scan upscaled 4×.", "Scan ampliado 4×."));
              } catch (e) {
                toast("error", errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {T("Upscale scan (AI)", "Melhorar resolução (IA)")}
          </Button>
        )}
        <Button size="sm" variant="danger" icon={Trash2} onClick={() => setBase(null)}>
          {T("Remove base", "Remover base")}
        </Button>
      </div>
    </Section>
  );
}
