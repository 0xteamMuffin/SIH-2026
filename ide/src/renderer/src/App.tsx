import { useCallback, useEffect, useMemo, useState } from "react";

import type { DataClassification, PreviewCapabilities, RunTrace } from "@shared/types.js";

import { BrowserPanel } from "./components/BrowserPanel.js";
import { ChatSidebar } from "./components/ChatSidebar.js";
import { ChatThread } from "./components/ChatThread.js";
import { CommandPalette, type Command } from "./components/CommandPalette.js";
import { Composer } from "./components/Composer.js";
import { SignIn } from "./components/SignIn.js";
import { StatusBar } from "./components/StatusBar.js";
import { TitleBar } from "./components/TitleBar.js";
import { Icon } from "./components/ui/Icon.js";
import { IconButton } from "./components/ui/IconButton.js";
import type { PanelTab } from "./components/ui/PanelTabs.js";
import { NUDGE_PX, Resizer } from "./components/ui/Resizer.js";
import { TracePanel } from "./components/trace/TracePanel.js";
import { useBrowserPane } from "./hooks/useBrowserPane.js";
import { useChats } from "./hooks/useChats.js";
import { usePaneLayout } from "./hooks/usePaneLayout.js";
import { useSession } from "./hooks/useSession.js";
import { useTheme } from "./theme/ThemeProvider.js";

/** Landing page when the browser pane is opened with no destination. */
const BLANK_PAGE = "https://example.com";

/** macOS renders ⌘ in shortcut hints; everything else says Ctrl. */
const IS_MAC = navigator.userAgent.includes("Mac");
const MODIFIER_LABEL = IS_MAC ? "⌘" : "Ctrl";

