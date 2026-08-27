export type ToolResult = { ok: boolean; summary: string; data?: Record<string, unknown>; errorCode?: string };
export type EvidenceItem = { id: string; title: string; summary: string; facts: string[]; sourceRef: string };
