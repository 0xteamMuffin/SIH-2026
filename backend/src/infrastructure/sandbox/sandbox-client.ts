import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

export async function runCode(code: string, language = "javascript", signal?: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(35_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${env.SANDBOX_RUNNER_URL}/execute`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, language }), signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AppError(503, "Sandbox request was cancelled", "SANDBOX_REQUEST_CANCELLED");
    if (requestSignal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw new AppError(504, "Sandbox runner timed out", "SANDBOX_TIMEOUT");
    throw new AppError(502, "Sandbox runner is unavailable", "SANDBOX_UNAVAILABLE");
  }
  if (!response.ok) throw new AppError(502, "Sandbox runner failed", "SANDBOX_UNAVAILABLE");
  return response.json() as Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
