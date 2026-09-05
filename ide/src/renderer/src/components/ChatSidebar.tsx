import type { ChatId, ChatSummary, SessionState } from "@shared/types.js";

export interface ChatSidebarProps {
  chats: ChatSummary[];
  activeChatId: ChatId | null;
  onSelect: (chatId: ChatId) => void;
  onCreate: () => void;
  onDelete: (chatId: ChatId) => void;
  session: SessionState;
  onSelectWorkspace: (workspaceId: string) => void;
  onDisconnect: () => void;
}

export function ChatSidebar({
  chats,
  activeChatId,
  onSelect,
  onCreate,
  onDelete,
  session,
  onSelectWorkspace,
  onDisconnect,
}: ChatSidebarProps): React.JSX.Element {
  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar__head">
        <span className="sidebar__brand">Workbench</span>
        <button type="button" className="sidebar__new" onClick={onCreate} title="New chat">
          + New
        </button>
      </div>

      <ul className="sidebar__list">
        {chats.map((chat) => (
          <li key={chat.id} className="sidebar__item">
            <button
              type="button"
              className={`sidebar__link ${chat.id === activeChatId ? "sidebar__link--active" : ""}`}
              onClick={() => onSelect(chat.id)}
              aria-current={chat.id === activeChatId}
            >
              <span className="sidebar__title">{chat.title}</span>
              <span className="sidebar__time">{formatRelativeTime(chat.updatedAt)}</span>
            </button>

            <button
              type="button"
              className="sidebar__delete"
              // The row itself is a button, so the click must not also select.
              onClick={(event) => {
                event.stopPropagation();
                onDelete(chat.id);
              }}
              title={`Delete "${chat.title}"`}
              aria-label={`Delete "${chat.title}"`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <footer className="sidebar__foot">
        {session.workspaces.length > 1 ? (
          <select
            className="sidebar__workspace"
            value={session.workspace?.id ?? ""}
            onChange={(event) => onSelectWorkspace(event.target.value)}
            aria-label="Workspace"
          >
            {session.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="sidebar__workspace-name">{session.workspace?.name ?? "No workspace"}</span>
        )}

        <div className="sidebar__session">
          <span className="sidebar__account" title={session.baseUrl}>
            <span className="sidebar__dot" aria-hidden="true" />
            {session.user?.email ?? "Connected"}
          </span>
          <button type="button" className="sidebar__signout" onClick={onDisconnect}>
            Sign out
          </button>
        </div>
      </footer>
    </nav>
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatRelativeTime(isoTimestamp: string): string {
  const elapsed = Date.now() - new Date(isoTimestamp).getTime();

  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;

  return new Date(isoTimestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
