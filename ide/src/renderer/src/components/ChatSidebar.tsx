import { useMemo, useState, type KeyboardEvent } from "react";

import type { ChatId, ChatSummary, SessionState } from "@shared/types.js";

import { Avatar } from "./ui/Avatar.js";
import { Icon } from "./ui/Icon.js";
import { IconButton } from "./ui/IconButton.js";
import { SearchField } from "./ui/SearchField.js";

export interface ChatSidebarProps {
  chats: ChatSummary[];
  activeChatId: ChatId | null;
  onSelect: (chatId: ChatId) => void;
  onCreate: () => void;
  onDelete: (chatId: ChatId) => void;
  onRename: (chatId: ChatId, title: string) => void;
  session: SessionState;
  onDisconnect: () => void;
  /**
   * The divider on the sidebar's trailing edge. Passed in rather than built
   * here because the width it drags belongs to the shell's layout, not to the
   * conversation list — but it has to be positioned against this element.
   */
  resizeHandle?: React.ReactNode;
}

export function ChatSidebar({
  chats,
  activeChatId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  session,
  onDisconnect,
  resizeHandle,
}: ChatSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<ChatId | null>(null);
  // Deletion is irreversible, so the trash icon arms a confirmation on the
  // row rather than acting on the first click.
  const [confirmingId, setConfirmingId] = useState<ChatId | null>(null);

  const groups = useMemo(() => groupByAge(filterChats(chats, query)), [chats, query]);

  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar__head">
        <button type="button" className="btn btn--primary btn--block" onClick={onCreate}>
          <Icon name="plus" size={14} strokeWidth={2} />
          New conversation
        </button>
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search conversations"
          placeholder="Search conversations"
        />
      </div>

      <div className="sidebar__scroll">
        {groups.length === 0 ? (
          <p className="chat-empty">
            {query ? `No conversations match “${query}”.` : "No conversations yet."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="chat-group">
              <h2 className="chat-group__label eyebrow">{group.label}</h2>
              <ul className="chat-list">
                {group.chats.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    isActive={chat.id === activeChatId}
                    isRenaming={renamingId === chat.id}
                    isConfirmingDelete={confirmingId === chat.id}
                    onSelect={() => onSelect(chat.id)}
                    onStartRename={() => {
                      setConfirmingId(null);
                      setRenamingId(chat.id);
                    }}
                    onRename={(title) => {
                      setRenamingId(null);
                      const trimmed = title.trim();
                      if (trimmed && trimmed !== chat.title) onRename(chat.id, trimmed);
                    }}
                    onCancelRename={() => setRenamingId(null)}
                    onRequestDelete={() => {
                      setRenamingId(null);
                      setConfirmingId(chat.id);
                    }}
                    onCancelDelete={() => setConfirmingId(null)}
                    onConfirmDelete={() => {
                      setConfirmingId(null);
                      onDelete(chat.id);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <footer className="sidebar__foot">
        <div className="account">
          <Avatar name={session.user?.email ?? "workbench"} />
          <span className="account__text">
            <span className="account__name">{session.user?.email ?? "Connected"}</span>
            <span className="account__meta">{session.user?.role ?? "Signed in"}</span>
          </span>
          <span className="account__spacer" />
          <IconButton
            icon="logout"
            label="Sign out"
            size="sm"
            onClick={onDisconnect}
            tooltipSide="top"
            tooltipAlign="end"
          />
        </div>
      </footer>

      {resizeHandle}
    </nav>
  );
}

interface ChatRowProps {
  chat: ChatSummary;
  isActive: boolean;
  isRenaming: boolean;
  isConfirmingDelete: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onRename: (title: string) => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

function ChatRow({
  chat,
  isActive,
  isRenaming,
  isConfirmingDelete,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: ChatRowProps): React.JSX.Element {
  if (isRenaming) {
    return (
      <li className="chat-row">
        <input
          className="chat-row__rename"
          defaultValue={chat.title}
          aria-label="Conversation title"
          autoFocus
          // Committing on blur means clicking anywhere else saves rather than
          // silently discarding what was typed.
          onBlur={(event) => onRename(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") onRename(event.currentTarget.value);
            if (event.key === "Escape") onCancelRename();
          }}
          onFocus={(event) => event.target.select()}
        />
      </li>
    );
  }

  return (
    <li className={`chat-row ${isConfirmingDelete ? "chat-row--confirming" : ""}`}>
      <button
        type="button"
        className={`chat-row__link ${isActive ? "chat-row__link--active" : ""}`}
        onClick={onSelect}
        onDoubleClick={onStartRename}
        aria-current={isActive}
      >
        <Icon name="message" size={14} className="chat-row__icon" />
        <span className="chat-row__title">{chat.title}</span>
        {!isConfirmingDelete && (
          <span className="chat-row__time">{formatRelativeTime(chat.updatedAt)}</span>
        )}
      </button>

      <span className="chat-row__actions">
        {isConfirmingDelete ? (
          <span className="chat-row__confirm">
            <button type="button" className="btn btn--sm btn--danger" onClick={onConfirmDelete}>
              Delete
            </button>
            <IconButton icon="close" label="Keep conversation" size="sm" hideTooltip onClick={onCancelDelete} />
          </span>
        ) : (
          <>
            <IconButton
              icon="pencil"
              label={`Rename “${chat.title}”`}
              size="sm"
              hideTooltip
              onClick={onStartRename}
            />
            <IconButton
              icon="trash"
              label={`Delete “${chat.title}”`}
              size="sm"
              tone="danger"
              hideTooltip
              onClick={onRequestDelete}
            />
          </>
        )}
      </span>
    </li>
  );
}

function filterChats(chats: ChatSummary[], query: string): ChatSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return chats;
  return chats.filter((chat) => chat.title.toLowerCase().includes(needle));
}

interface ChatGroup {
  label: string;
  chats: ChatSummary[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Buckets conversations by age, the way a mail client does.
 *
 * A flat list of thirty timestamps gives no sense of "the one from this
 * morning" versus "the one from last month", which is how people actually
 * remember a conversation they want back.
 */
function groupByAge(chats: ChatSummary[]): ChatGroup[] {
  const now = Date.now();
  const buckets = new Map<string, ChatSummary[]>();

  for (const chat of chats) {
    const label = bucketFor(now - new Date(chat.updatedAt).getTime());
    const existing = buckets.get(label);
    if (existing) existing.push(chat);
    else buckets.set(label, [chat]);
  }

  // Insertion order follows the backend's newest-first list, so the buckets
  // already come out oldest-last without an explicit sort.
  return [...buckets].map(([label, grouped]) => ({ label, chats: grouped }));
}

function bucketFor(elapsed: number): string {
  if (elapsed < DAY) return "Today";
  if (elapsed < 2 * DAY) return "Yesterday";
  if (elapsed < 7 * DAY) return "Previous 7 days";
  if (elapsed < 30 * DAY) return "Previous 30 days";
  return "Older";
}

function formatRelativeTime(isoTimestamp: string): string {
  const elapsed = Date.now() - new Date(isoTimestamp).getTime();

  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;

  return new Date(isoTimestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
