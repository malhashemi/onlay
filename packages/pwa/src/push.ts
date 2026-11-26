// Web Push, window side: permission + subscription lifecycle for the Settings
// row and the boot resync. One browser subscription serves every space: it is
// handed to each space the person sees (`/s/<id>/push/subscribe`), keyed
// server-side by this session. All calls ride the api.ts allowlist — only the
// SW itself (sw.ts) is exempt. The VAPID public key is persisted in IDB at
// subscribe time so the SW's `pushsubscriptionchange` handler can re-subscribe
// with no window alive.

import type { ApiClient, PushSubscriptionJson } from "./api";
import * as api from "./api";

/** What the Settings row renders: capability → permission → subscription. */
export type PushState = "unsupported" | "denied" | "off" | "on";

function supported(): boolean {
  return (
    self.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in self &&
    "Notification" in self
  );
}

/** The VAPID key is base64url of the raw 65-byte uncompressed P-256 point;
 *  `pushManager.subscribe` wants bytes (URL-safe chars, padding restored). */
function serverKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/app/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  return new Uint8Array(a).every((x, i) => x === b[i]);
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  try {
    return (await currentSubscription()) ? "on" : "off";
  } catch {
    return "off";
  }
}

/** Hand one subscription to every space; true when each accepted it. */
async function postToSpaces(
  c: ApiClient,
  spaceIds: readonly string[],
  sub: PushSubscriptionJson,
): Promise<boolean> {
  const results = await Promise.all(spaceIds.map((id) => api.pushSubscribe(c, id, sub)));
  return results.every((r) => r.ok);
}

/** Enable: fetch the server's VAPID key, ask permission, subscribe with the
 *  push service, hand the subscription to every space. Returns the resulting
 *  row state; "error" means the server/push service leg failed (permission
 *  may still be granted — the row simply stays off). */
export async function enablePush(
  c: ApiClient,
  spaceIds: readonly string[],
): Promise<"on" | "denied" | "error"> {
  const first = spaceIds[0];
  if (!first) return "error";
  const cfg = await api.pushConfig(c, first);
  if (!cfg.ok) return "error";
  const perm = await Notification.requestPermission();
  if (perm === "denied") return "denied";
  if (perm !== "granted") return "error"; // prompt dismissed — still askable
  try {
    // `ready` waits for the boot-time registration to activate — but only
    // lean on it when a registration EXISTS, or a failed registration would
    // park this promise (and the Settings button) forever.
    if (!(await navigator.serviceWorker.getRegistration("/app/"))) return "error";
    const reg = await navigator.serviceWorker.ready;
    const keyBytes = serverKeyBytes(cfg.data.vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, keyBytes)) {
      // A subscription minted under a DIFFERENT server key can never be
      // delivered to (VAPID mismatch) — shed it so Enable always heals.
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes,
    });
    // Persist the key BEFORE the POSTs: the SW's pushsubscriptionchange
    // re-subscribe must find it even if rotation strikes immediately.
    await c.store.putVapidKey(cfg.data.vapidPublicKey);
    // The body is PushSubscription.toJSON() verbatim — the server schema
    // validates endpoint+keys and strips anything else.
    const posted = await postToSpaces(c, spaceIds, sub.toJSON() as PushSubscriptionJson);
    return posted ? "on" : "error";
  } catch {
    return "error";
  }
}

/** Disable: drop the local subscription, then each space's row (idempotent).
 *  Either half alone self-heals — a dangling server row dies on the push
 *  service's 404/410, a dangling local subscription is re-POSTed at boot. */
export async function disablePush(c: ApiClient, spaceIds: readonly string[]): Promise<void> {
  try {
    const sub = await currentSubscription();
    await sub?.unsubscribe();
  } catch {
    // best-effort — the server rows below are the half that stops deliveries
  }
  await Promise.all(spaceIds.map((id) => api.pushUnsubscribe(c, id)));
}

/** Boot resync: if permission stands and a live subscription exists, re-POST
 *  it to every space (upsert) — this heals push-service rotation the SW slept
 *  through, and reaches a space joined since. The server's CURRENT VAPID key
 *  is checked first (the same guard enablePush applies): a subscription minted
 *  under a rotated-away key can never be delivered to — shed it and re-mint
 *  under the current key before handing it over. */
export async function resyncPush(c: ApiClient, spaceIds: readonly string[]): Promise<void> {
  const first = spaceIds[0];
  if (!first || !supported() || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/app/");
    let sub = (await reg?.pushManager.getSubscription()) ?? null;
    if (!reg || !sub) return;
    const cfg = await api.pushConfig(c, first);
    if (!cfg.ok) return;
    const keyBytes = serverKeyBytes(cfg.data.vapidPublicKey);
    if (!sameKey(sub.options.applicationServerKey, keyBytes)) {
      await sub.unsubscribe();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes,
      });
    }
    // Same order as enable: persist the key BEFORE the POSTs so the SW's
    // pushsubscriptionchange re-subscribe always finds the current key.
    await c.store.putVapidKey(cfg.data.vapidPublicKey);
    await postToSpaces(c, spaceIds, sub.toJSON() as PushSubscriptionJson);
  } catch {
    // best-effort — the next boot retries
  }
}
