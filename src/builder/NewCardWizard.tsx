// "New card" wizard: which TCG → how to start (official frames, import by name, real card base,
// generic template) → card type. Magic, Pokémon and Flesh and Blood have full editors.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, FileSearch, Layers, Loader2, Search, Sparkles, Wand2 } from "lucide-react";
import { useApp } from "../lib/store";
import { api, errorText } from "../lib/ipc";
import type { CardResult, Game } from "../lib/types";
import { Button, cx, Modal, TextField } from "../components/ui";
import { useBi } from "./bi";
import { loadPackFonts } from "./packs";
import { loadAssets, renderDesign } from "./render";
import { ensureFonts } from "./fonts";
import { FRAME_COLORS, TEMPLATES } from "./templates";
import { createTcgDesign, PROFILES } from "./tcg/registry";
import { withBaseVisibility } from "./tcg/sync";
import type { TcgId } from "./tcg/types";
import type { CardDesign, TextLayer } from "./types";

type Step = "game" | "mode" | "type" | "search" | "generic";
type Mode = "scratch" | "import" | "real";

const FULL: TcgId[] = ["mtg", "pokemon", "fab"];
const GAME_COLORS: Record<string, string> = {
  mtg: "linear-gradient(135deg,#f97316,#7c2d12)",
  pokemon: "linear-gradient(135deg,#facc15,#2563eb)",
  fab: "linear-gradient(135deg,#dc2626,#1c1917)",
  yugioh: "linear-gradient(135deg,#a16207,#292524)",
  lorcana: "linear-gradient(135deg,#a78bfa,#1e1b4b)",
  onepiece: "linear-gradient(135deg,#ef4444,#1e3a8a)",
  swu: "linear-gradient(135deg,#94a3b8,#0f172a)",
  digimon: "linear-gradient(135deg,#38bdf8,#1e40af)",
  riftbound: "linear-gradient(135deg,#2dd4bf,#134e4a)",
};

interface Props {
  onClose: () => void;
  onCreate: (d: CardDesign) => void;
  onGeneric: (templateId: string, color: string) => void;
}

