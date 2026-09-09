import { useCallback, useEffect, useState } from "react";

/**
 * Widths of the shell's resizable columns.
 *
 * Held here rather than in CSS because a drag has to clamp against the live
 * window width: the three-pane layout stops being usable once the content
 * column is squeezed, so the panel's maximum depends on what the sidebar is
 * currently taking.
 *
 * The stored value is what the user *asked for*; the value the grid gets is
 * that clamped to the current window. Keeping them separate is what stops a
 * moment spent in a narrow window from permanently shrinking a layout — the
 * naive version clamps the stored value down, and widening the window never
 * restores it.
 */

const STORAGE_KEY = "workbench.layout";

export const DEFAULT_SIDEBAR_WIDTH = 264;
export const DEFAULT_PANEL_WIDTH = 460;

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 440;
const PANEL_MIN = 340;
/** The content column never shrinks below this, whatever else is dragged. */
const CONTENT_MIN = 420;

export interface PaneLayout {
  /** Clamped to the current window — this is what the grid should use. */
  sidebarWidth: number;
  panelWidth: number;
  /** `clientX` of the divider on the sidebar's trailing edge. */
  resizeSidebar: (clientX: number) => void;
  /** `clientX` of the divider between the content column and the panel. */
  resizePanel: (clientX: number) => void;
  nudgeSidebar: (deltaPx: number) => void;
  nudgePanel: (deltaPx: number) => void;
  resetSidebar: () => void;
  resetPanel: () => void;
}

interface StoredLayout {
  sidebarWidth: number;
  panelWidth: number;
}

function clampSidebar(width: number, viewport: number): number {
  const ceiling = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, viewport - CONTENT_MIN));
  return Math.round(Math.min(ceiling, Math.max(SIDEBAR_MIN, width)));
}

function clampPanel(width: number, viewport: number, sidebarWidth: number): number {
  const ceiling = Math.max(PANEL_MIN, viewport - sidebarWidth - CONTENT_MIN);
  return Math.round(Math.min(ceiling, Math.max(PANEL_MIN, width)));
}

export function usePaneLayout(): PaneLayout {
  // Lazy initialisers: read the stored preference once at mount rather than
  // on every render.
  const [preferredSidebar, setPreferredSidebar] = useState(
    () => readStored()?.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
  );
  const [preferredPanel, setPreferredPanel] = useState(
    () => readStored()?.panelWidth ?? DEFAULT_PANEL_WIDTH,
  );
  const [viewport, setViewport] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = (): void => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Written on settle rather than on every pointer move — a drag would
  // otherwise hit localStorage sixty times a second.
  useEffect(() => {
    const timer = window.setTimeout(
      () => writeStored({ sidebarWidth: preferredSidebar, panelWidth: preferredPanel }),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [preferredSidebar, preferredPanel]);

  const sidebarWidth = clampSidebar(preferredSidebar, viewport);
  const panelWidth = clampPanel(preferredPanel, viewport, sidebarWidth);

  return {
    sidebarWidth,
    panelWidth,

    // The sidebar starts at x=0, so the divider's position *is* its width.
    resizeSidebar: useCallback(
      (clientX: number) => setPreferredSidebar(clampSidebar(clientX, window.innerWidth)),
      [],
    ),

    // The panel is flush to the right edge, so its width is the distance from
    // the divider to the window edge.
    resizePanel: useCallback(
      (clientX: number) =>
        setPreferredPanel((current) => {
          const requested = window.innerWidth - clientX;
          return clampPanel(requested, window.innerWidth, clampSidebar(current, window.innerWidth));
        }),
      [],
    ),

    nudgeSidebar: useCallback(
      (deltaPx: number) =>
        setPreferredSidebar((current) => clampSidebar(current + deltaPx, window.innerWidth)),
      [],
    ),
    nudgePanel: useCallback(
      (deltaPx: number) =>
        setPreferredPanel((current) => clampPanel(current + deltaPx, window.innerWidth, sidebarWidth)),
      [sidebarWidth],
    ),

    resetSidebar: useCallback(() => setPreferredSidebar(DEFAULT_SIDEBAR_WIDTH), []),
    resetPanel: useCallback(() => setPreferredPanel(DEFAULT_PANEL_WIDTH), []),
  };
}

/**
 * Persistence is best-effort: a packaged renderer runs from `file://`, where
 * Chromium may treat the origin as opaque and throw on `localStorage`. A
 * layout preference is not worth failing startup over.
 */
function readStored(): StoredLayout | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;

    const { sidebarWidth, panelWidth } = parsed as Partial<StoredLayout>;
    if (typeof sidebarWidth !== "number" || typeof panelWidth !== "number") return null;
    return { sidebarWidth, panelWidth };
  } catch {
    return null;
  }
}

function writeStored(layout: StoredLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Widths hold for the rest of the session.
  }
}
