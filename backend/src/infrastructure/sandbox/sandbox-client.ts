import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

type SandboxLanguage = "javascript" | "python";
type SandboxStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type SandboxResult = { stdout: string; stderr: string; exitCode: number; timedOut?: boolean; outputTruncated?: boolean };
type SandboxJob = { id: string; status: SandboxStatus; result?: SandboxResult; error?: string };

const headers = { authorization: `Bearer ${env.SANDBOX_API_TOKEN}`, "content-type": "application/json" };

async function sandboxFetch(path: string, init: RequestInit, signal?: AbortSignal) {
  try {
    return await fetch(`${env.SANDBOX_RUNNER_URL}${path}`, { ...init, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AppError(502, "Sandbox runner is unavailable", "SANDBOX_UNAVAILABLE");
  }
}

export async function submitSandboxJob(source: string, language: SandboxLanguage, idempotencyKey: string, signal?: AbortSignal) {
  const response = await sandboxFetch("/v1/jobs", {
    method: "POST",
    headers: { ...headers, "idempotency-key": idempotencyKey },
    body: JSON.stringify({ source, language }),
  }, signal);
  if (response.status === 429) throw new AppError(503, "Sandbox queue is full", "SANDBOX_QUEUE_FULL");
  if (!response.ok) throw new AppError(502, "Sandbox runner rejected the job", "SANDBOX_UNAVAILABLE");
  return response.json() as Promise<SandboxJob>;
}

export async function getSandboxJob(id: string, signal?: AbortSignal) {
  const response = await sandboxFetch(`/v1/jobs/${encodeURIComponent(id)}`, { method: "GET", headers }, signal);
  if (!response.ok) throw new AppError(502, "Sandbox job status is unavailable", "SANDBOX_UNAVAILABLE");
  return response.json() as Promise<SandboxJob>;
}

export async function cancelSandboxJob(id: string, signal?: AbortSignal) {
  const response = await sandboxFetch(`/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers }, signal);
  if (!response.ok && response.status !== 404) throw new AppError(502, "Sandbox cancellation failed", "SANDBOX_UNAVAILABLE");
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runCode(code: string, language = "javascript", signal?: AbortSignal) {
  if (language !== "javascript" && language !== "python") {
    throw new AppError(400, "Unsupported sandbox language", "SANDBOX_LANGUAGE_UNSUPPORTED");
  }
  const timeoutSignal = AbortSignal.timeout(40_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let jobId: string | undefined;
  try {
    const job = await submitSandboxJob(code, language, crypto.randomUUID(), requestSignal);
    jobId = job.id;
    let current = job;
    while (current.status === "queued" || current.status === "running") {
      await wait(200, requestSignal);
      current = await getSandboxJob(job.id, requestSignal);
    }
    if (current.status === "cancelled") throw new AppError(503, "Sandbox request was cancelled", "SANDBOX_REQUEST_CANCELLED");
    if (!current.result) throw new AppError(502, current.error ?? "Sandbox execution failed", "SANDBOX_UNAVAILABLE");
    return current.result;
  } catch (error) {
    if (jobId) {
      try {
        await cancelSandboxJob(jobId, AbortSignal.timeout(2_000));
      } catch {
        // Cancellation is best-effort if the runner is unavailable.
      }
    }
    if (error instanceof AppError) throw error;
    if (signal?.aborted) throw new AppError(503, "Sandbox request was cancelled", "SANDBOX_REQUEST_CANCELLED");
    if (requestSignal.aborted) throw new AppError(504, "Sandbox runner timed out", "SANDBOX_TIMEOUT");
    throw new AppError(502, "Sandbox runner is unavailable", "SANDBOX_UNAVAILABLE");
  }
}
