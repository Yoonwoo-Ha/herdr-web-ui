/**
 * Who is asking (docs/account.md, "Who is asking"): what an approval shows of a device the person
 * cannot see, against a phished device code (RFC 8628 section 5.4). The system the device says it
 * runs, and the approximate place the account service saw its request come from (Cloudflare's
 * country and city, never the address).
 */

export const ACCOUNT_OSES = ["ios", "android", "macos", "windows", "linux", "chromeos"] as const;
export type AccountOs = (typeof ACCOUNT_OSES)[number];

/** A system the account service knows, or null: it keeps any other value as unknown. */
export const accountOsOf = (value: unknown): AccountOs | null => ACCOUNT_OSES.find((os) => os === value) ?? null;

export const ACCOUNT_OS_NAMES: Readonly<Record<AccountOs, string>> = { ios: "iOS", android: "Android", macos: "macOS", windows: "Windows", linux: "Linux", chromeos: "ChromeOS" };

/** The system a process runs on, from Node's `process.platform`. */
export function accountOsOfPlatform(platform: string): AccountOs | null {
  switch (platform) {
    case "darwin": return "macos";
    case "win32": return "windows";
    case "linux": return "linux";
    default: return null;
  }
}

/** `country`: ISO 3166-1 alpha-2; a city comes only with a country. */
export interface AccountPlace { readonly country: string | null; readonly city: string | null }

export interface AccountAsker extends AccountPlace { readonly os: AccountOs | null }

/** "Seoul, South Korea" in `language`; the country alone without a city; null without a country. */
export function placeName(language: string, place: AccountPlace): string | null {
  if (place.country === null) return null;
  const country = new Intl.DisplayNames([language], { type: "region" }).of(place.country) ?? place.country;
  return place.city === null ? country : `${place.city}, ${country}`;
}

/** At most 48 UTF-16 units and no control characters, as the account service takes a label; whole characters only. */
export function accountLabel(text: string): string {
  let label = "";
  for (const char of text.replace(/[\p{Cc}\p{Cs}]/gu, "")) {
    if (label.length + char.length > 48) break;
    label += char;
  }
  return label.trim();
}
