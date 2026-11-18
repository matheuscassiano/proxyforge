import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Eye, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { api, errorText } from "../lib/ipc";
import { cx, IconButton, Segmented } from "./ui";

/** Live page preview rendered by the Rust pipeline (same code path as the export). */
export function Stage() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const profiles = useApp((s) => s.profiles);
  const images = useApp((s) => s.images);
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(0);
  const [png, setPng] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState(false);
  const [gamut, setGamut] = useState(false);
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState(600);
  const seq = useRef(0);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setBoxH(e.contentRect.height));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const allDecodable = project.cards.every((c) => images[c.front]?.meta.decodable !== false);
  const pageH = project.layout.orientation === "landscape" ? Math.min(project.layout.pageSize.width, project.layout.pageSize.height) : Math.max(project.layout.pageSize.width, project.layout.pageSize.height);
  const displayH = Math.max(200, (boxH - 32) * zoom);
  const dpi = Math.round(Math.min(150, Math.max(40, (displayH * window.devicePixelRatio) / (pageH / 25.4))));
  const key = useMemo(
    () => JSON.stringify([project.cards, project.layout, project.printProfileId, profile, page, dpi, proof, gamut]),
    [project.cards, project.layout, project.printProfileId, profile, page, dpi, proof, gamut],
  );

  useEffect(() => {
    if (!allDecodable) return;
    const my = ++seq.current;
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const r = await api.renderPreview(project, page, dpi, proof, gamut);
        if (my !== seq.current) return;
        setPng(`data:image/png;base64,${r.png}`);
        setCount(r.pageCount);
        setError(null);
        if (page >= r.pageCount && r.pageCount > 0) setPage(r.pageCount - 1);
      } catch (e) {
        if (my === seq.current) setError(errorText(e));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    }, 180);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, allDecodable]);

  const duplex = project.layout.duplex.enabled;
  const isBack = duplex && page % 2 === 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-4 bg-stage px-6 py-5">
      <div ref={box} className="flex min-h-0 w-full flex-1 items-center justify-center overflow-auto">
        {png ? (
          <div className="relative">
            <img
              src={png}
              alt={`${t("page")} ${page + 1}`}
              style={{ height: displayH }}
              className={cx("max-w-none shadow-2xl shadow-black/50 transition-opacity", loading && "opacity-80")}
              draggable={false}
            />
            {loading && <Loader2 size={18} className="absolute top-3 right-3 animate-spin text-accent" />}
          </div>
        ) : (
          <Loader2 className="animate-spin text-fg-3" />
        )}
      </div>
      {error && (
        <div className="flex max-w-xl items-center gap-2 rounded-md bg-bad/10 px-3 py-2 text-xs text-bad">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1.5">
        <IconButton icon={ChevronLeft} label="Previous page" disabled={page <= 0} onClick={() => setPage(page - 1)} />
        <span className="min-w-[96px] text-center font-mono text-xs font-medium">
          {t("page")} {Math.min(page + 1, Math.max(count, 1))} {t("of")} {Math.max(count, 1)}
        </span>
        <IconButton icon={ChevronRight} label="Next page" disabled={page >= count - 1} onClick={() => setPage(page + 1)} />
        {duplex && (
          <>
            <div className="mx-1.5 h-[18px] w-px bg-line" />
            <Segmented
              value={isBack ? "back" : "front"}
              onChange={(v) => setPage(v === "back" ? (page % 2 ? page : Math.min(page + 1, count - 1)) : page - (page % 2))}
              options={[
                { value: "front", label: t("fronts") },
                { value: "back", label: t("backs") },
              ]}
            />
          </>
        )}
        <div className="mx-1.5 h-[18px] w-px bg-line" />
        <button
          onClick={() => setProof(!proof)}
          aria-pressed={proof}
          className={cx("flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold", proof ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2")}
        >
          <Eye size={14} /> {t("softProof")}
        </button>
        {proof && (
          <button
            onClick={() => setGamut(!gamut)}
            aria-pressed={gamut}
            className={cx("h-7 rounded-md px-2 text-[11px] font-medium", gamut ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2")}
          >
            {t("gamut")}
          </button>
        )}
        <div className="mx-1.5 h-[18px] w-px bg-line" />
        <IconButton icon={ZoomOut} label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))} />
        <button className="w-12 text-center font-mono text-xs text-fg-2" onClick={() => setZoom(1)} title="Fit">
          {Math.round(zoom * 100)}%
        </button>
        <IconButton icon={ZoomIn} label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + 0.25))} />
      </div>
    </div>
  );
}
