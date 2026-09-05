import { useEffect, useState, type FormEvent } from "react";

import type { BrowserPaneController } from "../hooks/useBrowserPane.js";

export function BrowserPanel({ pane }: { pane: BrowserPaneController }): React.JSX.Element {
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
    <aside className="browser" aria-label="Embedded browser">
      <div className="browser__toolbar">
        <button
          type="button"
          className="browser__nav"
          onClick={pane.goBack}
          disabled={!pane.state.canGoBack}
          aria-label="Back"
        >
          ‹
        </button>
        <button
          type="button"
          className="browser__nav"
          onClick={pane.goForward}
          disabled={!pane.state.canGoForward}
          aria-label="Forward"
        >
          ›
        </button>
        <button type="button" className="browser__nav" onClick={pane.reload} aria-label="Reload">
          ⟳
        </button>

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

        <button
          type="button"
          className="browser__nav"
          onClick={() => pane.state.url && pane.openExternal(pane.state.url)}
          disabled={!pane.state.url}
          title="Open in system browser"
          aria-label="Open in system browser"
        >
          ↗
        </button>
        <button type="button" className="browser__nav" onClick={pane.close} aria-label="Close browser">
          ×
        </button>
      </div>

      {pane.state.isLoading && <div className="browser__progress" role="presentation" />}

      {pane.state.error && <p className="browser__error">{pane.state.error}</p>}

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
