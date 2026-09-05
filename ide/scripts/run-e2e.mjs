/**
 * Bundles and runs the end-to-end preview test inside Electron.
 *
 * Electron cannot execute TypeScript, and the test imports main-process
 * modules that use the `@shared` alias, so it is bundled first. The output
 * lands in `out/` so Node can still resolve the externalised dependencies
 * (`electron`, `exceljs`, `jszip`) from the project's `node_modules`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "out/e2e.cjs");

if (!existsSync(join(root, "out/renderer/index.html"))) {
  console.error("Run `npm run build` first — the e2e test drives the built renderer.");
  process.exit(1);
}

await build({
  entryPoints: [join(root, "test/e2e/preview-e2e.ts")],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  // Resolved from node_modules at runtime rather than bundled: `electron` is
  // provided by the runtime itself, and the other two are native-ish CJS
  // packages that bundle poorly.
  external: ["electron", "exceljs", "jszip"],
  alias: { "@shared": join(root, "src/shared") },
  logLevel: "error",
});

const electronBinary = join(root, "node_modules/.bin/electron");
const child = spawn(electronBinary, [bundlePath], {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, WORKBENCH_IDE_ROOT: root },
});
child.on("exit", (code) => process.exit(code ?? 1));
