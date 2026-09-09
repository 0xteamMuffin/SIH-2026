import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** How far one arrow-key press moves a divider. */
const NUDGE_PX = 16;

export interface ResizerProps {
  /** Accessible name, e.g. "Resize the conversation list". */
  label: string;
  /** Pointer x, in window coordinates, on every move of an active drag. */
  onMove: (clientX: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  /** Keyboard adjustment. `1` grows the region the handle belongs to. */
  onNudge?: (direction: -1 | 1) => void;
  /** Double-click restores the default width. */
  onReset?: () => void;
  className?: string;
}

/**
 * A draggable divider between two panes.
 *
 * The handle is 6px of hit area painting a 1px line, because a divider you
 * can see is not a divider you can grab.
 *
 * Tracking is done with `window` listeners rather than `setPointerCapture`.
 * Capture is the tidier API but it throws for a pointer id with no active
 * pointer — which is exactly what synthesised input produces — and a throw
 * inside the handler aborts the rest of it, so the drag silently never
 * starts. Window listeners have no such failure mode and cover the same
 * ground here.
 */
export function Resizer({
  label,
  onMove,
  onStart,
  onEnd,
  onNudge,
  onReset,
  className = "",
}: ResizerProps): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false);

  // Held in a ref so the drag effect can depend on `isDragging` alone. The
  // callers pass inline arrows, so a dependency on the callbacks themselves
  // would tear the drag down and set it up again on every render — firing
  // `onEnd`/`onStart` repeatedly mid-drag.
  const callbacks = useRef({ onMove, onStart, onEnd });
  callbacks.current = { onMove, onStart, onEnd };

  useEffect(() => {
    if (!isDragging) return;

    const move = (event: globalThis.PointerEvent): void => callbacks.current.onMove(event.clientX);
    const stop = (): void => setIsDragging(false);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    // Keeps the cursor as `col-resize` and stops the thread text selecting
    // while the pointer sweeps across it.
    document.documentElement.classList.add("is-resizing");
    callbacks.current.onStart?.();

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.documentElement.classList.remove("is-resizing");
      callbacks.current.onEnd?.();
    };
  }, [isDragging]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    setIsDragging(true);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!onNudge) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onNudge(-1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onNudge(1);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      className={`resizer ${isDragging ? "resizer--active" : ""} ${className}`}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}

export { NUDGE_PX };
