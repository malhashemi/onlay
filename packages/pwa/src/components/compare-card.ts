// The compare card — the informed-decision surface (F30), living IN the
// change's card on the thread screen (F33: no separate page — the F29 law
// again: the decision happens where the change lives). Stops (Original,
// variant 1..n) × rungs: every stop shows its BEST evidence — the variant's
// own live-page witness raster (rung 2, minted by the extension's automatic
// pass) when one exists, else the reconstruction through the SHARED renderer
// (rung 3/4). The trust line names the rung; Pick prominence follows the
// evidence pair (variantRungVerdict — the one shared law); press-and-hold
// flashes the ORIGINAL's LIKE evidence (witness↔witness or recon↔recon,
// never mixed) in a height-pinned stage. Per-variant comments ride the
// interaction thread (D-VARIANT-COMMENT); pick/discard ride the participant
// routes. Refresh (F24) re-pulls interaction AND set — witnesses land on the
// interaction's captures, the set carries versions; a witness NEWER than the
// cached set forces a set refetch (mixed cache generations, never mislabeled
// pixels). The card owns the change's hero slot only while the DECISION is
// open (set generating/previewing) — a pick or discard hands the slot back to
// the plain hero (its look history and lightbox must not stay buried; the
// decision's record lives in the thread). `onGone` fires when there is
// nothing left to decide (no set, unlinked, post-decision, unreadable).

import type {
  CaptureRef,
  MutationOp,
  MutationProgram,
  RawInteractionSnapshot,
} from "@onlay/protocol";
import { buildSrcdoc, type RenderResidue } from "@onlay/render";
import {
  age,
  anchorLabel,
  collectResidue,
  editContextCapture,
  flatRasterRef,
  hasFutureVariantLook,
  hostOf,
  originalRungLine,
  residueCopy,
  shownUrl,
  type VariantLook,
  variantLooks,
  variantRungLine,
  variantRungVerdict,
} from "@onlay/render/interaction-view";
import { sameRevision, withPrefix } from "@onlay/render/mentions";
import type { Fail, VariantSummary } from "../api";
import * as api from "../api";
import type { AppCtx } from "../context";
import { button, clear, el } from "../dom";
import { mentionCtx } from "../mention-ctx";
import { urlPool } from "../object-urls";
import { clientIdFor, confirmSend } from "../send-ids";
import { draftKey, webUrl } from "../view-model";
import { type Composer, composer } from "./composer";
import { fencedText } from "./rich-text";
import { failureToast, toast } from "./toast";

/** Headroom under the protocol's 4096 text bound for the variant prefix line. */
const COMMENT_CAP = 4000;

export interface CompareCard {
  node: HTMLElement;
  refresh(): Promise<boolean>;
  dispose(): void;
}

export interface CompareCardOpts {
  /** Nothing to compare (no set / unlinked / unreadable) — fall back to the hero. */
  onGone(): void;
  /** Mounts the thread's "⟳ Fresh look" duty in the card's action row (the
   *  Original's freshness is part of the decision). Absent = not offered. */
  onFreshLook?: () => void;
  /** Discard is a member's; a guest may only pick. */
  canDiscard: boolean;
}

