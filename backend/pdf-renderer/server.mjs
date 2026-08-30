import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { encodeRenderedPages, hasPdfSignature } from "./protocol.mjs";

function integerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

export function loadConfig() {
  const token = process.env.PDF_RENDERER_API_TOKEN ?? "";
  if (Buffer.byteLength(token) < 32) throw new Error("PDF_RENDERER_API_TOKEN must contain at least 32 bytes");
  return Object.freeze({
    token,
    port: integerEnv("PDF_RENDERER_PORT", 4200, 1, 65_535),
    concurrency: integerEnv("PDF_RENDERER_CONCURRENCY", 1, 1, 8),
    maxSourceBytes: integerEnv("PDF_RENDER_MAX_SOURCE_BYTES", 25 * 1024 * 1024, 1, 25 * 1024 * 1024),
    maxPages: integerEnv("PDF_RENDER_MAX_PAGES", 3, 1, 8),
    maxDocumentPages: integerEnv("PDF_RENDER_MAX_DOCUMENT_PAGES", 1_000, 1, 10_000),
    dpi: integerEnv("PDF_RENDER_DPI", 144, 72, 200),
    maxPixels: integerEnv("PDF_RENDER_MAX_PIXELS_PER_PAGE", 4_000_000, 100_000, 16_000_000),
    maxTotalBytes: integerEnv("PDF_RENDER_MAX_TOTAL_BYTES", 10 * 1024 * 1024, 1, 25 * 1024 * 1024),
    timeoutMs: integerEnv("PDF_RENDER_TIMEOUT_MS", 30_000, 1_000, 120_000),
  });
}

function authorized(request, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(request.headers.authorization ?? "");
  return expected.byteLength === provided.byteLength && crypto.timingSafeEqual(expected, provided);
}

async function readBounded(request, maximum) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximum) throw Object.assign(new Error(), { status: 413, code: "PDF_SOURCE_TOO_LARGE" });
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximum) throw Object.assign(new Error(), { status: 413, code: "PDF_SOURCE_TOO_LARGE" });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function requestedPages(request, maximum) {
  const raw = request.headers["x-pdf-pages"];
  if (raw === undefined || raw === "auto") return undefined;
  if (Array.isArray(raw) || !/^\d+(,\d+)*$/.test(raw)) throw Object.assign(new Error(), { status: 400, code: "PDF_PAGE_SELECTION_INVALID" });
  const pages = raw.split(",").map(Number);
  if (pages.length > maximum) throw Object.assign(new Error(), { status: 400, code: "PDF_PAGE_SELECTION_INVALID" });
  return pages;
}

export function renderInWorker(data, options, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transfer = Uint8Array.from(data);
    const worker = new Worker(new URL("./renderer-worker.mjs", import.meta.url), {
      workerData: { data: transfer.buffer, options },
      transferList: [transfer.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void worker.terminate();
      callback(value);
    };
    const onAbort = () => finish(reject, Object.assign(new Error(), { status: 499, code: "PDF_RENDER_CANCELLED" }));
    const timer = setTimeout(() => finish(reject, Object.assign(new Error(), { status: 504, code: "PDF_RENDER_TIMEOUT" })), timeoutMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    worker.once("message", (message) => message.error
      ? finish(reject, Object.assign(new Error(), { status: message.error.code === "PDF_RENDER_BYTES_EXCEEDED" ? 413 : 422, code: message.error.code }))
      : finish(resolve, message));
    worker.once("error", () => finish(reject, Object.assign(new Error(), { status: 422, code: "PDF_RENDER_FAILED" })));
    worker.once("exit", (code) => { if (code !== 0) finish(reject, Object.assign(new Error(), { status: 422, code: "PDF_RENDER_FAILED" })); });
  });
}

function sendError(response, status, code) {
  if (response.destroyed) return;
  const body = Buffer.from(JSON.stringify({ error: { code } }));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.byteLength });
  response.end(body);
}

export function createServer(config, render = renderInWorker) {
  let active = 0;
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && ["/health", "/ready"].includes(request.url)) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end('{"status":"ok"}');
    }
    if (request.method !== "POST" || request.url !== "/v1/render") return sendError(response, 404, "NOT_FOUND");
    if (!authorized(request, config.token)) return sendError(response, 401, "UNAUTHORIZED");
    if (request.headers["content-type"] !== "application/pdf") return sendError(response, 415, "PDF_CONTENT_TYPE_REQUIRED");
    if (active >= config.concurrency) return sendError(response, 429, "PDF_RENDER_BUSY");
    active += 1;
    const controller = new AbortController();
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", onClose);
    response.once("close", onClose);
    try {
      const data = await readBounded(request, config.maxSourceBytes);
      if (!hasPdfSignature(data)) throw Object.assign(new Error(), { status: 415, code: "PDF_SIGNATURE_INVALID" });
      const result = await render(data, {
        maxPages: config.maxPages,
        maxDocumentPages: config.maxDocumentPages,
        dpi: config.dpi,
        maxPixels: config.maxPixels,
        maxTotalBytes: config.maxTotalBytes,
        requestedPages: requestedPages(request, config.maxPages),
      }, controller.signal, config.timeoutMs);
      const body = encodeRenderedPages(result.metadata, result.images);
      response.writeHead(200, { "content-type": "application/vnd.sih.pdf-pages", "content-length": body.byteLength, "cache-control": "no-store" });
      response.end(body);
    } catch (error) {
      sendError(response, error?.status ?? 422, error?.code ?? "PDF_RENDER_FAILED");
    } finally {
      active -= 1;
      request.off("aborted", onClose);
      response.off("close", onClose);
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const server = createServer(config).listen(config.port, "0.0.0.0");
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
