import { useCallback, useSyncExternalStore } from "react";

interface InstallChoice {
  outcome: "accepted" | "dismissed";
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<InstallChoice>;
}

type Listener = () => void;

let pendingPrompt: BeforeInstallPromptEvent | null = null;
let installedByEvent = false;
let revision = 0;
const listeners = new Set<Listener>();

function emitChange(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): number {
  return revision;
}

function isStandalone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return installedByEvent || iosNavigator.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    pendingPrompt = event as BeforeInstallPromptEvent;
    emitChange();
  });
  window.addEventListener("appinstalled", () => {
    installedByEvent = true;
    pendingPrompt = null;
    emitChange();
  });
  const displayMode = window.matchMedia?.("(display-mode: standalone)");
  displayMode?.addEventListener("change", emitChange);
}

export interface InstallPromptState {
  canInstall: boolean;
  installed: boolean;
  install(): Promise<void>;
}

export function useInstallPrompt(): InstallPromptState {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const installed = isStandalone();
  const install = useCallback(async (): Promise<void> => {
    const prompt = pendingPrompt;
    if (prompt === null || isStandalone()) return;
    await prompt.prompt();
    await prompt.userChoice;
    if (pendingPrompt === prompt) pendingPrompt = null;
    emitChange();
  }, []);
  return { canInstall: pendingPrompt !== null && !installed, installed, install };
}
