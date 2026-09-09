import { useEffect, useState, type FormEvent } from "react";

import type { BrowserPaneController } from "../hooks/useBrowserPane.js";
import { Icon } from "./ui/Icon.js";
import { IconButton } from "./ui/IconButton.js";
import { PanelTabs, type PanelTab } from "./ui/PanelTabs.js";

export interface BrowserPanelProps {
  pane: BrowserPaneController;
  onSelectTab: (tab: PanelTab) => void;
  traceEnabled: boolean;
  onClose: () => void;
}

export function BrowserPanel({
  pane,
  onSelectTab,
  traceEnabled,
  onClose,
}: BrowserPanelProps): React.JSX.Element {
  const [addressValue, setAddressValue] = useState(pane.state.url ?? "");

  // Follow real navigations, but leave whatever the user is mid-way through
  // typing alone.
  useEffect(() => {
    if (pane.state.url) setAddressValue(pane.state.url);
  }, [pane.state.url]);

  function handleNavigate(event: FormEvent): void {
    event.preventDefault();
    const url = normaliseUrl(addressValue);
    if (url) pane.open(url);
  }

  return (
    <aside className="panel" aria-label="Embedded browser">
      <header className="panel__head">
        <PanelTabs active="browser" onSelect={onSelectTab} traceEnabled={traceEnabled} />
        <div className="panel__actions">
          <IconButton
            icon="external"
            label="Open in the system browser"
            size="sm"
            disabled={!pane.state.url}
            onClick={() => pane.state.url && pane.openExternal(pane.state.url)}
          />
          <IconButton
            icon="close"
            label="Close panel"
            size="sm"
            onClick={onClose}
            tooltipAlign="end"
          />
        </div>
      </header>

      <div className="panel__toolbar">
        <IconButton
          icon="arrow-left"
          label="Back"
          size="sm"
          disabled={!pane.state.canGoBack}
          onClick={pane.goBack}
        />
        <IconButton
          icon="arrow-right"
          label="Forward"
          size="sm"
          disabled={!pane.state.canGoForward}
          onClick={pane.goForward}
        />
        <IconButton icon="refresh" label="Reload" size="sm" onClick={pane.reload} />

        <form className="browser__address" onSubmit={handleNavigate}>
          <input
            className="browser__input"
            value={addressValue}
            onChange={(event) => setAddressValue(event.target.value)}
            placeholder="example.com"
            aria-label="Address"
            spellCheck={false}
          />
        </form>
      </div>

      {pane.state.isLoading && <div className="browser__progress" role="presentation" />}

      {pane.state.error && (
        <p className="panel__notice" role="alert">
          <Icon name="alert-circle" size={13} />
          {pane.state.error}
        </p>
      )}

      {/*
        The native WebContentsView is painted over this element by the main
        process. It stays empty on purpose — it exists only to reserve layout
        space and to be measured. Anything rendered inside would be hidden
        behind the native view.
      */}
      <div ref={pane.slotRef} className="browser__slot" />
    </aside>
  );
}

/**
 * Accepts what a user actually types. A bare host gets `https://`, since
 * defaulting to plaintext HTTP would be the wrong choice to make silently.
 */
function normaliseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
