// The capture pipeline's stable, insecure-context-safe ref hash.
//
// FNV-1a 32-bit → 8 hex. Used to mint `{{asset:<ref>}}` / `{{font:<ref>}}`
// placeholder ids whose suffix IS the part-name suffix (`asset-<ref>` /
// `font-<ref>`), so the renderer resolves them by exact name equality (capture
// D11). It is deliberately synchronous and crypto-free: the captured PAGE may be
// an insecure context (plain-http tailnet remote) where `crypto.subtle` is
// undefined, so the walker + harvest cannot content-address by real sha here —
// the wire `sha256` (dedup/possession) is computed later in the SW (A16). Walker
// and harvest share THIS function so an asset referenced both inline (computed
// `background-image`) and in harvested author CSS collapses to one part.
export function fnv8(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
