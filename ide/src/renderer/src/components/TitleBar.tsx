import type { SessionState } from "@shared/types.js";

import { DropdownMenu } from "./ui/DropdownMenu.js";
import { Icon } from "./ui/Icon.js";
import { IconButton } from "./ui/IconButton.js";
import { ThemeToggle } from "./ui/ThemeToggle.js";

export interface TitleBarProps {
  session: SessionState;
  onSelectWorkspace: (workspaceId: string) => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  tracePanelOpen: boolean;
  onToggleTracePanel: () => void;
  browserPanelOpen: boolean;
  onToggleBrowserPanel: () => void;
  onOpenPalette: () => void;
  /** Rendered into the keyboard hints — ⌘ on macOS, Ctrl elsewhere. */
  modifierLabel: string;
}

/**
 * The window's top band: identity on the left, the command palette in the
 * middle, appearance and panel toggles on the right.
 *
 * It doubles as the window's drag handle (`-webkit-app-region: drag` in
 * shell.css), which is why every control inside it has to opt back out — a
 * button inside a drag region is otherwise unclickable.
 */
export function TitleBar({
  session,
  onSelectWorkspace,
  sidebarVisible,
  onToggleSidebar,
  tracePanelOpen,
  onToggleTracePanel,
  browserPanelOpen,
  onToggleBrowserPanel,
  onOpenPalette,
  modifierLabel,
}: TitleBarProps): React.JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar__group">
        <IconButton
          icon="panel-left"
          label={sidebarVisible ? "Hide conversations" : "Show conversations"}
          size="sm"
          active={sidebarVisible}
          onClick={onToggleSidebar}
        />

        <span className="divider" />

        <span className="brand">
          <span className="brand__mark">
            <Icon name="shield" size={13} strokeWidth={2} />
          </span>
          <span className="brand__name">Sovereign Workbench</span>
        </span>

        <WorkspaceSwitcher session={session} onSelectWorkspace={onSelectWorkspace} />
      </div>

      <div className="titlebar__group titlebar__group--center">
        <button type="button" className="command-trigger" onClick={onOpenPalette}>
          <Icon name="search" size={13} />
          <span className="command-trigger__label">Search and commands</span>
          <span className="kbd-group">
            <kbd className="kbd">{modifierLabel}</kbd>
            <kbd className="kbd">K</kbd>
          </span>
        </button>
      </div>

      <div className="titlebar__group titlebar__group--end">
        <ThemeToggle />
        <span className="divider" />
        <IconButton
          icon="network"
          label="Run trace"
          size="sm"
          active={tracePanelOpen}
          onClick={onToggleTracePanel}
        />
        <IconButton
          icon="globe"
          label="Browser pane"
          size="sm"
          active={browserPanelOpen}
          onClick={onToggleBrowserPanel}
          tooltipAlign="end"
        />
      </div>
    </header>
  );
}

/**
 * Workspace is a hard scope on the backend — a chat's turns belong to one —
 * so it sits in the title bar rather than buried in a settings screen. With a
 * single workspace there is nothing to switch, so it renders as a label.
 */
function WorkspaceSwitcher({
  session,
  onSelectWorkspace,
}: {
  session: SessionState;
  onSelectWorkspace: (workspaceId: string) => void;
}): React.JSX.Element {
  const name = session.workspace?.name ?? "No workspace";

  if (session.workspaces.length <= 1) {
    return (
      <span className="workspace workspace--static" data-tooltip={`Workspace: ${name}`}>
        <Icon name="building" size={13} className="workspace__icon" />
        <span className="workspace__name">{name}</span>
      </span>
    );
  }

  return (
    <DropdownMenu
      label="Switch workspace"
      header="Workspace"
      triggerClassName="workspace"
      trigger={
        <>
          <Icon name="building" size={13} className="workspace__icon" />
          <span className="workspace__name">{name}</span>
          <Icon name="chevron-down" size={12} className="workspace__icon" />
        </>
      }
      items={session.workspaces.map((workspace) => ({
        id: workspace.id,
        label: workspace.name,
        // The backend lists newest first; the creation date is what
        // distinguishes two workspaces that were named similarly.
        description: new Date(workspace.createdAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }),
        selected: workspace.id === session.workspace?.id,
        onSelect: () => onSelectWorkspace(workspace.id),
      }))}
    />
  );
}
