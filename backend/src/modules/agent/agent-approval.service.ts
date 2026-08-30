import { ApprovalStatus, Prisma, RunStatus, RunToolCallStatus, ToolRiskLevel, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { AGENT_RUN_RESUMED_TOPIC } from "../../infrastructure/queue/agent-run-message.js";
import type { AuthUser } from "../../middleware/auth.js";

const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export class RunWaitingForApproval extends Error {
  constructor(public readonly approvalId: string) {
    super("Agent run is waiting for tool approval");
  }
}

export async function pauseForToolApproval(input: {
  runId: string;
  workspaceId: string;
  leaseId: string;
  modelToolCallId: string;
  idempotencyKey: string;
  toolName: string;
  toolInput: object;
  riskLevel: ToolRiskLevel;
}) {
  return prisma.$transaction(async (transaction) => {
    const toolCall = await transaction.runToolCall.create({
      data: {
        runId: input.runId,
        modelToolCallId: input.modelToolCallId,
        toolName: input.toolName,
        input: toJson(input.toolInput),
        idempotencyKey: input.idempotencyKey,
        riskLevel: input.riskLevel,
        status: RunToolCallStatus.WAITING_APPROVAL,
      },
    });
    const approval = await transaction.toolApproval.create({
      data: {
        runId: input.runId,
        toolCallId: toolCall.id,
        workspaceId: input.workspaceId,
        toolName: input.toolName,
        toolInput: toJson(input.toolInput),
        riskLevel: input.riskLevel,
      },
    });
    const paused = await transaction.agentRun.updateMany({
      where: { id: input.runId, status: RunStatus.RUNNING, leaseId: input.leaseId },
      data: { status: RunStatus.WAITING_APPROVAL, leaseId: null, heartbeatAt: null, leaseExpiresAt: null },
    });
    if (paused.count === 0) throw new Error("Agent run lease was lost while requesting approval");
    return approval;
  });
}

export async function decideToolApproval(
  approvalId: string,
  actor: Pick<AuthUser, "id" | "role">,
  decision: "APPROVED" | "REJECTED",
  note?: string,
) {
  const accessWhere: Prisma.ToolApprovalWhereInput = actor.role === UserRole.ADMIN
    ? { id: approvalId }
    : { id: approvalId, workspace: { members: { some: { userId: actor.id, role: { in: [UserRole.REVIEWER, UserRole.ADMIN] } } } } };
  const approval = await prisma.toolApproval.findFirst({
    where: accessWhere,
  });
  if (!approval) throw new AppError(404, "Approval not found", "NOT_FOUND");
  if (approval.status !== ApprovalStatus.PENDING) throw new AppError(409, "Approval has already been decided", "APPROVAL_ALREADY_DECIDED");

  const decidedAt = new Date();
  const decided = await prisma.$transaction(async (transaction) => {
    const changed = await transaction.toolApproval.updateMany({
      where: {
        ...accessWhere,
        id: approval.id,
        status: ApprovalStatus.PENDING,
      },
      data: { status: decision, decidedBy: actor.id, decisionNote: note, decidedAt },
    });
    if (changed.count === 0) return false;
    const resumed = await transaction.agentRun.updateMany({
      where: { id: approval.runId, status: RunStatus.WAITING_APPROVAL },
      data: { status: RunStatus.PENDING },
    });
    if (resumed.count === 0) throw new AppError(409, "Run is no longer waiting for approval", "RUN_NOT_WAITING_APPROVAL");
    await transaction.outboxEvent.create({
      data: { topic: AGENT_RUN_RESUMED_TOPIC, aggregateId: approval.runId, payload: toJson({ runId: approval.runId }) },
    });
    return true;
  });
  if (!decided) throw new AppError(409, "Approval has already been decided", "APPROVAL_ALREADY_DECIDED");

  await audit({
    actorId: actor.id,
    workspaceId: approval.workspaceId,
    runId: approval.runId,
    eventType: decision === ApprovalStatus.APPROVED ? "TOOL_APPROVAL_APPROVED" : "TOOL_APPROVAL_REJECTED",
    metadata: { approvalId, toolCallId: approval.toolCallId, toolName: approval.toolName, riskLevel: approval.riskLevel, note: note ?? null },
  });
  return prisma.toolApproval.findUniqueOrThrow({ where: { id: approval.id } });
}
