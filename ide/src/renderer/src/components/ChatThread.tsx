import { useEffect, useRef } from "react";

import type { Chat, PreviewCapabilities, RunTrace } from "@shared/types.js";

import { MessageBlocks } from "./blocks/MessageBlocks.js";

export interface ChatThreadProps {
  chat: Chat;
  capabilities: PreviewCapabilities | null;
  onOpenUrl: (url: string) => void;
  onShowTrace: (trace: RunTrace) => void;
  activeTraceRunId: string | null;
}

export function ChatThread({
  chat,
  capabilities,
  onOpenUrl,
  onShowTrace,
  activeTraceRunId,
}: ChatThreadProps): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const lastMessage = chat.messages.at(-1);

  // Follow the conversation as it grows, and as the final reply streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.messages.length, lastMessage?.blocks.length]);

  if (chat.messages.length === 0) {
    return <EmptyThread />;
  }

  return (
    <div className="thread">
      <div className="thread__inner">
        {chat.messages.map((message) => (
          <article key={message.id} className={`turn turn--${message.role}`}>
            <header className="turn__role">{message.role === "user" ? "You" : "Agent"}</header>
            <div className="turn__body">
              <MessageBlocks
                blocks={message.blocks}
                capabilities={capabilities}
                onOpenUrl={onOpenUrl}
              />
            </div>
            {message.trace && (
              <button
                type="button"
                className={`turn__trace ${activeTraceRunId === message.trace.runId ? "turn__trace--active" : ""}`}
                onClick={() => onShowTrace(message.trace!)}
              >
                {activeTraceRunId === message.trace.runId ? "Hide trace" : "View trace"}
              </button>
            )}
          </article>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function EmptyThread(): React.JSX.Element {
  return (
    <div className="thread thread--empty">
      <div className="empty">
        <h1 className="empty__title">Sovereign Workbench</h1>
        <p className="empty__body">
          Ask the agent to work on the documents and data held on your on-premise deployment.
          Nothing leaves the cluster.
        </p>
        <ul className="empty__hints">
          <li>
            <code>Attach an inspection report and ask for an approval note</code>
          </li>
          <li>
            <code>Build a workbook of the readings with the loss rate per station</code>
          </li>
          <li>
            <code>Write a Python script to check the thresholds, and run it</code>
          </li>
        </ul>
      </div>
    </div>
  );
}
