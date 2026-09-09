import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

export const THEMES: readonly Theme[] = ["light", "dark", "system"];

const STORAGE_KEY = "workbench.theme";
const DEFAULT_THEME: Theme = "dark";

/**
 * Reads and writes the stored preference.
 *
 * Wrapped because a packaged renderer runs from `file://`, where Chromium may
 * treat the origin as opaque and throw on `localStorage` access. The theme is
 * a preference, not data — degrading to "remembers for this session only" is
 * the right failure, not a crash on startup.
 */
function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Preference is held in React state for the rest of the session.
  }
}

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}

/*
 * Applied at module evaluation, before React renders anything.
 *
 * The alternative — setting it in an effect — paints one frame of the default
 * theme first, which on a light-theme machine is a full-screen black flash
 * every launch. The renderer's CSP forbids the inline <head> script that a web
 * app would use for this, so module side-effect order is the seam available.
 */
applyTheme(readStoredTheme() ?? DEFAULT_THEME);

export interface ThemeController {
  /** The stored preference, which may be `system`. */
  theme: Theme;
  /** What `system` currently resolves to — for anything that needs the answer. */
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
  /** Flips between light and dark, resolving `system` first. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeController | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme() ?? DEFAULT_THEME);
  const [systemIsDark, setSystemIsDark] = useState(() => prefersDark());

  // Only relevant while the preference is `system`, but the listener is cheap
  // and unconditional subscription keeps the resolved value correct the moment
  // someone switches to it.
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent): void => setSystemIsDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    writeStoredTheme(next);
  }, []);

  const resolved: "light" | "dark" =
    theme === "system" ? (systemIsDark ? "dark" : "light") : theme;

  const toggleTheme = useCallback(() => {
    setTheme(resolved === "dark" ? "light" : "dark");
  }, [resolved, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeController {
  const controller = useContext(ThemeContext);
  if (!controller) throw new Error("useTheme must be used inside a ThemeProvider");
  return controller;
}

function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
