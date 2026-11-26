// The one URL redaction (AGENTS.md, "One redaction policy"): origin + path,
// a dropped query or fragment left as a literal `?…`, non-web schemes cut to
// the scheme alone. Pure, so the service worker uses it too (`hostUrl`).

/**
 * A URL cut to origin + path; a dropped query or fragment becomes a literal
 * `?…` so a reader can tell something was there. Null when it does not parse.
 */
export function redactUrl(value: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(value.trim(), base);
  } catch {
    return null;
  }
  // Non-web schemes (data:, blob:, javascript:, mailto:, …) keep only the
  // scheme: their "path" is the payload (an embedded image, an address).
  if (u.protocol !== "http:" && u.protocol !== "https:") return u.protocol;
  const dropped = u.search !== "" || u.hash !== "";
  const head = `${u.origin}${u.pathname}`;
  return dropped ? `${head}?…` : head;
}
