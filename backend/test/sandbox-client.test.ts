import { afterEach, describe, expect, it, vi } from "vitest";
import { runCode } from "../src/infrastructure/sandbox/sandbox-client.js";

describe("sandbox client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("submits with authentication and polls to completion", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "job-1", status: "queued" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "job-1", status: "succeeded", result: { stdout: "ok\n", stderr: "", exitCode: 0 } }), { status: 200 })));

    await expect(runCode("console.log('ok')")).resolves.toEqual({ stdout: "ok\n", stderr: "", exitCode: 0 });
    expect(fetch).toHaveBeenNthCalledWith(1, "http://localhost:4100/v1/jobs", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer test-sandbox-token-with-at-least-32-bytes", "idempotency-key": expect.any(String) }),
      signal: expect.any(AbortSignal),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, "http://localhost:4100/v1/jobs/job-1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("cancels the submitted job when the caller aborts", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "job-2", status: "running" }), { status: 202 }))
      .mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "job-2", status: "running" }), { status: 202 })));

    const request = runCode("while (true) {}", "javascript", controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "SANDBOX_REQUEST_CANCELLED" });
    expect(fetch).toHaveBeenLastCalledWith("http://localhost:4100/v1/jobs/job-2/cancel", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer test-sandbox-token-with-at-least-32-bytes" }),
      signal: expect.any(AbortSignal),
    }));
  });
});
