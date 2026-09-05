import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { DATA_CLASSIFICATIONS, type DataClassification, type DocumentRef } from "@shared/types.js";

/** Grow the textarea up to this height, then scroll inside it. */
const MAX_TEXTAREA_HEIGHT_PX = 200;

/** Landing page when the browser is opened with no destination. */
const BLANK_PAGE = "https://example.com";

/**
 * Returns the URL when the message is nothing but a link, optionally prefixed
 * with a word like "open". Anything else is a question for the agent.
 */
function onlyUrl(prompt: string): string | null {
  const match = /^(?:open|browse|go to|visit)?\s*(https?:\/\/\S+)$/i.exec(prompt.trim());
  return match?.[1] ?? null;
}

/** Restricted classifications force the backend to route to a local model. */
const CLASSIFICATION_LABELS: Record<DataClassification, string> = {
  SYNTHETIC: "Synthetic",
  PUBLIC: "Public",
  INTERNAL: "Internal — local model",
  CONFIDENTIAL: "Confidential — local model",
};

export interface ComposerProps {
  disabled: boolean;
  isStreaming: boolean;
  onSubmit: (prompt: string, attachments: DocumentRef[], classification: DataClassification) => void;
  onCancel: () => void;
  /** Opens a page in the embedded browser pane. */
  onOpenBrowser: (url: string) => void;
}

export function Composer({
  disabled,
  isStreaming,
  onSubmit,
  onCancel,
  onOpenBrowser,
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<DocumentRef[]>([]);
  const [classification, setClassification] = useState<DataClassification>("SYNTHETIC");
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-size to the content. Reset to `auto` first so the box can shrink back
  // down when text is deleted.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [value]);

  const canSubmit = value.trim().length > 0 && !disabled;

  function submit(): void {
    if (!canSubmit) return;
    const prompt = value.trim();

    // The agent has no browsing tool yet, so sending it a bare URL only
    // produces "I cannot open links". Opening the pane is what the user meant.
    const url = onlyUrl(prompt);
    if (url) {
      onOpenBrowser(url);
      setValue("");
      return;
    }

    onSubmit(prompt, attachments, classification);
    setValue("");
    setAttachments([]);
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    submit();
  }

  // Enter sends; Shift+Enter inserts a newline.
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  }

  function attach(): void {
    setAttachError(null);
    window.workbench.documents
      .pick()
      .then((picked) => {
        // Cancelling the dialog yields an empty list, which is not an error.
        if (picked.length === 0) return;
        setAttachments((current) => [...current, ...picked]);
      })
      .catch((cause: unknown) => {
        setAttachError(cause instanceof Error ? cause.message : String(cause));
      });
  }

  function removeAttachment(documentId: string): void {
    setAttachments((current) => current.filter((document) => document.id !== documentId));
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      {attachments.length > 0 && (
        <ul className="composer__attachments">
          {attachments.map((document) => (
            <li key={document.id} className="composer__attachment">
              <span className="composer__attachment-name">{document.filename}</span>
              <button
                type="button"
                onClick={() => removeAttachment(document.id)}
                aria-label={`Remove ${document.filename}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {attachError && <p className="composer__error">{attachError}</p>}

      <div className="composer__box">
        <button
          type="button"
          className="composer__attach"
          onClick={attach}
          title="Attach a file"
          aria-label="Attach a file"
        >
          +
        </button>

        <textarea
          ref={textareaRef}
          className="composer__input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the agent to change code, read a document, or open a page…"
          rows={1}
          aria-label="Message the agent"
        />

        {isStreaming ? (
          <button type="button" className="composer__stop" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button type="submit" className="composer__send" disabled={!canSubmit} aria-label="Send">
            ↑
          </button>
        )}
      </div>

      <div className="composer__footer">
        <label className="composer__classification">
          <span className="composer__classification-label">Data</span>
          <select
            value={classification}
            onChange={(event) => setClassification(event.target.value as DataClassification)}
            aria-label="Data classification"
          >
            {DATA_CLASSIFICATIONS.map((value) => (
              <option key={value} value={value}>
                {CLASSIFICATION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="composer__browser"
          onClick={() => onOpenBrowser(BLANK_PAGE)}
          title="Open the embedded browser"
        >
          Open browser
        </button>
        <p className="composer__hint">Enter to send · Shift+Enter for a new line</p>
      </div>
    </form>
  );
}
