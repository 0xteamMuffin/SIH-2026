import type { DataClassification, SessionState } from "@shared/types.js";

import { Icon } from "./ui/Icon.js";

/** Classifications the backend pins to an on-premise model. */
const RESTRICTED: readonly DataClassification[] = ["INTERNAL", "CONFIDENTIAL"];

export interface StatusBarProps {
  session: SessionState;
  isStreaming: boolean;
  classification: DataClassification;
  chatCount: number;
}

/**
 * The bottom band: where this session is connected, what routing policy the
 * next message will be sent under, and whether the agent is working.
 *
 * All three are things someone needs to be able to check without clicking.
 * Data classification in particular decides whether a prompt may leave the
 * cluster, so it is displayed permanently rather than only inside the
 * composer's dropdown.
 */
export function StatusBar({
  session,
  isStreaming,
  classification,
  chatCount,
}: StatusBarProps): React.JSX.Element {
  const restricted = RESTRICTED.includes(classification);

  return (
    <footer className="statusbar">
      <div className="statusbar__group">
        <span
          className="statusbar__item"
          data-tooltip={`Connected to ${session.baseUrl}`}
          data-tooltip-side="top"
        >
          <Icon name="network" size={11} />
          <span>{hostOf(session.baseUrl)}</span>
        </span>

        <span className="statusbar__separator" aria-hidden="true" />

        <span className="statusbar__item statusbar__item--truncate">
          <Icon name="folder" size={11} />
          <span>{session.workspace?.name ?? "No workspace"}</span>
        </span>

        <span className="statusbar__separator" aria-hidden="true" />

        <span className="statusbar__item">
          <Icon name="message" size={11} />
          <span>
            {chatCount} {chatCount === 1 ? "conversation" : "conversations"}
          </span>
        </span>
      </div>

      <div className="statusbar__group statusbar__group--end">
        <span
          className={`statusbar__item ${restricted ? "statusbar__item--warn" : ""}`}
          data-tooltip={
            restricted
              ? "Restricted data — the backend will route this to a local model"
              : "Standard routing — the backend may select any permitted model"
          }
          data-tooltip-side="top"
          data-tooltip-align="end"
        >
          <Icon name={restricted ? "lock" : "shield"} size={11} />
          <span>{restricted ? "Local models enforced" : "Standard routing"}</span>
        </span>

        <span className="statusbar__separator" aria-hidden="true" />

        {isStreaming ? (
          <span className="statusbar__item statusbar__item--busy" aria-live="polite">
            <span className="spinner spinner--sm" aria-hidden="true" />
            <span>Agent working</span>
          </span>
        ) : (
          <span className="statusbar__item" aria-live="polite">
            <Icon name="check" size={11} />
            <span>Ready</span>
          </span>
        )}
      </div>
    </footer>
  );
}

/** `http://cluster.internal:4000` reads better in a 26px band as the host. */
function hostOf(baseUrl: string): string {
  try {
    const { host } = new URL(baseUrl);
    return host || baseUrl;
  } catch {
    return baseUrl || "Not connected";
  }
}
