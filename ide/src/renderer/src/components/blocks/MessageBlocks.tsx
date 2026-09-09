import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type {
  MessageBlock,
  PreviewCapabilities,
  RunState,
  StatusBlock,
  ToolCallBlock,
} from "@shared/types.js";
import { isTerminalRunState } from "@shared/types.js";

import { Icon, type IconName } from "../ui/Icon.js";
import { ApprovalView } from "./ApprovalView.js";
import { DiffView } from "./DiffView.js";
import { DocumentCard } from "./DocumentCard.js";
import { ToolCallView } from "./ToolCallView.js";

export interface MessageBlocksProps {
  blocks: MessageBlock[];
  capabilities: PreviewCapabilities | null;
  /** Opens a URL in the embedded browser pane. */
  onOpenUrl: (url: string) => void;
}

/**
 * Renders a message's blocks in order.
 *
 * Adjacent tool calls are collected into one list first. A long run is mostly
 * tool calls, and rendering each as a standalone block spaced like prose
 * turns the agent's work into a wall that buries the answer under it.
 */
export function MessageBlocks({
  blocks,
  capabilities,
  onOpenUrl,
}: MessageBlocksProps): React.JSX.Element {
  return (
    <>
      {groupToolCalls(blocks).map((group, index) =>
        group.kind === "tool-group" ? (
          <ul key={index} className="tool-calls">
            {group.calls.map((call, callIndex) => (
              <ToolCallView key={callIndex} block={call} />
            ))}
          </ul>
        ) : (
          <BlockView
            key={index}
            block={group.block}
            capabilities={capabilities}
            onOpenUrl={onOpenUrl}
          />
        ),
      )}
    </>
  );
}

type RenderGroup =
  | { kind: "tool-group"; calls: ToolCallBlock[] }
  | { kind: "single"; block: Exclude<MessageBlock, ToolCallBlock> };

function groupToolCalls(blocks: MessageBlock[]): RenderGroup[] {
  const groups: RenderGroup[] = [];

  for (const block of blocks) {
    if (block.kind !== "tool") {
      groups.push({ kind: "single", block });
      continue;
    }

    const previous = groups.at(-1);
    if (previous?.kind === "tool-group") previous.calls.push(block);
    else groups.push({ kind: "tool-group", calls: [block] });
  }

  return groups;
}

/**
 * The switch is exhaustive over `MessageBlock`, so adding a block kind to the
 * shared contract surfaces here as a type error until it has a renderer.
 */
function BlockView({
  block,
  capabilities,
  onOpenUrl,
}: {
  block: Exclude<MessageBlock, ToolCallBlock>;
  capabilities: PreviewCapabilities | null;
  onOpenUrl: (url: string) => void;
}): React.JSX.Element {
  switch (block.kind) {
    case "text":
      return (
        <div className="markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown>
        </div>
      );

    case "status":
      return <RunStatus block={block} />;

    case "approval":
      return <ApprovalView block={block} />;

    case "diff":
      return <DiffView patch={block.patch} />;

    case "document":
      return <DocumentCard document={block.document} capabilities={capabilities} />;

    case "browser":
      return (
        <button type="button" className="link-card" onClick={() => onOpenUrl(block.url)}>
          <span className="link-card__icon">
            <Icon name="globe" size={16} />
          </span>
          <span className="link-card__text">
            <span className="link-card__title">{block.title ?? "Open in the browser pane"}</span>
            <span className="link-card__url">{block.url}</span>
          </span>
          <Icon name="arrow-up-right" size={14} />
        </button>
      );
  }
}

const STATE_ICONS: Record<RunState, IconName> = {
  queued: "clock",
  running: "circle-dot",
  "awaiting-approval": "pause",
  completed: "check-circle",
  failed: "x-circle",
  cancelled: "ban",
};

function RunStatus({ block }: { block: StatusBlock }): React.JSX.Element {
  const isActive = !isTerminalRunState(block.state);

  return (
    <p
      className={`run-status run-status--${block.state}`}
      // Announced as it changes, so a screen reader user hears the run
      // progressing rather than only its final answer.
      aria-live={isActive ? "polite" : "off"}
    >
      {isActive ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <Icon name={STATE_ICONS[block.state]} size={14} />
      )}
      <span className="run-status__label">{block.label}</span>
      {block.detail && <span className="run-status__detail">{block.detail}</span>}
    </p>
  );
}