export function NewCardWizard({ onClose, onCreate, onGeneric }: Props) {
  const T = useBi();
  const info = useApp((s) => s.info);
  const [step, setStep] = useState<Step>("game");
  const [game, setGame] = useState<Game | null>(null);
  const [mode, setMode] = useState<Mode>("scratch");
  const games = info?.games ?? FULL.map((g) => ({ game: g, name: PROFILES[g].name, source: "", beta: false }));
  const full = game && FULL.includes(game as TcgId) ? (game as TcgId) : null;

  const back = () => setStep(step === "type" || step === "search" ? "mode" : "game");
  const titles: Record<Step, [string, string]> = {
    game: [T("Which TCG?", "Qual é o TCG?"), T("The editor, frames, fonts and symbols follow the game.", "O editor, as molduras, as fontes e os símbolos seguem o jogo.")],
    mode: [T("How do you want to start?", "Como você quer começar?"), PROFILES[full ?? "mtg"].name],
    type: [T("Card type", "Tipo de carta"), T("Official frames download on first use.", "As molduras oficiais baixam no primeiro uso.")],
    search: [mode === "real" ? T("Pick the real card", "Escolha a carta real") : T("Import a card", "Importar uma carta"), PROFILES[full ?? "mtg"].name],
    generic: [T("Generic template", "Modelo genérico"), T("Fully editable layers for any game.", "Camadas totalmente editáveis para qualquer jogo.")],
  };
  return (
    <Modal
      title={titles[step][0]}
      subtitle={titles[step][1]}
      onClose={onClose}
      width={step === "game" ? 680 : 720}
      leading={step !== "game" ? <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={back} aria-label={T("Back", "Voltar")} /> : undefined}
    >
      {step === "game" && (
        <div className="grid grid-cols-3 gap-3">
          {games.map((g) => {
            const isFull = FULL.includes(g.game as TcgId);
            return (
              <button
                key={g.game}
                onClick={() => {
                  setGame(g.game);
                  setStep(isFull ? "mode" : "generic");
                }}
                className="group flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-2.5 text-left hover:border-accent"
              >
                <div className="flex h-16 items-end rounded p-2" style={{ background: GAME_COLORS[g.game] ?? "linear-gradient(135deg,#52525b,#18181b)" }}>
                  {isFull && <span className="rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase">{T("Full editor", "Editor completo")}</span>}
                </div>
                <span className="text-[13px] font-semibold">{g.name}</span>
                <span className="text-[11px] text-fg-3">{isFull ? T("Official frames, fonts and symbols", "Molduras, fontes e símbolos oficiais") : T("Generic templates", "Modelos genéricos")}</span>
              </button>
            );
          })}
          <button onClick={() => setStep("generic")} className="flex flex-col justify-center gap-1 rounded-lg border border-dashed border-line p-2.5 text-left hover:border-accent">
            <span className="text-[13px] font-semibold">{T("Other / custom", "Outro / próprio")}</span>
            <span className="text-[11px] text-fg-3">{T("Start from a generic template", "Começar de um modelo genérico")}</span>
          </button>
        </div>
      )}

      {step === "mode" && full && (
        <div className="grid grid-cols-2 gap-3">
          <ModeCard icon={Layers} title={T("From scratch, official look", "Do zero, visual oficial")} text={T("Pick a card type and fill in the form. Frames, fonts and symbols come from the game's pack.", "Escolha o tipo de carta e preencha o formulário. Molduras, fontes e símbolos vêm do pacote do jogo.")} onClick={() => (setMode("scratch"), setStep("type"))} />
          <ModeCard icon={FileSearch} title={T("Import a card by name", "Importar carta pelo nome")} text={T("Search the card bank and fill every field (text, stats, art crop) automatically.", "Busque no banco de cartas e preencha todos os campos (texto, atributos, arte) automaticamente.")} onClick={() => (setMode("import"), setStep("search"))} />
          <ModeCard icon={Sparkles} title={T("From a real card", "A partir de carta real")} text={T("Use the real scan as the base and repaint only the parts you change (name, text, stats).", "Usa o scan real como base e repinta só o que você mudar (nome, texto, atributos).")} onClick={() => (setMode("real"), setStep("search"))} />
          <ModeCard icon={Wand2} title={T("Generic template", "Modelo genérico")} text={T("Free layers without the official frame.", "Camadas livres, sem a moldura oficial.")} onClick={() => setStep("generic")} />
        </div>
      )}

      {step === "type" && full && <TypeGrid game={full} onPick={(type) => onCreate(createTcgDesign(full, type))} />}

      {step === "search" && full && <WizardSearch game={full} real={mode === "real"} onCreate={onCreate} />}

      {step === "generic" && <GenericPicker onPick={onGeneric} />}
    </Modal>
  );
}

function ModeCard({ icon: Icon, title, text, onClick }: { icon: typeof Layers; title: string; text: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3.5 text-left hover:border-accent">
      <Icon size={18} className="text-accent" />
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="text-[11px] leading-relaxed text-fg-3">{text}</span>
    </button>
  );
}

/** Live thumbnail of a card type with its default fields. */
function TypeThumb({ design }: { design: CardDesign }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadPackFonts(PROFILES[design.tcg!.game].packId);
      await ensureFonts(design.layers.filter((l): l is TextLayer => l.kind === "text").map((t) => ({ font: t.font, weight: t.weight, italic: t.italic })));
      const k = 3;
      const c = document.createElement("canvas");
      c.width = Math.round((design.width + 2 * design.bleed) * k);
      c.height = Math.round((design.height + 2 * design.bleed) * k);
      renderDesign(c.getContext("2d")!, design, k, await loadAssets(design));
      if (alive) setUrl(c.toDataURL("image/png"));
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [design]);
  return (
    <div className="relative aspect-[69/94] w-full overflow-hidden rounded bg-surface-3">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <Loader2 size={16} className="absolute inset-0 m-auto animate-spin text-fg-3" />}
    </div>
  );
}

function TypeGrid({ game, onPick }: { game: TcgId; onPick: (type: string) => void }) {
  const T = useBi();
  const p = PROFILES[game];
  const [designs] = useState(() => Object.fromEntries(p.cardTypes.map((t) => [t.id, createTcgDesign(game, t.id)])));
  return (
    <div className="grid grid-cols-4 gap-3">
      {p.cardTypes.map((t) => (
        <button key={t.id} onClick={() => onPick(t.id)} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 p-2 text-left hover:border-accent">
          <TypeThumb design={designs[t.id]} />
          <span className="text-[12px] font-semibold">{T.l(t.label)}</span>
          <span className="text-[10.5px] leading-snug text-fg-3">{T.l(t.description)}</span>
        </button>
      ))}
    </div>
  );
}

