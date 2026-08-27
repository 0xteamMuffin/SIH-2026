import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export async function audit(input: {
  eventType: string;
  actorId?: string;
  workspaceId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditEvent.create({ data: { actorId: input.actorId, workspaceId: input.workspaceId, runId: input.runId, eventType: input.eventType, metadata: (input.metadata ?? {}) as Prisma.InputJsonValue } });
}