export function App(): React.JSX.Element {
  const chats = useChats();
  const pane = useBrowserPane();
  const capabilities = usePreviewCapabilities();
  const layout = usePaneLayout();
  const { session, isReady, connect, disconnect, selectWorkspace } = useSession();
  const { setTheme, toggleTheme, resolved } = useTheme();

  const [trace, setTrace] = useState<RunTrace | null>(null);
  // Remembers a run the user hid, so it is not reopened on the next poll.
  const [hiddenRunId, setHiddenRunId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The composer's text lives here so the empty-thread starter cards can
  // write into it.
  const [draft, setDraft] = useState("");
  // Classification is lifted out of the composer so the status bar can show
  // the routing policy the next message will be sent under.
  const [classification, setClassification] = useState<DataClassification>("SYNTHETIC");

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

  const hideTrace = useCallback(() => {
    setTrace((current) => {
      if (current) setHiddenRunId(current.runId);
      return null;
    });
  }, []);

  // The browser is a native view painted over the UI, so it and the trace
  // cannot share the right column. Opening one closes the other.
  const showTrace = useCallback(
    (next: RunTrace) => {
      if (pane.isOpen) pane.close();
      setTrace((current) => {
        if (current?.runId === next.runId) {
          setHiddenRunId(next.runId);
          return null;
        }
        setHiddenRunId(null);
        return next;
      });
    },
    [pane],
  );

  const openUrl = useCallback(
    (url: string) => {
      setTrace(null);
      pane.open(url);
    },
    [pane],
  );

  const closePanel = useCallback(() => {
    if (pane.isOpen) pane.close();
    else hideTrace();
  }, [pane, hideTrace]);

  const selectPanelTab = useCallback(
    (tab: PanelTab) => {
      if (tab === "browser") {
        openUrl(pane.state.url ?? BLANK_PAGE);
        return;
      }
      if (latestTrace) {
        if (pane.isOpen) pane.close();
        setHiddenRunId(null);
        setTrace(latestTrace);
      }
    },
    [openUrl, pane, latestTrace],
  );

  const toggleTracePanel = useCallback(() => {
    if (trace) hideTrace();
    else if (latestTrace) selectPanelTab("trace");
  }, [trace, hideTrace, latestTrace, selectPanelTab]);

  const toggleBrowserPanel = useCallback(() => {
    if (pane.isOpen) pane.close();
    else selectPanelTab("browser");
  }, [pane, selectPanelTab]);

  // Global shortcuts. Registered on the window rather than on a focused
  // element so they work no matter where the caret is — including inside the
  // composer, which is where it usually is.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const accel = IS_MAC ? event.metaKey : event.ctrlKey;
      if (!accel || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (key === "b") {
        event.preventDefault();
        setSidebarVisible((visible) => !visible);
        return;
      }
      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        chats.newChat();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chats]);

  const commands = useMemo(
    (): Command[] => [
      ...chats.chats.slice(0, 40).map(
        (chat): Command => ({
          id: `chat:${chat.id}`,
          group: "Conversations",
          label: chat.title,
          icon: "message",
          keywords: "open conversation chat",
          run: () => chats.selectChat(chat.id),
        }),
      ),
      {
        id: "action:new",
        group: "Actions",
        label: "New conversation",
        icon: "plus",
        hint: `${MODIFIER_LABEL} N`,
        run: chats.newChat,
      },
      {
        id: "action:sidebar",
        group: "Actions",
        label: sidebarVisible ? "Hide conversation list" : "Show conversation list",
        icon: "panel-left",
        hint: `${MODIFIER_LABEL} B`,
        keywords: "sidebar toggle",
        run: () => setSidebarVisible((visible) => !visible),
      },
      {
        id: "action:trace",
        group: "Actions",
        label: "Show run trace",
        icon: "network",
        keywords: "graph audit steps",
        run: () => selectPanelTab("trace"),
      },
      {
        id: "action:browser",
        group: "Actions",
        label: "Open browser pane",
        icon: "globe",
        keywords: "web page url",
        run: () => selectPanelTab("browser"),
      },
      {
        id: "theme:toggle",
        group: "Appearance",
        label: `Switch to ${resolved === "dark" ? "light" : "dark"} theme`,
        icon: resolved === "dark" ? "sun" : "moon",
        keywords: "theme appearance colour color",
        run: toggleTheme,
      },
      {
        id: "theme:system",
        group: "Appearance",
        label: "Match system appearance",
        icon: "monitor",
        keywords: "theme auto",
        run: () => setTheme("system"),
      },
      {
        id: "session:signout",
        group: "Session",
        label: "Sign out",
        icon: "logout",
        keywords: "disconnect leave",
        run: disconnect,
      },
    ],
    [chats, sidebarVisible, resolved, selectPanelTab, toggleTheme, setTheme, disconnect],
  );

  // Nothing in the workbench works without the backend — every answer comes
  // from it — so the shell is gated rather than showing an inert UI.
  if (!isReady) {
    return (
      <div className="boot">
        <span className="spinner" aria-hidden="true" />
        Starting the workbench…
      </div>
    );
  }

  if (session.status !== "connected") {
    return <SignIn session={session} onConnect={connect} />;
  }

  const panelOpen = pane.isOpen || trace !== null;

  // The grid's columns are the resizable layout. A collapsed sidebar is a
  // zero-width column rather than an unmounted one, so its contents do not
  // reflow on every toggle.
  const bodyColumns = [
    sidebarVisible ? `${layout.sidebarWidth}px` : "0px",
    "minmax(0, 1fr)",
    panelOpen ? `${layout.panelWidth}px` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`app ${IS_MAC ? "app--mac" : ""} ${sidebarVisible ? "" : "app--sidebar-hidden"}`}
    >
      <TitleBar
        session={session}
        onSelectWorkspace={selectWorkspace}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
        tracePanelOpen={trace !== null}
        onToggleTracePanel={toggleTracePanel}
        browserPanelOpen={pane.isOpen}
        onToggleBrowserPanel={toggleBrowserPanel}
        onOpenPalette={() => setPaletteOpen(true)}
        modifierLabel={MODIFIER_LABEL}
      />

      <div className="app__body" style={{ gridTemplateColumns: bodyColumns }}>
        <ChatSidebar
          chats={chats.chats}
          activeChatId={chats.activeChat?.id ?? null}
          onSelect={chats.selectChat}
          onCreate={chats.newChat}
          onDelete={chats.deleteChat}
          onRename={chats.renameChat}
          session={session}
          onDisconnect={disconnect}
          resizeHandle={
            <Resizer
              label="Resize the conversation list"
              className="resizer--sidebar"
              onMove={layout.resizeSidebar}
              onNudge={(direction) => layout.nudgeSidebar(direction * NUDGE_PX)}
              onReset={layout.resetSidebar}
            />
          }
        />

        <main className="main">
          <header className="main__head">
            <div className="main__title-group">
              <h1 className="main__title">{chats.activeChat?.title ?? "Workbench"}</h1>
              {chats.activeChat && (
                <span className="main__meta">
                  {chats.activeChat.messages.length}{" "}
                  {chats.activeChat.messages.length === 1 ? "message" : "messages"}
                </span>
              )}
            </div>

            <div className="main__actions">
              {!sidebarVisible && (
                <IconButton
                  icon="plus"
                  label="New conversation"
                  size="sm"
                  onClick={chats.newChat}
                  tooltipAlign="end"
                />
              )}
            </div>
          </header>

          {chats.error && (
            <div className="alert" role="alert">
              <Icon name="alert-circle" size={15} />
              <span className="alert__text">{chats.error}</span>
              <IconButton
                icon="close"
                label="Dismiss"
                size="sm"
                hideTooltip
                onClick={chats.dismissError}
              />
            </div>
          )}

          {chats.isLoading ? (
            <div className="center-state">
              <span className="spinner" aria-hidden="true" />
              Loading conversations…
            </div>
          ) : chats.activeChat ? (
            <ChatThread
              chat={chats.activeChat}
              capabilities={capabilities}
              onOpenUrl={openUrl}
              onShowTrace={showTrace}
              activeTraceRunId={trace?.runId ?? null}
              onSuggest={setDraft}
            />
          ) : (
            <div className="center-state">No conversation selected.</div>
          )}

          <Composer
            value={draft}
            onValueChange={setDraft}
            disabled={!chats.activeChat}
            isStreaming={chats.isStreaming}
            classification={classification}
            onClassificationChange={setClassification}
            onSubmit={chats.send}
            onCancel={chats.cancel}
            onOpenBrowser={openUrl}
          />

          {panelOpen && (
            <Resizer
              label="Resize the inspector panel"
              className="resizer--panel"
              onMove={layout.resizePanel}
              // Nudging right shrinks the panel, so the sign is flipped
              // relative to the sidebar's handle.
              onNudge={(direction) => layout.nudgePanel(-direction * NUDGE_PX)}
              onReset={layout.resetPanel}
              // The native browser view would swallow the pointer mid-drag;
              // parking it hands those events back to the DOM.
              onStart={() => pane.setTracking(false)}
              onEnd={() => pane.setTracking(true)}
            />
          )}
        </main>

        {pane.isOpen && (
          <BrowserPanel
            pane={pane}
            onSelectTab={selectPanelTab}
            traceEnabled={latestTrace !== null}
            onClose={closePanel}
          />
        )}
        {!pane.isOpen && trace && (
          <TracePanel trace={trace} onClose={closePanel} onSelectTab={selectPanelTab} />
        )}
      </div>

      <StatusBar
        session={session}
        isStreaming={chats.isStreaming}
        classification={classification}
        chatCount={chats.chats.length}
      />

      {paletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
          modifierLabel={MODIFIER_LABEL}
        />
      )}
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
