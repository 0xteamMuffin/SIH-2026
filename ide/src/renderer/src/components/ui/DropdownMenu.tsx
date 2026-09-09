import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Icon } from "./Icon.js";

export interface MenuItem {
  id: string;
  label: string;
  /** Secondary line under the label — an id, a path, a description. */
  description?: string;
  selected?: boolean;
  onSelect: () => void;
}

export interface DropdownMenuProps {
  /** Accessible name for the trigger. */
  label: string;
  /** Trigger contents. The component supplies the button itself. */
  trigger: React.ReactNode;
  triggerClassName?: string;
  items: MenuItem[];
  /** Small heading above the list. */
  header?: string;
  /** Which edge of the trigger the panel lines up with. */
  align?: "start" | "end";
}

/**
 * A real dropdown menu.
 *
 * Replaces the native `<select>` this used to be. A native option list is
 * drawn by the OS: on Linux and Windows it ignores the app's theme entirely,
 * so a dark chrome would open a light grey system list with a different font
 * and no room for a second line. Owning the list costs the keyboard and
 * dismissal behaviour implemented below, and buys a menu that matches the
 * application it belongs to and can show more than a bare label per row.
 */
export function DropdownMenu({
  label,
  trigger,
  triggerClassName = "",
  items,
  header,
  align = "start",
}: DropdownMenuProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setIsOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Dismiss on an outside press or on Escape. `pointerdown` rather than
  // `click`, so the menu is gone before whatever was pressed reacts.
  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    }

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen, close]);

  // Move focus into the menu when it opens, onto the current value if there
  // is one — arrowing from the selected row is what a menu is expected to do.
  useEffect(() => {
    if (!isOpen) return;
    const buttons = itemButtons(panelRef.current);
    const selectedIndex = items.findIndex((item) => item.selected);
    buttons[selectedIndex === -1 ? 0 : selectedIndex]?.focus();
  }, [isOpen, items]);

  function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();

    const buttons = itemButtons(panelRef.current);
    if (buttons.length === 0) return;

    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return (
    <div className="menu" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        {trigger}
      </button>

      {isOpen && (
        <div
          ref={panelRef}
          className={`menu__panel ${align === "end" ? "menu__panel--end" : ""}`}
          role="menu"
          aria-label={label}
          onKeyDown={handlePanelKeyDown}
        >
          {header && <p className="menu__header eyebrow">{header}</p>}

          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.selected ?? false}
              className={`menu__item ${item.selected ? "menu__item--selected" : ""}`}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              <span className="menu__item-text">
                <span className="menu__item-label">{item.label}</span>
                {item.description && (
                  <span className="menu__item-description">{item.description}</span>
                )}
              </span>
              {item.selected && <Icon name="check" size={13} className="menu__item-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function itemButtons(panel: HTMLElement | null): HTMLButtonElement[] {
  return [...(panel?.querySelectorAll<HTMLButtonElement>(".menu__item") ?? [])];
}
