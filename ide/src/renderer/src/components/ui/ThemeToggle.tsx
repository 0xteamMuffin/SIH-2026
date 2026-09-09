import { THEMES, useTheme, type Theme } from "../../theme/ThemeProvider.js";
import { Icon, type IconName } from "./Icon.js";

const THEME_ICONS: Record<Theme, IconName> = {
  light: "sun",
  dark: "moon",
  system: "monitor",
};

const THEME_LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "Match system",
};

/**
 * Three-way appearance control.
 *
 * A segmented control rather than a toggle button: with a `system` option the
 * state is not binary, and a button that cycles through three values gives no
 * indication of what the next press does.
 */
export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme();

  return (
    <div className="segmented" role="radiogroup" aria-label="Appearance">
      {THEMES.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={theme === option}
          aria-label={THEME_LABELS[option]}
          data-tooltip={THEME_LABELS[option]}
          className={`segmented__option ${theme === option ? "segmented__option--active" : ""}`}
          onClick={() => setTheme(option)}
        >
          <Icon name={THEME_ICONS[option]} size={13} strokeWidth={1.9} />
        </button>
      ))}
    </div>
  );
}
