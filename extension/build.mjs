#!/usr/bin/env node
// Bundles the extension's four entry points with esbuild and assembles
// dist/ as a loadable unpacked extension. Also stamps manifest.template.json
// with WEB_APP_ORIGIN so host_permissions matches whichever API the build is
// pointed at (localhost during dev, the deployed Vercel URL otherwise) —
// see the Phase 2 plan's manifest.json section for why this is build-time
// rather than editable from the options page.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import esbuild from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

// .env is optional and gitignored; WEB_APP_ORIGIN can also just be set in
// the shell. Defaults to the local Next.js dev server.
function loadDotEnv() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!(key in process.env)) {
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
}
loadDotEnv();

const WEB_APP_ORIGIN = process.env.WEB_APP_ORIGIN ?? "http://localhost:3000";

function writeManifest() {
  const template = readFileSync(path.join(root, "manifest.template.json"), "utf8");
  const manifest = template.replaceAll("{{WEB_APP_ORIGIN}}", WEB_APP_ORIGIN);
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "manifest.json"), manifest);
}

function copyStaticAssets() {
  cpSync(path.join(root, "icons"), path.join(dist, "icons"), { recursive: true });
  for (const entry of ["popup", "options"]) {
    mkdirSync(path.join(dist, entry), { recursive: true });
    cpSync(
      path.join(root, "src", entry, `${entry}.html`),
      path.join(dist, entry, `${entry}.html`),
    );
  }
}

const entryPoints = {
  background: "src/background.ts",
  "popup/popup": "src/popup/popup.ts",
  "options/options": "src/options/options.ts",
  "content/lock-overlay": "src/content/lock-overlay.ts",
  "content/flixcloud-detect": "src/content/flixcloud-detect.ts",
  "content/mark-applied": "src/content/mark-applied.ts",
};

const buildOptions = {
  entryPoints,
  outdir: dist,
  bundle: true,
  // IIFE, not ESM: content scripts can't use `import`/`export` without extra
  // manifest plumbing, and the MV3 service worker doesn't need module
  // support either since esbuild already resolves all imports at build time.
  format: "iife",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  define: {
    __WEB_APP_ORIGIN__: JSON.stringify(WEB_APP_ORIGIN),
  },
};

writeManifest();
copyStaticAssets();

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log(`Watching for changes — building against WEB_APP_ORIGIN=${WEB_APP_ORIGIN}`);
} else {
  await esbuild.build(buildOptions);
  console.log(`Built dist/ — WEB_APP_ORIGIN=${WEB_APP_ORIGIN}`);
  console.log("Load it: chrome://extensions -> Developer mode -> Load unpacked -> select dist/");
}
