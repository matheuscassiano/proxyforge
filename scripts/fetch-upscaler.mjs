#!/usr/bin/env node
// Downloads the Real-ESRGAN ncnn-vulkan executable (MIT) and its models (BSD-3-Clause)
// for the current OS into src-tauri/resources. Run once before `pnpm tauri dev/build`.
//
//   node scripts/fetch-upscaler.mjs            # current platform
//   node scripts/fetch-upscaler.mjs --platform windows
//
// Uses only Node built-ins plus the system `unzip` / PowerShell `Expand-Archive`.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0";
const ASSETS = {
  macos: { file: "realesrgan-ncnn-vulkan-20220424-macos.zip", size: 51817124 },
  linux: { file: "realesrgan-ncnn-vulkan-20220424-ubuntu.zip", size: 46931474 },
  windows: { file: "realesrgan-ncnn-vulkan-20220424-windows.zip", size: 45474481 },
};
const MODELS = ["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3-x2", "realesr-animevideov3-x3", "realesr-animevideov3-x4"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "src-tauri", "resources");
const argPlatform = process.argv.includes("--platform") ? process.argv[process.argv.indexOf("--platform") + 1] : null;
const platform = argPlatform ?? { darwin: "macos", win32: "windows", linux: "linux" }[process.platform];
if (!ASSETS[platform]) throw new Error(`unsupported platform ${platform}`);
const exe = platform === "windows" ? "realesrgan-ncnn-vulkan.exe" : "realesrgan-ncnn-vulkan";

if (existsSync(join(res, "bin", exe)) && existsSync(join(res, "models", "realesrgan-x4plus.param")) && !process.argv.includes("--force")) {
  console.log("Upscaler already present.");
  process.exit(0);
}

const { file, size } = ASSETS[platform];
const work = join(tmpdir(), `proxyforge-upscaler-${Date.now()}`);
mkdirSync(work, { recursive: true });
const zip = join(work, file);
console.log(`Downloading ${file} (${(size / 1e6).toFixed(1)} MB)…`);
const r = await fetch(`${RELEASE}/${file}`, { redirect: "follow" });
if (!r.ok) throw new Error(`download failed: ${r.status}`);
const buf = Buffer.from(await r.arrayBuffer());
if (buf.length !== size) throw new Error(`unexpected size ${buf.length}, expected ${size}`);
writeFileSync(zip, buf);
console.log("sha256", createHash("sha256").update(buf).digest("hex"));

const out = join(work, "x");
mkdirSync(out);
if (process.platform === "win32") {
  execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`], { stdio: "inherit" });
} else {
  execFileSync("unzip", ["-q", zip, "-d", out], { stdio: "inherit" });
}

const find = (dir, name) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === name) return p;
    if (statSync(p).isDirectory()) {
      const f = find(p, name);
      if (f) return f;
    }
  }
  return null;
};

mkdirSync(join(res, "bin"), { recursive: true });
mkdirSync(join(res, "models"), { recursive: true });
const bin = find(out, exe);
if (!bin) throw new Error("executable not found in archive");
copyFileSync(bin, join(res, "bin", exe));
if (platform !== "windows") chmodSync(join(res, "bin", exe), 0o755);
// Windows build needs vcomp140.dll next to the exe
if (platform === "windows") {
  const dll = find(out, "vcomp140.dll");
  if (dll) copyFileSync(dll, join(res, "bin", "vcomp140.dll"));
}
for (const m of MODELS) {
  for (const ext of ["param", "bin"]) {
    const f = find(out, `${m}.${ext}`);
    if (!f) throw new Error(`model ${m}.${ext} missing`);
    copyFileSync(f, join(res, "models", `${m}.${ext}`));
  }
}
if (platform === "macos") {
  // Downloaded binaries are quarantined by Gatekeeper; clear it for local dev.
  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", join(res, "bin", exe)]);
  } catch {}
}
rmSync(work, { recursive: true, force: true });
console.log("Upscaler installed in src-tauri/resources");
