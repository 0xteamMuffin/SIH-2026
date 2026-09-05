import type { WorkbenchApi } from "@shared/api.js";

declare global {
  interface Window {
    /** Installed by the preload bridge. See `src/preload/index.ts`. */
    readonly workbench: WorkbenchApi;
  }
}

export {};
