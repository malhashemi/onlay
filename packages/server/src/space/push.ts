import { type InteractionState, needsActor } from "@onlay/kernel";
import { flattenFences } from "@onlay/protocol";
import type { PushSubscriptionRow } from "./push-store";
import { canSee, personSummary, type Runtime, revokedHere, rowText, storedAccess } from "./runtime";
import { pushTopicOf, sendWebPush, type VapidKeys } from "./webpush";

/**
 * Web Push triggering — server-authoritative: a push fires exactly when a
 * mutation moves an interaction INTO a subscriber's needs-you set (the kernel
 * `needsActor` semantics, nothing more). The diff is between the state before
 * and after the one mutation, so it needs no memory that eviction could lose,
 * and it is self-action-safe: `needsActor` never adds you for your own
 * message. A subscriber only hears about interactions their access shows.
 */

const PUSH_TTL_SECONDS = 24 * 3600;
const PUSH_BODY_MAX = 120;

type Because = NonNullable<ReturnType<typeof needsActor>>;

const PHRASE: Record<Because, string> = {
  "waiting-on": "needs you",
  mentioned: "mentioned you",
  "thread-reply": "replied",
  verify: "ready to verify",
  "agent-answered": "an agent answered",
  shared: "shared a thread with you",
  "waiting-on-agent": "waiting on an agent",
};

/** The encrypted payload the web app's service worker shows. */
interface PushPayload {
  interactionId: string;
  spaceId?: string;
  kind: InteractionState["kind"];
  title: string;
  body: string;
  url: string;
}

/** The newest voiced (non-system, non-deleted) message. */
function latestVoicedMsg(s: InteractionState) {
  for (let i = s.thread.length - 1; i >= 0; i--) {
    const m = s.thread[i];
    if (m && !m.system && !m.deleted) return m;
  }
  return undefined;
}

/**
 * The deployment's VAPID keys, or null when the deployment has none: then web
 * push is off. Keys are deployment-wide by design: the web app holds one push
 * subscription and hands it to every space, so every space must sign with the
 * same key.
 */
export function vapidKeysOf(rt: Runtime): VapidKeys | null {
  return rt.deps.vapid ?? null;
}

/** Rides every accepted interaction mutation; delivery never blocks it. */
/**
 * The browser push services a subscription may name (exact hosts, or a
 * `.suffix` for any host under it). The space POSTs to the endpoint, so
 * nothing else is accepted (the security audit's SSRF finding).
 */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  ".push.apple.com",
  ".notify.windows.com",
] as const;

function isPushService(host: string): boolean {
  return PUSH_SERVICE_HOSTS.some((entry) =>
    entry.startsWith(".") ? host.endsWith(entry) && host.length > entry.length : host === entry,
  );
}

/** Why an endpoint is refused: https on the default port, no credentials, a known push service. */
export function pushEndpointRefusal(endpoint: string, allowHttp: boolean): string | null {
  const u = new URL(endpoint);
  if (u.username !== "" || u.password !== "") return "endpoint-credentials";
  // Tests only: a local receiver over http.
  if (allowHttp && u.protocol === "http:") return null;
  if (u.protocol !== "https:") return "endpoint-not-https";
  if (u.port !== "") return "endpoint-port";
  if (!isPushService(u.hostname.toLowerCase())) return "endpoint-not-push-service";
  return null;
}

/** How long a subscription's stored access is trusted without a re-subscribe (the web app renews at boot). */
const PUSH_ACCESS_MAX_AGE_MS = 30 * 86_400_000;

