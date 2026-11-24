import { useCallback, useEffect, useRef, useState } from "react";

export interface DesktopUpdate {
  readonly version: string;
  readonly closed: boolean;
}

export interface DesktopUpdateBridge {
  current(): Promise<unknown>;
  onChange(listener: (update: unknown) => void): () => void;
  /** Restart to Update: settles only when Ovis keeps running after it (a .deb's password prompt cancelled) */
  install(): Promise<void>;
  close(version: string): void;
}

export function desktopUpdateBridge(): DesktopUpdateBridge | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisUpdate?: Partial<DesktopUpdateBridge> }).ovisUpdate;
  return bridge && typeof bridge.current === "function" && typeof bridge.onChange === "function" && typeof bridge.install === "function" && typeof bridge.close === "function"
    ? bridge as DesktopUpdateBridge : null;
}

export function readDesktopUpdate(value: unknown): DesktopUpdate | null {
  const update = value as { version?: unknown; closed?: unknown } | null;
  return typeof update?.version === "string" && update.version !== "" ? { version: update.version, closed: update.closed === true } : null;
}

/** Listens before it asks: an answer that comes after a change was read before it, and is dropped */
function follow<Value>(subscribe: (listener: (value: unknown) => void) => () => void, ask: () => Promise<unknown>, read: (value: unknown) => Value, listener: (value: Value) => void): () => void {
  let changed = false;
  let stopped = false;
  const stop = subscribe((value) => {
    changed = true;
    if (!stopped) listener(read(value));
  });
  void ask().then((value) => { if (!changed && !stopped) listener(read(value)); }, () => {});
  return () => {
    stopped = true;
    stop();
  };
}

export function watchDesktopUpdate(bridge: DesktopUpdateBridge, listener: (update: DesktopUpdate | null) => void): () => void {
  return follow((heard) => bridge.onChange(heard), () => bridge.current(), readDesktopUpdate, listener);
}

/** The app's version and its own check, for Settings → About (app/electron/src/updates.ts AppUpdateState) */
export interface AppUpdate {
  version: string;
  phase: "off" | "idle" | "checking" | "latest" | "downloading" | "ready" | "failed";
  update: string | null;
  percent: number | null;
  error: string | null;
}

export interface AppUpdateBridge extends DesktopUpdateBridge {
  state(): Promise<unknown>;
  onState(listener: (state: unknown) => void): () => void;
  check(): Promise<void>;
}

/** An app from before About's check has the line's bridge alone */
export function appUpdateBridge(): AppUpdateBridge | null {
  const bridge = desktopUpdateBridge() as Partial<AppUpdateBridge> | null;
  return bridge && typeof bridge.state === "function" && typeof bridge.onState === "function" && typeof bridge.check === "function" ? bridge as AppUpdateBridge : null;
}

const APP_PHASES: ReadonlySet<string> = new Set<AppUpdate["phase"]>(["off", "idle", "checking", "latest", "downloading", "ready", "failed"]);

export function readAppUpdate(value: unknown): AppUpdate | null {
  const state = value as Partial<Record<keyof AppUpdate, unknown>> | null;
  if (typeof state?.version !== "string" || state.version === "" || typeof state.phase !== "string" || !APP_PHASES.has(state.phase)) return null;
  const text = (field: unknown) => typeof field === "string" && field !== "" ? field : null;
  // a download and a held update name their version
  if ((state.phase === "downloading" || state.phase === "ready") && text(state.update) === null) return null;
  const percent = typeof state.percent === "number" && Number.isFinite(state.percent) ? Math.min(100, Math.max(0, Math.floor(state.percent))) : null;
  return { version: state.version, phase: state.phase as AppUpdate["phase"], update: text(state.update), percent, error: text(state.error) };
}

export function watchAppUpdate(bridge: AppUpdateBridge, listener: (state: AppUpdate | null) => void): () => void {
  return follow((heard) => bridge.onState(heard), () => bridge.state(), readAppUpdate, listener);
}

export interface DesktopUpdateLine {
  version: string;
  installing: boolean;
  install(): void;
  close(): void;
}

/** Restart to Update, pressed once: held until Ovis answers that it keeps running (a .deb's password prompt cancelled) */
function useInstall(bridge: DesktopUpdateBridge | null): { installing: boolean; install(): void } {
  const [installing, setInstalling] = useState(false);
  const asked = useRef(false);
  const install = useCallback(() => {
    if (!bridge || asked.current) return;
    asked.current = true;
    setInstalling(true);
    const over = () => { asked.current = false; setInstalling(false); };
    void bridge.install().then(over, over);
  }, [bridge]);
  return { installing, install };
}

export function useDesktopUpdate(): DesktopUpdateLine | null {
  const [bridge] = useState(desktopUpdateBridge);
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  const { installing, install } = useInstall(bridge);
  useEffect(() => bridge ? watchDesktopUpdate(bridge, setUpdate) : undefined, [bridge]);
  const version = update?.version ?? null;
  const close = useCallback(() => { if (version !== null) bridge?.close(version); }, [bridge, version]);
  return bridge && update && !update.closed ? { version: update.version, installing, install, close } : null;
}

export interface DesktopAppUpdate {
  state: AppUpdate;
  installing: boolean;
  check(): void;
  install(): void;
}

/** Settings → About's row for the app itself: null in a browser, and until the app has answered */
export function useDesktopAppUpdate(): DesktopAppUpdate | null {
  const [bridge] = useState(appUpdateBridge);
  const [state, setState] = useState<AppUpdate | null>(null);
  const { installing, install } = useInstall(bridge);
  useEffect(() => bridge ? watchAppUpdate(bridge, setState) : undefined, [bridge]);
  const check = useCallback(() => { void bridge?.check().catch(() => {}); }, [bridge]);
  return bridge && state ? { state, installing, check, install } : null;
}
