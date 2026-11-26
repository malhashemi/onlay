// The residue recorder (Stage 1 capture spec §6).
//
// Residue is the closed, honest enumeration of everything a capture could not
// faithfully reproduce. The canonical `ResidueClass` union + `ResidueEntry`
// shape are the shared wire truth in `@onlay/protocol` (file-plan item 1);
// server/CLI/PWA and this extension all read the SAME enum from there. This
// module re-exports them and layers on the recorder the walker / harvest /
// witness feed — no local copy of the enum survives (truth lives in protocol).
//
// Recording rules (§6): `declined-grant` is deduped per-origin (one entry per
// distinct origin, carrying that origin); every other class is deduped
// per-class with a count. Bounds: ≤ MAX_RESIDUE_ENTRIES entries, ≤
// MAX_RESIDUE_ORIGINS distinct declined-grant origins (excess origins collapse
// into one counted origin-less entry), `detail` ≤ MAX_RESIDUE_DETAIL chars.
import { RESIDUE_CLASSES, type ResidueClass, type ResidueEntry } from "@onlay/protocol";
import { CAPTURE_LIMITS } from "./limits";

export { RESIDUE_CLASSES, type ResidueClass, type ResidueEntry };

/** The residue classes that say why a look kept no screenshot (L-3). */
export type ScreenshotDrop = Extract<ResidueClass, `screenshot-${string}`>;

/** Accumulates residue during a walk/harvest/witness pass, deduped + bounded. */
export class ResidueLog {
  /** declined-grant entries, one per distinct origin, in first-seen order. */
  private readonly declined: ResidueEntry[] = [];
  private readonly declinedSeen = new Set<string>();
  /** Every other class, deduped by class with a running count. */
  private readonly byClass = new Map<ResidueClass, ResidueEntry>();

  /** Record one residue occurrence. */
  add(cls: ResidueClass, opts: { origin?: string; detail?: string } = {}): void {
    const detail = opts.detail?.slice(0, CAPTURE_LIMITS.MAX_RESIDUE_DETAIL);
    if (cls === "declined-grant") {
      const origin = opts.origin ?? "";
      if (this.declinedSeen.has(origin)) return; // dedup per origin
      this.declinedSeen.add(origin);
      this.declined.push({
        class: cls,
        ...(origin ? { origin } : {}),
        ...(detail ? { detail } : {}),
      });
      return;
    }
    const existing = this.byClass.get(cls);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      return;
    }
    this.byClass.set(cls, { class: cls, count: 1, ...(detail ? { detail } : {}) });
  }

  /** Convenience for the common declined-grant path. */
  declinedGrant(origin: string, detail?: string): void {
    this.add("declined-grant", { origin, ...(detail ? { detail } : {}) });
  }

  /**
   * Absorb already-deduped entries (e.g. the walker's `toArray()` output) into
   * this log, PRESERVING counts + origins, so the pipeline legs (harvest, the
   * witness) keep accumulating onto one accumulator that upload flattens back to
   * `meta.residue`. Re-adding via `add()` would reset counts to 1; this merges.
   */
  seed(entries: readonly ResidueEntry[]): void {
    for (const e of entries) {
      if (e.class === "declined-grant") {
        const origin = e.origin ?? "";
        if (this.declinedSeen.has(origin)) continue;
        this.declinedSeen.add(origin);
        this.declined.push({ ...e });
        continue;
      }
      const existing = this.byClass.get(e.class);
      if (existing) existing.count = (existing.count ?? 1) + (e.count ?? 1);
      else this.byClass.set(e.class, { ...e });
    }
  }

  /** True when nothing has been recorded (drives the "Captured from the live page." copy). */
  isEmpty(): boolean {
    return this.declined.length === 0 && this.byClass.size === 0;
  }

  /** Why the screenshot was dropped, said once: the first reason recorded is the one kept. */
  screenshotDropped(cls: ScreenshotDrop): void {
    for (const c of this.byClass.keys()) if (c.startsWith("screenshot-")) return;
    this.add(cls);
  }

  /** True when at least one occurrence of `cls` was recorded (F31 gate reads). */
  has(cls: ResidueClass): boolean {
    return cls === "declined-grant" ? this.declined.length > 0 : this.byClass.has(cls);
  }

  /**
   * The bounded, deduped entry list for `meta.residue`. Declined-grant origins
   * past MAX_RESIDUE_ORIGINS collapse into one origin-less counted entry; the
   * whole list is capped at MAX_RESIDUE_ENTRIES.
   */
  toArray(): ResidueEntry[] {
    // Why a screenshot was dropped comes first, so the entry cap never cuts it.
    const shot = (e: ResidueEntry): number => (e.class.startsWith("screenshot-") ? 0 : 1);
    const out: ResidueEntry[] = [...this.byClass.values()].sort((a, b) => shot(a) - shot(b));
    const kept = this.declined.slice(0, CAPTURE_LIMITS.MAX_RESIDUE_ORIGINS);
    out.push(...kept);
    const overflow = this.declined.length - kept.length;
    if (overflow > 0) out.push({ class: "declined-grant", count: overflow });
    return out.slice(0, CAPTURE_LIMITS.MAX_RESIDUE_ENTRIES);
  }
}
