import { useCallback, useEffect, useState } from "react";

import type { AuditEvent, AuditQuery, WorkspaceSummary } from "@shared/types.js";

import { DropdownMenu } from "../components/ui/DropdownMenu.js";
import { Icon } from "../components/ui/Icon.js";
import { IconButton } from "../components/ui/IconButton.js";

/**
 * The audit log.
 *
 * Scoped to one workspace, because that is how the backend scopes it: a
 * conversation, its runs, and its approvals belong to a workspace, and so does
 * the right to read what happened inside it.
 *
 * Metadata is shown raw and unformatted on expand. These records are the thing
 * an auditor is trying to read, and a prettified summary would be a second
 * account of the event sitting between them and the stored one.
 */

/** Page size. Large enough that a demo rarely needs the pager. */
const PAGE_SIZE = 50;

/**
 * The event vocabulary the backend emits, offered as completions.
 *
 * A hint rather than a constraint — the field stays free text, so an event
 * type added backend-side is filterable here before this list is updated.
 */
const KNOWN_EVENT_TYPES = [
  "AGENT_RUN_CREATED",
  "AGENT_RUN_COMPLETED",
  "AGENT_RUN_FAILED",
  "AGENT_RUN_CANCELLED",
  "AGENT_RUN_ATTEMPT_FAILED",
  "MODEL_ROUTED",
  "EXTERNAL_INFERENCE_BLOCKED",
  "EGRESS_PROBE_RUN",
  "TOOL_APPROVAL_REQUESTED",
  "ARTIFACT_UPLOADED",
  "ARTIFACT_DELETED",
  "ARTIFACT_DELETION_REQUESTED",
  "KNOWLEDGE_SOURCE_DELETION_REQUESTED",
  "LOGIN_SUCCEEDED",
  "LOGIN_FAILED",
  "USER_CREATED",
  "USER_DISABLED",
  "WORKSPACE_CREATED",
  "WORKSPACE_MEMBER_ADDED",
  "WORKSPACE_MEMBER_REMOVED",
  "WORKSPACE_MEMBER_ROLE_UPDATED",
];

