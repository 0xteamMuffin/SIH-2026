import { useState } from "react";

import type { ApprovalBlock } from "@shared/types.js";

import { Icon } from "../ui/Icon.js";

const RISK_TONE: Record<ApprovalBlock["riskLevel"], string> = {
  HIGH: "badge--danger",
  MEDIUM: "badge--warning",
  LOW: "badge--neutral",
};

/**
 * A high-risk tool waiting on a human decision.
 *
 * The backend suspends the run until someone answers, so this shows the exact
 * arguments the tool would run with. Approving code you have not read is the
 * failure mode this whole gate exists to prevent, so the payload is displayed
 * rather than summarised — and the block is styled as a stop, not as another
 * status line to scroll past.
 */
export function ApprovalView({ block }: { block: ApprovalBlock }): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [decided, setDecided] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function decide(decision: "APPROVED" | "REJECTED"): void {
    setSubmitting(true);
    setError(null);
    window.workbench.approvals
      .decide(block.approvalId, decision)
      .then(() => setDecided(decision))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSubmitting(false));
  }

  return (
    <div className="approval" role="group" aria-label="Tool approval required">
      <div className="approval__head">
        <span className="approval__icon">
          <Icon name="alert-triangle" size={15} />
        </span>
        <span className="approval__title">Approval required</span>
        <span className={`badge ${RISK_TONE[block.riskLevel]}`}>{block.riskLevel} risk</span>
      </div>

      <p className="approval__prompt">
        The agent wants to run <span className="approval__tool">{block.toolName}</span>. Review the
        arguments below before approving — this executes on your cluster.
      </p>

      <pre className="approval__payload selectable">{formatInput(block.input)}</pre>

      {error && (
        <p className="approval__error" role="alert">
          {error}
        </p>
      )}

      {decided ? (
        <p
          className={`approval__decided ${decided === "APPROVED" ? "approval__decided--approved" : ""}`}
        >
          <Icon name={decided === "APPROVED" ? "check-circle" : "ban"} size={14} />
          {decided === "APPROVED" ? "Approved — the run is continuing." : "Rejected."}
        </p>
      ) : (
        <div className="approval__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => decide("APPROVED")}
            disabled={submitting}
          >
            <Icon name="check" size={14} strokeWidth={2.2} />
            Approve and run
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => decide("REJECTED")}
            disabled={submitting}
          >
            Reject
          </button>
          {submitting && <span className="spinner" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}

/**
 * Renders the payload readably. Sandbox calls carry a `code` field whose
 * newlines matter far more than its JSON quoting, so it is unwrapped.
 */
function formatInput(input: unknown): string {
  if (input && typeof input === "object" && "code" in input) {
    const { code, ...rest } = input as { code: unknown } & Record<string, unknown>;
    const header = Object.keys(rest).length > 0 ? `${JSON.stringify(rest)}\n\n` : "";
    return `${header}${String(code)}`;
  }
  return JSON.stringify(input, null, 2) ?? String(input);
}
