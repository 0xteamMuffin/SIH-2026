import { useCallback, useEffect, useRef, useState } from "react";

import { CLOSED_BROWSER_PANE, type BrowserPaneState } from "@shared/types.js";

export interface BrowserPaneController {
  state: BrowserPaneState;
  isOpen: boolean;
  /** Attach to the element whose rectangle the native view should fill. */
  slotRef: (element: HTMLElement | null) => void;
  open: (url: string) => void;
  close: () => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  openExternal: (url: string) => void;
  /**
   * Collapses the native view out of the way, and stops it following the
   * layout, until tracking is switched back on.
   *
   * Needed for the panel divider. The native view sits *on top* of the
   * window, outside the DOM, so while it covers the area a drag is moving
   * through, the renderer receives no pointer events there and the drag
   * stalls. Collapsing it for the duration of the drag hands those events
   * back to the DOM.
   */
  setTracking: (tracking: boolean) => void;
}

/** Where the native view is parked while tracking is off. */
const COLLAPSED_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Drives the embedded browser pane.
 *
 * The pane is a native `WebContentsView` living outside the DOM, so it cannot
 * be positioned by CSS. This hook measures a placeholder element and reports
 * its rectangle to the main process, which is the only way to keep the two in
 * agreement. Because it always paints over the React UI, the placeholder must
 * be a stable region of the layout rather than something inside the scrolling
 * chat thread.
 */
export function useBrowserPane(): BrowserPaneController {
  const [state, setState] = useState<BrowserPaneState>(CLOSED_BROWSER_PANE);
  const [isTracking, setIsTracking] = useState(true);
  const slotElementRef = useRef<HTMLElement | null>(null);
  const isOpen = state.url !== null;

  useEffect(
    () =>
      window.workbench.onEvent((event) => {
        if (event.type === "browser/state-changed") setState(event.state);
      }),
    [],
  );

  const measure = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const element = slotElementRef.current;
    if (!element) return null;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, []);

  // Keep the native view aligned while the pane is open. A ResizeObserver
  // catches layout changes; the window listeners catch everything else that
  // moves the element without resizing it.
  useEffect(() => {
    if (!isOpen) return;

    // Tracking off: park the view and stop observing. Re-running this effect
    // when it comes back on is what restores it to the settled layout.
    if (!isTracking) {
      void window.workbench.browser.setBounds(COLLAPSED_BOUNDS);
      return;
    }

    const push = (): void => {
      const bounds = measure();
      if (bounds) void window.workbench.browser.setBounds(bounds);
    };

    push();

    const element = slotElementRef.current;
    const observer = new ResizeObserver(push);
    if (element) observer.observe(element);
    window.addEventListener("resize", push);
    // Capture phase, because scrolling any ancestor moves the slot.
    window.addEventListener("scroll", push, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", push);
      window.removeEventListener("scroll", push, true);
    };
  }, [isOpen, isTracking, measure]);

  const slotRef = useCallback((element: HTMLElement | null) => {
    slotElementRef.current = element;
  }, []);

  const open = useCallback(
    (url: string) => {
      // The slot is not measurable until after the pane region has rendered,
      // so opening waits a frame and falls back to a zero rect that the effect
      // above corrects as soon as layout settles.
      requestAnimationFrame(() => {
        const bounds = measure() ?? { x: 0, y: 0, width: 0, height: 0 };
        window.workbench.browser.open(url, bounds).then(setState).catch(reportToConsole);
      });
    },
    [measure],
  );

  const close = useCallback(() => {
    window.workbench.browser.close().catch(reportToConsole);
    setState(CLOSED_BROWSER_PANE);
  }, []);

  return {
    state,
    isOpen,
    slotRef,
    open,
    close,
    setTracking: setIsTracking,
    goBack: useCallback(() => void window.workbench.browser.goBack().catch(reportToConsole), []),
    goForward: useCallback(() => void window.workbench.browser.goForward().catch(reportToConsole), []),
    reload: useCallback(() => void window.workbench.browser.reload().catch(reportToConsole), []),
    openExternal: useCallback(
      (url: string) => void window.workbench.browser.openExternal(url).catch(reportToConsole),
      [],
    ),
  };
}

function reportToConsole(error: unknown): void {
  console.error("[browser-pane]", error);
}
