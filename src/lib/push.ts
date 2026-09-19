import { fetchPushKey, registerPushSubscription, unregisterPushSubscription } from "./api.ts";

/**
 * This device's web push subscription: pane alerts that arrive with the app closed.
 *
 * Needs a service worker and PushManager, which exist only in secure contexts (https or
 * localhost) - and on iPhone only in the app added to the home screen. Everywhere else
 * pushSupported() is false and the bell keeps tab-only alerts (lib/notifications.ts).
 */

/** How long to wait for the service worker before giving up on push for this page load. */
const WORKER_READY_TIMEOUT_MS = 10_000;

export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof globalThis.PushManager !== "undefined";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameKey(current: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (!current || current.byteLength !== expected.length) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, index) => byte === expected[index]);
}

/** navigator.serviceWorker.ready never settles when registration failed; bound it. */
async function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), WORKER_READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The subscription being made right now, shared by every caller that arrives meanwhile. */
let pending: Promise<string | null> | null = null;

/**
 * Subscribes this device (reusing a live subscription) and registers it with the server.
 * Idempotent, so it also runs on every load: a server that lost its state gets the device
 * back without a click. Resolves the endpoint, or null when push is not available here.
 *
 * Single-flight: the bell's first tap grants permission, which also starts App's
 * load-time registration. Two overlapping `subscribe()` calls make Chrome issue TWO
 * subscriptions and keep only the later one, so the confirmation push could go to a
 * dead endpoint. Concurrent callers therefore share one attempt.
 */
export function ensurePushSubscription(): Promise<string | null> {
  pending ??= subscribeDevice().finally(() => {
    pending = null;
  });
  return pending;
}

async function subscribeDevice(): Promise<string | null> {
  if (!pushSupported() || globalThis.Notification?.permission !== "granted") return null;
  const registration = await workerRegistration();
  if (!registration) return null;
  const key = keyBytes(await fetchPushKey());
  let subscription = await registration.pushManager.getSubscription();
  // made for another server key (the server's state dir was reset): it can never receive our pushes
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await registerPushSubscription(subscription.toJSON());
  return subscription.endpoint;
}

/** Stops pushes to this device: the server forgets it first, then the browser drops it. */
export async function removePushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  try {
    await unregisterPushSubscription(subscription.endpoint);
  } finally {
    await subscription.unsubscribe();
  }
}
