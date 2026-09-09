import { Icon } from "./Icon.js";

/** The two things the inspector can show. */
export type PanelTab = "trace" | "browser";

export interface PanelTabsProps {
  active: PanelTab;
  onSelect: (tab: PanelTab) => void;
  /** No trace exists until a turn has run, so the tab is disabled until then. */
  traceEnabled: boolean;
}

/**
 * Tab strip shared by the inspector's two occupants.
 *
 * They cannot be shown side by side: the browser is a native `WebContentsView`
 * painted over the window, so it would cover anything the DOM drew beside it.
 * One strip switching between them makes that constraint read as a design
 * rather than as two panels fighting over the same column.
 */
export function PanelTabs({ active, onSelect, traceEnabled }: PanelTabsProps): React.JSX.Element {
  return (
    <div className="panel__tabs" role="tablist" aria-label="Inspector">
      <button
        type="button"
        role="tab"
        aria-selected={active === "trace"}
        className={`panel__tab ${active === "trace" ? "panel__tab--active" : ""}`}
        onClick={() => onSelect("trace")}
        disabled={!traceEnabled}
      >
        <Icon name="network" size={13} />
        Run trace
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "browser"}
        className={`panel__tab ${active === "browser" ? "panel__tab--active" : ""}`}
        onClick={() => onSelect("browser")}
      >
        <Icon name="globe" size={13} />
        Browser
      </button>
    </div>
  );
}
