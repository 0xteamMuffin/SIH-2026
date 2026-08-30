"use client";

import type { Workspace } from "../../lib/api";

interface Props {
  workspaces: Workspace[];
  selected: string;
  loading: boolean;
  newName: string;
  onSelect: (id: string) => void;
  onNewName: (v: string) => void;
  onCreate: () => void;
  error?: string;
}

export default function WorkspacePanel({
  workspaces, selected, loading, newName,
  onSelect, onNewName, onCreate, error,
}: Props) {
  return (
    <aside className="ws-panel">
      <p className="ws-panel-title">Workspaces</p>

      {loading ? (
        <p className="text-muted px-2">Loading…</p>
      ) : workspaces.length === 0 ? (
        <p className="text-muted px-2">No workspaces yet.</p>
      ) : (
        <ul className="ws-list">
          {workspaces.map((ws) => (
            <li key={ws.id}>
              <button
                id={`ws-${ws.id}`}
                className={`ws-item${selected === ws.id ? " active" : ""}`}
                onClick={() => onSelect(ws.id)}
                title={ws.id}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
                <span className="ws-item-text">
                  {ws.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="error" style={{ padding: "0 6px" }}>{error}</p>}

      <div className="ws-create">
        <input
          id="ws-name-input"
          placeholder="New workspace…"
          value={newName}
          onChange={(e) => onNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onCreate()}
        />
        <button id="ws-create-btn" type="button" onClick={onCreate} title="Create workspace">
          +
        </button>
      </div>
    </aside>
  );
}
