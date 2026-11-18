import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, Circle, Copy, ExternalLink, FileUp, Plus, RotateCcw, SwatchBook, Trash2 } from "lucide-react";
import { useApp } from "../../lib/store";
import { useT } from "../../lib/i18n";
import { api, errorText } from "../../lib/ipc";
import type { Adjustments, CurvePoints, PrintProfile, RenderingIntent } from "../../lib/types";
import { Button, cx, IconButton, NumberField, Section, Segmented, Select, Slider, TextField, Toggle } from "../ui";

const DEFAULT_ADJ: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  gamma: 1,
  levelsBlack: 0,
  levelsWhite: 1,
  red: 1,
  green: 1,
  blue: 1,
  curveMaster: [],
  curveRed: [],
  curveGreen: [],
  curveBlue: [],
  sharpen: 0,
};

const pct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`;

export function ColorPanel() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const profiles = useApp((s) => s.profiles);
  const icc = useApp((s) => s.icc);
  const { update, saveProfiles, refreshProfiles, toast } = useApp.getState();
  const current = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const [draft, setDraft] = useState<PrintProfile | null>(current ?? null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => setDraft(current ?? null), [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft) return null;

  const edit = (fn: (p: PrintProfile) => PrintProfile) => {
    const next = fn(structuredClone(draft));
    setDraft(next);
    // apply to the live preview immediately, persist shortly after
    useApp.setState({ profiles: profiles.map((p) => (p.id === next.id ? next : p)) });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saveProfiles(useApp.getState().profiles).catch((e) => toast("error", errorText(e))), 400);
  };
  const adj = (k: keyof Adjustments, v: number) => edit((p) => ({ ...p, adjustments: { ...p.adjustments, [k]: v } }));

  const create = async (base?: PrintProfile) => {
    const p: PrintProfile = base
      ? { ...structuredClone(base), id: crypto.randomUUID(), name: `${base.name} (copy)` }
      : { ...structuredClone(profiles[0]), id: crypto.randomUUID(), name: "New profile", adjustments: { ...DEFAULT_ADJ } };
    await saveProfiles([...profiles, p]);
    update((pr) => ({ ...pr, printProfileId: p.id }));
  };

  const iccSpace = icc.find((i) => i.id === draft.outputIcc)?.space ?? draft.outputSpace;

  return (
    <>
      <div className="flex flex-col gap-2.5 border-b border-line px-4 pt-4.5 pb-3.5">
        <div className="flex items-center">
          <h2 className="flex-1 text-base font-semibold">{t("printProfiles")}</h2>
          <IconButton icon={Copy} label={t("duplicate")} onClick={() => create(draft)} />
          <Button size="sm" icon={Plus} onClick={() => create()}>
            {t("new")}
          </Button>
        </div>
        <div className="flex max-h-[150px] flex-col gap-0.5 overflow-y-auto">
          {profiles.map((p) => {
            const active = p.id === draft.id;
            return (
              <button
                key={p.id}
                onClick={() => update((pr) => ({ ...pr, printProfileId: p.id }))}
                className={cx("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left", active ? "bg-accent-soft" : "hover:bg-surface-2")}
              >
                {active ? <CheckCircle2 size={15} className="text-accent" /> : <Circle size={15} className="text-fg-3" />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs font-medium">{p.name}</span>
                  <span className="truncate text-[11px] text-fg-3">
                    {p.outputSpace.toUpperCase()} · {icc.find((i) => i.id === p.outputIcc)?.name ?? p.outputIcc} · {p.dpi} DPI
                  </span>
                </span>
                {!active && profiles.length > 1 && (
                  <span
                    role="button"
                    aria-label={t("delete")}
                    onClick={(e) => {
                      e.stopPropagation();
                      saveProfiles(profiles.filter((x) => x.id !== p.id));
                    }}
                    className="text-fg-3 hover:text-bad"
                  >
                    <Trash2 size={13} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <TextField label={t("profileName")} value={draft.name} onChange={(v) => edit((p) => ({ ...p, name: v }))} />
        <Section title={t("output")}>
          <div className="flex items-end gap-2">
            <Select
              className="flex-1"
              label={t("iccProfile")}
              value={draft.outputIcc}
              onChange={(v) => edit((p) => ({ ...p, outputIcc: v, outputSpace: icc.find((i) => i.id === v)?.space ?? p.outputSpace }))}
              options={icc.map((i) => ({ value: i.id, label: `${i.space.toUpperCase()} · ${i.name}` }))}
            />
            <IconButton
              icon={FileUp}
              label={t("importIcc")}
              className="h-8 w-8 border border-line bg-surface-2"
              onClick={async () => {
                const path = await open({ multiple: false, filters: [{ name: "ICC profile", extensions: ["icc", "icm"] }] });
                if (!path || Array.isArray(path)) return;
                try {
                  const info = await api.importIcc(path);
                  await refreshProfiles();
                  edit((p) => ({ ...p, outputIcc: info.id, outputSpace: info.space }));
                } catch (e) {
                  toast("error", errorText(e));
                }
              }}
            />
          </div>
          <button className="flex items-center gap-1.5 self-start text-[11px] text-fg-2 hover:text-accent" onClick={() => openUrl("https://www.eci.org/en/downloads")}>
            <ExternalLink size={12} /> {t("getCmyk")}
          </button>
          <p className="text-[11px] text-fg-3">
            {iccSpace === "cmyk" ? "CMYK → PDF / TIFF" : "RGB → PDF / PNG / TIFF"}
          </p>
          <Select<RenderingIntent>
            label={t("intent")}
            value={draft.intent}
            onChange={(v) => edit((p) => ({ ...p, intent: v }))}
            options={[
              { value: "perceptual", label: t("perceptual") },
              { value: "relativeColorimetric", label: t("relativeColorimetric") },
              { value: "saturation", label: t("saturationIntent") },
              { value: "absoluteColorimetric", label: t("absoluteColorimetric") },
            ]}
          />
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <Toggle checked={draft.blackPointCompensation} onChange={(v) => edit((p) => ({ ...p, blackPointCompensation: v }))} label={t("bpc")} />
            <Toggle checked={draft.embedProfile} onChange={(v) => edit((p) => ({ ...p, embedProfile: v }))} label={t("embed")} />
          </div>
          <div className="flex gap-2">
            <Select
              className="flex-1"
              label={t("dpi")}
              value={String(draft.dpi)}
              onChange={(v) => edit((p) => ({ ...p, dpi: Number(v) }))}
              options={["300", "600", "800", "1200", "2400", "4800"].map((d) => ({ value: d, label: `${d} DPI` }))}
            />
            {iccSpace === "cmyk" && (
              <NumberField className="flex-1" label={t("inkLimit")} unit="%" value={draft.inkLimit} min={150} max={400} step={10} onChange={(v) => edit((p) => ({ ...p, inkLimit: v }))} />
            )}
          </div>
        </Section>

        <Section
          title={t("adjustments")}
          right={
            <button className="flex items-center gap-1 text-[11px] text-fg-2 hover:text-fg" onClick={() => edit((p) => ({ ...p, adjustments: { ...DEFAULT_ADJ } }))}>
              <RotateCcw size={12} /> {t("reset")}
            </button>
          }
        >
          <Slider label={t("brightness")} value={draft.adjustments.brightness} min={-0.5} max={0.5} onChange={(v) => adj("brightness", v)} format={pct} />
          <Slider label={t("contrast")} value={draft.adjustments.contrast} min={-0.5} max={0.5} onChange={(v) => adj("contrast", v)} format={pct} />
          <Slider label={t("saturation")} value={draft.adjustments.saturation} min={-1} max={1} onChange={(v) => adj("saturation", v)} format={pct} />
          <Slider label={t("vibrance")} value={draft.adjustments.vibrance} min={-1} max={1} onChange={(v) => adj("vibrance", v)} format={pct} />
          <Slider label={t("gamma")} value={draft.adjustments.gamma} min={0.5} max={2} onChange={(v) => adj("gamma", v)} format={(v) => v.toFixed(2)} />
          <Slider label={t("sharpen")} value={draft.adjustments.sharpen} min={0} max={2} onChange={(v) => adj("sharpen", v)} format={(v) => v.toFixed(1)} />
        </Section>

        <Section title={t("levels")}>
          <div className="flex gap-2">
            <NumberField className="flex-1" label="Black" value={draft.adjustments.levelsBlack} min={0} max={0.5} step={0.01} onChange={(v) => adj("levelsBlack", v)} />
            <NumberField className="flex-1" label="White" value={draft.adjustments.levelsWhite} min={0.5} max={1} step={0.01} onChange={(v) => adj("levelsWhite", v)} />
          </div>
        </Section>

        <Section title={t("channels")}>
          <Slider label={t("red")} value={draft.adjustments.red} min={0.7} max={1.3} onChange={(v) => adj("red", v)} format={(v) => v.toFixed(2)} />
          <Slider label={t("green")} value={draft.adjustments.green} min={0.7} max={1.3} onChange={(v) => adj("green", v)} format={(v) => v.toFixed(2)} />
          <Slider label={t("blue")} value={draft.adjustments.blue} min={0.7} max={1.3} onChange={(v) => adj("blue", v)} format={(v) => v.toFixed(2)} />
        </Section>

        <CurvesEditor adj={draft.adjustments} onChange={(k, pts) => edit((p) => ({ ...p, adjustments: { ...p.adjustments, [k]: pts } }))} />

        <Button
          icon={SwatchBook}
          onClick={async () => {
            const path = await save({ defaultPath: `test-chart-${draft.name.replace(/\W+/g, "-")}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
            if (!path) return;
            try {
              await api.testChart(draft.id, project.layout, path);
              toast("success", path);
            } catch (e) {
              toast("error", errorText(e));
            }
          }}
        >
          {t("testChart")}
        </Button>
      </div>
    </>
  );
}

