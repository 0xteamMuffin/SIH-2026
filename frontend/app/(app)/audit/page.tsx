"use client";

import { Fragment, useEffect, useState } from "react";
import { api, type Workspace, type AuditEvent } from "../../../lib/api";

export default function AuditPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.getWorkspaces()
      .then((d) => { setWorkspaces(d.workspaces); if (d.workspaces.length) setSelectedWs(d.workspaces[0].id); })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load workspaces"))
      .finally(() => setLoading(false));
  }, []);

  function refresh() {
    if (!selectedWs) return;
    setError("");
    api.getAuditEvents(selectedWs, eventTypeFilter.trim() || undefined).then((d) => setEvents(d.auditEvents)).catch((err) => setError(err instanceof Error ? err.message : "Failed to load audit events"));
  }

  useEffect(() => { refresh(); }, [selectedWs]);

  return (
    <div className="stub-page" style={{ padding: 32, maxWidth: 1100 }}>
      <h1>Audit Log</h1>
      <p className="text-muted" style={{ marginBottom: 20 }}>Every recorded action for a workspace — logins, runs, uploads, approvals, deletions.</p>

      <div className="row-gap" style={{ marginBottom: 16 }}>
        <select value={selectedWs} onChange={(e) => setSelectedWs(e.target.value)} className="field-input" style={{ width: 260 }}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <input
          value={eventTypeFilter}
          onChange={(e) => setEventTypeFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && refresh()}
          placeholder="Filter by event type (e.g. LOGIN_SUCCEEDED)"
          className="field-input"
          style={{ width: 280 }}
        />
        <button onClick={refresh} className="btn-ghost">Filter</button>
        <button onClick={() => api.exportAuditEvents(selectedWs, "json").catch((err) => setError(err instanceof Error ? err.message : "Export failed (requires workspace admin)"))} className="btn-ghost">Export JSON</button>
      </div>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-muted">No audit events match this filter.</p>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                {["Event", "Actor", "Run", "When", ""].map((h) => (
                  <th key={h} style={{ padding: "10px 14px", color: "var(--ink-3)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <Fragment key={e.id}>
                  <tr style={{ borderBottom: expanded === e.id ? "none" : "1px solid var(--line)" }}>
                    <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 12, color: "var(--ink)" }}>{e.eventType}</td>
                    <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 11, color: "var(--ink-3)" }}>{e.actorId ? `${e.actorId.slice(0, 8)}…` : "—"}</td>
                    <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 11, color: "var(--ink-3)" }}>{e.runId ? `${e.runId.slice(0, 8)}…` : "—"}</td>
                    <td style={{ padding: "10px 14px", color: "var(--ink-3)" }}>{new Date(e.createdAt).toLocaleString()}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <button onClick={() => setExpanded(expanded === e.id ? null : e.id)} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 11 }}>{expanded === e.id ? "Hide" : "Details"}</button>
                    </td>
                  </tr>
                  {expanded === e.id && (
                    <tr style={{ borderBottom: "1px solid var(--line)" }}>
                      <td colSpan={5} style={{ padding: "0 14px 12px" }}>
                        <pre style={{ fontSize: 11, background: "rgba(0,0,0,0.3)", padding: 12, borderRadius: 8, border: "1px solid var(--line)", overflowX: "auto", color: "var(--ink-2)" }}>{JSON.stringify(e.metadata, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
