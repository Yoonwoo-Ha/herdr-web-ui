/**
 * The iOS app (app/) opens this client as its WebView's first page and puts Capacitor's bridge
 * on it. Only what the client needs of the app is here, through `window.Capacitor` as the app
 * injects it, so the browser build carries no Capacitor code.
 */
interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
}

function bridge(): CapacitorBridge | undefined {
  return (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
}

/** Whether this page runs inside the iOS app rather than a browser. */
export function inNativeApp(): boolean {
  return bridge()?.isNativePlatform?.() === true;
}

/** Back to the app's list of PCs (app/ios/App/App/HerdrShellPlugin.swift, `disconnect`). */
export async function changePc(): Promise<void> {
  await bridge()?.nativePromise?.("HerdrShell", "disconnect", {});
}
