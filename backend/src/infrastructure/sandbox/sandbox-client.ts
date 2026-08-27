import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

export async function runCode(code: string, language = "javascript") {
  const response = await fetch(`${env.SANDBOX_RUNNER_URL}/execute`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, language }), signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new AppError(502, "Sandbox runner failed", "SANDBOX_UNAVAILABLE");
  return response.json() as Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
