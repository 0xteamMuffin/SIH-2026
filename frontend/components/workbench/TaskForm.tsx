"use client";

import type { FormEvent } from "react";

interface Props {
  task: string;
  file: File | null;
  loading: boolean;
  hasWorkspace: boolean;
  error: string;
  isRunning: boolean;
  onTask: (v: string) => void;
  onFile: (f: File | null) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}

export default function TaskForm({
  task, file, loading, hasWorkspace, error,
  isRunning, onTask, onFile, onSubmit, onCancel,
}: Props) {
  return (
    <section className="card">
      <p className="card-title">New Run</p>

      <form id="task-form" onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Task textarea */}
        <div
          style={{
            background: "var(--field)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            transition: "border-color 150ms, box-shadow 150ms",
          }}
          onFocus={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = "rgba(129,140,248,0.4)";
            (e.currentTarget as HTMLElement).style.boxShadow = "0 0 0 3px rgba(129,140,248,0.08)";
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              (e.currentTarget as HTMLElement).style.borderColor = "var(--line)";
              (e.currentTarget as HTMLElement).style.boxShadow = "none";
            }
          }}
        >
          <textarea
            id="task-input"
            value={task}
            onChange={(e) => onTask(e.target.value)}
            placeholder="Describe the task for the agent…"
            rows={4}
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              resize: "vertical",
              color: "var(--ink)",
              fontSize: 13.5,
              lineHeight: 1.65,
              width: "100%",
            }}
          />

          {/* Bottom row: file attach + send */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <label
              htmlFor="task-file"
              style={{
                display: "flex", alignItems: "center", gap: 6,
                fontSize: 12.5, color: "var(--ink-3)", cursor: "pointer",
                padding: "4px 8px", borderRadius: 6,
                border: "1px solid transparent",
                transition: "background 120ms, border-color 120ms, color 120ms",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "var(--hover)";
                (e.currentTarget as HTMLElement).style.color = "var(--ink-2)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.color = "var(--ink-3)";
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6A4 4 0 0 1 18 9l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />
              </svg>
              {file ? (
                <span style={{ color: "var(--accent)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file.name}
                </span>
              ) : (
                "Attach file"
              )}
              <input
                id="task-file"
                type="file"
                style={{ display: "none" }}
                onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              />
            </label>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {isRunning && (
                <button
                  id="task-cancel"
                  type="button"
                  className="btn-danger"
                  onClick={onCancel}
                >
                  Cancel
                </button>
              )}
              <button
                id="task-submit"
                type="submit"
                disabled={loading || !hasWorkspace}
                style={{
                  width: 32, height: 32,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  borderRadius: 8,
                  background: loading || !hasWorkspace
                    ? "var(--line-strong)"
                    : "linear-gradient(135deg, #818cf8 0%, #6366f1 100%)",
                  color: loading || !hasWorkspace ? "var(--ink-3)" : "#fff",
                  border: "none",
                  cursor: loading || !hasWorkspace ? "not-allowed" : "pointer",
                  transition: "opacity 150ms, transform 100ms",
                  boxShadow: loading || !hasWorkspace ? "none" : "0 2px 8px rgba(99,102,241,.4)",
                  flexShrink: 0,
                }}
              >
                {loading ? (
                  <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(255,255,255,.3)", borderTopColor: "white", animation: "spin 700ms linear infinite", display: "block" }} />
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <p className="error">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
            </svg>
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
