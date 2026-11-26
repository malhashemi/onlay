/**
 * The contact a push service may use to reach this deployment's operator: the
 * `sub` claim of every VAPID JWT (RFC 8292 §2.1, a `mailto:` or `https:` URI).
 *
 * It is the `PUSH_CONTACT` var when that is a `mailto:` address or an `https:`
 * URL; otherwise the deployment's own service origin (`PUBLIC_ORIGIN`), so a
 * self-hosted instance never names another deployment's contact. With neither
 * usable, there is none and the claim is left out.
 */
export function pushContactOf(
  contact: string | undefined,
  publicOrigin: string | undefined,
): string | undefined {
  const given = contact?.trim() ?? "";
  if (/^mailto:[^\s@/?#]+@[^\s@/?#]+$/i.test(given)) return given;
  const https = urlOf(given);
  if (https?.protocol === "https:" && !https.username && !https.password) return https.href;
  const origin = urlOf(publicOrigin?.trim() ?? "");
  if (origin && (origin.protocol === "https:" || origin.protocol === "http:")) return origin.origin;
  return undefined;
}

function urlOf(raw: string): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
