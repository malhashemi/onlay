// `crypto.randomUUID` exists only in SECURE contexts, and a content script
// inherits the page's secure-context status — on a plain-http page it is
// simply absent, and calling it threw synchronously mid-create (F2: button
// disabled, no receipt, no toast). `getRandomValues` has no secure-context
// gate, so a v4 built from it works on every page the overlay can visit.
export function uuid4(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] as number) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
