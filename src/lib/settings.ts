/**
 * User preferences: one localStorage record, one React context, applied to the
 * document as `data-theme` / `data-density` attributes that src/styles.css keys
 * its token overrides on. xterm reads no CSS, so `terminalTheme()` mirrors the
 * `--term-*` tokens of each theme for PaneTerminal's theme object.
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeSetting = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export type Density = "compact" | "comfortable";

export interface Settings {
  theme: ThemeSetting;
  density: Density;
  /** xterm font size in px */
  terminalFontSize: number;
  /** true: Enter sends in the composer, Shift+Enter breaks the line; false: Ctrl/Cmd+Enter sends */
  enterSends: boolean;
  /** show the agent's folded reasoning blocks in the chat view */
  showThinking: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  density: "comfortable",
  terminalFontSize: 13,
  enterSends: true,
  showThinking: false,
};

const STORAGE_KEY = "herdr-web-ui:settings";
export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 22;

function clampFont(size: number): number {
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

/** Only known keys with the right type survive: a stale or hand-edited record never breaks the UI. */
export function sanitizeSettings(raw: unknown): Settings {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const theme = record["theme"];
  const density = record["density"];
  const font = record["terminalFontSize"];
  return {
    theme: theme === "dark" || theme === "light" || theme === "system" ? theme : DEFAULT_SETTINGS.theme,
    density: density === "compact" || density === "comfortable" ? density : DEFAULT_SETTINGS.density,
    terminalFontSize: typeof font === "number" && Number.isFinite(font) ? clampFont(font) : DEFAULT_SETTINGS.terminalFontSize,
    enterSends: typeof record["enterSends"] === "boolean" ? record["enterSends"] : DEFAULT_SETTINGS.enterSends,
    showThinking: typeof record["showThinking"] === "boolean" ? record["showThinking"] : DEFAULT_SETTINGS.showThinking,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_SETTINGS : sanitizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: preferences last for the session */
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting !== "system") return setting;
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === false ? "light" : "dark";
}

/** The xterm theme for a resolved theme: the `--term-*` tokens of src/styles.css, verbatim. */
export function terminalTheme(theme: ResolvedTheme): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  return theme === "light"
    ? { background: "#ffffff", foreground: "#1f2937", cursor: "#2563eb", selectionBackground: "#bfdbfe" }
    : { background: "#0b0e14", foreground: "#c5cdd9", cursor: "#6cb6ff", selectionBackground: "#2d3f5e" };
}

/** `<meta name="theme-color">` follows the panel surface so the PWA title bar matches. */
const THEME_COLOR: Record<ResolvedTheme, string> = { dark: "#0b0e14", light: "#ffffff" };

function applyToDocument(settings: Settings, resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset["theme"] = resolved;
  root.dataset["density"] = settings.density;
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[resolved]);
}

interface SettingsContextValue {
  settings: Settings;
  /** the theme after resolving `system` against the OS preference */
  resolvedTheme: ResolvedTheme;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [systemDark, setSystemDark] = useState(() => resolveTheme("system") === "dark");

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  useEffect(() => {
    applyToDocument(settings, resolvedTheme);
  }, [settings, resolvedTheme]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = sanitizeSettings({ ...current, ...patch });
      saveSettings(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, resolvedTheme, update }), [settings, resolvedTheme, update]);
  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error("useSettings needs a SettingsProvider above it");
  return value;
}
