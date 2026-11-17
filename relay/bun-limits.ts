import type { Limiters, RateLimiter } from "./core.ts";
import type { PassSettings } from "./pass.ts";

export const DEFAULT_RELAY_LIMITS = {
  perAddressPerMinute: 120,
  globalPerMinute: 600,
  maxSockets: 1024,
  maxRooms: 256,
  maxPairRooms: 256,
  maxAddresses: 4096,
  maxSocketsPerAddress: 64,
} as const;

export type BunRelayLimits = { readonly [K in keyof typeof DEFAULT_RELAY_LIMITS]: number };

export function relayLimits(overrides: Partial<BunRelayLimits> = {}): BunRelayLimits {
  const limits = { ...DEFAULT_RELAY_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer`);
  }
  return limits;
}

export function relayLimitsFromArgs(args: readonly string[], env: Readonly<Record<string, string | undefined>>): BunRelayLimits {
  const value = (flag: string, variable: string, fallback: number) => {
    const index = args.indexOf(`--${flag}`);
    const input = index >= 0 ? args[index + 1] : env[variable];
    if (index >= 0 && input === undefined) throw new Error(`--${flag} needs a value`);
    return input === undefined ? fallback : Number(input);
  };
  return relayLimits({
    perAddressPerMinute: value("per-address-per-minute", "RELAY_PER_ADDRESS_PER_MINUTE", DEFAULT_RELAY_LIMITS.perAddressPerMinute),
    globalPerMinute: value("global-per-minute", "RELAY_GLOBAL_PER_MINUTE", DEFAULT_RELAY_LIMITS.globalPerMinute),
    maxSockets: value("max-sockets", "RELAY_MAX_SOCKETS", DEFAULT_RELAY_LIMITS.maxSockets),
    maxRooms: value("max-rooms", "RELAY_MAX_ROOMS", DEFAULT_RELAY_LIMITS.maxRooms),
    maxPairRooms: value("max-pair-rooms", "RELAY_MAX_PAIR_ROOMS", DEFAULT_RELAY_LIMITS.maxPairRooms),
    maxAddresses: value("max-addresses", "RELAY_MAX_ADDRESSES", DEFAULT_RELAY_LIMITS.maxAddresses),
    maxSocketsPerAddress: value("max-sockets-per-address", "RELAY_MAX_SOCKETS_PER_ADDRESS", DEFAULT_RELAY_LIMITS.maxSocketsPerAddress),
  });
}

export function relayPassFromArgs(args: readonly string[], env: Readonly<Record<string, string | undefined>>): PassSettings {
  const value = (flag: string, variable: keyof PassSettings) => {
    const index = args.indexOf(`--${flag}`);
    if (index >= 0 && args[index + 1] === undefined) throw new Error(`--${flag} needs a value`);
    return index >= 0 ? args[index + 1] : env[variable];
  };
  return {
    RELAY_PASS_MODE: value("pass-mode", "RELAY_PASS_MODE"),
    RELAY_PASS_ENFORCE_AT: value("pass-enforce-at", "RELAY_PASS_ENFORCE_AT"),
    RELAY_PASS_KEYS: value("pass-keys", "RELAY_PASS_KEYS"),
    RELAY_PASS_REVOKED: value("pass-revoked", "RELAY_PASS_REVOKED"),
  };
}

export function memoryLimiters(limits: BunRelayLimits, now: () => number = Date.now): Limiters {
  const bucket = (capacity: number, maxKeys: number): RateLimiter => {
    const entries = new Map<string, { tokens: number; at: number }>();
    return {
      async limit({ key }) {
        const time = now();
        for (const [address, entry] of entries) {
          if (time - entry.at >= 60_000) entries.delete(address);
        }
        const entry = entries.get(key);
        if (!entry && entries.size >= maxKeys) return { success: false };
        const tokens = entry ? Math.min(capacity, entry.tokens + Math.max(0, time - entry.at) * capacity / 60_000) : capacity;
        const success = tokens >= 1;
        entries.set(key, { tokens: success ? tokens - 1 : tokens, at: time });
        return { success };
      },
    };
  };
  return {
    perAddress: bucket(limits.perAddressPerMinute, limits.maxAddresses),
    global: bucket(limits.globalPerMinute, 1),
    perPc: bucket(limits.perAddressPerMinute, limits.maxAddresses),
    passChecks: bucket(limits.perAddressPerMinute, limits.maxAddresses),
  };
}