function WizardSearch({ game, real, onCreate }: { game: TcgId; real: boolean; onCreate: (d: CardDesign) => void }) {
  const T = useBi();
  const toast = useApp((s) => s.toast);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [hits, setHits] = useState<CardResult[]>([]);
  const run = async () => {
    setBusy("search");
    try {
      setHits((await api.searchCards(game, q, 0, game === "mtg")).results.slice(0, 40));
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const pick = async (hit: CardResult) => {
    setBusy(hit.id);
    try {
      const p = PROFILES[game];
      const raw = await invoke<unknown>("card_details", { game, id: hit.id });
      const imp = p.fromApi?.(raw);
      if (!imp) throw new Error(T("This card could not be read.", "Não foi possível ler esta carta."));
      let base = null;
      if (real) {
        const entry = await api.fetchCard(hit);
        base = { imageId: entry.front, sourceName: `${hit.name} · ${hit.setCode} ${hit.number}`, masks: p.realMasks?.(imp.cardType) ?? [] };
      }
      const d = createTcgDesign(game, imp.cardType, imp.fields, { name: imp.name, base });
      if (real) d.tcg = { ...d.tcg!, overrides: withBaseVisibility(d.tcg!.overrides, true) };
      onCreate(d);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) run();
        }}
      >
        <TextField className="flex-1" value={q} onChange={setQ} placeholder={T("Card name", "Nome da carta")} autoFocus />
        <Button icon={busy === "search" ? undefined : Search} disabled={!!busy}>
          {busy === "search" && <Loader2 size={14} className="animate-spin" />}
          {T("Search", "Buscar")}
        </Button>
      </form>
      <p className="text-[11px] text-fg-3">
        {real
          ? T("The scan stays as the base; the name, text and stats areas are masked so you can rewrite them.", "O scan fica como base; as áreas de nome, texto e atributos são mascaradas para você reescrever.")
          : T("Every field is filled from the card; the art comes from the art crop when the bank has one.", "Todos os campos vêm da carta; a arte vem do recorte de arte quando o banco tem.")}
      </p>
      <div className="grid max-h-[52vh] grid-cols-5 gap-2 overflow-y-auto">
        {hits.map((h) => (
          <button key={h.id + h.number} title={`${h.name} · ${h.setName} #${h.number}`} disabled={!!busy} onClick={() => pick(h)} className="relative aspect-[63/88] overflow-hidden rounded hover:ring-2 hover:ring-accent">
            <img src={h.thumbUrl} alt={h.name} className="h-full w-full object-cover" loading="lazy" />
            {busy === h.id && (
              <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                <Loader2 size={18} className="animate-spin text-white" />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function GenericPicker({ onPick }: { onPick: (t: string, color: string) => void }) {
  const T = useBi();
  const [color, setColor] = useState("red");
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        {TEMPLATES.map((t) => (
          <button key={t.id} onClick={() => onPick(t.id, color)} className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-2.5 text-left hover:border-accent">
            <div className="h-24 w-full rounded" style={{ background: t.id === "classic" ? `linear-gradient(160deg, ${FRAME_COLORS[color].frame.join(",")})` : t.preview }} />
            <span className="text-[13px] font-semibold">{t.name}</span>
            <span className="text-[11px] leading-snug text-fg-3">{t.description}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className="section-title">{T("Frame colour (classic template)", "Cor da moldura (modelo clássico)")}</span>
        <div className="flex flex-wrap gap-2">
          {Object.entries(FRAME_COLORS).map(([id, c]) => (
            <button
              key={id}
              onClick={() => setColor(id)}
              title={c.name}
              aria-pressed={id === color}
              className={cx("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", id === color ? "border-accent text-fg" : "border-line text-fg-2")}
            >
              <span className="h-3 w-3 rounded-full" style={{ background: `linear-gradient(135deg, ${c.frame.join(",")})` }} />
              {c.name}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
