import type { ToolCallBlock, ToolCallState } from "@shared/types.js";

const STATE_GLYPHS: Record<ToolCallState, string> = {
  running: "",
  completed: "✓",
  failed: "✕",
  rejected: "⊘",
  "awaiting-approval": "⏸",
};

/**
 * One step the agent took.
 *
 * Shown so the run is legible as work rather than as a pause followed by an
 * answer — which is also what makes the agent's grounding auditable at a
 * glance.
 */
export function ToolCallView({ block }: { block: ToolCallBlock }): React.JSX.Element {
  return (
    <p className={`tool-step tool-step--${block.state}`} title={block.toolName}>
      {block.state === "running" ? (
        <span className="tool-step__spinner" aria-hidden="true" />
      ) : (
        <span className="tool-step__glyph" aria-hidden="true">
          {STATE_GLYPHS[block.state]}
        </span>
      )}
      <span className="tool-step__label">{block.summary}</span>
    </p>
  );
}