type Filters = {
  eventType: string;
  actorId: string;
  runId: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: Filters = { eventType: "", actorId: "", runId: "", from: "", to: "" };

export interface AuditViewProps {
  workspaces: WorkspaceSummary[];
  workspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
}

export function AuditView({
  workspaces,
  workspaceId,
  onSelectWorkspace,
}: AuditViewProps): React.JSX.Element {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportState, setExportState] = useState<string | null>(null);

  /**
   * Loads a page. Without a cursor this replaces the list; with one it
   * appends, which is what makes "load more" accumulate rather than jump.
   */
  const loadPage = useCallback(
    (cursor?: string) => {
      if (!workspaceId) return;
      setIsLoading(true);
      setError(null);

      const query: AuditQuery = {
        workspaceId,
        limit: PAGE_SIZE,
        ...(applied.eventType ? { eventType: applied.eventType } : {}),
        ...(applied.actorId ? { actorId: applied.actorId } : {}),
        ...(applied.runId ? { runId: applied.runId } : {}),
        ...(applied.from ? { from: toIsoStart(applied.from) } : {}),
        ...(applied.to ? { to: toIsoEnd(applied.to) } : {}),
        ...(cursor ? { cursor } : {}),
      };

      window.workbench.audit
        .list(query)
        .then((page) => {
          setEvents((current) => (cursor ? [...current, ...page.auditEvents] : page.auditEvents));
          setNextCursor(page.nextCursor);
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => setIsLoading(false));
    },
    [workspaceId, applied],
  );

  // Reload from the top whenever the scope or the filters change.
  useEffect(() => loadPage(), [loadPage]);

  function exportEvents(format: "json" | "ndjson"): void {
    if (!workspaceId) return;
    setExportState(null);
    window.workbench.audit
      .export(workspaceId, format, {
        ...(applied.eventType ? { eventType: applied.eventType } : {}),
        ...(applied.actorId ? { actorId: applied.actorId } : {}),
        ...(applied.runId ? { runId: applied.runId } : {}),
        ...(applied.from ? { from: toIsoStart(applied.from) } : {}),
        ...(applied.to ? { to: toIsoEnd(applied.to) } : {}),
      })
      .then((path) => setExportState(path ? `Exported to ${path}` : null))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }

  const workspaceName =
    workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "No workspace";
  const hasFilters = Object.values(applied).some(Boolean);

  return (
    <section className="view" aria-label="Audit log">
      <header className="view__head">
        <div className="view__titles">
          <h1 className="view__title">Audit log</h1>
          <p className="view__subtitle">
            Every security and operational event recorded for this workspace.
          </p>
        </div>

        <div className="view__actions">
          {workspaces.length > 1 ? (
            <DropdownMenu
              label="Workspace"
              header="Workspace"
              align="end"
              triggerClassName="chip chip--button"
              trigger={
                <>
                  <Icon name="folder" size={12} />
                  {workspaceName}
                  <Icon name="chevron-down" size={11} />
                </>
              }
              items={workspaces.map((workspace) => ({
                id: workspace.id,
                label: workspace.name,
                selected: workspace.id === workspaceId,
                onSelect: () => onSelectWorkspace(workspace.id),
              }))}
            />
          ) : (
            <span className="chip">
              <Icon name="folder" size={12} />
              {workspaceName}
            </span>
          )}

          <DropdownMenu
            label="Export audit events"
            header="Export"
            align="end"
            triggerClassName="btn btn--secondary btn--sm"
            trigger={
              <>
                <Icon name="download" size={13} />
                Export
              </>
            }
            items={[
              { id: "json", label: "JSON array", onSelect: () => exportEvents("json") },
              {
                id: "ndjson",
                label: "NDJSON",
                description: "One event per line",
                onSelect: () => exportEvents("ndjson"),
              },
            ]}
          />

          <IconButton
            icon="refresh"
            label="Refresh"
            onClick={() => loadPage()}
            disabled={isLoading}
            tooltipAlign="end"
          />
        </div>
      </header>

      <div className="view__body">
        <div className="view__inner">
          <div className="filters">
            <label className="filters__field filters__field--wide">
              <span className="form-label">Event type</span>
              <input
                className="field"
                list="audit-event-types"
                value={draft.eventType}
                onChange={(event) => setDraft({ ...draft, eventType: event.target.value })}
                placeholder="Any event"
                spellCheck={false}
              />
              <datalist id="audit-event-types">
                {KNOWN_EVENT_TYPES.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
            </label>

            <label className="filters__field">
              <span className="form-label">Actor</span>
              <input
                className="field"
                value={draft.actorId}
                onChange={(event) => setDraft({ ...draft, actorId: event.target.value })}
                placeholder="User id"
                spellCheck={false}
              />
            </label>

            <label className="filters__field">
              <span className="form-label">Run</span>
              <input
                className="field"
                value={draft.runId}
                onChange={(event) => setDraft({ ...draft, runId: event.target.value })}
                placeholder="Run id"
                spellCheck={false}
              />
            </label>

            <label className="filters__field">
              <span className="form-label">From</span>
              <input
                className="field"
                type="date"
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              />
            </label>

            <label className="filters__field">
              <span className="form-label">To</span>
              <input
                className="field"
                type="date"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            </label>

            <span className="filters__spacer" />

            <div className="filters__actions">
              {(hasFilters || Object.values(draft).some(Boolean)) && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setDraft(EMPTY_FILTERS);
                    setApplied(EMPTY_FILTERS);
                  }}
                >
                  Clear
                </button>
              )}
              <button type="button" className="btn btn--primary" onClick={() => setApplied(draft)}>
                <Icon name="search" size={13} />
                Apply
              </button>
            </div>
          </div>

          {error && (
            <p className="form-error" role="alert">
              <Icon name="alert-circle" size={14} />
              {error}
            </p>
          )}

          {exportState && (
            <p className="form-notice">
              <Icon name="check-circle" size={13} />
              {exportState}
            </p>
          )}

          <div className="card">
            {events.length === 0 && !isLoading ? (
              <p className="card__empty">
                {hasFilters
                  ? "No events match these filters."
                  : "No audit events recorded for this workspace yet."}
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Actor</th>
                      <th>Run</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <EventRow key={event.id} event={event} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(isLoading || nextCursor) && (
              <div className="pager">
                {isLoading ? (
                  <>
                    <span className="spinner spinner--sm" aria-hidden="true" />
                    Loading…
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => nextCursor && loadPage(nextCursor)}
                  >
                    Load more
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function EventRow({ event }: { event: AuditEvent }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasMetadata = Object.keys(event.metadata).length > 0;

  return (
    <tr>
      <td className="data-table__mono">{formatTimestamp(event.createdAt)}</td>
      <td>
        <span className={`badge ${badgeFor(event.eventType)}`}>{event.eventType}</span>
      </td>
      <td className="data-table__mono">{shortId(event.actorId)}</td>
      <td className="data-table__mono">{shortId(event.runId)}</td>
      <td>
        {hasMetadata ? (
          <>
            <button
              type="button"
              className="event-row__toggle"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
            >
              <Icon name={expanded ? "chevron-up" : "chevron-down"} size={11} />
              {expanded ? "Hide" : "Show"} metadata
            </button>
            {expanded && <pre className="json-detail selectable">{JSON.stringify(event.metadata, null, 2)}</pre>}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

/** Security-relevant events are coloured; routine operations stay neutral. */
function badgeFor(eventType: string): string {
  if (/FAILED|BLOCKED|DISABLED|DELETED|REJECTED/.test(eventType)) return "badge--danger";
  if (/APPROVAL|PROBE|CANCELLED/.test(eventType)) return "badge--warning";
  if (/COMPLETED|SUCCEEDED|CREATED|ADDED/.test(eventType)) return "badge--success";
  return "badge--neutral";
}

/** Ids are 36 characters and the table has five columns; the prefix is enough
 *  to correlate rows, and the full value is in the exported record. */
function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  return `${at.toLocaleDateString(undefined, { month: "short", day: "2-digit" })} ${at.toLocaleTimeString(undefined, { hour12: false })}`;
}

/** A `date` input yields `YYYY-MM-DD`; the API wants an instant. */
function toIsoStart(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

function toIsoEnd(date: string): string {
  return new Date(`${date}T23:59:59.999`).toISOString();
}
