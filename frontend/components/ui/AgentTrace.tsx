"use client";

import { useState } from "react";
import type { ToolCall } from "../../lib/api";

interface Props {
  toolCalls: ToolCall[];
  isRunning: boolean;
}

/** Visual tool-call trace inspired by ThinkingState's expandable design. */
export default function AgentTrace({ toolCalls, isRunning }: Props) {
  const [open, setOpen] = useState(true);
  const done = toolCalls.filter((t) => t.status !== "RUNNING").length;
  const header = isRunning
    ? "Running tools…"
    : toolCalls.length === 0
    ? "No tools used"
    : `Ran ${done} tool${done !== 1 ? "s" : ""}`;

  return (
    <div className="flex flex-col w-full">
      {/* header */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1
          transition-colors duration-100 hover:bg-hover-2"
      >
        <StarIcon working={isRunning} />
        <span
          className={`text-[13px] font-medium whitespace-nowrap ${isRunning ? "bg-clip-text text-transparent" : "text-ink-2"}`}
          style={
            isRunning
              ? {
                  backgroundImage:
                    "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
                  backgroundSize: "200% 100%",
                  animation: "shimmer-text 1.4s linear infinite",
                }
              : undefined
          }
        >
          {header}
        </span>
        <ChevronIcon open={open} />
      </button>

      {/* expandable rows */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-400"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span
              aria-hidden
              className="absolute left-[3px] w-px bg-line"
              style={{ top: -8, bottom: 4 }}
            />
            <div className="flex flex-col gap-1 py-1">
              {toolCalls.length === 0 && (
                <p className="text-[12px] text-ink-3 px-1.5 py-1">No steps yet.</p>
              )}
              {toolCalls.map((tc, i) => (
                <div
                  key={i}
                  className="flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5"
                  style={{ animation: `fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both` }}
                >
                  <StepIcon tc={tc} isLast={i === toolCalls.length - 1} running={isRunning} />
                  <span className="min-w-0 truncate text-[12.5px] font-medium text-ink font-mono">
                    {tc.toolName}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-3 ml-auto capitalize">
                    {tc.status.toLowerCase()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StarIcon({ working }: { working: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={working ? "var(--ink-2)" : "var(--ink-3)"}>
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="var(--ink-3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      className="transition-transform duration-300"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function StepIcon({ tc, isLast, running }: { tc: ToolCall; isLast: boolean; running: boolean }) {
  if (tc.status === "RUNNING" || (isLast && running && tc.status !== "COMPLETED" && tc.status !== "FAILED")) {
    return (
      <span
        className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
        style={{ animation: "spin 700ms linear infinite" }}
      />
    );
  }
  if (tc.status === "FAILED") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
