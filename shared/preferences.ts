/**
 * What every browser of this server shares: the settings that do not depend on the device
 * (src/lib/settings.ts SETTING_SCOPE says which) and the pinned agents. GET/PUT
 * /api/preferences; a change reaches the other browsers as a `preferences` event on
 * /api/machines/events. The values are checked where they are used (sanitizeSettings): the
 * server keeps only the names below and the shape. A browser sends only the settings it changed,
 * which the server lays over what it holds, so a setting nobody changed stays each device's own.
 */
export const SHARED_SETTING_KEYS = [
  "theme", "palette", "language", "sidebarRows", "agentOrder", "agentCards", "agentPins", "agentMarks", "autoSendQueued",
  "showThinking", "quickReplies", "showQuickReplies", "showSuggestionChip", "showUsage", "usageCount", "usagePace",
  "usageGlance", "usageOrder", "usageHidden", "highlightCode",
] as const;
export type SharedSettingKey = (typeof SHARED_SETTING_KEYS)[number];

export interface SharedPreferences {
  /** 0 until a browser first writes; each write adds one */
  revision: number;
  /** only the settings some browser has shared: one nobody changed is absent, and stays each device's own */
  settings: Partial<Record<SharedSettingKey, unknown>>;
  /** sidebar pin keys (`machine:pane`), in their order; absent until a browser first shares its pins */
  pins?: string[];
}

export const MAX_PINS = 500;
const MAX_PIN_LENGTH = 300;
/** a shared value is a few words or a short list; a change and the whole document it makes stay small */
export const MAX_PREFERENCES_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a browser sends: the settings it changed, and the pins when they changed */
export interface PreferencesChange { settings: SharedPreferences["settings"]; pins?: string[] }

/** The settings and pins of a body or a stored file, cut to the shared names and the limits; null when the shape is wrong. */
export function sharedPreferencesBody(raw: unknown): PreferencesChange | null {
  if (!isObject(raw) || !isObject(raw["settings"]) || (raw["pins"] !== undefined && !Array.isArray(raw["pins"]))) return null;
  const pins = raw["pins"] as unknown[] | undefined;
  if (pins !== undefined && (pins.length > MAX_PINS || !pins.every((pin) => typeof pin === "string" && pin.length > 0 && pin.length <= MAX_PIN_LENGTH))) return null;
  const given = raw["settings"];
  const settings: SharedPreferences["settings"] = {};
  for (const key of SHARED_SETTING_KEYS) if (key in given) settings[key] = given[key];
  return pins === undefined ? { settings } : { settings, pins: [...new Set(pins as string[])] };
}