export function compareCard(
  ctx: AppCtx,
  spaceId: string,
  id: string,
  opts: CompareCardOpts,
): CompareCard {
  // The embed wrapper renders as nothing (display: contents) — the card and
  // the comment composer stack as siblings in the detail body, exactly as the
  // retired screen laid them out.
  const node = el("div", "compare-embed");

  // index -1 = Original; 0..n-1 = variants
  let index = -1;
  let cap: CaptureRef | null = null;
  let setId: string | null = null;
  /** The set's lifecycle: Pick/Discard/comment only while `previewing`. */
  let setStatus = "";
  /** The interaction snapshot behind the card — intent + source line context. */
  let snap: RawInteractionSnapshot | null = null;
  let gone = false;
  const markGone = (): void => {
    if (gone) return;
    gone = true;
    opts.onGone();
  };
  // In-flight initial load, retained so a live tick arriving mid-boot AWAITS it
  // instead of racing a second load whose build() would reset the selected stop
  // and flush an open composer (codex-f33-5).
  let pending: Promise<boolean> | null = null;
  let variants: VariantSummary[] = [];
  let looks = new Map<string, VariantLook>();
  const urls = urlPool();
  const frames = new Map<
    number,
    {
      iframe: HTMLIFrameElement;
      built: Promise<void>;
      residue: RenderResidue | null;
      failed: boolean;
    }
  >();
  /** Object URLs for witness rasters, keyed by captureId (session-only). */
  const witnessUrls = new Map<string, Promise<string | null>>();
  /** Witness fetches that came back empty — the stop falls to the recon rung
   *  instead of wearing a live-capture label over a blank stage. */
  const failedWitness = new Set<string>();
  let originalFrameFailed: boolean | null = null;

  const card = el("section", "hero-card cap-card");
  card.setAttribute("data-kind", "edit");
  const stage = el("div", "cap-stage");
  const holdLayer = el("div", "cap-hold-layer");
  holdLayer.hidden = true;
  stage.append(holdLayer);
  // F32 — the honest empty stage: with NO committed capture and no witness for
  // this stop, say so instead of presenting a silent blank (the trust line names
  // the rung; this names the duty and the recovery).
  const emptyStage = el("div", "cap-empty-stage");
  emptyStage.hidden = true;
  stage.append(emptyStage);
  const nav = el("div", "cap-nav");
  const trust = el("div", "cap-trust");
  const meter = el("div", "cap-meter");
  const program = el("div", "cap-program");
  const actions = el("div", "cap-actions");
  const commentWrap = el("div", "cap-comment");

  let lastKey = "";
  let renderGen = 0;

  /* ── evidence resolution ── */

  // A raster that stayed FLAT through the capture-side retry is metered
  // `flat-raster` — it must not anchor rung-1/2 trust or like-evidence pairing
  // (codex-4): the stop falls to the reconstruction rung like a missing witness.
  const capWitness = (): boolean =>
    (cap?.parts.some((p) => p.role === "witness" || p.name === "witness") ?? false) &&
    !flatRasterRef(cap);

  function lookOf(i: number): VariantLook | undefined {
    const v = i >= 0 ? variants[i] : undefined;
    return v ? looks.get(v.variantId) : undefined;
  }

  /** A stop shows a WITNESS raster when: Original with a captured screenshot,
   *  or a variant with a fresh (non-stale) variant-look. Stale looks fall to
   *  the reconstruction (their raster still serves the hold when recon fails). */
  function witnessRefOf(i: number): { ref: CaptureRef; part: string } | null {
    if (i < 0) {
      if (!cap || !capWitness() || failedWitness.has(cap.captureId)) return null;
      return { ref: cap, part: "witness" };
    }
    const look = lookOf(i);
    if (!look || look.stale || failedWitness.has(look.ref.captureId) || flatRasterRef(look.ref)) {
      return null;
    }
    return { ref: look.ref, part: "witness" };
  }

  function witnessUrl(ref: CaptureRef): Promise<string | null> {
    let p = witnessUrls.get(ref.captureId);
    if (!p) {
      const persist = ref.kind !== "variant-look"; // sol-14: varlook pixels stay off IDB
      p = api.part(ctx.client, spaceId, id, ref.captureId, "witness", { persist }).then((bytes) => {
        if (!bytes) {
          // Never cache a miss (a transient failure must retry), and demote the
          // stop honestly — a blank stage must not wear the live-capture label.
          witnessUrls.delete(ref.captureId);
          failedWitness.add(ref.captureId);
          return null;
        }
        const mime = ref.parts.find((x) => x.role === "witness")?.mime ?? "image/webp";
        return urls.claim(bytes, mime);
      });
      witnessUrls.set(ref.captureId, p);
    }
    return p;
  }

  function originalTrusted(): boolean {
    if (capWitness()) return true;
    if (!cap) return false;
    return originalFrameFailed === false;
  }

  function verdictOf(i: number) {
    if (i < 0) return null;
    const frame = frames.get(i);
    // Like-evidence pairing (codex-high): a variant WITNESS is only fully
    // trusted beside a witness ORIGINAL — a lossy reconstruction on the other
    // side of the flip can't anchor a rung-2 primary Pick.
    const trusted = witnessRefOf(i) !== null ? capWitness() : originalTrusted();
    // A flat or unfetchable raster anchors NO rung-2 verdict (codex-f34-1):
    // the stop shows — and is judged as — its reconstruction.
    const raw = lookOf(i);
    const look =
      raw && !flatRasterRef(raw.ref) && !failedWitness.has(raw.ref.captureId) ? raw : undefined;
    return variantRungVerdict({
      look,
      render: frame?.residue ?? null,
      renderFailed: frame?.failed === true || (!cap && !witnessRefOf(i)),
      originalTrusted: trusted,
    });
  }

  /* ── data loading (F24: both reads, one truth) ── */

  async function load(): Promise<boolean> {
    const res = await api.interaction(ctx.client, spaceId, id);
    if (gone) return true; // disposed/superseded mid-flight — never rebuild
    if (!res.ok) {
      // SEMANTIC gone only (codex-f33-2): a collapsed-404 means this will never
      // read; a transient failure keeps the card (empty) and the F24 fallback
      // interval armed — the next tick retries through refresh() → load().
      if (res.verdict === "hidden") markGone();
      return false;
    }
    const s = res.data.interaction;
    snap = s;
    cap = editContextCapture(s);
    setId = s.change?.variantSetId ?? null;
    if (!setId) {
      markGone();
      return !res.fromCache;
    }
    let setRes = await api.variantSet(ctx.client, spaceId, setId);
    if (gone) return true;
    if (!setRes.ok) {
      if (setRes.verdict === "hidden") markGone();
      return false;
    }
    // Mixed cache generations (sol-14): a witness NEWER than the set copy in
    // hand means the set read is stale — one forced refetch reconciles.
    if (setRes.fromCache && hasFutureVariantLook(s, setId, setRes.data.set.variants)) {
      const fresh = await api.variantSet(ctx.client, spaceId, setId);
      if (fresh.ok && !fresh.fromCache) setRes = fresh;
    }
    variants = setRes.data.set.variants;
    setStatus = setRes.data.set.status ?? "";
    // Post-decision (picked/discarded/implementing/…): nothing left to decide —
    // the hero takes the slot back. A set never returns to previewing, so the
    // hand-back is final for this set.
    if (setStatus !== "previewing" && setStatus !== "generating") {
      markGone();
      return !res.fromCache && !setRes.fromCache;
    }
    looks = variantLooks(s, setId, variants);
    lastKey = truthKey(s.captures ?? []);
    build();
    return !res.fromCache && !setRes.fromCache;
  }

  function truthKey(captures: readonly CaptureRef[]): string {
    return JSON.stringify([
      variants,
      setStatus,
      cap?.captureId,
      captures
        .filter((c) => c.kind === "variant-look")
        .map((c) => [c.captureId, c.variantId, c.variantVersion, c.revision]),
    ]);
  }

  // Live refresh (F24): witnesses land one-by-one while this card is mounted —
  // each commit ticks, each tick lands here. Unchanged truth leaves the DOM
  // alone (open composer, hold state, zoom of attention all survive).
  async function refresh(): Promise<boolean> {
    if (gone) return true;
    if (pending) return pending; // the boot load is still in flight — one truth
    if (!setId) {
      pending = load().finally(() => {
        pending = null;
      });
      return pending;
    }
    const res = await api.interaction(ctx.client, spaceId, id);
    if (gone) return true;
    if (!res.ok || res.fromCache) return false;
    const s = res.data.interaction;
    snap = s;
    if (!s.change?.variantSetId) {
      // The set was unlinked (a reopen spends it, F26) — nothing to compare.
      markGone();
      return true;
    }
    let setRes = await api.variantSet(ctx.client, spaceId, setId);
    if (gone) return true;
    if (!setRes.ok) return false;
    if (hasFutureVariantLook(s, setId, setRes.data.set.variants)) {
      const fresh = await api.variantSet(ctx.client, spaceId, setId);
      if (fresh.ok && !fresh.fromCache) setRes = fresh;
    }
    cap = editContextCapture(s);
    const nextVariants = setRes.data.set.variants;
    const nextStatus = setRes.data.set.status ?? "";
    if (nextStatus !== "previewing" && nextStatus !== "generating") {
      markGone();
      return !setRes.fromCache; // gone is a truth too — but only live truth counts
    }
    const key = JSON.stringify([
      nextVariants,
      nextStatus,
      cap?.captureId,
      (s.captures ?? [])
        .filter((c) => c.kind === "variant-look")
        .map((c) => [c.captureId, c.variantId, c.variantVersion, c.revision]),
    ]);
    if (key === lastKey) return !setRes.fromCache;
    lastKey = key;
    variants = nextVariants;
    setStatus = nextStatus;
    looks = variantLooks(s, setId, variants);
    renderGen += 1;
    for (const [, f] of frames) f.iframe.remove();
    frames.clear();
    // New truth invalidates the witness caches too (codex-critical): a revised
    // variant's NEW captureId must never paint through an index-keyed old img.
    // The blob URLs behind them are released with the pool (codex-f33-6) — the
    // card now lives as long as the detail mount, so a revise storm must not
    // accumulate full-page rasters. (An in-flight fetch claiming after this
    // release stays pooled until dispose — bounded, not leaked.)
    for (const [, img] of witnessImgs) img.remove();
    witnessImgs.clear();
    witnessUrls.clear();
    urls.release();
    failedWitness.clear();
    originalFrameFailed = null;
    index = Math.min(index, variants.length - 1);
    void show(index);
    return !setRes.fromCache;
  }

  /* ── the stage ── */

  function fetchPart(name: string): Promise<Uint8Array | null> {
    if (!cap) return Promise.resolve(null);
    return api.part(ctx.client, spaceId, id, cap.captureId, name);
  }

  function frameFor(i: number) {
    const existing = frames.get(i);
    if (existing) return existing;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "");
    iframe.className = "cap-frame";
    iframe.hidden = true;
    stage.appendChild(iframe);
    const prog = i < 0 ? undefined : (variants[i]?.program as MutationProgram | undefined);
    const rec = {
      iframe,
      built: Promise.resolve(),
      residue: null as RenderResidue | null,
      failed: false,
    };
    rec.built = buildSrcdoc(
      prog === undefined
        ? { ref: cap as CaptureRef, fetchPart }
        : { ref: cap as CaptureRef, fetchPart, program: prog },
    ).then((r) => {
      iframe.srcdoc = r.srcdoc;
      rec.residue = r.residue;
      rec.failed = r.failed === true;
      if (i === -1) originalFrameFailed = rec.failed;
    });
    frames.set(i, rec);
    return rec;
  }

  const witnessImgs = new Map<number, HTMLImageElement>();
  function witnessImgFor(i: number, ref: CaptureRef): HTMLImageElement {
    const existing = witnessImgs.get(i);
    if (existing) return existing;
    const img = el("img", "cap-witness-stage") as HTMLImageElement;
    img.alt = i < 0 ? "original — captured screenshot" : "variant — captured on the live page";
    img.hidden = true;
    stage.appendChild(img);
    void witnessUrl(ref).then((u) => {
      if (u) img.src = u;
      // Bytes never arrived: re-show falls to the reconstruction rung.
      else if (index === i) void show(i);
    });
    witnessImgs.set(i, img);
    return img;
  }

  async function show(i: number): Promise<void> {
    const g = renderGen;
    index = i;
    const wit = witnessRefOf(i);
    if (wit) {
      witnessImgFor(i, wit.ref);
    } else if (cap) {
      const rec = frameFor(i);
      await rec.built;
      if (g !== renderGen || index !== i) return;
    }
    for (const [, f] of frames) f.iframe.hidden = true;
    for (const [, img] of witnessImgs) img.hidden = true;
    emptyStage.hidden = true;
    if (wit) {
      const img = witnessImgs.get(i);
      if (img) img.hidden = false;
    } else if (cap) {
      const frame = frames.get(i);
      if (frame) frame.iframe.hidden = false;
    } else {
      emptyStage.textContent =
        i < 0
          ? "The original page hasn't been captured yet. The extension uploads it while the page is open — open the page again and it will retry."
          : "No screenshot of this variant has landed yet. The extension captures one while the page is open.";
      emptyStage.hidden = false;
    }
    renderNav();
    renderTrust();
    renderProgram();
    renderActions();
    // pre-build recon neighbours while idle (the hold layer + fallbacks)
    prebuild(i + 1);
    prebuild(i - 1);
  }

  function prebuild(i: number): void {
    if (!cap || i < -1 || i >= variants.length || frames.has(i)) return;
    const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    const run = () => {
      if (!frames.has(i)) frameFor(i);
    };
    if (idle) idle(run);
    else setTimeout(run, 120);
  }

  /* ── press-and-hold: the original's LIKE evidence, height pinned ── */

  let holding = false;
  function startHold(): void {
    if (holding || index < 0) return;
    const showingWitness = witnessRefOf(index) !== null;
    holding = true;
    stage.style.minHeight = `${stage.getBoundingClientRect().height}px`;
    clear(holdLayer);
    if (showingWitness && cap && capWitness()) {
      const img = el("img", "cap-witness-stage") as HTMLImageElement;
      img.alt = "original — captured screenshot";
      void witnessUrl(cap).then((u) => {
        if (u) img.src = u;
      });
      holdLayer.append(img);
    } else if (cap) {
      const rec = frameFor(-1);
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "");
      iframe.className = "cap-frame";
      holdLayer.append(iframe);
      // The prebuild may still be in flight — populate when it lands (a clone
      // taken before srcdoc is set would hold a blank layer forever).
      void rec.built.then(() => {
        if (holding) iframe.srcdoc = rec.iframe.srcdoc;
      });
    } else {
      holding = false;
      stage.style.minHeight = "";
      return;
    }
    holdLayer.hidden = false;
    renderTrust();
  }
  function endHold(): void {
    if (!holding) return;
    holding = false;
    holdLayer.hidden = true;
    clear(holdLayer);
    stage.style.minHeight = "";
    renderTrust();
  }
  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  stage.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted) return;
    startHold();
  });
  stage.addEventListener("pointerup", endHold);
  stage.addEventListener("pointercancel", endHold);
  stage.addEventListener("pointerleave", endHold);

  /* ── chrome ── */

  function build(): void {
    clear(node);
    clear(card);
    // Top-down (the F28 grammar): what this card is doing, the intent, THEN
    // the stops with their evidence, trust, words, and the decision controls.
    card.append(el("span", "hero-label", "Editing"));
    if (snap?.change?.intent) card.append(fencedText("p", "hero-question", snap.change.intent));
    card.append(nav, stage, trust, meter, program, actions);
    const source = sourceLine();
    if (source) card.append(source);
    node.append(card, commentWrap);
    void show(-1);
  }

  /** The hero card's source line, kept on the embed: anchor · host ↗. */
  function sourceLine(): HTMLElement | null {
    if (!snap) return null;
    const parts: (string | HTMLElement)[] = [];
    if (snap.anchor.level !== "unanchored") parts.push(anchorLabel(snap.anchor));
    const host = hostOf(shownUrl(snap));
    const pageUrl = webUrl(shownUrl(snap));
    if (pageUrl && host) {
      const link = el("a", "hero-link", host) as HTMLAnchorElement;
      link.href = pageUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.append(" ↗");
      parts.push(link);
    } else if (host) {
      parts.push(host);
    }
    if (parts.length === 0) return null;
    const source = el("p", "hero-source");
    parts.forEach((p, i) => {
      if (i > 0) source.append(document.createTextNode(" · "));
      source.append(typeof p === "string" ? document.createTextNode(p) : p);
    });
    return source;
  }

  function renderNav(): void {
    clear(nav);
    const label = index < 0 ? "Original" : variants[index]?.label || `#${index + 1}`;
    const prev = button("icon-btn", "‹", () => void show(Math.max(-1, index - 1)));
    const next = button("icon-btn", "›", () => void show(Math.min(variants.length - 1, index + 1)));
    prev.setAttribute("aria-label", "Previous variant");
    next.setAttribute("aria-label", "Next variant");
    nav.append(prev, el("span", "cap-label", label), next);
  }

  function renderTrust(): void {
    clear(trust);
    clear(meter);
    const wit = witnessRefOf(index);
    const look = lookOf(index);
    if (holding) {
      // Dual ages during the flip: rasters minted minutes apart on a dynamic
      // page must not attribute unrelated drift to the variant.
      const origAge = cap ? age(cap.capturedAt) : "—";
      const varAge = wit ? age(wit.ref.capturedAt) : "—";
      trust.append(
        el("p", "cap-rung", `holding: original (uploaded ${origAge} ago · variant ${varAge} ago)`),
      );
      return;
    }
    // The ONE trust-line grammar (@onlay/render) — the desk full-page stage
    // speaks these verbatim too (F34).
    if (index < 0) {
      trust.append(
        el(
          "p",
          "cap-rung",
          originalRungLine({
            ...(capWitness() && cap ? { witnessAt: cap.capturedAt } : {}),
            capExists: cap !== null,
          }),
        ),
      );
    } else {
      const v = verdictOf(index);
      const line = variantRungLine({
        ...(wit ? { witnessAt: (wit.ref as CaptureRef).capturedAt } : {}),
        ...(look?.stale ? { stale: true } : {}),
        capExists: cap !== null,
      });
      trust.append(el("p", "cap-rung", line));
      if (v?.caution) trust.append(el("p", "cap-caution", v.caution));
    }
    const frame = frames.get(index);
    const refResidue = index < 0 ? cap?.residue : witnessRefOf(index)?.ref.residue;
    const entries = collectResidue(refResidue, frame?.residue ?? null);
    const top = entries[0];
    if (top) meter.append(el("p", "cap-residue", residueCopy(top)));
    if (entries.length > 1) {
      meter.append(el("p", "cap-residue-more", entries.slice(1).map(residueCopy).join(" · ")));
    }
  }

  /** Words as the second channel — ops can't lie about render fidelity. */
  function renderProgram(): void {
    clear(program);
    const v = index >= 0 ? variants[index] : undefined;
    if (!v || !Array.isArray(v.program)) return;
    const phrases = (v.program as MutationOp[]).slice(0, 4).map(opPhrase);
    if ((v.program as MutationOp[]).length > 4)
      phrases.push(`+${(v.program as MutationOp[]).length - 4} more`);
    program.append(el("p", "cap-ops", phrases.join(" · ")));
  }

  function renderActions(): void {
    clear(actions);
    // The decision window: Pick/Discard only while the set previews — after a
    // pick/discard the card stands as the record, and the change's own resolve
    // pill (detail head) owns anything further.
    if (setStatus === "previewing") {
      if (index >= 0) {
        const v = verdictOf(index);
        const pick = button(
          v?.pick === "primary" ? "btn btn-primary" : "btn btn-secondary",
          "Pick this variant",
          () => void doPick(),
        );
        actions.append(pick);
      }
      if (opts.canDiscard) {
        actions.append(button("btn btn-ghost", "Discard", () => void doDiscard()));
      }
    }
    if (opts.onFreshLook) {
      actions.append(button("btn btn-ghost", "⟳ Fresh look", () => opts.onFreshLook?.()));
    }
    renderComment();
  }

  /* ── comment / pick / discard (unchanged law) ── */

  let commentComposer: Composer | null = null;
  let commentFor: string | null = null;

  function commentPrefix(v: VariantSummary): string {
    const i = variants.findIndex((x) => x.variantId === v.variantId);
    return `Variant ${i + 1}/${variants.length} — ${v.label || v.variantId}: `;
  }

  function renderComment(): void {
    const v = index >= 0 && setId && setStatus === "previewing" ? variants[index] : undefined;
    const nextFor = v ? v.variantId : null;
    if (nextFor === commentFor && commentWrap.childElementCount > 0) return; // keep typing state
    commentComposer?.flush();
    commentComposer = null;
    commentFor = nextFor;
    clear(commentWrap);
    if (!v) return;
    const key = draftKey("variant-comment", `${id}:${v.variantId}`);
    const c = composer(mentionCtx(ctx, spaceId), {
      placeholder: "Comment on this variant…",
      draftKey: key,
      cap: Math.max(0, COMMENT_CAP - commentPrefix(v).length),
    });
    const send = button("btn btn-secondary", "Comment", () => void doComment(c, v));
    c.actions.append(send);
    commentWrap.append(c.node);
    commentComposer = c;
  }

  async function doPick(): Promise<void> {
    const shown = index >= 0 ? variants[index] : undefined;
    if (!setId || !shown || setStatus !== "previewing") return;
    const res = await api.pick(ctx.client, spaceId, setId, {
      variantId: shown.variantId,
      version: shown.version ?? 1,
    });
    if (!res.ok) return afterFail(res);
    toast("Variant picked.");
    markGone(); // decision made — the hero takes the slot back
  }

  async function doDiscard(): Promise<void> {
    if (!setId || setStatus !== "previewing" || !opts.canDiscard) return;
    const res = await api.discard(ctx.client, spaceId, setId);
    if (!res.ok) return afterFail(res);
    toast("Variants discarded.");
    markGone();
  }

  async function doComment(c: Composer, v: VariantSummary): Promise<void> {
    const msg = c.value();
    if (!msg.text) return;
    const sent = withPrefix(msg, commentPrefix(v), COMMENT_CAP);
    // A retry of an unconfirmed send reuses its id: the server answers it once (M-1).
    const place = `variant-comment:${spaceId}:${id}`;
    const clientId = clientIdFor(place, sent);
    const res = await api.reply(ctx.client, spaceId, id, sent, undefined, clientId);
    if (!res.ok) return afterFail(res);
    confirmSend(place, clientId);
    if (sameRevision(c.value(), msg)) c.clear();
    toast("Comment sent.");
  }

  function afterFail(res: Fail): void {
    toast(failureToast(res));
  }

  // keyboard: [ / ] prev/next, p pick, d discard, w hold-toggle
  const onKey = (e: KeyboardEvent): void => {
    if (!e.isTrusted) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
    if (e.key === "[") void show(Math.max(-1, index - 1));
    else if (e.key === "]") void show(Math.min(variants.length - 1, index + 1));
    else if (e.key === "p" && index >= 0) void doPick();
    else if (e.key === "d") void doDiscard();
    else if (e.key === "w") {
      if (holding) endHold();
      else startHold();
    }
  };
  window.addEventListener("keydown", onKey);

  pending = load().finally(() => {
    pending = null;
  });

  return {
    node,
    refresh: () => refresh(),
    dispose: () => {
      // A disposed card is GONE without the callback (codex-f33-1): a pending
      // load/refresh resolving later must neither rebuild nor fire onGone into
      // a successor card's state.
      gone = true;
      window.removeEventListener("keydown", onKey);
      urls.dispose();
    },
  };
}

function opPhrase(op: MutationOp): string {
  switch (op.op) {
    case "setText":
      return `text → “${truncate(op.text, 40)}”`;
    case "setStyle":
      return `style ${op.props.map((p) => `${p.prop}: ${truncate(p.value, 24)}`).join(", ")}`;
    case "setClass":
      return `class ${[...(op.add ?? []).map((c) => `+${c}`), ...(op.remove ?? []).map((c) => `−${c}`)].join(" ")}`;
    case "setAttr":
      return op.value === null ? `${op.name} removed` : `${op.name} → ${truncate(op.value, 30)}`;
    case "insertFragment":
      return `inserts markup (${op.position})`;
    default:
      return "edit";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
