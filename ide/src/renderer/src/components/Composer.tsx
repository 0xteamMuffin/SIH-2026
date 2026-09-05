import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { DocumentRef } from "@shared/types.js";

/** Grow the textarea up to this height, then scroll inside it. */
const MAX_TEXTAREA_HEIGHT_PX = 200;

export interface ComposerProps {
  disabled: boolean;
  isStreaming: boolean;
  onSubmit: (prompt: string, attachments: DocumentRef[]) => void;
  onCancel: () => void;
}

export function Composer({
  disabled,
  isStreaming,
  onSubmit,
  onCancel,
}: ComposerProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<DocumentRef[]>([]);
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
    onSubmit(value.trim(), attachments);
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

      <p className="composer__hint">
        Enter to send · Shift+Enter for a new line · runs execute on your on-premise cluster
      </p>
    </form>
  );
}
