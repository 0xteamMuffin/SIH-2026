import { useEffect, useState } from "react";

import type { PreviewCapabilities } from "@shared/types.js";

import { BrowserPanel } from "./components/BrowserPanel.js";
import { ChatSidebar } from "./components/ChatSidebar.js";
import { ChatThread } from "./components/ChatThread.js";
import { Composer } from "./components/Composer.js";
import { useBrowserPane } from "./hooks/useBrowserPane.js";
import { useChats } from "./hooks/useChats.js";

export function App(): React.JSX.Element {
  const chats = useChats();
  const pane = useBrowserPane();
  const capabilities = usePreviewCapabilities();

  return (
    <div className={`app ${pane.isOpen ? "app--with-browser" : ""}`}>
      <ChatSidebar
        chats={chats.chats}
        activeChatId={chats.activeChat?.id ?? null}
        onSelect={chats.selectChat}
        onCreate={chats.newChat}
        onDelete={chats.deleteChat}
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
            onOpenUrl={pane.open}
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
        />
      </main>

      {pane.isOpen && <BrowserPanel pane={pane} />}
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
