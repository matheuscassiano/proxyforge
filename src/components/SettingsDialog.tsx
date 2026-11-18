import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { ExternalLink, FolderOpen } from "lucide-react";
import { useApp } from "../lib/store";
import { useT, type Lang } from "../lib/i18n";
import { Button, Modal, Select } from "./ui";

export function SettingsDialog() {
  const t = useT();
  const info = useApp((s) => s.info);
  const lang = useApp((s) => s.lang);
  const { setLang, setSettingsOpen } = useApp.getState();
  return (
    <Modal title={t("settings")} subtitle={`ProxyForge ${info?.version ?? ""}`} onClose={() => setSettingsOpen(false)} width={480}>
      <Select<Lang>
        label={t("language")}
        value={lang}
        onChange={setLang}
        options={[
          { value: "en", label: "English" },
          { value: "pt-BR", label: "Português (Brasil)" },
        ]}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-2">{t("dataFolder")}</span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2.5 py-2 font-mono text-[11px] text-fg-2">{info?.dataDir}</code>
          <Button icon={FolderOpen} onClick={() => info && revealItemInDir(info.dataDir)} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-2">{t("upscale")}</span>
        <span className={`text-xs ${info?.upscalerAvailable ? "text-ok" : "text-bad"}`}>
          {info?.upscalerAvailable ? "Real-ESRGAN ncnn-vulkan · ready" : t("upscaleMissing")}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-fg-2">{t("about")}</span>
        <p className="text-xs leading-relaxed text-fg-2">{t("aboutText")}</p>
        <p className="text-[11px] leading-relaxed text-fg-3">
          Card data: Scryfall, TCGdex, YGOPRODeck, the-fab-cube, Lorcast, OPTCG API, SWU-DB, digimoncard.io, Riftcodex. Not affiliated with any game publisher.
        </p>
        <button className="flex items-center gap-1.5 self-start text-xs text-accent" onClick={() => openUrl("https://github.com/matheuscassiano/proxyforge")}>
          <ExternalLink size={12} /> GitHub
        </button>
      </div>
    </Modal>
  );
}
