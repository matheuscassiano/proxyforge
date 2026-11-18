import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Anvil, FolderOpen, Layers, LayoutGrid, Palette, PenTool, Settings, Sparkles, X } from "lucide-react";
import { useApp, type Panel } from "./lib/store";
import { useT, type Key } from "./lib/i18n";
import { api, errorText } from "./lib/ipc";
import { cx } from "./components/ui";
import { ProjectsView } from "./components/ProjectsView";
import { TopBar } from "./components/TopBar";
import { Stage } from "./components/Stage";
import { DeckPanel } from "./components/DeckPanel";
import { CardsPanel } from "./components/panels/CardsPanel";
import { LayoutPanel } from "./components/panels/LayoutPanel";
import { ColorPanel } from "./components/panels/ColorPanel";
import { UpscalePanel } from "./components/panels/UpscalePanel";
import { ExportDialog } from "./components/ExportDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { BuilderView } from "./builder/BuilderView";
import { CardModal } from "./components/CardModal";
import { PrintDialog } from "./components/PrintDialog";
import { ResizeHandle } from "./components/ResizeHandle";

const IMAGE_EXT = /\.(png|jpe?g|webp|tiff?|bmp|gif|avif)$/i;

export default function App() {
  const init = useApp((s) => s.init);
  const view = useApp((s) => s.view);
  const project = useApp((s) => s.project);
  const exportOpen = useApp((s) => s.exportOpen);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const printOpen = useApp((s) => s.printOpen);
  const cardModal = useApp((s) => s.cardModal);
  const focus = useApp((s) => s.focus);
  const [dragging, setDragging] = useState(false);
  const t = useT();

  useEffect(() => {
    init();
  }, [init]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = (e.target instanceof Element && e.target.closest("input, textarea, select"));
      const s = useApp.getState();
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        s.redo();
      } else if (mod && e.key.toLowerCase() === "e" && s.project) {
        e.preventDefault();
        s.setExportOpen(true);
      } else if (mod && e.key.toLowerCase() === "p" && s.project) {
        e.preventDefault();
        s.setPrintOpen(true);
      } else if (s.project && s.view === "workspace" && s.panel !== "builder" && !typing && ((mod && e.shiftKey && e.key.toLowerCase() === "f") || (!mod && !e.altKey && e.key.toLowerCase() === "f" && !anyDialog(s)))) {
        e.preventDefault();
        s.setFocus(!s.focus);
      } else if (e.key === "Escape" && s.focus && !anyDialog(s)) {
        s.setFocus(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drag & drop images from the OS into the open project
  useEffect(() => {
    let un: (() => void) | undefined;
    if (!("__TAURI_INTERNALS__" in window) || !(window as any).__TAURI_INTERNALS__?.metadata) return;
    getCurrentWebview()
      .onDragDropEvent(async (ev) => {
        const s = useApp.getState();
        if (ev.payload.type === "enter" || ev.payload.type === "over") setDragging(!!s.project);
        else if (ev.payload.type === "leave") setDragging(false);
        else if (ev.payload.type === "drop") {
          setDragging(false);
          if (!s.project) return;
          const paths = ev.payload.paths.filter((p) => IMAGE_EXT.test(p));
          if (!paths.length) return;
          try {
            const entries = await api.importImages(paths, s.project.layout.cardSize);
            await s.addCards(entries);
          } catch (e) {
            s.toast("error", errorText(e));
          }
        }
      })
      .then((u) => (un = u));
    return () => un?.();
  }, []);

  return (
    <div className="flex h-full">
      {!(focus && view === "workspace") && <Rail />}
      {view === "projects" || !project ? <ProjectsView /> : <Workspace />}
      <Toasts />
      {exportOpen && project && <ExportDialog />}
      {printOpen && project && <PrintDialog />}
      {cardModal && project && <CardModal key={cardModal} />}
      {settingsOpen && <SettingsDialog />}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-2 border-dashed border-accent bg-accent/10">
          <span className="rounded-lg bg-surface px-4 py-2 text-sm font-medium">{t("dropHere")}</span>
        </div>
      )}
    </div>
  );
}

const anyDialog = (s: ReturnType<typeof useApp.getState>) => s.exportOpen || s.printOpen || s.settingsOpen || !!s.cardModal;

function Workspace() {
  const panel = useApp((s) => s.panel);
  const focus = useApp((s) => s.focus);
  const left = useApp((s) => s.paneWidths.left);
  if (panel === "builder") return <BuilderView />;
  return (
    <>
      {!focus && (
        <>
          <aside style={{ width: left }} className="flex shrink-0 flex-col border-r border-line bg-surface">
            {panel === "cards" && <CardsPanel />}
            {panel === "layout" && <LayoutPanel />}
            {panel === "color" && <ColorPanel />}
            {panel === "upscale" && <UpscalePanel />}
          </aside>
          <ResizeHandle pane="left" side="left" />
        </>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {!focus && <TopBar />}
        <Stage />
      </main>
      {!focus && (
        <>
          <ResizeHandle pane="right" side="right" />
          <DeckPanel />
        </>
      )}
    </>
  );
}

const NAV: { id: Panel; icon: typeof Layers; key: Key }[] = [
  { id: "cards", icon: Layers, key: "cards" },
  { id: "builder", icon: PenTool, key: "builder" },
  { id: "layout", icon: LayoutGrid, key: "layout" },
  { id: "color", icon: Palette, key: "color" },
  { id: "upscale", icon: Sparkles, key: "upscale" },
];

function Rail() {
  const t = useT();
  const view = useApp((s) => s.view);
  const panel = useApp((s) => s.panel);
  const project = useApp((s) => s.project);
  const { setPanel, setView, setSettingsOpen } = useApp.getState();
  const item = (active: boolean, Icon: typeof Layers, label: string, onClick: () => void, disabled = false) => (
    <button
      key={label}
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex w-16 flex-col items-center gap-1 rounded-lg px-1 py-2.5 text-[11px] font-medium transition-colors disabled:opacity-30",
        active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon size={20} />
      {label}
    </button>
  );
  return (
    <nav className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface px-1.5 py-3.5">
      <div className="mb-3.5 flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent" title="ProxyForge">
        <Anvil size={20} />
      </div>
      {NAV.map((n) =>
        item(view === "workspace" && panel === n.id, n.icon, t(n.key), () => {
          setView("workspace");
          setPanel(n.id);
        }, !project),
      )}
      {item(view === "projects", FolderOpen, t("projects"), () => setView("projects"))}
      <div className="flex-1" />
      {item(false, Settings, t("settings"), () => setSettingsOpen(true))}
    </nav>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-[360px] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "flex items-start gap-3 rounded-lg border bg-surface px-3.5 py-3 text-xs shadow-xl shadow-black/40",
            t.kind === "error" ? "border-bad/40" : t.kind === "success" ? "border-ok/40" : "border-line",
          )}
        >
          <span className={cx("flex-1 leading-relaxed", t.kind === "error" && "text-bad")}>{t.text}</span>
          {t.action && (
            <button className="font-semibold text-accent" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
          <button aria-label="Dismiss" className="text-fg-3 hover:text-fg" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
