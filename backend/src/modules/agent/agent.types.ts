import { z } from "zod";

export const generatedCodeSchema = z.object({
  language: z.enum(["python", "javascript"]),
  code: z.string().min(1).max(100_000),
  explanation: z.string().min(1).max(20_000),
}).strict();

export type GeneratedCode = z.infer<typeof generatedCodeSchema>;
export type ToolResult = { ok: boolean; summary: string; data?: Record<string, unknown>; errorCode?: string };
export type EvidenceItem = { id: string; title: string; summary: string; facts: string[]; sourceRef: string };
type SandboxExecution = { stdout: string; stderr: string; exitCode: number; timedOut?: boolean; outputTruncated?: boolean };

export function parseGeneratedCode(value: string): GeneratedCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Generated code response is not valid JSON");
  }
  const result = generatedCodeSchema.safeParse(parsed);
  if (!result.success) throw new Error("Generated code response does not match the required schema");
  return result.data;
}

export function sandboxToolResult(execution: SandboxExecution) {
  return execution.exitCode === 0
    ? { ...execution, ok: true as const, summary: "Sandbox execution completed" }
    : { ok: false as const, summary: `Sandbox execution failed with exit code ${execution.exitCode}`, errorCode: "SANDBOX_NON_ZERO_EXIT", data: execution };
}
