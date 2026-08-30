import { afterEach, describe, expect, it, vi } from "vitest";
import { runCode } from "../src/infrastructure/sandbox/sandbox-client.js";

describe("sandbox client cancellation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("propagates an abort signal to the sandbox request", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));

    const request = runCode("console.log('test')", "javascript", controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "SANDBOX_REQUEST_CANCELLED" });
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