type CurveKey = "curveMaster" | "curveRed" | "curveGreen" | "curveBlue";

function CurvesEditor({ adj, onChange }: { adj: Adjustments; onChange: (k: CurveKey, pts: CurvePoints) => void }) {
  const t = useT();
  const [ch, setCh] = useState<CurveKey>("curveMaster");
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const S = 280;
  const pts: CurvePoints = adj[ch].length >= 2 ? adj[ch] : [[0, 0], [1, 1]];
  const color = { curveMaster: "#ededf0", curveRed: "#f87171", curveGreen: "#4ade80", curveBlue: "#60a5fa" }[ch];

  const toXY = (e: React.PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const sorted = (p: CurvePoints) => [...p].sort((a, b) => a[0] - b[0]);
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x * S},${(1 - y) * S}`).join(" ");

  return (
    <Section
      title={t("curves")}
      right={
        <button className="flex items-center gap-1 text-[11px] text-fg-2 hover:text-fg" onClick={() => onChange(ch, [])}>
          <RotateCcw size={12} /> {t("reset")}
        </button>
      }
    >
      <Segmented
        value={ch}
        onChange={setCh}
        options={[
          { value: "curveMaster", label: t("master") },
          { value: "curveRed", label: "R" },
          { value: "curveGreen", label: "G" },
          { value: "curveBlue", label: "B" },
        ]}
      />
      <svg
        ref={svg}
        viewBox={`0 0 ${S} ${S}`}
        className="aspect-square w-full cursor-crosshair touch-none rounded-md border border-line bg-surface-2"
        onPointerDown={(e) => {
          const [x, y] = toXY(e);
          const hit = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.05);
          if (hit >= 0) setDrag(hit);
          else {
            const next = sorted([...pts, [x, y]]);
            onChange(ch, next);
            setDrag(next.findIndex((p) => p[0] === x));
          }
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          const [x, y] = toXY(e);
          const next = pts.map((p, i) => (i === drag ? ([i === 0 ? 0 : i === pts.length - 1 ? 1 : x, y] as [number, number]) : p));
          onChange(ch, next);
        }}
        onPointerUp={() => setDrag(null)}
        onDoubleClick={(e) => {
          const [x, y] = toXY(e as unknown as React.PointerEvent);
          const hit = pts.findIndex(([px, py], i) => i > 0 && i < pts.length - 1 && Math.hypot(px - x, py - y) < 0.05);
          if (hit >= 0) onChange(ch, pts.filter((_, i) => i !== hit));
        }}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="var(--color-line)" strokeWidth={1}>
            <line x1={g * S} x2={g * S} y1={0} y2={S} />
            <line y1={g * S} y2={g * S} x1={0} x2={S} />
          </g>
        ))}
        <line x1={0} y1={S} x2={S} y2={0} stroke="var(--color-surface-3)" strokeDasharray="4 4" />
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x * S} cy={(1 - y) * S} r={5} fill="var(--color-bg)" stroke={color} strokeWidth={2} />
        ))}
      </svg>
      <p className="text-[11px] text-fg-3">Click to add a point, drag to move, double-click to remove.</p>
    </Section>
  );
}
