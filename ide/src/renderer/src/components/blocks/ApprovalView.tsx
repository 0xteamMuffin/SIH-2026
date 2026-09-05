import { useState } from "react";

import type { ApprovalBlock } from "@shared/types.js";

/**
 * A high-risk tool waiting on a human decision.
 *
 * The backend suspends the run until someone answers, so this shows the exact
 * arguments the tool would run with. Approving code you have not read is the
 * failure mode this whole gate exists to prevent, so the payload is displayed
 * rather than summarised.
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
        <span className={`approval__risk approval__risk--${block.riskLevel.toLowerCase()}`}>
          {block.riskLevel} risk
        </span>
        <span className="approval__tool">{block.toolName}</span>
      </div>

      <p className="approval__prompt">
        The agent wants to run this. Review it before approving — it executes on your cluster.
      </p>

      <pre className="approval__payload">{formatInput(block.input)}</pre>

      {error && <p className="approval__error">{error}</p>}

      {decided ? (
        <p className="approval__decided">
          {decided === "APPROVED" ? "Approved — the run is continuing." : "Rejected."}
        </p>
      ) : (
        <div className="approval__actions">
          <button type="button" className="approval__approve" onClick={() => decide("APPROVED")} disabled={submitting}>
            Approve
          </button>
          <button type="button" className="approval__reject" onClick={() => decide("REJECTED")} disabled={submitting}>
            Reject
          </button>
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
