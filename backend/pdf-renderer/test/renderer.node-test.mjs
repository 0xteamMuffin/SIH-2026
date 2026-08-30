import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { encodeRenderedPages, hasPdfSignature } from "../protocol.mjs";
import { renderPdf, selectPages } from "../renderer-worker.mjs";
import { createServer, renderInWorker } from "../server.mjs";

const token = "test-pdf-renderer-token-at-least-32-bytes";
const config = { token, port: 4200, concurrency: 1, maxSourceBytes: 1024, maxPages: 3, maxDocumentPages: 100, dpi: 144, maxPixels: 4_000_000, maxTotalBytes: 1024, timeoutMs: 1_000 };

async function withServer(render, callback) {
  const server = createServer(config, render).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

test("uses deterministic bounded page selection", () => {
  assert.deepEqual(selectPages(10, 3), { pages: [1, 6, 10], policy: "representative" });
  assert.deepEqual(selectPages(2, 3), { pages: [1, 2], policy: "all-within-limit" });
  assert.deepEqual(selectPages(10, 3, [9, 2, 2]), { pages: [2, 9], policy: "explicit" });
  assert.throws(() => selectPages(10, 3, [0]), /allowed range/);
});

test("validates PDF signatures", () => {
  assert.equal(hasPdfSignature(Buffer.from("%PDF-1.7")), true);
  assert.equal(hasPdfSignature(Buffer.from("not-a-pdf")), false);
});

function onePagePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 29 >>\nstream\nq 1 0 0 rg 10 10 50 50 re f Q\nendstream",
  ];
  let content = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  content += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

test("renders a PDF page within pixel and byte limits", async () => {
  const result = await renderPdf(onePagePdf(), { maxPages: 3, maxDocumentPages: 100, dpi: 144, maxPixels: 20_000, maxTotalBytes: 1024 * 1024 });

  assert.equal(result.metadata.sourcePageCount, 1);
  assert.deepEqual(result.metadata.pages.map(({ pageNumber, width, height }) => ({ pageNumber, width, height })), [{ pageNumber: 1, width: 200, height: 100 }]);
  assert.equal(Buffer.from(result.images[0]).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
});

test("fails closed when rendered bytes exceed the limit", async () => {
  await assert.rejects(
    renderPdf(onePagePdf(), { maxPages: 1, maxDocumentPages: 100, dpi: 72, maxPixels: 20_000, maxTotalBytes: 1 }),
    { code: "PDF_RENDER_BYTES_EXCEEDED" },
  );
});

test("terminates a render worker when cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderInWorker(onePagePdf(), { maxPages: 1, maxDocumentPages: 100, dpi: 72, maxPixels: 20_000, maxTotalBytes: 1024 * 1024 }, controller.signal, 1_000),
    { code: "PDF_RENDER_CANCELLED" },
  );
});

test("terminates a render worker at its deadline", async () => {
  await assert.rejects(
    renderInWorker(onePagePdf(), { maxPages: 1, maxDocumentPages: 100, dpi: 72, maxPixels: 20_000, maxTotalBytes: 1024 * 1024 }, new AbortController().signal, 1),
    { code: "PDF_RENDER_TIMEOUT" },
  );
});

test("authenticates and returns a bounded binary response without base64", async () => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const metadata = { renderer: "test", rendererVersion: "1", sourcePageCount: 1, selectionPolicy: "all-within-limit", dpi: 144, totalBytes: image.byteLength, pages: [{ pageNumber: 1, width: 10, height: 20, sizeBytes: image.byteLength }] };
  await withServer(async () => ({ metadata, images: [image] }), async (url) => {
    assert.equal((await fetch(`${url}/v1/render`, { method: "POST", body: Buffer.from("%PDF-1.7"), headers: { "content-type": "application/pdf" } })).status, 401);
    const response = await fetch(`${url}/v1/render`, { method: "POST", body: Buffer.from("%PDF-1.7"), headers: { authorization: `Bearer ${token}`, "content-type": "application/pdf" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), encodeRenderedPages(metadata, [image]));
  });
});

test("rejects oversized and non-PDF request bodies before rendering", async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; }, async (url) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/pdf" };
    assert.equal((await fetch(`${url}/v1/render`, { method: "POST", headers, body: Buffer.alloc(1025, 1) })).status, 413);
    assert.equal((await fetch(`${url}/v1/render`, { method: "POST", headers, body: Buffer.from("not-pdf") })).status, 415);
  });
  assert.equal(calls, 0);
});
