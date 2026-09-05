import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const root = import.meta.dirname;
const shared = resolve(root, "src/shared");
const pdfjs = resolve(root, "node_modules/pdfjs-dist");

/**
 * Directories pdf.js fetches at runtime rather than bundling.
 *
 * All four are required. Without `wasm/` any PDF containing JPEG 2000 imagery
 * throws; without `iccs/` CMYK colour conversion is wrong; without `cmaps/`
 * CJK text renders as blank glyphs; without `standard_fonts/` documents that
 * omit embedded fonts render incorrectly.
 */
const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts", "iccs", "wasm"] as const;

/**
 * `quickjs-eval` is the engine pdf.js uses to run JavaScript embedded in
 * AcroForms — not something to execute against untrusted documents. Scripting
 * is opt-in at the viewer layer and we only call `page.render`, so it is never
 * requested; excluding it makes that structural rather than a setting someone
 * can flip later.
 */
function isExcludedAsset(filename: string): boolean {
  return filename.startsWith("quickjs-eval");
}

async function assetFilesIn(directory: string): Promise<string[]> {
  const entries = await readdir(resolve(pdfjs, directory));
  return entries.filter((entry) => !isExcludedAsset(entry));
}

/**
 * Serves pdf.js's runtime assets at `/cmaps/`, `/wasm/`, and so on.
 *
 * Hand-rolled rather than using a copy plugin because those resolve paths
 * relative to the Vite root, and `node_modules` sits outside the renderer
 * root — which silently produced a nested `node_modules/pdfjs-dist/cmaps/`
 * tree instead of the flat layout the runtime URLs expect.
 *
 * Handles both modes: a dev middleware while serving, and emitted assets at
 * exact paths when building.
 */
function pdfjsAssets(): Plugin {
  return {
    name: "workbench:pdfjs-assets",

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
        const match = /^\/(cmaps|standard_fonts|iccs|wasm)\/([\w.-]+)$/.exec(url);
        if (!match) return next();

        const [, directory, filename] = match;
        // `basename` neutralises any traversal the pattern let through.
        if (!directory || !filename || isExcludedAsset(filename)) return next();

        response.setHeader("Content-Type", contentTypeFor(filename));
        createReadStream(resolve(pdfjs, directory, basename(filename)))
          .on("error", next)
          .pipe(response);
      });
    },

    async generateBundle() {
      for (const directory of PDFJS_ASSET_DIRS) {
        for (const filename of await assetFilesIn(directory)) {
          this.emitFile({
            type: "asset",
            // An explicit fileName bypasses hashing, so the runtime URLs
            // pdf.js builds stay predictable.
            fileName: `${directory}/${filename}`,
            source: await readFile(resolve(pdfjs, directory, filename)),
          });
        }
      }
    },
  };
}

function contentTypeFor(filename: string): string {
  if (filename.endsWith(".wasm")) return "application/wasm";
  if (filename.endsWith(".js")) return "text/javascript";
  return "application/octet-stream";
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    build: {
      rollupOptions: {
        // Emitted as CommonJS, not ESM.
        //
        // Electron only supports an ESM preload when `sandbox` is false, and
        // keeping the renderer sandboxed is worth more than module syntax in
        // one small bridge file. Electron ignores the package's
        // `"type": "module"` for preload scripts, so a `.js` file here is
        // loaded as CommonJS as intended.
        output: { format: "cjs", entryFileNames: "index.js" },
      },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    plugins: [react(), pdfjsAssets()],
    resolve: {
      alias: {
        "@shared": shared,
        "@renderer": resolve(root, "src/renderer/src"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(root, "src/renderer/index.html"),
      },
      // Small .wasm files would otherwise be inlined as base64 data URIs,
      // which breaks the runtime fetch pdf.js performs against `wasmUrl`.
      assetsInlineLimit: 0,
    },
  },
});
