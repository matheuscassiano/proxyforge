import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ClipboardCopy, Download, FileArchive, FileImage, FileText, Image, ListOrdered } from "lucide-react";
import { decklistText } from "../lib/deck";
import { cardDpi, useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { ensureUpscales } from "../lib/autoUpscale";
import { api, errorText, onProgress } from "../lib/ipc";
import { detectBleedMm, estimateExportBytes, formatBytes } from "../lib/units";
import type { ExportFormat } from "../lib/types";
import { Button, cx, Modal, NumberField, ProgressBar, Segmented, Select, TextField, Toggle } from "./ui";

const PREFS = "pf.export.prefs";
interface ExportPrefs {
  openAfter: boolean;
  label: boolean;
  labelProject: boolean;
  labelText: string;
  labelPage: boolean;
}
const DEFAULT_PREFS: ExportPrefs = { openAfter: false, label: false, labelProject: true, labelText: "", labelPage: true };
function loadPrefs(): ExportPrefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

const FORMATS: { id: ExportFormat; icon: typeof FileText; desc: string }[] = [
  { id: "pdf", icon: FileText, desc: "Vector guides" },
  { id: "png", icon: Image, desc: "Per page" },
  { id: "tiff", icon: FileImage, desc: "16-bit · CMYK" },
  { id: "zip", icon: FileArchive, desc: "Card images" },
];

export function ExportDialog() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const profiles = useApp((s) => s.profiles);
  const images = useApp((s) => s.images);
  const { setExportOpen, toast, update } = useApp.getState();
  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [dpiChoice, setDpiChoice] = useState(String(profile?.dpi ?? 600));
  const [custom, setCustom] = useState(3600);
  const [compression, setCompression] = useState<"lossless" | "jpeg">("lossless");
  const [quality, setQuality] = useState(95);
  const [sixteen, setSixteen] = useState(false);
  const [cutFile, setCutFile] = useState(project.layout.registrationMarks);
  const [progress, setProgress] = useState<{ p: number; m: string } | null>(null);
  const [range, setRange] = useState("");
  const [frontsOnly, setFrontsOnly] = useState(false);
  const [prefs, setPrefsState] = useState<ExportPrefs>(loadPrefs);
  const [alpha, setAlpha] = useState(false);
  const setPrefs = (p: Partial<ExportPrefs>) =>
    setPrefsState((old) => {
      const next = { ...old, ...p };
      try {
        localStorage.setItem(PREFS, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  const pageLabel = prefs.label
    ? [prefs.labelProject && project.name, prefs.labelText.trim(), prefs.labelPage && `${t("page")} {page}/{pages}`].filter(Boolean).join(" · ")
    : null;
  const rangeOk = !range.trim() || /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(range);
  const dpi = dpiChoice === "custom" ? custom : Number(dpiChoice);
  const cmyk = profile?.outputSpace === "cmyk";
  const { cardSize, bleedMm } = project.layout;

  useEffect(() => {
    const un = onProgress((e) => e.task === "export" && setProgress({ p: e.progress, m: e.message }));
    return () => {
      un.then((f) => f());
    };
  }, []);

  const total = project.cards.reduce((a, c) => a + c.qty, 0);
  const lowRes = useMemo(
    () =>
      project.cards.filter((c) => {
        const im = images[c.front];
        if (!im) return false;
        const b = c.builtinBleedMm ?? detectBleedMm(im.meta.width, im.meta.height, cardSize.width, cardSize.height);
        return cardDpi(im.meta, cardSize.width, b) < dpi;
      }).length,
    [project.cards, images, dpi, cardSize],
  );
  const unique = new Set(project.cards.flatMap((c) => [c.front, c.back ?? ""]).filter(Boolean)).size;
  const estimate = estimateExportBytes(unique, cardSize.width, cardSize.height, bleedMm, dpi, cmyk, format === "pdf" && compression === "jpeg");
  const pngCmyk = format === "png" && cmyk;

  const run = async () => {
    const ext = { pdf: "pdf", png: "png", tiff: "tif", zip: "zip" }[format];
    const path = await save({ defaultPath: `${project.name.replace(/[^\w\- ]+/g, "")}.${ext}`, filters: [{ name: format.toUpperCase(), extensions: [ext] }] });
    if (!path) return;
    setProgress({ p: 0, m: "" });
    try {
      await ensureUpscales(dpi, (d, n) => setProgress({ p: 0, m: t("upscalingN", { d: String(d + 1), n: String(n) }) }));
      const out = await api.exportProject(project, {
        format,
        path,
        dpi,
        compression,
        jpegQuality: quality,
        sixteenBit: sixteen,
        cutFile,
        pages: range.trim() || null,
        frontsOnly,
        pageLabel: format === "pdf" ? pageLabel : null,
      });
      setExportOpen(false);
      if (prefs.openAfter) openPath(out[0]).catch(() => undefined);
      toast("success", `${t("exportDone")}: ${out[0]}${out.length > 1 ? ` (+${out.length - 1})` : ""}`, { label: t("openFolder"), run: () => revealItemInDir(out[0]) });
    } catch (e) {
      toast("error", errorText(e));
      setProgress(null);
    }
  };

  return (
    <Modal
      title={t("export")}
      subtitle={`${total} cards · ${project.layout.pagePreset} · ${profile?.name ?? ""}${project.layout.duplex.enabled ? " · duplex" : ""}`}
      onClose={() => (progress ? api.cancelTask() : setExportOpen(false))}
      footer={
        progress ? (
          <div className="flex w-full items-center gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <ProgressBar value={progress.p} />
              <span className="text-[11px] text-fg-3">{progress.m}</span>
            </div>
            <Button onClick={() => api.cancelTask()}>{t("cancel")}</Button>
          </div>
        ) : (
          <>
            <span className="flex-1 font-mono text-[11px] text-fg-3">≈ {formatBytes(estimate)}</span>
            <Button onClick={() => setExportOpen(false)}>{t("cancel")}</Button>
            <Button variant="primary" icon={Download} onClick={run} disabled={pngCmyk || total === 0 || !rangeOk}>
              {t("export")} {format.toUpperCase()}
            </Button>
          </>
        )
      }
    >
      <section className="flex flex-col gap-2.5">
        <h3 className="section-title">{t("format")}</h3>
        <div className="flex gap-2">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFormat(f.id)}
              aria-pressed={f.id === format}
              className={cx(
                "flex flex-1 flex-col gap-1.5 rounded-lg border p-3 text-left",
                f.id === format ? "border-accent bg-accent-soft" : "border-line bg-surface-2 hover:bg-surface-3",
              )}
            >
              <f.icon size={18} className={f.id === format ? "text-accent" : "text-fg-2"} />
              <span className="text-[13px] font-semibold">{f.id.toUpperCase()}</span>
              <span className="text-[10px] text-fg-3">{f.desc}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <h3 className="section-title">{t("resolution")}</h3>
        <Segmented
          value={dpiChoice}
          onChange={setDpiChoice}
          mono
          options={[...["300", "600", "1200", "2400", "4800"].map((d) => ({ value: d, label: d })), { value: "custom", label: t("custom") }]}
        />
        {dpiChoice === "custom" && <NumberField label="DPI" value={custom} min={72} max={4800} step={50} onChange={setCustom} />}
        {lowRes > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-accent/10 p-2.5 text-[11px] text-fg-2">
            <AlertTriangle size={14} className="shrink-0 text-accent" />
            <span className="flex-1">{t("lowResWarning", { n: lowRes, d: dpi })}</span>
            <button
              className="font-semibold text-accent"
              onClick={() => {
                setExportOpen(false);
                useApp.getState().setPanel("upscale");
              }}
            >
              {t("upscale")}
            </button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <h3 className="section-title">{t("color")}</h3>
        <div className="flex gap-2">
          <Select
            className="flex-1"
            label="Print profile"
            value={profile?.id ?? ""}
            onChange={(v) => update((p) => ({ ...p, printProfileId: v }), { history: false })}
            options={profiles.map((p) => ({ value: p.id, label: `${p.name} · ${p.outputSpace.toUpperCase()}` }))}
          />
          {format === "pdf" && (
            <Select
              className="flex-1"
              label={t("compression")}
              value={compression}
              onChange={setCompression}
              options={[
                { value: "lossless", label: t("lossless") },
                { value: "jpeg", label: cmyk ? `${t("jpeg")} (RGB only)` : t("jpeg") },
              ]}
            />
          )}
        </div>
        {format === "pdf" && compression === "jpeg" && !cmyk && <NumberField label="JPEG quality" value={quality} min={50} max={100} step={1} onChange={setQuality} />}
        {(format === "png" || format === "tiff" || format === "zip") && <Toggle checked={sixteen} onChange={setSixteen} label={t("sixteen")} />}
        {format !== "zip" && <Toggle checked={cutFile} onChange={setCutFile} label={t("cutFile")} />}
        {pngCmyk && <p className="text-xs text-bad">{t("pngCmyk")}</p>}
      </section>

      {format !== "zip" && (
        <section className="flex flex-col gap-2.5">
          <h3 className="section-title">{t("pagesSection")}</h3>
          <div className="flex items-end gap-3">
            <TextField className="w-44" label={t("exportRange")} value={range} onChange={setRange} placeholder={t("exportAllPages")} />
            {project.layout.duplex.enabled && <Toggle checked={frontsOnly} onChange={setFrontsOnly} label={t("frontsOnly")} />}
          </div>
          {!rangeOk && <p className="text-xs text-bad">{t("exportBadRange")}</p>}
          {format === "pdf" && (
            <>
              <Toggle checked={prefs.label} onChange={(v) => setPrefs({ label: v })} label={t("pageLabels")} />
              {prefs.label && (
                <div className="flex flex-wrap items-end gap-3">
                  <Toggle checked={prefs.labelProject} onChange={(v) => setPrefs({ labelProject: v })} label={t("labelProject")} />
                  <Toggle checked={prefs.labelPage} onChange={(v) => setPrefs({ labelPage: v })} label={t("labelPage")} />
                  <TextField className="min-w-40 flex-1" label={t("labelCustom")} value={prefs.labelText} onChange={(v) => setPrefs({ labelText: v })} />
                  {pageLabel && <p className="w-full font-mono text-[11px] text-fg-3">{pageLabel.replace("{page}", "1").replace("{pages}", "3")}</p>}
                </div>
              )}
            </>
          )}
          <Toggle checked={prefs.openAfter} onChange={(v) => setPrefs({ openAfter: v })} label={t("openAfterExport")} />
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <h3 className="section-title">{t("decklistSection")}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            className="w-72"
            value={alpha ? "alpha" : "deck"}
            onChange={(v) => setAlpha(v === "alpha")}
            options={[
              { value: "deck", label: t("orderDeck") },
              { value: "alpha", label: t("orderAlpha") },
            ]}
          />
          <Button
            size="sm"
            icon={ClipboardCopy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(decklistText(project.cards, alpha));
                toast("success", t("decklistCopied"));
              } catch (e) {
                toast("error", errorText(e));
              }
            }}
          >
            {t("copyDecklist")}
          </Button>
          <Button
            size="sm"
            icon={ListOrdered}
            onClick={async () => {
              const path = await save({ defaultPath: `${project.name.replace(/[^\w\- ]+/g, "")}.txt`, filters: [{ name: "Text", extensions: ["txt"] }] });
              if (!path) return;
              try {
                await api.writeTextFile(path, decklistText(project.cards, alpha));
                toast("success", path);
              } catch (e) {
                toast("error", errorText(e));
              }
            }}
          >
            {t("saveDecklist")}
          </Button>
        </div>
      </section>
    </Modal>
  );
}
