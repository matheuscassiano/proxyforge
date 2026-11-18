import { describe, expect, it } from "vitest";
import { artDpi, detectBleedMm, estimateExportBytes, formatBytes } from "./units";
import { translate } from "./i18n-core";

describe("detectBleedMm", () => {
  it("finds MPC 1/8in bleed", () => {
    const w = Math.floor((69.35 / 25.4) * 800);
    const h = Math.floor((94.35 / 25.4) * 800);
    expect(detectBleedMm(w, h, 63, 88)).toBe(3.175);
  });
  it("returns 0 for trimmed scans", () => {
    expect(detectBleedMm(745, 1040, 63, 88)).toBe(0);
  });
});

describe("artDpi", () => {
  it("scryfall png is ~300 dpi", () => {
    expect(artDpi(745, 63, 0)).toBe(300);
  });
});

describe("format helpers", () => {
  it("formats bytes", () => {
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
  it("estimates more bytes at higher dpi", () => {
    expect(estimateExportBytes(1, 63, 88, 1, 1200, false, false)).toBeGreaterThan(estimateExportBytes(1, 63, 88, 1, 600, false, false));
  });
});

describe("i18n", () => {
  it("interpolates and falls back", () => {
    expect(translate("en", "lowRes", { n: 3, d: 600 })).toBe("3 cards below 600 DPI");
    expect(translate("pt-BR", "cards")).toBe("Cartas");
  });
});
