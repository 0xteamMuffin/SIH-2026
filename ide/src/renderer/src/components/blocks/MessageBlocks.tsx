import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { MessageBlock, PreviewCapabilities, StatusBlock } from "@shared/types.js";
import { isTerminalRunState } from "@shared/types.js";

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
 * The switch is exhaustive over `MessageBlock`, so adding a block kind to the
 * shared contract surfaces here as a type error until it has a renderer.
 */
export function MessageBlocks({
  blocks,
  capabilities,
  onOpenUrl,
}: MessageBlocksProps): React.JSX.Element {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} capabilities={capabilities} onOpenUrl={onOpenUrl} />
      ))}
    </>
  );
}

function BlockView({
  block,
  capabilities,
  onOpenUrl,
}: {
  block: MessageBlock;
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
      return <StatusLine block={block} />;

    case "tool":
      return <ToolCallView block={block} />;

    case "approval":
      return <ApprovalView block={block} />;

    case "diff":
      return <DiffView patch={block.patch} />;

    case "document":
      return <DocumentCard document={block.document} capabilities={capabilities} />;

    case "browser":
      return (
        <button type="button" className="browser-chip" onClick={() => onOpenUrl(block.url)}>
          <span className="browser-chip__icon" aria-hidden="true">
            ◴
          </span>
          <span className="browser-chip__text">
            <span className="browser-chip__title">{block.title ?? "Open in browser pane"}</span>
            <span className="browser-chip__url">{block.url}</span>
          </span>
        </button>
      );
  }
}

function StatusLine({ block }: { block: StatusBlock }): React.JSX.Element {
  const isActive = !isTerminalRunState(block.state);

  return (
    <p className={`status-line status-line--${block.state}`}>
      <span
        className={`status-line__dot ${isActive ? "status-line__dot--pulsing" : ""}`}
        aria-hidden="true"
      />
      <span>{block.label}</span>
      {block.detail && <span className="status-line__detail">{block.detail}</span>}
    </p>
  );
}
