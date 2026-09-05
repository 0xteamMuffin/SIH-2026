import { useEffect, useMemo, useState } from "react";

import type { PreviewCapabilities, RunTrace } from "@shared/types.js";

import { BrowserPanel } from "./components/BrowserPanel.js";
import { ChatSidebar } from "./components/ChatSidebar.js";
import { ChatThread } from "./components/ChatThread.js";
import { Composer } from "./components/Composer.js";
import { SignIn } from "./components/SignIn.js";
import { TracePanel } from "./components/trace/TracePanel.js";
import { useBrowserPane } from "./hooks/useBrowserPane.js";
import { useChats } from "./hooks/useChats.js";
import { useSession } from "./hooks/useSession.js";

export function App(): React.JSX.Element {
  const chats = useChats();
  const pane = useBrowserPane();
  const capabilities = usePreviewCapabilities();
  const { session, isReady, connect, disconnect, selectWorkspace } = useSession();
  const [trace, setTrace] = useState<RunTrace | null>(null);
  // Remembers a run the user hid, so it is not reopened on the next poll.
  const [hiddenRunId, setHiddenRunId] = useState<string | null>(null);

  const latestTrace = useMemo(() => {
    const messages = chats.activeChat?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index]?.trace;
      if (candidate) return candidate;
    }
    return null;
  }, [chats.activeChat]);

  // The trace opens on its own for a new turn and follows the run live. Asking
  // the user to go looking for it defeats the point of showing the work.
  useEffect(() => {
    if (!latestTrace) return;
    setTrace((current) => {
      // Same run: keep the panel in step with the poll, including when the
      // user is deliberately looking at it.
      if (current?.runId === latestTrace.runId) return latestTrace;
      // The turn starts on a provisional id and adopts the real one once the
      // backend creates the run; following that swap keeps the panel from
      // closing and reopening mid-turn.
      if (current?.runId.startsWith("pending-")) return latestTrace;
      // A run the user hid stays hidden, and the browser is never displaced.
      if (latestTrace.runId === hiddenRunId || pane.isOpen) return current;
      return latestTrace;
    });
  }, [latestTrace, hiddenRunId, pane.isOpen]);

  // The browser is a native view painted over the UI, so it and the trace
  // cannot share the right column. Opening one closes the other.
  function showTrace(next: RunTrace): void {
    if (pane.isOpen) pane.close();
    if (trace?.runId === next.runId) {
      hideTrace();
      return;
    }
    setHiddenRunId(null);
    setTrace(next);
  }

  function hideTrace(): void {
    if (trace) setHiddenRunId(trace.runId);
    setTrace(null);
  }

  function openUrl(url: string): void {
    setTrace(null);
    pane.open(url);
  }

  const rightPanelOpen = pane.isOpen || trace !== null;

  // Nothing in the workbench works without the backend — every answer comes
  // from it — so the shell is gated rather than showing an inert UI.
  if (!isReady) return <div className="thread thread--empty" />;
  if (session.status !== "connected") return <SignIn session={session} onConnect={connect} />;

  return (
    <div className={`app ${rightPanelOpen ? "app--with-panel" : ""}`}>
      <ChatSidebar
        chats={chats.chats}
        activeChatId={chats.activeChat?.id ?? null}
        onSelect={chats.selectChat}
        onCreate={chats.newChat}
        onDelete={chats.deleteChat}
        session={session}
        onSelectWorkspace={selectWorkspace}
        onDisconnect={disconnect}
      />

      <main className="main">
        {chats.error && (
          <div className="banner" role="alert">
            <span>{chats.error}</span>
            <button type="button" onClick={chats.dismissError} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {chats.isLoading ? (
          <div className="thread thread--empty">
            <p className="muted">Loading…</p>
          </div>
        ) : chats.activeChat ? (
          <ChatThread
            chat={chats.activeChat}
            capabilities={capabilities}
            onOpenUrl={openUrl}
            onShowTrace={showTrace}
            activeTraceRunId={trace?.runId ?? null}
          />
        ) : (
          <div className="thread thread--empty">
            <p className="muted">No conversation selected.</p>
          </div>
        )}

        <Composer
          disabled={!chats.activeChat}
          isStreaming={chats.isStreaming}
          onSubmit={chats.send}
          onCancel={chats.cancel}
          onOpenBrowser={openUrl}
        />
      </main>

      {pane.isOpen && <BrowserPanel pane={pane} />}
      {!pane.isOpen && trace && <TracePanel trace={trace} onClose={hideTrace} />}
    </div>
  );
}

/**
 * Loads the document families this build can render. Fetched once at startup;
 * a failure degrades to "nothing supported" rather than blocking the UI.
 */
function usePreviewCapabilities(): PreviewCapabilities | null {
  const [capabilities, setCapabilities] = useState<PreviewCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;

    window.workbench.preview
      .capabilities()
      .then((result) => {
        if (!cancelled) setCapabilities(result);
      })
      .catch((error: unknown) => {
        console.error("[app] could not read preview capabilities", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return capabilities;
}
