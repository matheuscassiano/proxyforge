import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, Loader2, Printer, RefreshCw } from "lucide-react";
import { cardDpi, useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { api, errorText, onProgress } from "../lib/ipc";
import { detectBleedMm } from "../lib/units";
import type { PrinterInfo, PrintSides } from "../lib/types";
import { Button, IconButton, Modal, NumberField, ProgressBar, Segmented, Select, TextField } from "./ui";

const LAST_PRINTER = "lastPrinter";

/** Render the deck with the export pipeline and send it to a system printer. */
export function PrintDialog() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const profiles = useApp((s) => s.profiles);
  const images = useApp((s) => s.images);
  const { setPrintOpen, toast, update } = useApp.getState();
  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const [printers, setPrinters] = useState<PrinterInfo[] | null>(null);
  const [printer, setPrinter] = useState("");
  const [copies, setCopies] = useState(1);
  const [range, setRange] = useState<"all" | "custom">("all");
  const [pages, setPages] = useState("");
  const { duplex, cardSize } = project.layout;
  const [sides, setSides] = useState<PrintSides>(duplex.enabled ? duplex.flip : "oneSided");
  const [dpiChoice, setDpiChoice] = useState(String(profile?.dpi ?? 600));
  const [progress, setProgress] = useState<{ p: number; m: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dpi = Number(dpiChoice);

  const load = () => {
    setPrinters(null);
    setLoadError(null);
    api
      .listPrinters()
      .then((list) => {
        setPrinters(list);
        let last = "";
        try {
          last = localStorage.getItem(LAST_PRINTER) ?? "";
        } catch {
          /* ignore */
        }
        const pick = list.find((p) => p.name === last) ?? list.find((p) => p.isDefault) ?? list[0];
        setPrinter((cur) => (cur && list.some((p) => p.name === cur) ? cur : (pick?.name ?? "")));
      })
      .catch((e) => {
        setPrinters([]);
        setLoadError(errorText(e));
      });
  };
  useEffect(load, []);

  useEffect(() => {
    const un = onProgress((e) => e.task === "print" && setProgress({ p: e.progress, m: e.message }));
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
  const rangeOk = range === "all" || /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(pages);

  const run = async () => {
    setProgress({ p: 0, m: "" });
    try {
      localStorage.setItem(LAST_PRINTER, printer);
    } catch {
      /* ignore */
    }
    try {
      await api.printProject(project, { printer, copies, dpi, pages: range === "custom" ? pages.replace(/\s+/g, "") : null, sides });
      setPrintOpen(false);
      toast("success", t("printSent", { p: printer }));
    } catch (e) {
      toast("error", errorText(e));
      setProgress(null);
    }
  };

  const options = (printers ?? []).map((p) => ({ value: p.name, label: `${p.name.replace(/_/g, " ")}${p.isDefault ? ` · ${t("default")}` : ""}` }));

  return (
    <Modal
      title={t("print")}
      subtitle={`${total} cards · ${project.layout.pagePreset} · ${profile?.name ?? ""}${duplex.enabled ? " · duplex" : ""}`}
      onClose={() => (progress ? api.cancelTask() : setPrintOpen(false))}
      footer={
        progress ? (
          <div className="flex w-full items-center gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <ProgressBar value={progress.p} />
              <span className="text-[11px] text-fg-3">{progress.m || t("rendering")}</span>
            </div>
            <Button onClick={() => api.cancelTask()}>{t("cancel")}</Button>
          </div>
        ) : (
          <>
            <span className="flex-1 text-[11px] text-fg-3">{t("printQueueNote")}</span>
            <Button onClick={() => setPrintOpen(false)}>{t("cancel")}</Button>
            <Button variant="primary" icon={Printer} onClick={run} disabled={!printer || total === 0 || !rangeOk || copies < 1}>
              {t("print")}
            </Button>
          </>
        )
      }
    >
      <section className="flex flex-col gap-2.5">
        <h3 className="section-title">{t("printer")}</h3>
        {printers === null ? (
          <div className="flex h-8 items-center gap-2 text-xs text-fg-3">
            <Loader2 size={14} className="animate-spin" /> {t("findingPrinters")}
          </div>
        ) : printers.length ? (
          <div className="flex items-center gap-2">
            <Select className="flex-1" value={printer} onChange={setPrinter} options={options} />
            <IconButton icon={RefreshCw} label={t("refresh")} onClick={load} />
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md bg-bad/10 p-2.5 text-xs text-bad">
            <AlertTriangle size={14} className="shrink-0" />
            <span className="flex-1">{loadError ?? t("noPrinters")}</span>
            <IconButton icon={RefreshCw} label={t("refresh")} onClick={load} />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <h3 className="section-title">{t("job")}</h3>
        <div className="flex items-end gap-2.5">
          <NumberField className="w-[90px]" label={t("copies")} value={copies} min={1} max={999} step={1} onChange={(v) => setCopies(Math.max(1, Math.round(v)))} />
          <Select
            className="w-[140px]"
            label={t("pages")}
            value={range}
            onChange={setRange}
            options={[
              { value: "all", label: t("allPages") },
              { value: "custom", label: t("pageRange") },
            ]}
          />
          {range === "custom" && <TextField className="flex-1" label=" " value={pages} onChange={setPages} placeholder="1-4, 7" autoFocus />}
          <Select
            className={range === "custom" ? "w-[110px]" : "flex-1"}
            label={t("resolution")}
            value={dpiChoice}
            onChange={setDpiChoice}
            options={["300", "600", "1200"].concat(["300", "600", "1200"].includes(String(profile?.dpi)) ? [] : [String(profile?.dpi)]).map((d) => ({ value: d, label: `${d} DPI` }))}
          />
        </div>
        {!rangeOk && <p className="text-xs text-bad">{t("badRange")}</p>}
        <Segmented
          value={sides}
          onChange={(v) => {
            setSides(v);
            if (v !== "oneSided" && duplex.enabled && v !== duplex.flip) update((p) => ({ ...p, layout: { ...p.layout, duplex: { ...p.layout.duplex, flip: v } } }));
          }}
          options={[
            { value: "oneSided", label: t("oneSided") },
            { value: "longEdge", label: t("longEdge") },
            { value: "shortEdge", label: t("shortEdge") },
          ]}
        />
        {duplex.enabled && sides === "oneSided" && <p className="text-[11px] text-fg-3">{t("manualDuplexNote")}</p>}
        {lowRes > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-accent/10 p-2.5 text-[11px] text-fg-2">
            <AlertTriangle size={14} className="shrink-0 text-accent" />
            <span className="flex-1">{t("lowResWarning", { n: lowRes, d: dpi })}</span>
          </div>
        )}
        <div className="flex items-start gap-2 rounded-md bg-surface-2 p-2.5 text-[11px] leading-relaxed text-fg-2">
          <Info size={14} className="mt-px shrink-0" />
          <span>{t("printScaleNote", { p: profile?.name ?? "" })}</span>
        </div>
      </section>
    </Modal>
  );
}
