import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { DATA_CLASSIFICATIONS, type DataClassification, type DocumentRef } from "@shared/types.js";

import { Icon } from "./ui/Icon.js";
import { IconButton } from "./ui/IconButton.js";
import { Select } from "./ui/Select.js";

/** Grow the textarea up to this height, then scroll inside it. */
const MAX_TEXTAREA_HEIGHT_PX = 200;

/** Landing page when the browser is opened with no destination. */
const BLANK_PAGE = "https://example.com";

/** Classifications the backend pins to an on-premise model. */
const RESTRICTED: readonly DataClassification[] = ["INTERNAL", "CONFIDENTIAL"];

const CLASSIFICATION_LABELS: Record<DataClassification, string> = {
  SYNTHETIC: "Synthetic",
  PUBLIC: "Public",
  INTERNAL: "Internal",
  CONFIDENTIAL: "Confidential",
};

const CLASSIFICATION_OPTIONS = DATA_CLASSIFICATIONS.map((value) => ({
  value,
  label: CLASSIFICATION_LABELS[value],
}));

/**
 * Returns the URL when the message is nothing but a link, optionally prefixed
 * with a word like "open". Anything else is a question for the agent.
 */
function onlyUrl(prompt: string): string | null {
  const match = /^(?:open|browse|go to|visit)?\s*(https?:\/\/\S+)$/i.exec(prompt.trim());
  return match?.[1] ?? null;
}

export interface ComposerProps {
  /**
   * Controlled, because the starter cards in an empty thread write into it.
   * A composer that owned its own text could not be filled from outside.
   */
  value: string;
  onValueChange: (value: string) => void;
  disabled: boolean;
  isStreaming: boolean;
  classification: DataClassification;
  onClassificationChange: (classification: DataClassification) => void;
  onSubmit: (prompt: string, attachments: DocumentRef[], classification: DataClassification) => void;
  onCancel: () => void;
  /** Opens a page in the embedded browser pane. */
  onOpenBrowser: (url: string) => void;
}

export function Composer({
  value,
  onValueChange,
  disabled,
  isStreaming,
  classification,
  onClassificationChange,
  onSubmit,
  onCancel,
  onOpenBrowser,
}: ComposerProps): React.JSX.Element {
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
  const restricted = RESTRICTED.includes(classification);

  function submit(): void {
    if (!canSubmit) return;
    const prompt = value.trim();

    // The agent has no browsing tool yet, so sending it a bare URL only
    // produces "I cannot open links". Opening the pane is what the user meant.
    const url = onlyUrl(prompt);
    if (url) {
      onOpenBrowser(url);
      onValueChange("");
      return;
    }

    onSubmit(prompt, attachments, classification);
    onValueChange("");
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
      <div className="composer__inner">
        <div className={`composer__card ${disabled ? "composer__card--disabled" : ""}`}>
          {attachments.length > 0 && (
            <ul className="composer__attachments">
              {attachments.map((document) => (
                <li key={document.id} className="attachment">
                  <Icon name="file" size={12} className="attachment__icon" />
                  <span className="attachment__name">{document.filename}</span>
                  <IconButton
                    icon="close"
                    label={`Remove ${document.filename}`}
                    size="sm"
                    hideTooltip
                    onClick={() => removeAttachment(document.id)}
                  />
                </li>
              ))}
            </ul>
          )}

          {attachError && (
            <p className="composer__error" role="alert">
              <Icon name="alert-circle" size={13} />
              {attachError}
            </p>
          )}

          <textarea
            ref={textareaRef}
            className="composer__input selectable"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask the agent to change code, read a document, or open a page…"
            rows={1}
            disabled={disabled}
            aria-label="Message the agent"
          />

          <div className="composer__toolbar">
            <IconButton
              icon="paperclip"
              label="Attach a file"
              onClick={attach}
              disabled={disabled}
              tooltipSide="top"
            />
            <IconButton
              icon="globe"
              label="Open the browser pane"
              onClick={() => onOpenBrowser(BLANK_PAGE)}
              tooltipSide="top"
            />

            {/*
              Data-classification picker — parked, not deleted.

              Every message still carries a classification (`SYNTHETIC` by
              default, see App.tsx) and the status bar still reports the
              routing policy, so the backend contract is unchanged. Only the
              in-composer control is hidden until the classification workflow
              is settled; uncomment this block to bring it back.

              <span
                className={`classification ${restricted ? "classification--restricted" : ""}`}
                data-tooltip={
                  restricted
                    ? "Restricted — the backend will route this to a local model"
                    : "Data classification for this message"
                }
                data-tooltip-side="top"
              >
                <Icon
                  name={restricted ? "lock" : "shield"}
                  size={12}
                  className="classification__icon"
                />
                <Select
                  value={classification}
                  options={CLASSIFICATION_OPTIONS}
                  onChange={(next) => onClassificationChange(next as DataClassification)}
                  label="Data classification"
                />
              </span>
            */}

            <span className="composer__toolbar-spacer" />

            {isStreaming ? (
              <button type="button" className="composer__stop" onClick={onCancel}>
                <Icon name="stop" size={9} />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="composer__send"
                disabled={!canSubmit}
                aria-label="Send message"
              >
                <Icon name="send" size={15} strokeWidth={2.1} />
              </button>
            )}
          </div>
        </div>

        <p className="composer__hint">
          <span>
            <kbd className="kbd">↵</kbd> to send
          </span>
          <span>
            <kbd className="kbd">⇧</kbd>
            <kbd className="kbd">↵</kbd> for a new line
          </span>
        </p>
      </div>
    </form>
  );
}
