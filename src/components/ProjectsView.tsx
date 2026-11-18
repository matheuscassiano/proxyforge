import { useEffect, useState } from "react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { Copy, FolderInput, MoreHorizontal, Plus, Share2, Trash2 } from "lucide-react";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { api, errorText, fileUrl } from "../lib/ipc";
import type { Project, ProjectSummary } from "../lib/types";
import { Button } from "./ui";

export function ProjectsView() {
  const t = useT();
  const images = useApp((s) => s.images);
  const { openProject, createProject, toast, ensureImages } = useApp.getState();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [fans, setFans] = useState<Record<string, string[]>>({});
  const [menu, setMenu] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const l = await api.listProjects();
      setList(l);
      // three cover images per project for the fan thumbnail
      const loaded: Project[] = await Promise.all(l.map((p) => api.loadProject(p.id)));
      const f = Object.fromEntries(loaded.map((p) => [p.id, p.cards.slice(0, 3).map((c) => c.front)]));
      setFans(f);
      await ensureImages(Object.values(f).flat());
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (id: string, kind: "duplicate" | "share" | "delete", name: string) => {
    setMenu(null);
    try {
      if (kind === "duplicate") await api.duplicateProject(id);
      if (kind === "share") {
        const path = await save({ defaultPath: `${name}.pforge`, filters: [{ name: "ProxyForge project", extensions: ["pforge"] }] });
        if (path) {
          await api.exportBundle(id, path);
          toast("success", path);
        }
      }
      if (kind === "delete" && (await ask(t("confirmDelete", { n: name }), { kind: "warning" }))) await api.deleteProject(id);
      refresh();
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-7 overflow-y-auto px-12 py-10">
      <header className="flex items-end gap-2.5">
        <div className="flex flex-1 flex-col gap-1.5">
          <h1 className="text-[26px] font-bold">{t("projects")}</h1>
          <p className="text-[13px] text-fg-2">{t("projectsSubtitle")}</p>
        </div>
        <Button
          icon={FolderInput}
          onClick={async () => {
            const path = await open({ multiple: false, filters: [{ name: "ProxyForge project", extensions: ["pforge", "zip"] }] });
            if (!path || Array.isArray(path)) return;
            try {
              const p = await api.importBundle(path);
              await openProject(p.id);
            } catch (e) {
              toast("error", errorText(e));
            }
          }}
        >
          {t("importBundle")}
        </Button>
        <Button variant="primary" icon={Plus} onClick={() => createProject(t("untitled"))}>
          {t("newProject")}
        </Button>
      </header>

      {list && list.length === 0 && (
        <button
          onClick={() => createProject(t("untitled"))}
          className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-line text-fg-2 hover:border-accent hover:text-fg"
        >
          <Plus size={28} />
          <span className="text-sm font-medium">{t("newProject")}</span>
        </button>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
        {list?.map((p) => (
          <div key={p.id} className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface hover:border-surface-3">
            <button onClick={() => openProject(p.id)} className="relative h-[200px] bg-stage" aria-label={p.name}>
              {(fans[p.id] ?? []).map((id, k, arr) => {
                const im = images[id];
                const offset = (k - (arr.length - 1) / 2) * 58;
                return im ? (
                  <img
                    key={id + k}
                    src={fileUrl(im.thumb)}
                    alt=""
                    className="absolute top-1/2 left-1/2 h-[140px] w-[100px] rounded-[5px] object-cover shadow-lg shadow-black/60"
                    style={{ transform: `translate(calc(-50% + ${offset}px), -50%) rotate(${(k - (arr.length - 1) / 2) * 8}deg)` }}
                  />
                ) : null;
              })}
            </button>
            <div className="flex items-center gap-2 px-4 py-3.5">
              <button onClick={() => openProject(p.id)} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
                <span className="truncate text-sm font-semibold">{p.name}</span>
                <span className="truncate text-[11px] text-fg-3">
                  {p.cardCount} cards · {new Date(p.updatedAt).toLocaleString()}
                </span>
              </button>
              <div className="relative">
                <button aria-label="More" onClick={() => setMenu(menu === p.id ? null : p.id)} className="rounded-md p-1.5 text-fg-2 hover:bg-surface-2">
                  <MoreHorizontal size={16} />
                </button>
                {menu === p.id && (
                  <div className="absolute right-0 bottom-9 z-10 flex w-48 flex-col rounded-lg border border-line bg-surface-2 p-1 shadow-xl shadow-black/40">
                    <MenuItem icon={Copy} label={t("duplicate")} onClick={() => act(p.id, "duplicate", p.name)} />
                    <MenuItem icon={Share2} label={t("share")} onClick={() => act(p.id, "share", p.name)} />
                    <MenuItem icon={Trash2} label={t("delete")} danger onClick={() => act(p.id, "delete", p.name)} />
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Copy; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-xs hover:bg-surface-3 ${danger ? "text-bad" : "text-fg"}`}>
      <Icon size={14} /> {label}
    </button>
  );
}
