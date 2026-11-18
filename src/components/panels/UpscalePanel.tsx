import { useEffect, useMemo, useState } from "react";
import { CircleDot, Circle, Info, Sparkles, X } from "lucide-react";
import { cardDpi, useApp } from "../../lib/store";
import { useUpscaleQueue } from "../../lib/autoUpscale";
import { useT } from "../../lib/i18n";
import { api, errorText, fileUrl, onProgress } from "../../lib/ipc";
import { detectBleedMm } from "../../lib/units";
import { Button, cx, ProgressBar, Section, Segmented, Toggle } from "../ui";

type JobState = { progress: number; status: "waiting" | "running" | "done" | "failed"; error?: string };

export function UpscalePanel() {
  const t = useT();
  const info = useApp((s) => s.info);
  const project = useApp((s) => s.project)!;
  const images = useApp((s) => s.images);
  const profiles = useApp((s) => s.profiles);
  const selected = useApp((s) => s.selectedCard);
  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const target = profile?.dpi ?? 600;
  const [model, setModel] = useState(project.upscale?.model ?? "realesrgan-x4plus");
  const autoQueue = useUpscaleQueue();
  const [scale, setScale] = useState("4");
  const [onlyLow, setOnlyLow] = useState(true);
  const [cpu, setCpu] = useState(false);
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [running, setRunning] = useState(false);
  const { cardSize } = project.layout;

  const dpiOf = (imageId: string, builtin?: number | null) => {
    const im = images[imageId];
    if (!im) return 0;
    const b = builtin ?? detectBleedMm(im.meta.width, im.meta.height, cardSize.width, cardSize.height);
    return cardDpi(im.meta, cardSize.width, b);
  };

  // Cards already upscaled stay eligible: the DPI check uses the current artwork, so a
  // card that still falls short of the target can be upscaled again.
  const candidates = useMemo(
    () => project.cards.filter((c) => !onlyLow || dpiOf(c.front, c.builtinBleedMm) < target),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.cards, onlyLow, target, images],
  );
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const queue = candidates.filter((c) => !skipped.has(c.id));
  const togglePick = (id: string) =>
    setSkipped((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  useEffect(() => {
    const un = onProgress((e) => {
      if (!e.task.startsWith("upscale:")) return;
      const id = e.task.slice(8);
      setJobs((j) => (j[id] ? { ...j, [id]: { ...j[id], progress: e.progress } } : j));
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const sample = project.cards.find((c) => c.id === selected) ?? queue[0];
  const sampleMeta = sample ? images[sample.front]?.meta : undefined;
  const s = Number(scale);

  const run = async () => {
    setRunning(true);
    const st = useApp.getState();
    setJobs(Object.fromEntries(queue.map((c) => [c.front, { progress: 0, status: "waiting" } as JobState])));
    for (const c of queue) {
      if (!useApp.getState().project) break;
      setJobs((j) => ({ ...j, [c.front]: { progress: 0, status: "running" } }));
      try {
        const meta = await api.upscaleImage({ imageId: c.front, model, scale: s, tile: 0, gpu: cpu ? -1 : null, tta: false });
        let back = c.back ?? null;
        if (c.back) {
          const bm = await api.upscaleImage({ imageId: c.back, model, scale: s, tile: 0, gpu: cpu ? -1 : null, tta: false });
          back = bm.id;
        }
        st.update((p) => ({
          ...p,
          cards: p.cards.map((x) =>
            x.id === c.id
              ? {
                  ...x,
                  // keep the very first artwork so "revert" always goes back to the source
                  originalFront: x.originalFront ?? x.front,
                  originalBack: x.originalFront ? (x.originalBack ?? null) : (x.back ?? null),
                  front: meta.id,
                  back,
                }
              : x,
          ),
        }));
        await st.ensureImages([meta.id, back ?? ""].filter(Boolean));
        setJobs((j) => ({ ...j, [c.front]: { progress: 1, status: "done" } }));
      } catch (e) {
        const msg = errorText(e);
        setJobs((j) => ({ ...j, [c.front]: { progress: 0, status: "failed", error: msg } }));
        if (msg.includes("cancelled")) break;
      }
    }
    setRunning(false);
  };

  const scaleOptions = ["2", "4", "8", "16"].map((v) => ({ value: v, label: `×${v}` }));

  return (
    <>
      <div className="flex flex-col gap-1 border-b border-line px-4 pt-4.5 pb-3.5">
        <h2 className="text-base font-semibold">{t("aiUpscale")}</h2>
        <p className="text-[11px] text-fg-3">{t("upscaleSub")}</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {!info?.upscalerAvailable && <p className="rounded-md bg-bad/10 p-2.5 text-xs text-bad">{t("upscaleMissing")}</p>}
        <Section title={t("autoUpscale")}>
          <Toggle
            checked={!!project.upscale?.auto}
            onChange={(v) => useApp.getState().update((p) => ({ ...p, upscale: { ...(p.upscale ?? { model, maxScale: 4 }), auto: v, model: p.upscale?.model ?? model } }))}
            label={t("autoUpscaleOn")}
          />
          <p className="text-[11px] leading-relaxed text-fg-3">{t("autoUpscaleHint")}</p>
          {project.upscale?.auto && (
            <>
              <span className="text-xs font-medium text-fg-2">{t("maxScale")}</span>
              <Segmented
                value={String(project.upscale.maxScale)}
                onChange={(v) => useApp.getState().update((p) => ({ ...p, upscale: { ...p.upscale, maxScale: Number(v) } }))}
                options={["2", "4", "8"].map((v) => ({ value: v, label: `×${v}` }))}
                mono
              />
              {autoQueue.running && (
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] text-fg-2">{t("upscaleChip", { d: String(autoQueue.done), n: String(autoQueue.total) })}</span>
                  <ProgressBar value={autoQueue.total ? autoQueue.done / autoQueue.total : 0} />
                </div>
              )}
            </>
          )}
        </Section>
        <Section title={t("model")}>
          {(info?.models ?? []).map((m) => {
            const a = m.id === model;
            return (
              <button
                key={m.id}
                onClick={() => {
                  setModel(m.id);
                  if (project.upscale?.auto) useApp.getState().update((p) => ({ ...p, upscale: { ...p.upscale, model: m.id } }));
                }}
                className={cx("flex gap-2.5 rounded-md border p-2.5 text-left", a ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2")}
              >
                {a ? <CircleDot size={15} className="mt-0.5 text-accent" /> : <Circle size={15} className="mt-0.5 text-fg-3" />}
                <span className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">{m.name}</span>
                  <span className="text-[11px] text-fg-3">{m.description}</span>
                </span>
              </button>
            );
          })}
        </Section>
        <Section title={t("scale")}>
          <Segmented value={scale} onChange={setScale} options={scaleOptions} mono />
          {sampleMeta && (
            <div className="flex items-start gap-2 rounded-md bg-surface-2 p-2.5 text-[11px] text-fg-2">
              <Info size={14} className="mt-px shrink-0" />
              <span>
                {sampleMeta.width}×{sampleMeta.height} → {sampleMeta.width * s}×{sampleMeta.height * s} px · {dpiOf(sample!.front, sample!.builtinBleedMm) * s} DPI @ {cardSize.width}×{cardSize.height} mm
              </span>
            </div>
          )}
          <Toggle checked={onlyLow} onChange={setOnlyLow} label={t("onlyLowRes")} />
          <Toggle checked={cpu} onChange={setCpu} label="CPU (no GPU)" />
        </Section>
        <Section
          title={`${t("queue")} · ${queue.length}/${candidates.length}`}
          right={
            candidates.length > 0 && (
              <button
                className="text-[11px] font-medium text-accent"
                onClick={() => setSkipped(queue.length ? new Set(candidates.map((c) => c.id)) : new Set())}
              >
                {queue.length ? t("selectNone") : t("selectAll")}
              </button>
            )
          }
        >
          {candidates.map((c) => {
            const j = jobs[c.front];
            const im = images[c.front];
            const picked = !skipped.has(c.id);
            return (
              <div
                key={c.id}
                className={cx("flex cursor-pointer items-center gap-2.5 rounded-md", !picked && "opacity-50", c.id === selected && "bg-surface-2/60")}
                onClick={() => useApp.getState().select(c.id)}
              >
                <input
                  type="checkbox"
                  checked={picked}
                  disabled={running}
                  aria-label={c.name}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => togglePick(c.id)}
                  className="h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                />
                {im ? <img src={fileUrl(im.thumb)} alt="" className="h-[34px] w-6 rounded-[2px] object-cover" /> : <div className="h-[34px] w-6 rounded-[2px] bg-surface-3" />}
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex justify-between gap-2">
                    <span className="truncate text-xs font-medium">{c.name}</span>
                    <span className={cx("shrink-0 font-mono text-[11px]", j?.status === "done" ? "text-ok" : j?.status === "failed" ? "text-bad" : "text-fg-3")} title={j?.error}>
                      {!j ? `${dpiOf(c.front, c.builtinBleedMm)} DPI` : j.status === "running" ? `${Math.round(j.progress * 100)}%` : t(j.status === "done" ? "done" : j.status === "failed" ? "failed" : "waiting")}
                    </span>
                  </div>
                  <ProgressBar value={j?.progress ?? 0} tone={j?.status === "done" ? "ok" : "accent"} />
                </div>
              </div>
            );
          })}
        </Section>
        <div className="flex-1" />
        {running ? (
          <Button variant="secondary" icon={X} onClick={() => api.cancelTask()}>
            {t("cancel")}
          </Button>
        ) : (
          <Button variant="primary" icon={Sparkles} disabled={!queue.length || !info?.upscalerAvailable} onClick={run}>
            {t("runUpscale", { n: queue.length })}
          </Button>
        )}
      </div>
    </>
  );
}
