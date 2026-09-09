import { Icon, type IconName } from "./ui/Icon.js";

/** The window's top-level modes. */
export type WorkbenchView = "workbench" | "sovereignty" | "audit" | "admin";

interface RailItem {
  view: WorkbenchView;
  icon: IconName;
  label: string;
}

const ITEMS: readonly RailItem[] = [
  { view: "workbench", icon: "message", label: "Workbench" },
  { view: "sovereignty", icon: "shield", label: "Sovereignty" },
  { view: "audit", icon: "activity", label: "Audit log" },
  { view: "admin", icon: "sliders", label: "Administration" },
];

export interface NavRailProps {
  active: WorkbenchView;
  onSelect: (view: WorkbenchView) => void;
  /**
   * Flags the sovereignty item. Set when calls to an off-premise destination
   * have been recorded — the one condition that should pull someone's
   * attention to that view without their asking.
   */
  egressDetected: boolean;
}

export function NavRail({ active, onSelect, egressDetected }: NavRailProps): React.JSX.Element {
  return (
    <nav className="nav-rail" aria-label="Views">
      {ITEMS.map((item) => (
        <button
          key={item.view}
          type="button"
          className={`nav-rail__item ${active === item.view ? "nav-rail__item--active" : ""}`}
          onClick={() => onSelect(item.view)}
          aria-current={active === item.view}
          aria-label={item.label}
          data-tooltip={item.label}
        >
          <Icon name={item.icon} size={17} strokeWidth={1.7} />
          {item.view === "sovereignty" && egressDetected && (
            <span className="nav-rail__flag" aria-hidden="true" />
          )}
        </button>
      ))}
    </nav>
  );
}

export const VIEW_LABELS: Record<WorkbenchView, string> = {
  workbench: "Workbench",
  sovereignty: "Sovereignty",
  audit: "Audit log",
  admin: "Administration",
};
