import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Bookmark, Link2, Printer, Save, Trash2, Unlink2 } from "lucide-react";
import { useApp } from "../../lib/store";
import { useT } from "../../lib/i18n";
import { api, errorText } from "../../lib/ipc";
import { guideStyles, type CutGuides, type EdgeDarken, type GridInfo, type LayoutSettings, type RegistrationMarks } from "../../lib/types";
import { Button, Collapsible, cx, IconButton, NumberField, Section, Segmented, Select, Slider, TextField, Toggle } from "../ui";

export function LayoutPanel() {
  const t = useT();
  const project = useApp((s) => s.project)!;
  const info = useApp((s) => s.info);
  const presets = useApp((s) => s.presets);
  const { update, savePresets, toast } = useApp.getState();
  const l = project.layout;
  const set = (fn: (l: LayoutSettings) => LayoutSettings) => update((p) => ({ ...p, layout: fn(structuredClone(p.layout)) }));
  const cg = l.cutGuides;
  const [pageStyle, cardStyle] = guideStyles(cg);
  const setGuides = (patch: Partial<CutGuides>) => set((x) => ({ ...x, cutGuides: { ...x.cutGuides, ...patch } }));
  const setDarken = (patch: Partial<EdgeDarken>) => set((x) => ({ ...x, edgeDarken: { ...x.edgeDarken, ...patch } }));
  const setReg = (patch: Partial<RegistrationMarks>) => set((x) => ({ ...x, registration: { ...x.registration, ...patch } }));
  const [linked, setLinked] = useState(l.spacingXMm === l.spacingYMm);
  const [grid, setGrid] = useState<GridInfo | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const total = project.cards.reduce((a, c) => a + c.qty, 0);

  useEffect(() => {
    api.gridInfo(l, total).then(setGrid).catch(() => setGrid(null));
  }, [l, total]);

  const pagePresets = info?.pagePresets ?? [];
  const cardPresets = info?.cardPresets ?? [];

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-line px-4 pt-4.5 pb-3.5">
        <h2 className="text-base font-semibold">{t("layout")}</h2>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Bookmark size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-accent" />
            <select
              aria-label={t("preset")}
              value=""
              onChange={(e) => {
                const p = presets.find((x) => x.id === e.target.value);
                if (p) update((pr) => ({ ...pr, layout: { ...structuredClone(p.layout), duplex: { ...p.layout.duplex, defaultBack: pr.layout.duplex.defaultBack } } }));
              }}
              className="h-8 w-full appearance-none truncate rounded-md border border-line bg-surface-2 pr-2 pl-8 text-xs font-medium outline-none focus:border-accent"
            >
              <option value="">
                {grid ? `${l.pagePreset} · ${grid.columns}×${grid.rows} · ${l.cardPreset}` : t("preset")}
              </option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <IconButton icon={Save} label={t("savePreset")} onClick={() => setNaming("")} className="h-8 w-8 border border-line bg-surface-2" />
        </div>
        {naming !== null && (
          <form
            className="flex items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!naming.trim()) return;
              await savePresets([...presets, { id: crypto.randomUUID(), name: naming.trim(), layout: structuredClone(l) }]);
              setNaming(null);
              toast("success", `${t("preset")}: ${naming.trim()}`);
            }}
          >
            <TextField className="flex-1" label={t("presetName")} value={naming} onChange={setNaming} autoFocus />
            <Button type="submit" variant="primary">
              <Save size={14} />
            </Button>
          </form>
        )}
        {presets.length > 0 && naming !== null && (
          <div className="flex flex-col gap-1">
            {presets.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-xs text-fg-2">
                {p.name}
                <IconButton icon={Trash2} label={t("delete")} onClick={() => savePresets(presets.filter((x) => x.id !== p.id))} />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {grid && (
          <p className={grid.perPage === 0 ? "text-xs text-bad" : "font-mono text-[11px] text-fg-3"}>
            {grid.columns} × {grid.rows} = {grid.perPage} / page · {grid.pages} pages
          </p>
        )}
        <Section title={t("pageSection")}>
          <div className="flex gap-2">
            <Select
              className="flex-[1.3]"
              label={t("size")}
              value={l.pagePreset}
              onChange={(v) =>
                set((x) => {
                  const p = pagePresets.find((pp) => pp.id === v);
                  x.pagePreset = v;
                  if (p) x.pageSize = { width: p.width, height: p.height };
                  return x;
                })
              }
              options={[...pagePresets.map((p) => ({ value: p.id, label: p.name })), { value: "custom", label: t("custom") }]}
            />
            <NumberField className="flex-1" label={t("width")} unit="mm" value={l.pageSize.width} min={50} max={1500} onChange={(v) => set((x) => ({ ...x, pagePreset: "custom", pageSize: { ...x.pageSize, width: v } }))} />
            <NumberField className="flex-1" label={t("height")} unit="mm" value={l.pageSize.height} min={50} max={1500} onChange={(v) => set((x) => ({ ...x, pagePreset: "custom", pageSize: { ...x.pageSize, height: v } }))} />
          </div>
          <Segmented
            value={l.orientation}
            onChange={(v) => set((x) => ({ ...x, orientation: v }))}
            options={[
              { value: "portrait", label: t("portrait") },
              { value: "landscape", label: t("landscape") },
            ]}
          />
          <div className="flex gap-2">
            {(["top", "right", "bottom", "left"] as const).map((k) => (
              <NumberField key={k} className="flex-1" label={t(k)} unit="mm" min={0} max={100} value={l.margins[k]} onChange={(v) => set((x) => ({ ...x, margins: { ...x.margins, [k]: v } }))} />
            ))}
          </div>
        </Section>

        <Section title={t("cardSection")}>
          <div className="flex gap-2">
            <Select
              className="flex-[1.3]"
              label={t("preset")}
              value={l.cardPreset}
              onChange={(v) =>
                set((x) => {
                  const p = cardPresets.find((pp) => pp.id === v);
                  x.cardPreset = v;
                  if (p) x.cardSize = { width: p.width, height: p.height };
                  return x;
                })
              }
              options={[...cardPresets.map((p) => ({ value: p.id, label: `${p.name.split(" (")[0]} · ${p.width}×${p.height}` })), { value: "custom", label: t("custom") }]}
            />
            <NumberField className="flex-1" label={t("width")} unit="mm" value={l.cardSize.width} min={10} max={500} onChange={(v) => set((x) => ({ ...x, cardPreset: "custom", cardSize: { ...x.cardSize, width: v } }))} />
            <NumberField className="flex-1" label={t("height")} unit="mm" value={l.cardSize.height} min={10} max={500} onChange={(v) => set((x) => ({ ...x, cardPreset: "custom", cardSize: { ...x.cardSize, height: v } }))} />
          </div>
          <NumberField label={`${t("corner")} (cut file)`} unit="mm" value={l.cornerRadiusMm} min={0} max={20} onChange={(v) => set((x) => ({ ...x, cornerRadiusMm: v }))} />
        </Section>

        <Section title={t("bleedSection")}>
          <div className="flex items-end gap-2">
            <NumberField className="flex-1" label={t("bleed")} unit="mm" value={l.bleedMm} min={0} max={10} onChange={(v) => set((x) => ({ ...x, bleedMm: v }))} />
            <NumberField
              className="flex-1"
              label={`${t("spacing")} X`}
              unit="mm"
              value={l.spacingXMm}
              min={0}
              max={50}
              onChange={(v) => set((x) => ({ ...x, spacingXMm: v, spacingYMm: linked ? v : x.spacingYMm }))}
            />
            <NumberField
              className="flex-1"
              label={`${t("spacing")} Y`}
              unit="mm"
              value={l.spacingYMm}
              min={0}
              max={50}
              onChange={(v) => set((x) => ({ ...x, spacingYMm: v, spacingXMm: linked ? v : x.spacingXMm }))}
            />
            <IconButton
              icon={linked ? Link2 : Unlink2}
              label={linked ? t("unlinkSpacing") : t("linkSpacing")}
              active={linked}
              onClick={() => {
                setLinked(!linked);
                if (!linked) set((x) => ({ ...x, spacingYMm: x.spacingXMm }));
              }}
              className="mb-0.5 h-8 w-8 border border-line bg-surface-2"
            />
          </div>
          <Select
            label={t("bleedModeLabel")}
            value={l.bleedMode}
            onChange={(v) => set((x) => ({ ...x, bleedMode: v }))}
            options={[
              { value: "extend", label: t("extend") },
              { value: "blur", label: t("bleedBlur") },
              { value: "stretch", label: t("bleedStretch") },
              { value: "mirror", label: t("mirror") },
              { value: "solid", label: t("solid") },
            ]}
          />
          <p className="text-[11px] leading-relaxed text-fg-3">{t(`bleedHint_${l.bleedMode}`)}</p>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-2">{t("builtinBleedLabel")}</span>
            <Segmented
              value={l.builtinBleed}
              onChange={(v) => set((x) => ({ ...x, builtinBleed: v }))}
              options={[
                { value: "use", label: t("builtinUse") },
                { value: "regenerate", label: t("builtinRegenerate") },
              ]}
            />
          </div>
          <Collapsible title={t("edgeDarken")} subtitle={l.edgeDarken.enabled ? `${t(l.edgeDarken.mode)} · ${Math.round(l.edgeDarken.amount * 100)}%` : "off"} defaultOpen={l.edgeDarken.enabled}>
            <Toggle checked={l.edgeDarken.enabled} onChange={(v) => setDarken({ enabled: v })} label={t("edgeDarkenOn")} />
            <p className="text-[11px] leading-relaxed text-fg-3">{t("edgeDarkenHint")}</p>
            <Segmented
              value={l.edgeDarken.mode}
              onChange={(v) => setDarken({ mode: v })}
              options={[
                { value: "contrastEdges", label: t("contrastEdges") },
                { value: "darkenAll", label: t("darkenAll") },
              ]}
            />
            <Slider label={t("amount")} value={l.edgeDarken.amount} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setDarken({ amount: v })} />
            <Slider label={t("blackThreshold")} value={l.edgeDarken.threshold} min={0.05} max={0.6} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setDarken({ threshold: v })} />
            {l.edgeDarken.mode === "contrastEdges" && (
              <NumberField label={t("edgeWidth")} unit="mm" value={l.edgeDarken.edgeWidthMm} min={0.5} max={15} onChange={(v) => setDarken({ edgeWidthMm: v })} />
            )}
            <span className="text-xs font-medium text-fg-2">{t("applyTo")}</span>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <Toggle checked={l.edgeDarken.bank} onChange={(v) => setDarken({ bank: v })} label={t("srcBank")} />
              <Toggle checked={l.edgeDarken.uploads} onChange={(v) => setDarken({ uploads: v })} label={t("srcUploads")} />
              <Toggle checked={l.edgeDarken.backs} onChange={(v) => setDarken({ backs: v })} label={t("srcBacks")} />
            </div>
          </Collapsible>
        </Section>

        <Section title={t("grid")}>
          <div className="flex gap-2">
            <NumberField className="flex-1" label={`${t("columns")} (0 = ${t("auto")})`} value={l.columns} step={1} min={0} max={20} onChange={(v) => set((x) => ({ ...x, columns: Math.round(v) }))} />
            <NumberField className="flex-1" label={`${t("rows")} (0 = ${t("auto")})`} value={l.rows} step={1} min={0} max={20} onChange={(v) => set((x) => ({ ...x, rows: Math.round(v) }))} />
          </div>
          <Toggle checked={l.center} onChange={(v) => set((x) => ({ ...x, center: v }))} label={t("center")} />
          {grid && grid.columns > 0 && grid.rows > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-fg-2">{t("slotsOnPage")}</span>
              <div className="grid w-fit gap-1" style={{ gridTemplateColumns: `repeat(${grid.columns}, 22px)` }}>
                {Array.from({ length: grid.columns * grid.rows }, (_, i) => {
                  const off = l.disabledSlots.includes(i);
                  return (
                    <button
                      key={i}
                      aria-pressed={!off}
                      title={off ? t("slotOff") : t("slotOn")}
                      onClick={() =>
                        set((x) => ({ ...x, disabledSlots: off ? x.disabledSlots.filter((s) => s !== i) : [...x.disabledSlots, i].sort((a, b) => a - b) }))
                      }
                      className={cx("h-[30px] rounded-[3px] border", off ? "border-dashed border-line bg-transparent" : "border-accent/60 bg-accent-soft")}
                    />
                  );
                })}
              </div>
              {l.disabledSlots.length > 0 && (
                <Toggle checked={l.centerDisabled} onChange={(v) => set((x) => ({ ...x, centerDisabled: v }))} label={t("centerDisabled")} />
              )}
            </div>
          )}
        </Section>

        <Section title={t("calibrationSection")}>
          <div className="flex gap-2">
            <NumberField className="flex-1" label={t("sheetOffsetX")} unit="mm" value={l.sheetOffsetXMm} min={-20} max={20} onChange={(v) => set((x) => ({ ...x, sheetOffsetXMm: v }))} />
            <NumberField className="flex-1" label={t("sheetOffsetY")} unit="mm" value={l.sheetOffsetYMm} min={-20} max={20} onChange={(v) => set((x) => ({ ...x, sheetOffsetYMm: v }))} />
            <NumberField className="flex-1" label={t("rotation")} unit="°" step={0.05} value={l.rotationDeg} min={-5} max={5} onChange={(v) => set((x) => ({ ...x, rotationDeg: v }))} />
          </div>
          <p className="text-[11px] leading-relaxed text-fg-3">{t("calibrationHint")}</p>
        </Section>

        <Section title={t("cutGuides")}>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-2">{t("pageGuides")}</span>
            <Segmented
              value={pageStyle}
              onChange={(v) => setGuides({ pageStyle: v, cardStyle })}
              options={[
                { value: "none", label: t("none") },
                { value: "crop", label: t("crop") },
                { value: "full", label: t("fullLines") },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-fg-2">{t("cardGuides")}</span>
            <Segmented
              value={cardStyle}
              onChange={(v) => setGuides({ cardStyle: v, pageStyle })}
              options={[
                { value: "none", label: t("none") },
                { value: "corners", label: t("corners") },
                { value: "outline", label: t("outline") },
              ]}
            />
          </div>
          {cardStyle === "corners" && (
            <Segmented
              value={cg.placement}
              onChange={(v) => setGuides({ placement: v })}
              options={[
                { value: "inside", label: t("placeInside") },
                { value: "outside", label: t("placeOutside") },
                { value: "centered", label: t("placeCentered") },
              ]}
            />
          )}
          {(cardStyle === "outline" || (cardStyle === "corners" && cg.placement === "inside")) && (
            <Segmented
              value={cg.corner}
              onChange={(v) => setGuides({ corner: v })}
              options={[
                { value: "square", label: t("cornerSquare") },
                { value: "round", label: `${t("cornerRound")} · ${l.cornerRadiusMm} mm` },
              ]}
            />
          )}
          {(pageStyle !== "none" || cardStyle !== "none") && (
            <>
              <div className="flex items-end gap-2">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-fg-2">{t("guideColor")}</span>
                  <input
                    type="color"
                    aria-label={t("guideColor")}
                    value={cg.color}
                    onChange={(e) => setGuides({ color: e.target.value })}
                    className="h-8 w-12 cursor-pointer rounded-md border border-line bg-surface-2 p-1"
                  />
                </div>
                <NumberField className="flex-1" label={t("guideWidth")} unit="pt" value={cg.widthPt} min={0.1} max={5} onChange={(v) => setGuides({ widthPt: v })} />
                <NumberField className="flex-1" label={t("guideLength")} unit="mm" value={cg.lengthMm} min={1} max={20} onChange={(v) => setGuides({ lengthMm: v })} />
                <NumberField className="flex-1" label={t("guideOffset")} unit="mm" value={cg.offsetMm} min={0} max={10} onChange={(v) => setGuides({ offsetMm: v })} />
              </div>
              <Segmented
                value={cg.dashed ? "dashed" : "solid"}
                onChange={(v) => setGuides({ dashed: v === "dashed" })}
                options={[
                  { value: "solid", label: t("lineSolid") },
                  { value: "dashed", label: t("lineDashed") },
                ]}
              />
              <Toggle checked={l.guidesOverArt} onChange={(v) => set((x) => ({ ...x, guidesOverArt: v }))} label={t("guidesOverArt")} />
              {l.duplex.enabled && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <Toggle checked={cg.faces.pageFront} onChange={(v) => setGuides({ faces: { ...cg.faces, pageFront: v } })} label={t("pageGuidesFront")} />
                  <Toggle checked={cg.faces.cardFront} onChange={(v) => setGuides({ faces: { ...cg.faces, cardFront: v } })} label={t("cardGuidesFront")} />
                  <Toggle checked={cg.faces.pageBack} onChange={(v) => setGuides({ faces: { ...cg.faces, pageBack: v } })} label={t("pageGuidesBack")} />
                  <Toggle checked={cg.faces.cardBack} onChange={(v) => setGuides({ faces: { ...cg.faces, cardBack: v } })} label={t("cardGuidesBack")} />
                </div>
              )}
            </>
          )}
        </Section>

        <div className="flex flex-col">
          <Collapsible
            title={t("duplex")}
            subtitle={l.duplex.enabled ? `${t(l.duplex.flip)} · ${l.duplex.offsetXMm} / ${l.duplex.offsetYMm} mm` : "off"}
            defaultOpen={l.duplex.enabled}
          >
            <Toggle checked={l.duplex.enabled} onChange={(v) => set((x) => ({ ...x, duplex: { ...x.duplex, enabled: v } }))} label={t("duplex")} />
            <Segmented
              value={l.duplex.flip}
              onChange={(v) => set((x) => ({ ...x, duplex: { ...x.duplex, flip: v } }))}
              options={[
                { value: "longEdge", label: t("longEdge") },
                { value: "shortEdge", label: t("shortEdge") },
              ]}
            />
            <div className="flex gap-2">
              <NumberField className="flex-1" label={t("offsetX")} unit="mm" value={l.duplex.offsetXMm} min={-20} max={20} onChange={(v) => set((x) => ({ ...x, duplex: { ...x.duplex, offsetXMm: v } }))} />
              <NumberField className="flex-1" label={t("offsetY")} unit="mm" value={l.duplex.offsetYMm} min={-20} max={20} onChange={(v) => set((x) => ({ ...x, duplex: { ...x.duplex, offsetYMm: v } }))} />
            </div>
            <Button
              icon={Printer}
              onClick={async () => {
                const path = await save({ defaultPath: "duplex-calibration.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
                if (!path) return;
                try {
                  await api.duplexCalibration(l, path);
                  toast("success", path);
                } catch (e) {
                  toast("error", errorText(e));
                }
              }}
            >
              {t("calibration")}
            </Button>
          </Collapsible>
          <Collapsible title={t("cutter")} subtitle={l.registrationMarks ? "Silhouette Type 1 · on" : "off"} defaultOpen={l.registrationMarks}>
            <Toggle checked={l.registrationMarks} onChange={(v) => set((x) => ({ ...x, registrationMarks: v }))} label={t("regMarks")} />
            {l.registrationMarks && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <NumberField label={t("regInset")} unit="mm" value={l.registration.insetMm} min={5} max={30} onChange={(v) => setReg({ insetMm: v })} />
                  <NumberField label={t("regLength")} unit="mm" value={l.registration.lengthMm} min={5} max={40} onChange={(v) => setReg({ lengthMm: v })} />
                  <NumberField label={t("regThickness")} unit="mm" value={l.registration.thicknessMm} min={0.2} max={2} onChange={(v) => setReg({ thicknessMm: v })} />
                  <NumberField label={t("regSquare")} unit="mm" value={l.registration.squareMm} min={2} max={10} onChange={(v) => setReg({ squareMm: v })} />
                </div>
                <p className="text-[11px] leading-relaxed text-fg-3">{t("regHint")}</p>
              </>
            )}
          </Collapsible>
        </div>
      </div>
    </>
  );
}
