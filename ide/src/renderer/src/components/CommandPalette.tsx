import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Icon, type IconName } from "./ui/Icon.js";

export interface Command {
  id: string;
  /** Group heading this command appears under. */
  group: string;
  label: string;
  icon: IconName;
  /** Trailing text — a shortcut, a timestamp, a current value. */
  hint?: string;
  /** Extra terms to match on that are not in the label. */
  keywords?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
  modifierLabel: string;
}

/**
 * Keyboard entry point to the whole application.
 *
 * The palette is what makes a dense tool navigable without hunting through
 * toolbars: every chrome action is reachable by name, and conversations are
 * searchable in the same field. Selection is driven by the keyboard only —
 * pointer hover moves the selected index rather than painting a second
 * highlight, so there is never a question of which row Enter will run.
 */
export function CommandPalette({
  commands,
  onClose,
  modifierLabel,
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Filtering shortens the list, so a held-over index could point past its
  // end — or at a row the user is no longer looking at.
  useEffect(() => setSelected(0), [query]);

  // Follow the selection when it moves out of view under the arrow keys.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setSelected((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length));
      return;
    }

    if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setSelected((current) =>
        matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const command = matches[selected];
      if (!command) return;
      // Closing first means a command that changes what is on screen — open a
      // panel, switch conversation — does not do so behind the overlay.
      onClose();
      command.run();
    }
  }

  // Groups render as headings in the order the caller declared them, so the
  // list does not reshuffle its structure as the query narrows.
  const grouped = groupCommands(matches);
  let flatIndex = -1;

  return (
    <div
      className="palette-scrim"
      role="presentation"
      // A click on the backdrop dismisses; a click inside must not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        <div className="palette__search">
          <Icon name="search" size={16} className="palette__icon" />
          <input
            className="palette__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations or run a command…"
            aria-label="Search conversations or run a command"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          <kbd className="kbd">esc</kbd>
        </div>

        {matches.length === 0 ? (
          <p className="palette__empty">No matches for “{query}”.</p>
        ) : (
          <ul className="palette__list" ref={listRef} role="listbox" aria-label="Results">
            {grouped.map(([group, items]) => (
              <li key={group}>
                <h2 className="palette__group-label eyebrow">{group}</h2>
                <ul role="group" aria-label={group}>
                  {items.map((command) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const isSelected = index === selected;

                    return (
                      <li key={command.id} role="option" aria-selected={isSelected}>
                        <button
                          type="button"
                          data-selected={isSelected}
                          className={`palette__option ${isSelected ? "palette__option--selected" : ""}`}
                          onMouseMove={() => setSelected(index)}
                          onClick={() => {
                            onClose();
                            command.run();
                          }}
                        >
                          <Icon name={command.icon} size={15} className="palette__option-icon" />
                          <span className="palette__option-label">{command.label}</span>
                          {command.hint && (
                            <span className="palette__option-hint">{command.hint}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <div className="palette__foot">
          <span className="palette__foot-item">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd>
            navigate
          </span>
          <span className="palette__foot-item">
            <kbd className="kbd">↵</kbd>
            run
          </span>
          <span className="palette__foot-item">
            <kbd className="kbd">{modifierLabel}</kbd>
            <kbd className="kbd">K</kbd>
            toggle
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Subsequence match, not substring: "ncv" finds "New conversation" the way
 * every editor's file finder behaves, which is what people already expect
 * from a palette.
 */
function filterCommands(commands: Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;

  return commands.filter((command) =>
    isSubsequence(needle, `${command.label} ${command.keywords ?? ""}`.toLowerCase()),
  );
}

function isSubsequence(needle: string, haystack: string): boolean {
  let cursor = 0;
  for (const character of needle) {
    if (character === " ") continue;
    cursor = haystack.indexOf(character, cursor) + 1;
    if (cursor === 0) return false;
  }
  return true;
}

function groupCommands(commands: Command[]): [string, Command[]][] {
  const groups = new Map<string, Command[]>();
  for (const command of commands) {
    const existing = groups.get(command.group);
    if (existing) existing.push(command);
    else groups.set(command.group, [command]);
  }
  return [...groups];
}
