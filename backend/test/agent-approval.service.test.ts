import { ApprovalStatus, RunStatus, RunToolCallStatus, ToolRiskLevel, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { agentRunMock, approvalMock, auditMock, outboxMock, toolCallMock, transactionMock } = vi.hoisted(() => ({
  agentRunMock: { updateMany: vi.fn() },
  approvalMock: { create: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
  auditMock: vi.fn(),
  outboxMock: { create: vi.fn() },
  toolCallMock: { create: vi.fn() },
  transactionMock: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    agentRun: agentRunMock,
    toolApproval: approvalMock,
    runToolCall: toolCallMock,
    outboxEvent: outboxMock,
    $transaction: transactionMock,
  },
}));
vi.mock("../src/lib/audit.js", () => ({ audit: auditMock }));

import { decideToolApproval, pauseForToolApproval } from "../src/modules/agent/agent-approval.service.js";

const approval = {
  id: "40000000-0000-4000-8000-000000000001",
  runId: "10000000-0000-4000-8000-000000000001",
  toolCallId: "20000000-0000-4000-8000-000000000001",
  workspaceId: "30000000-0000-4000-8000-000000000001",
  toolName: "sandbox.execute",
  riskLevel: ToolRiskLevel.HIGH,
  status: ApprovalStatus.PENDING,
};

describe("agent tool approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((work) => work({ agentRun: agentRunMock, toolApproval: approvalMock, runToolCall: toolCallMock, outboxEvent: outboxMock }));
  });

  it("atomically stores the exact tool input and pauses the leased run", async () => {
    toolCallMock.create.mockResolvedValue({ id: approval.toolCallId });
    approvalMock.create.mockResolvedValue(approval);
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    const toolInput = { language: "javascript", code: "console.log('checked')" };

    await expect(pauseForToolApproval({
      runId: approval.runId,
      workspaceId: approval.workspaceId,
      leaseId: "50000000-0000-4000-8000-000000000001",
      modelToolCallId: "call-1",
      idempotencyKey: "key-1",
      toolName: approval.toolName,
      toolInput,
      riskLevel: ToolRiskLevel.HIGH,
    })).resolves.toEqual(approval);

    expect(toolCallMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ input: toolInput, status: RunToolCallStatus.WAITING_APPROVAL }) });
    expect(approvalMock.create).toHaveBeenCalledWith({ data: expect.objectContaining({ toolInput, toolName: "sandbox.execute", riskLevel: ToolRiskLevel.HIGH }) });
    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: RunStatus.RUNNING }),
      data: expect.objectContaining({ status: RunStatus.WAITING_APPROVAL, leaseId: null }),
    }));
  });

  it("authorizes from reviewer or admin workspace membership and resumes through the outbox", async () => {
    approvalMock.findFirst.mockResolvedValue(approval);
    approvalMock.updateMany.mockResolvedValue({ count: 1 });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    outboxMock.create.mockResolvedValue({});
    approvalMock.findUniqueOrThrow.mockResolvedValue({ ...approval, status: ApprovalStatus.APPROVED });

    await decideToolApproval(approval.id, { id: "reviewer-1", role: UserRole.OPERATOR }, ApprovalStatus.APPROVED, "Reviewed source");

    expect(approvalMock.findFirst).toHaveBeenCalledWith({ where: {
      id: approval.id,
      workspace: { members: { some: { userId: "reviewer-1", role: { in: [UserRole.REVIEWER, UserRole.ADMIN] } } } },
    } });
    expect(approvalMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: approval.id, status: ApprovalStatus.PENDING }) }));
    expect(outboxMock.create).toHaveBeenCalledWith({ data: { topic: "agent.run.resumed", aggregateId: approval.runId, payload: { runId: approval.runId } } });
    expect(agentRunMock.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "PENDING" } }));
  });

  it("denies non-global administrators without a matching workspace membership", async () => {
    approvalMock.findFirst.mockResolvedValue(null);
    await expect(decideToolApproval(approval.id, { id: "operator-1", role: UserRole.OPERATOR }, ApprovalStatus.APPROVED)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(approvalMock.updateMany).not.toHaveBeenCalled();
  });

  it("allows the current global administrator without workspace membership", async () => {
    approvalMock.findFirst.mockResolvedValue(approval);
    approvalMock.updateMany.mockResolvedValue({ count: 1 });
    agentRunMock.updateMany.mockResolvedValue({ count: 1 });
    outboxMock.create.mockResolvedValue({});
    approvalMock.findUniqueOrThrow.mockResolvedValue({ ...approval, status: ApprovalStatus.APPROVED });

    await decideToolApproval(approval.id, { id: "global-admin", role: UserRole.ADMIN }, ApprovalStatus.APPROVED);

    expect(approvalMock.findFirst).toHaveBeenCalledWith({ where: { id: approval.id } });
  });

  it("uses compare-and-set to reject a concurrent second decision", async () => {
    approvalMock.findFirst.mockResolvedValue(approval);
    approvalMock.updateMany.mockResolvedValue({ count: 0 });
    await expect(decideToolApproval(approval.id, { id: "reviewer-1", role: UserRole.OPERATOR }, ApprovalStatus.REJECTED)).rejects.toMatchObject({ status: 409, code: "APPROVAL_ALREADY_DECIDED" });
    expect(outboxMock.create).not.toHaveBeenCalled();
  });
});