export function pushOnMutation(
  rt: Runtime,
  prev: InteractionState | undefined,
  next: InteractionState,
): void {
  const vapid = vapidKeysOf(rt);
  if (!vapid) return; // push is off in this deployment
  const rows = rt.pushStore.listAll();
  if (rows.length === 0) return;
  const threadDriven =
    latestVoicedMsg(next)?.msgId !== undefined &&
    latestVoicedMsg(next)?.msgId !== (prev ? latestVoicedMsg(prev)?.msgId : undefined);
  const now = rt.clock.now();
  for (const row of rows) {
    // Access stored on a subscription older than this, never renewed by the
    // web app re-subscribing, is not trusted: the row goes.
    if (now - row.createdAt > PUSH_ACCESS_MAX_AGE_MS) {
      rt.pushStore.remove(row.credentialId);
      rt.log("push-expired", { credentialId: row.credentialId });
      continue;
    }
    // The destination is checked again at every delivery: a stored row that
    // no longer passes the allowlist is deleted, never sent to.
    const refused = endpointRefused(row.subscription.endpoint, rt.deps.allowHttpPush === true);
    if (refused) {
      rt.pushStore.remove(row.credentialId);
      rt.log("push-destination-refused", { credentialId: row.credentialId, reason: refused });
      continue;
    }
    // The subscribing credential still counts, and the person's CURRENT access
    // (kept right by controls and re-validation) decides, never the scope
    // stored with the subscription (R3-S3).
    if (revokedHere(rt, row.personId, row.credentialId, row.credentialGeneration)) {
      rt.pushStore.remove(row.credentialId);
      rt.log("push-revoked", { credentialId: row.credentialId });
      continue;
    }
    const current = storedAccess(rt, row.personId)?.access ?? null;
    if (current === null || !canSee(current, next.id)) continue;
    const because = needsActor(next, row.personId);
    if (!because) continue;
    if (prev && needsActor(prev, row.personId)) continue; // already needed them
    const delivery = deliver(rt, vapid, row, next, because, threadDriven);
    rt.deps.waitUntil?.(delivery);
  }
}

async function deliver(
  rt: Runtime,
  vapid: VapidKeys,
  row: PushSubscriptionRow,
  s: InteractionState,
  because: Because,
  threadDriven: boolean,
): Promise<void> {
  const voicedMsg = latestVoicedMsg(s);
  const voiceId = threadDriven
    ? (voicedMsg?.authorId ?? s.authorId)
    : s.kind === "ask" && s.state === "answered"
      ? (s.ask?.answers.at(-1)?.actorId ?? s.authorId)
      : s.authorId;
  const voice = personSummary(rt, voiceId).name;
  // A notification is a preview: each fenced block reduced to its code, before the cut.
  const preview = threadDriven && voicedMsg ? flattenFences(voicedMsg.body.text) : rowText(s, true);
  const spaceId = rt.deps.spaceId;
  const payload: PushPayload = {
    interactionId: s.id,
    ...(spaceId ? { spaceId } : {}),
    kind: s.kind,
    title: `${voice} · ${PHRASE[because]}`,
    body: preview.slice(0, PUSH_BODY_MAX),
    url: spaceId ? `/app/#/t/${spaceId}/${s.id}` : `/app/#/i/${s.id}`,
  };
  try {
    const status = await sendWebPush(
      { endpoint: row.subscription.endpoint, keys: row.subscription.keys },
      new TextEncoder().encode(JSON.stringify(payload)),
      {
        vapid,
        ...(rt.deps.pushContact ? { subject: rt.deps.pushContact } : {}),
        topic: pushTopicOf(s.id),
        ttlSeconds: PUSH_TTL_SECONDS,
        now: rt.clock.now(),
        ...(rt.deps.fetch ? { fetch: rt.deps.fetch } : {}),
      },
    );
    if (status === 404 || status === 410) {
      // The push service says this subscription is gone — drop it, but only
      // while the stored row still carries the endpoint that failed.
      const stored = rt.pushStore.listAll().find((r) => r.credentialId === row.credentialId);
      if (stored?.subscription.endpoint === row.subscription.endpoint) {
        rt.pushStore.remove(row.credentialId);
        rt.log("push-dropped", { credentialId: row.credentialId, status });
      }
    } else if (status >= 400) {
      rt.log("push-refused", { credentialId: row.credentialId, status });
    } else {
      rt.log("push-sent", { credentialId: row.credentialId, interactionId: s.id, status });
    }
  } catch (err) {
    rt.log("push-failed", {
      credentialId: row.credentialId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** `pushEndpointRefusal`, for a stored endpoint that may not even parse. */
function endpointRefused(endpoint: string, allowHttp: boolean): string | null {
  try {
    return pushEndpointRefusal(endpoint, allowHttp);
  } catch {
    return "endpoint-invalid";
  }
}
