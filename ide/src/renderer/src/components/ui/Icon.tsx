/**
 * The icon set.
 *
 * Hand-authored inline SVG rather than an icon package for two reasons. The
 * renderer's CSP declares no remote origins — this is an air-gapped install,
 * so an icon font or sprite fetched at runtime is not an option — and every
 * glyph the previous UI used was a Unicode character (`×`, `↑`, `▤`, `⟳`),
 * which renders at a different weight and baseline on every platform. A
 * single stroked geometry at one width is what makes a toolbar look built.
 *
 * All paths are drawn on a 24×24 grid with a 1.75 stroke, round caps and
 * joins, so any two icons sit together without one looking heavier.
 */

const ICONS = {
  // ── Actions ──────────────────────────────────────────────────────────────
  plus: <path d="M5 12h14M12 5v14" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="M20 6 9 17l-5-5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7.5" />
      <path d="m21 21-4.4-4.4" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V6" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  pencil: (
    <>
      <path d="M20.4 6.6a2.3 2.3 0 0 0-3.2-3.2L4.3 16.3a2 2 0 0 0-.5.85l-1.1 3.6a.6.6 0 0 0 .75.75l3.6-1.1a2 2 0 0 0 .85-.5Z" />
      <path d="m15 5 4 4" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2.5" />
      <path d="M15.5 5.5A2.5 2.5 0 0 0 13 3H5.5A2.5 2.5 0 0 0 3 5.5V13a2.5 2.5 0 0 0 2.5 2.5" />
    </>
  ),
  download: (
    <>
      <path d="M21 15.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3.5" />
      <path d="m7.5 11 4.5 4.5L16.5 11M12 15.5V3" />
    </>
  ),
  paperclip: (
    <path d="M20.9 11.6l-8.7 8.7a5.5 5.5 0 0 1-7.8-7.8l8.1-8.1a3.7 3.7 0 0 1 5.2 5.2l-8.1 8.1a1.85 1.85 0 0 1-2.6-2.6l7.5-7.5" />
  ),
  send: <path d="m5 12 7-7 7 7M12 19V5" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01" />
      <path d="M20.5 3.5V9H15" />
    </>
  ),
  external: (
    <>
      <path d="M14.5 3.5H20.5V9.5" />
      <path d="M20.5 3.5 12 12" />
      <path d="M18 14v5.5a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 19.5V7.5A1.5 1.5 0 0 1 4.5 6H10" />
    </>
  ),
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </g>
  ),

  // ── Direction ────────────────────────────────────────────────────────────
  "chevron-up": <path d="m18 15-6-6-6 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "arrow-left": <path d="M19 12H5m7 7-7-7 7-7" />,
  "arrow-right": <path d="M5 12h14m-7-7 7 7-7 7" />,
  "arrow-up-right": <path d="M7 17 17 7M8 7h9v9" />,
  "corner-down-left": <path d="M20 4.5v6.5a4 4 0 0 1-4 4H4M9 10l-5 5 5 5" />,

  // ── Status ───────────────────────────────────────────────────────────────
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
    </>
  ),
  "alert-circle": (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7.5v5M12 16.2h.01" />
    </>
  ),
  "alert-triangle": (
    <>
      <path d="M10.6 3.9 2.9 17.6A1.6 1.6 0 0 0 4.3 20h15.4a1.6 1.6 0 0 0 1.4-2.4L13.4 3.9a1.6 1.6 0 0 0-2.8 0Z" />
      <path d="M12 9v4M12 16.6h.01" />
    </>
  ),
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="m14.8 9.2-5.6 5.6M9.2 9.2l5.6 5.6" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M5.3 5.3l13.4 13.4" />
    </>
  ),
  pause: (
    <g fill="currentColor" stroke="none">
      <rect x="6.5" y="4.5" width="3.6" height="15" rx="1.2" />
      <rect x="13.9" y="4.5" width="3.6" height="15" rx="1.2" />
    </g>
  ),
  "circle-dot": (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 6.8V12l3.6 2.1" />
    </>
  ),
  activity: <path d="M3 12h3.5l2.8-7.5 4.4 15L16.5 12H21" />,

  // ── Files and documents ──────────────────────────────────────────────────
  file: (
    <>
      <path d="M14.5 3H6.5A2 2 0 0 0 4.5 5v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8Z" />
      <path d="M14.5 3v5h5" />
    </>
  ),
  "file-text": (
    <>
      <path d="M14.5 3H6.5A2 2 0 0 0 4.5 5v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8Z" />
      <path d="M14.5 3v5h5M8.5 13h7M8.5 16.5h4.5" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M3.5 9.5h17M3.5 15h17M9.5 4v16" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="m4 18 4.7-4.7a1.8 1.8 0 0 1 2.5 0L20.5 22" />
    </>
  ),
  folder: (
    <path d="M20 20a1.8 1.8 0 0 0 1.8-1.8V8.6A1.8 1.8 0 0 0 20 6.8h-6.7a1.8 1.8 0 0 1-1.5-.8L10.9 4.6A1.8 1.8 0 0 0 9.4 4H4a1.8 1.8 0 0 0-1.8 1.8v12.4A1.8 1.8 0 0 0 4 20Z" />
  ),
  code: <path d="m8.5 17-5-5 5-5M15.5 7l5 5-5 5" />,

  // ── Domain ───────────────────────────────────────────────────────────────
  message: (
    <path d="M20.5 14.5a2 2 0 0 1-2 2H7.5l-4 3.5V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M2.6 12h18.8" />
      <path d="M12 2.5a14.5 14.5 0 0 1 3.8 9.5A14.5 14.5 0 0 1 12 21.5a14.5 14.5 0 0 1-3.8-9.5A14.5 14.5 0 0 1 12 2.5Z" />
    </>
  ),
  shield: (
    <>
      <path d="M19.5 12c0 4.7-3.3 7-7.2 8.4a1 1 0 0 1-.62 0C7.8 19 4.5 16.7 4.5 12V6.2a.9.9 0 0 1 .9-.9c1.9 0 4.2-1.1 5.85-2.5a1.1 1.1 0 0 1 1.4 0C14.3 4.2 16.7 5.3 18.6 5.3a.9.9 0 0 1 .9.9Z" />
      <path d="m9.4 12.2 2 2 3.4-3.6" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
      <path d="M7.8 10.5V7.2a4.2 4.2 0 0 1 8.4 0v3.3" />
    </>
  ),
  network: (
    <>
      <rect x="9" y="2.5" width="6" height="5.5" rx="1.5" />
      <rect x="2.5" y="16" width="6" height="5.5" rx="1.5" />
      <rect x="15.5" y="16" width="6" height="5.5" rx="1.5" />
      <path d="M12 8v3.5M5.5 16v-2.5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1V16" />
    </>
  ),
  terminal: <path d="m4.5 17 5.5-5-5.5-5M12.5 19h7" />,
  cpu: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 2.5V5M15 2.5V5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </>
  ),
  building: (
    <>
      <path d="M7 21V4.6A1.6 1.6 0 0 1 8.6 3h6.8A1.6 1.6 0 0 1 17 4.6V21" />
      <path d="M7 11.5H4.6A1.6 1.6 0 0 0 3 13.1V21h18v-7.9a1.6 1.6 0 0 0-1.6-1.6H17" />
      <path d="M10.5 7h3M10.5 11h3M10.5 15h3M2.5 21h19" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 4.2 13.4 8a2 2 0 0 0 1.2 1.2l3.8 1.4-3.8 1.4A2 2 0 0 0 13.4 13.2L12 17l-1.4-3.8a2 2 0 0 0-1.2-1.2L5.6 10.6l3.8-1.4A2 2 0 0 0 10.6 8Z" />
      <path d="M18.5 3v3M17 4.5h3M6 18v2.5M4.8 19.2h2.5" />
    </>
  ),
  zap: (
    <path d="M13.5 2.5 4.8 13.1a.6.6 0 0 0 .47.98h4.9l-.67 6.42a.6.6 0 0 0 1.06.44l8.7-10.6a.6.6 0 0 0-.47-.98h-4.9l.67-6.42a.6.6 0 0 0-1.06-.44Z" />
  ),
  layers: (
    <>
      <path d="M12.8 2.6a1.8 1.8 0 0 0-1.6 0L3.1 6.4a.9.9 0 0 0 0 1.64l8.1 3.7a1.8 1.8 0 0 0 1.6 0l8.1-3.7a.9.9 0 0 0 0-1.64Z" />
      <path d="m6.4 11.4-3.3 1.5a.9.9 0 0 0 0 1.64l8.1 3.7a1.8 1.8 0 0 0 1.6 0l8.1-3.7a.9.9 0 0 0 0-1.64l-3.3-1.5" />
    </>
  ),

  // ── Chrome ───────────────────────────────────────────────────────────────
  "panel-left": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </>
  ),
  "panel-right": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M14.5 4v16" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
    </>
  ),
  moon: <path d="M20.5 14.4A8.9 8.9 0 0 1 9.6 3.5 8.9 8.9 0 1 0 20.5 14.4Z" />,
  monitor: (
    <>
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </>
  ),
  command: (
    <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M19 21v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V21" />
    </>
  ),
  logout: (
    <>
      <path d="M9.5 21H5.5A2 2 0 0 1 3.5 19V5a2 2 0 0 1 2-2h4" />
      <path d="m16 16.5 4.5-4.5L16 7.5M20.5 12h-11" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-6.5M4 10.5V3M12 21v-8.5M12 8.5V3M20 21v-4.5M20 12.5V3" />
      <path d="M1.5 13.5h5M9.5 8h5M17.5 15.5h5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.3 12c2.1-4.6 5.5-6.9 9.7-6.9s7.6 2.3 9.7 6.9c-2.1 4.6-5.5 6.9-9.7 6.9S4.4 16.6 2.3 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
} as const satisfies Record<string, React.ReactNode>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** Edge length in px. 14 for dense rows, 16 default, 18+ for headers. */
  size?: number;
  /**
   * Overrides the stroke weight. Lower it for large sizes so the icon does
   * not out-weigh the text beside it.
   */
  strokeWidth?: number;
  className?: string;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  className,
}: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Icons in this app are always paired with a label or an accessible name
      // on the control that contains them, so none of them are content.
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
