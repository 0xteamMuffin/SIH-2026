import { Icon, type IconName } from "./Icon.js";

export interface IconButtonProps {
  icon: IconName;
  /**
   * Accessible name, and the tooltip text. Required: an icon-only control with
   * no label is unusable with a screen reader and unguessable without one.
   */
  label: string;
  onClick?: () => void;
  /** Renders the pressed/on state — panel toggles, active tabs. */
  active?: boolean;
  disabled?: boolean;
  size?: "sm" | "md";
  tone?: "default" | "danger";
  iconSize?: number;
  /** Suppresses the tooltip where the surrounding context already says it. */
  hideTooltip?: boolean;
  /** Flips the tooltip for controls sitting at the right edge of the window. */
  tooltipAlign?: "center" | "end";
  tooltipSide?: "bottom" | "top";
  type?: "button" | "submit";
  className?: string;
}

/**
 * The single icon-only control used across the chrome.
 *
 * Centralised so hit area, hover feedback, tooltip timing, and the accessible
 * name are decided once rather than per toolbar.
 */
export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  size = "md",
  tone = "default",
  iconSize,
  hideTooltip = false,
  tooltipAlign = "center",
  tooltipSide = "bottom",
  type = "button",
  className = "",
}: IconButtonProps): React.JSX.Element {
  const classes = [
    "icon-btn",
    size === "sm" && "icon-btn--sm",
    active && "icon-btn--active",
    tone === "danger" && "icon-btn--danger",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active || undefined}
      data-tooltip={hideTooltip ? undefined : label}
      data-tooltip-align={tooltipAlign === "end" ? "end" : undefined}
      data-tooltip-side={tooltipSide === "top" ? "top" : undefined}
    >
      <Icon name={icon} size={iconSize ?? (size === "sm" ? 14 : 16)} />
    </button>
  );
}
