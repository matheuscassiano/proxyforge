import { useEffect, useState } from "react";
import { ChevronDown, Download, Printer, Redo2, Undo2 } from "lucide-react";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { Button, IconButton } from "./ui";

export function TopBar() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const saving = useApp((s) => s.saving);
  const savedAt = useApp((s) => s.savedAt);
  const profiles = useApp((s) => s.profiles);
  const past = useApp((s) => s.past.length);
  const future = useApp((s) => s.future.length);
  const { update, undo, redo, setExportOpen, setPanel } = useApp.getState();
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.id, project.name]);
  const profile = profiles.find((p) => p.id === project.printProfileId) ?? profiles[0];
  const ago = savedAt ? relative(Date.now() - savedAt) : "";
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(i);
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          aria-label="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== project.name && update((p) => ({ ...p, name: name.trim() }))}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="w-full truncate rounded bg-transparent text-sm font-semibold outline-none focus:bg-surface-2"
        />
        <span className="truncate text-[11px] text-fg-3">{saving ? t("saving") : `${t("saved")}${ago ? ` · ${ago}` : ""}`}</span>
      </div>
      <IconButton icon={Undo2} label="Undo (⌘Z)" onClick={undo} disabled={!past} />
      <IconButton icon={Redo2} label="Redo (⇧⌘Z)" onClick={redo} disabled={!future} />
      <div className="relative">
        <select
          aria-label="Print profile"
          value={profile?.id ?? ""}
          onChange={(e) => {
            if (e.target.value === "__edit") setPanel("color");
            else update((p) => ({ ...p, printProfileId: e.target.value }));
          }}
          className="h-8 max-w-[260px] appearance-none truncate rounded-md border border-line bg-surface-2 pr-8 pl-8 text-xs font-medium text-fg outline-none focus:border-accent"
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__edit">…</option>
        </select>
        <Printer size={15} className="pointer-events-none absolute top-2 left-2.5 text-fg-2" />
        <ChevronDown size={14} className="pointer-events-none absolute top-2.5 right-2.5 text-fg-3" />
      </div>
      <span className="rounded-md border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-xs font-semibold">{profile?.dpi ?? 600} DPI</span>
      <Button variant="primary" icon={Download} onClick={() => setExportOpen(true)}>
        {t("export")}
      </Button>
    </header>
  );
}

function relative(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}
