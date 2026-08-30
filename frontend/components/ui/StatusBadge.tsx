export type RunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

const CONFIG: Record<RunStatus, { label: string; dot: string; badge: string }> = {
  PENDING:   { label: "Pending",   dot: "#fbbf24", badge: "status-pending"   },
  RUNNING:   { label: "Running",   dot: "#a5b4fc", badge: "status-running"   },
  COMPLETED: { label: "Completed", dot: "var(--green)", badge: "status-completed" },
  FAILED:    { label: "Failed",    dot: "var(--red)",   badge: "status-failed"    },
  CANCELLED: { label: "Cancelled", dot: "var(--ink-3)", badge: "status-cancelled" },
};

export default function StatusBadge({ status }: { status: RunStatus }) {
  const cfg = CONFIG[status] ?? CONFIG.PENDING;
  return (
    <span className={`status ${cfg.badge}`}>
      <span
        style={{
          width: 6, height: 6, borderRadius: "50%",
          background: cfg.dot,
          display: "inline-block",
          flexShrink: 0,
          ...(status === "RUNNING" ? { animation: "glow-pulse 2s ease-in-out infinite" } : {}),
        }}
      />
      {cfg.label}
    </span>
  );
}
