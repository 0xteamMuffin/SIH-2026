import type { ToolCallBlock, ToolCallState } from "@shared/types.js";

import { Icon, type IconName } from "../ui/Icon.js";

const STATE_ICONS: Record<Exclude<ToolCallState, "running">, IconName> = {
  completed: "check",
  failed: "close",
  rejected: "ban",
  "awaiting-approval": "pause",
};

/**
 * One step the agent took.
 *
 * Shown so the run is legible as work rather than as a pause followed by an
 * answer — which is also what makes the agent's grounding auditable at a
 * glance. The tool's real name is displayed beside the summary: "read 4
 * files" is reassuring, `fs.read` is verifiable.
 */
export function ToolCallView({ block }: { block: ToolCallBlock }): React.JSX.Element {
  return (
    <li className={`tool-call tool-call--${block.state}`}>
      <span className="tool-call__glyph">
        {block.state === "running" ? (
          <span className="spinner spinner--sm" aria-hidden="true" />
        ) : (
          <Icon name={STATE_ICONS[block.state]} size={12} strokeWidth={2.2} />
        )}
      </span>

      <span className="tool-call__name">{block.toolName}</span>
      <span className="tool-call__summary" title={block.summary}>
        {block.summary}
      </span>
    </li>
  );
}
