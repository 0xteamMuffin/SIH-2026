import { useEffect, useRef, useState } from "react";

import type { Chat, Message, PreviewCapabilities, RunTrace } from "@shared/types.js";

import { MessageBlocks } from "./blocks/MessageBlocks.js";
import { AgentAvatar } from "./ui/Avatar.js";
import { Icon, type IconName } from "./ui/Icon.js";
import { IconButton } from "./ui/IconButton.js";

export interface ChatThreadProps {
  chat: Chat;
  capabilities: PreviewCapabilities | null;
  onOpenUrl: (url: string) => void;
  onShowTrace: (trace: RunTrace) => void;
  activeTraceRunId: string | null;
  /** Fills the composer from a starter card. */
  onSuggest: (prompt: string) => void;
}

export function ChatThread({
  chat,
  capabilities,
  onOpenUrl,
  onShowTrace,
  activeTraceRunId,
  onSuggest,
}: ChatThreadProps): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const lastMessage = chat.messages.at(-1);

  // Follow the conversation as it grows, and as the final reply streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.messages.length, lastMessage?.blocks.length]);

  if (chat.messages.length === 0) {
    return <WelcomeThread onSuggest={onSuggest} />;
  }

  return (
    <div className="thread">
      <div className="thread__inner">
        {chat.messages.map((message) => (
          <Turn
            key={message.id}
            message={message}
            capabilities={capabilities}
            onOpenUrl={onOpenUrl}
            onShowTrace={onShowTrace}
            activeTraceRunId={activeTraceRunId}
          />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function Turn({
  message,
  capabilities,
  onOpenUrl,
  onShowTrace,
  activeTraceRunId,
}: {
  message: Message;
  capabilities: PreviewCapabilities | null;
  onOpenUrl: (url: string) => void;
  onShowTrace: (trace: RunTrace) => void;
  activeTraceRunId: string | null;
}): React.JSX.Element {
  const isAgent = message.role === "agent";
  const trace = message.trace;

  return (
    <article className={`turn turn--${message.role}`}>
      {isAgent && (
        <div className="turn__gutter">
          <AgentAvatar size="sm" />
        </div>
      )}

      <div className="turn__content">
        {isAgent ? (
          <header className="turn__author">
            <span className="turn__name">Agent</span>
            {/*
              No model name here. Which profile answered is routing detail,
              not part of the conversation — it belongs in the run trace,
              where it sits beside the reason it was chosen.
            */}
            <div className="turn__tools">
              <CopyButton message={message} />
              {trace && (
                <IconButton
                  icon="network"
                  label={activeTraceRunId === trace.runId ? "Hide run trace" : "Show run trace"}
                  size="sm"
                  active={activeTraceRunId === trace.runId}
                  onClick={() => onShowTrace(trace)}
                />
              )}
            </div>
          </header>
        ) : (
          <span className="visually-hidden">You said</span>
        )}

        <div className="turn__body selectable">
          <MessageBlocks
            blocks={message.blocks}
            capabilities={capabilities}
            onOpenUrl={onOpenUrl}
          />
        </div>
      </div>
    </article>
  );
}

/**
 * Copies a turn's prose.
 *
 * Only text blocks: a diff or a workbook preview has no useful plain-text
 * form, and silently flattening one into the clipboard would be worse than
 * omitting it.
 */
function CopyButton({ message }: { message: Message }): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);

  const text = message.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!text) return null;

  return (
    <IconButton
      icon={copied ? "check" : "copy"}
      label={copied ? "Copied" : "Copy reply"}
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch((error: unknown) => console.error("[thread] copy failed", error));
      }}
    />
  );
}

interface Suggestion {
  icon: IconName;
  label: string;
  prompt: string;
}

/**
 * Starter prompts.
 *
 * Chosen to show the three things the workbench does that a chat window does
 * not — read an attached document, produce a real file, and execute code —
 * because an empty composer gives no clue that any of those are possible.
 */
const SUGGESTIONS: readonly Suggestion[] = [
  {
    icon: "file-text",
    label: "Draft",
    prompt: "Read the attached inspection report and draft an approval note for it.",
  },
  {
    icon: "table",
    label: "Analyse",
    prompt: "Build a workbook of the readings with the loss rate per station.",
  },
  {
    icon: "terminal",
    label: "Automate",
    prompt: "Write a Python script that checks the readings against the thresholds, then run it.",
  },
];

function WelcomeThread({ onSuggest }: { onSuggest: (prompt: string) => void }): React.JSX.Element {
  return (
    <div className="welcome">
      <span className="welcome__mark" aria-hidden="true">
        <Icon name="shield" size={22} strokeWidth={1.9} />
      </span>

      <h1 className="welcome__title">Sovereign Workbench</h1>
      <p className="welcome__body">
        Put the agent to work on the documents and data held on your on-premise deployment.
        Nothing leaves the cluster.
      </p>

      <ul className="welcome__cards">
        {SUGGESTIONS.map((suggestion) => (
          <li key={suggestion.label}>
            <button
              type="button"
              className="suggestion"
              onClick={() => onSuggest(suggestion.prompt)}
            >
              <span className="suggestion__head">
                <Icon name={suggestion.icon} size={14} />
                <span className="suggestion__label">{suggestion.label}</span>
              </span>
              <span className="suggestion__text">{suggestion.prompt}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="welcome__hint">
        Every run is recorded — open the trace to see which model answered and why.
      </p>
    </div>
  );
}
