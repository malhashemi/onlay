// Object-URL lifecycle for screens that mint blob: URLs from async part
// fetches. Two races leak a full-viewport webp for the page lifetime without
// this: a fetch resolving AFTER the screen's dispose() (the URL is minted into
// nowhere), and a re-render/refresh minting fresh URLs while the last cycle's
// wait for teardown to be revoked (detail refreshes every 30s — they
// accumulate). `claim` guards the first; `release` per render cycle stops the
// second; `dispose` is release-forever. One pool per screen instance.

export interface UrlPool {
  /** Blob-URL the bytes. After dispose() the URL is revoked immediately and
   *  null returns — the caller simply skips wiring it. */
  claim(bytes: Uint8Array, mime: string): string | null;
  /** Revoke everything claimed so far — call when a re-render is about to
   *  mint anew (the old URLs' elements are gone with the old render). */
  release(): void;
  /** release() + refuse all future claims (screen teardown). */
  dispose(): void;
}

export function urlPool(): UrlPool {
  let disposed = false;
  let urls: string[] = [];
  const release = (): void => {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
  };
  return {
    claim(bytes, mime) {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      if (disposed) {
        URL.revokeObjectURL(url);
        return null;
      }
      urls.push(url);
      return url;
    },
    release,
    dispose() {
      disposed = true;
      release();
    },
  };
}

// ── the app-lifetime capture-image cache ──────────────────────────────
// A repaint of the SAME look must hand the <img> the SAME blob: URL — a fresh
// URL per render is what made the periodic refresh visibly reload screenshots.
// Keys carry the capture revision, so a genuinely new look (resnap) still gets
// a new URL while every quiet refresh reuses the old one. LRU-bounded; evicting
// (or superseding a revision) revokes. These URLs deliberately OUTLIVE screen
// dispose() — the cache owns them, screens must not pool-claim them.

// Accepted bound: eviction doesn't refcount mounted <img> users, so >48 live
// images could in theory revoke a URL mid-load. No screen mounts more than a
// handful of capture images, and a broken image self-heals on the next repaint
// (the miss poisons the skip guard) — the refcount isn't worth its weight.
const PART_URL_MAX = 48;
const partUrls = new Map<string, string>(); // insertion order = LRU order

export function partUrlKey(
  interactionId: string,
  cap: { captureId: string; revision: number },
  partName: string,
): string {
  return `${interactionId}/${cap.captureId}/r${cap.revision}/${partName}`;
}

export function cachedPartUrl(key: string, bytes: Uint8Array, mime: string): string {
  const hit = partUrls.get(key);
  if (hit) {
    partUrls.delete(key);
    partUrls.set(key, hit); // refresh LRU position
    return hit;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  partUrls.set(key, url);
  if (partUrls.size > PART_URL_MAX) {
    const oldest = partUrls.keys().next().value;
    if (oldest !== undefined) {
      const evicted = partUrls.get(oldest);
      partUrls.delete(oldest);
      if (evicted) URL.revokeObjectURL(evicted);
    }
  }
  return url;
}
