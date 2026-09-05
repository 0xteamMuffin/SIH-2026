import { previewCapabilities } from "../services/preview-capabilities.js";
import { handle } from "./typed-handle.js";

export function registerPreviewHandlers(): void {
  handle("preview:capabilities", () => previewCapabilities());
}
