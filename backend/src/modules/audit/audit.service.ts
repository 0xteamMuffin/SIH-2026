import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

export type AuditCursor = { createdAt: Date; id: string };
export type AuditFilters = {
  eventType?: string;
  actorId?: string;
  runId?: string;
  from?: Date;
  to?: Date;
};

const auditEventSelect = {
  id: true,
  actorId: true,
  workspaceId: true,
  runId: true,
  eventType: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.AuditEventSelect;

export type AuditEventView = Prisma.AuditEventGetPayload<{ select: typeof auditEventSelect }>;

function auditWhere(workspaceId: string, filters: AuditFilters, cursor?: AuditCursor): Prisma.AuditEventWhereInput {
  return {
    workspaceId,
    eventType: filters.eventType,
    actorId: filters.actorId,
    runId: filters.runId,
    createdAt: filters.from || filters.to ? { gte: filters.from, lte: filters.to } : undefined,
    ...(cursor ? {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    } : {}),
  };
}

export function encodeAuditCursor(event: Pick<AuditEventView, "createdAt" | "id">) {
  return Buffer.from(JSON.stringify({ createdAt: event.createdAt.toISOString(), id: event.id })).toString("base64url");
}

export async function listAuditEvents(input: {
  workspaceId: string;
  limit: number;
  cursor?: AuditCursor;
  filters: AuditFilters;
}) {
  const events = await prisma.auditEvent.findMany({
    where: auditWhere(input.workspaceId, input.filters, input.cursor),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: auditEventSelect,
  });
  const page = events.slice(0, input.limit);
  return {
    events: page,
    nextCursor: events.length > input.limit ? encodeAuditCursor(page[page.length - 1]!) : null,
  };
}

export async function* exportAuditEvents(workspaceId: string, filters: AuditFilters, batchSize = 500) {
  let cursor: AuditCursor | undefined;
  do {
    const page = await listAuditEvents({ workspaceId, filters, cursor, limit: batchSize });
    for (const event of page.events) yield event;
    cursor = page.nextCursor && page.events.length > 0
      ? { createdAt: page.events[page.events.length - 1]!.createdAt, id: page.events[page.events.length - 1]!.id }
      : undefined;
  } while (cursor);
}
