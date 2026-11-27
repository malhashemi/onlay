// Variant sets (ADR-0004, spec §8): several per page, each the method of its
// own Edit and docked in that Edit's sidecar. Every set keeps its own state,
// panel and display stop (−1 = the Original); every frame it sends carries
// its space. Previews go through the kept layer: at most one set per root is
// shown, and opening another Edit's variants on that root switches to it. A
// picked variant is not taken off the page — it hands over to the kept layer,
// which keeps it applied while the Edit is kept. A set's root is one block or
// the whole page. A set previews only on its Edit's own page (`page-url.ts`),
// only once its variants are all here (a truncated frame is filled in over
// HTTP first), and its reload bookmark belongs to one person on one server.
//
// A set whose root is in a child frame (E-1) lives in that frame: its
// controller syncs the set, previews in its own document through its own
// layer and sends every set frame with its own address. The top frame shows
// the set's panel as a mirror of what the child reports (`mirrors`), and its
// buttons ask the child to act (`drive`) through the service worker; the
// child acts only on what its own view of the set holds.

import {
  type ElementContext,
  LIMITS,
  type MutationProgram,
  type VariantRoot,
} from "@onlay/protocol";
import type { ApplyResult, PreviewRoot } from "@onlay/render";
import { sameRevision, withPrefix } from "@onlay/render/mentions";
import { cssPath, documentProvenance, pinBlock, readSourcePointer } from "./anchors";
import type { App, CreateResult } from "./app";
import { captureFull, captureQueueBusy } from "./capture";
import { bindCapture } from "./capture/binding";
import {
  cancelVariantPasses,
  type LookOmission,
  lookOmission,
  noteHumanVariantInput,
  onLookOmission,
} from "./capture/variant-pass";
import { richInput } from "./composers";
import { el } from "./dom";
import { clearDraftIfUnchanged, draftRevision } from "./drafts";
import type { KeptLayer } from "./kept-layer";
import { ownsEditHere } from "./ownership";
import { samePage } from "./page-url";
import { renderedText } from "./rendered";
import { type SanitizedAnchor, sanitizeElement, sanitizePage } from "./sanitize";
import { clientIdFor, confirmSend } from "./send-ids";
import { spaceOfInteraction } from "./space-of";
import { uploadOrigin } from "./upload-origin";
import {
  type AppliedOutcome,
  liveOutcomeOf,
  OUTCOME_COPY,
  outcomeLine,
  owesReport,
  type RedactedCopy,
  reportVariantOutcome,
} from "./variant-outcome";

type VariantElementContext = ElementContext;

export interface VariantStateMessage {
  setId: string;
  spaceId?: string;
  nonce?: string;
  status: "generating" | "previewing" | "implementing" | "verifying" | "resolved";
  outcome?: "picked" | "discarded" | "stale";
  selector?: string;
  rootKind?: "block" | "page";
  variants: Array<{
    variantId: string;
    label: string;
    program: MutationProgram;
    version: number;
    /** Who wrote it (the person an agent acts as); absent from older servers. */
    by?: string;
  }>;
  activeIndex?: number;
  changeInteractionId?: string;
  truncated?: boolean;
}

/**
 * chrome.storage.local: per person and server (`<key>:<person>|<origin>`), per
 * page URL, the sets to re-sync after a reload. The unscoped key is legacy.
 */
const ACTIVE_VARIANT_SETS_KEY = "onlayActiveVariantSets";
/** A page remembers at most this many live sets. */
const MAX_BOOKMARKS_PER_PAGE = 12;

/** One bookmarked set; its space routes the sync. */
export interface SetBookmark {
  setId: string;
  spaceId: string;
}

/** Read the bookmark map, keeping only well-formed `{setId, spaceId}` entries. */
export function readBookmarks(raw: unknown): Record<string, SetBookmark[]> {
  const out: Record<string, SetBookmark[]> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [url, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue; // the old single-id shape carries no space
    const entries = list.filter(
      (e): e is SetBookmark =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as SetBookmark).setId === "string" &&
        typeof (e as SetBookmark).spaceId === "string",
    );
    if (entries.length > 0) out[url] = entries;
  }
  return out;
}

/** Add or remove one set on a page's list (newest last, bounded). */
export function updateBookmarks(
  map: Record<string, SetBookmark[]>,
  url: string,
  entry: SetBookmark,
  live: boolean,
): Record<string, SetBookmark[]> {
  const list = (map[url] ?? []).filter((e) => e.setId !== entry.setId);
  if (live) list.push(entry);
  const next = { ...map };
  if (list.length > 0) next[url] = list.slice(-MAX_BOOKMARKS_PER_PAGE);
  else delete next[url];
  return next;
}

/**
 * One set as a child frame reports it to the top frame's panel (E-1): what the
 * panel shows, never the programs.
 */
export interface SetMirror {
  setId: string;
  spaceId?: string;
  status: VariantStateMessage["status"];
  outcome?: VariantStateMessage["outcome"];
  selector?: string;
  rootKind?: "block" | "page";
  changeInteractionId?: string;
  variants: Array<{ variantId: string; label: string; version: number }>;
  displayIndex: number;
  full: boolean;
  nothingApplied: boolean;
  /** The frame is showing this set's preview (the top frame's pill is derived from it). */
  previewing: boolean;
  /** The panel's status line in the frame. */
  statusText: string;
  /** Why the variant on preview got no automatic look; empty when it got one. */
  lookNote: string;
  /** Which steps of the variant on preview couldn't be applied, and why; empty when all landed. */
  refusedNote?: string;
}

/** What the top frame's panel asks the frame that owns a set to do (E-1). */
export type RemoteAct =
  | { act: "open"; changeId: string }
  | { act: "cycle"; delta: 1 | -1 }
  | { act: "pick"; variantId: string; version: number }
  | { act: "discard" }
  | { act: "more" };

export interface VariantController {
  /** The one "Indicative preview" pill (top frame). */
  previewLabel: HTMLElement;
  /** Show a set in its Edit's sidecar (`mount`) and start previewing it. */
  openSet(setId: string, mount?: HTMLElement): void;
  /**
   * Show a set that a child frame owns (top frame, E-1): the panel docks in
   * `mount` and mirrors what that frame reports; its buttons drive the frame.
   */
  openRemoteSet(setId: string, mount: HTMLElement, documentId: string, changeId: string): void;
  /** A child frame's report of its sets and its preview pill (top frame). */
  mirror(documentId: string, sets: readonly SetMirror[]): void;
  /** A child document is gone: its mirrored panels and pill go with it. */
  forgetFrame(documentId: string): void;
  /** What child frames reported about these spaces goes, panels and pill at once (2-E3). */
  forgetFrameSpaces(which: (spaceId: string | undefined) => boolean): void;
  /** This frame's sets as the top frame's panel shows them, and its pill (child frame). */
  mirrors(): { sets: SetMirror[] };
  /** The top frame's panel asks for an act on one of this frame's sets; false when refused. */
  drive(setId: string, act: RemoteAct): boolean;
  /** The block a set created here was picked on, pinned there (3-E1). */
  pinOf(setId: string): PinnedBlock | undefined;
  /**
   * A block was picked for an Edit: take its redacted markup now, while the
   * person sees it (what a Variants set's upload and reports use). `large`:
   * it had to be reduced or cut to fit.
   */
  notePick(t: Element): { large: boolean };
  /**
   * Ask an agent for variants. `target` is the picked block, or null for the
   * whole page. The owning Edit's sidecar opens when the set lands; the
   * promise says whether it did.
   */
  startFromChange(
    target: Element | null,
    command: string,
    count: number,
    intent: "change" | "insert-after",
    spaceId: string,
    /** A child frame's pick: the account generation it was made under (3-F3). */
    opts?: { pickGeneration?: number | null },
  ): Promise<CreateResult>;
  onVariantState(msg: VariantStateMessage): void;
  onVariantReceipt(msg: { kind: string; ok: boolean; reason?: string }): void;
  sync(): void;
  /**
   * The person, server or their spaces changed. A different scope drops every
   * set, its bookmarks and its queued witness work; the same scope drops the
   * sets (and bookmarks) of spaces that are gone.
   */
  scopeChanged(prev: string | null, next: string | null, spaceIds: readonly string[]): void;
  /** The page's URL changed (an SPA route): previews are re-checked against it. */
  pageChanged(): void;
  /** New snapshots landed: captures waiting to see their Edit run (or are dropped). */
  snapshotsChanged(): void;
  /** These Edits are no longer visible to this person: their sets go, with their witness work. */
  dropForEdits(editIds: ReadonlySet<string>): void;
  /** The capture queue drained: replay renders it deferred. */
  settle(): void;
  /** Another set took this set's root: drop back to the Original stop. */
  displaced(setId: string): void;
  /** Sets this page is tracking (tests). */
  setIds(): string[];
}

export interface VariantControllerDeps {
  layer: KeptLayer;
  /** Open the Edit a set just landed for (a child frame opens it in the top frame). */
  openChangeJob?(interactionId: string, spaceId: string | undefined): void;
  /** Uploads a page edit's sanitized body (service worker; tests stub it). */
  uploadPageContent?(
    spaceId: string,
    interactionId: string,
    content: string,
    truncated: boolean,
  ): Promise<boolean>;
  /** `<person>|<server origin>` while signed in, else null: bookmarks live under it. */
  scope?(): string | null;
  /** Bookmark storage per scope (chrome.storage.local; tests stub it). */
  bookmarks?: {
    load(scope: string): Promise<Record<string, SetBookmark[]>>;
    save(scope: string, map: Record<string, SetBookmark[]>): Promise<void>;
    clear(scope: string): Promise<void>;
  };
  /**
   * Which Edits already captured their context, per person, server and space
   * (chrome.storage.local; tests stub it). Never the page's own storage.
   */
  captureLatch?: {
    load(): Promise<Record<string, number>>;
    save(map: Record<string, number>): void;
  };
  /** Top frame: reach the child frame that owns a set (E-1). */
  remote?: {
    act(documentId: string, setId: string, act: RemoteAct): Promise<boolean>;
    /** A comment on the active variant, sent by that frame (its Edit is bound there). */
    reply(documentId: string, frame: Record<string, unknown>): Promise<{ ok: boolean }>;
  };
  /** What `mirrors()` reports may have changed (a child frame reports it). */
  onChange?(): void;
  /** The full set over HTTP, for a frame that left variants out (tests stub it). */
  fetchSet?(
    setId: string,
    spaceId: string | undefined,
  ): Promise<{ variants: VariantStateMessage["variants"]; url?: string } | null>;
}

/** A picked block and its pin (3-E1): true while it is where it was picked. */
interface PinnedBlock {
  el: Element;
  held: () => boolean;
}

/**
 * What leaves the browser about a picked block (or, for a page set, the page),
 * read once, at the pick, while the person could see it: the block context the
 * create sends, the redacted markup its upload carries, and the copy its
 * outcome reports are computed against. Nothing reads the live block again
 * for anything that leaves the browser.
 */
interface BlockSnapshot {
  /** The block's context for `variant-create`; absent for a page set. */
  context?: VariantElementContext;
  capture: SanitizedAnchor;
  copy: RedactedCopy;
}

interface PendingCreate {
  spaceId: string;
  /** The picked block and its pin, or null for the whole page. */
  block: PinnedBlock | null;
  /** What leaves the browser about the block (or page), read at the pick. */
  snapshot: BlockSnapshot;
  openOnLand: boolean;
  /** The page the set was asked for on: its evidence belongs to that page only. */
  url: string;
}

interface SetView {
  setId: string;
  spaceId: string | undefined;
  state: VariantStateMessage | null;
  displayIndex: number;
  /** The human opened this set (or created it here): it may preview. */
  previewing: boolean;
  deferredRender: boolean;
  dockedMount: HTMLElement | null;
  openedSidecar: boolean;
  /** False while a truncated frame waits for the full set: no cycling or picking. */
  full: boolean;
  /** Bumped per full-set fetch: an older answer never overwrites a newer one. */
  fetchSeq: number;
  /** The page the set was created on here, or its server-side page once fetched. */
  knownUrl: string | undefined;
  /** The variant on preview applied none of its ops: it cannot be picked (R3-C9). */
  nothingApplied: boolean;
  /** How the variant on preview applied on the live page; null when none is on preview. */
  outcome: AppliedOutcome | null;
  /** What the panel showed for it (applied and refused steps): a pick checks it still holds. */
  shownKey: string;
  /** The child document that owns this set (top frame, E-1); null when it is this frame's. */
  remote: string | null;
  /** What that frame last reported for it. */
  mirror: SetMirror | null;
  ui: SetPanel;
}

interface SetPanel {
  panel: HTMLElement;
  target: HTMLElement;
  changeLine: HTMLElement;
  cycleRow: HTMLElement;
  current: HTMLElement;
  more: HTMLButtonElement;
  terminalRow: HTMLElement;
  pick: HTMLButtonElement;
  /** Beside Pick: why it is off when the preview applied nothing. */
  pickNote: HTMLElement;
  discard: HTMLButtonElement;
  commentWrap: HTMLElement;
  commentSend: HTMLButtonElement;
  status: HTMLElement;
  /** Why the variant on preview got no automatic look (3b-C5), when it got none. */
  lookNote: HTMLElement;
  /** Which steps of the variant on preview couldn't be applied, and why, by kind. */
  refusedNote: HTMLElement;
}

const PAGE_ROOT: PreviewRoot = { kind: "page" };
/** A child frame reports at most this many sets, each line at most this long. */
const MAX_MIRRORED_SETS = 12;
const MIRROR_TEXT = 240;

/** The new words a set's panel says (spec §8). */
export const VARIANT_COPY = {
  wholePage: "whole page",
  moreTitle: "Ask for one more variant",
  moreInstruction: "Add one more variant to this set; keep the existing ones.",
  commented: "Comment posted to the Edit thread.",
  refused: (n: number) => `${n} couldn't be applied`,
  pageNotSent: "Couldn't send this page to the agent.",
  pickChanged: "This variant changed since you previewed it. Look at it again, then pick.",
  noVariant: "This variant is no longer in the set.",
  previewFailed: "This variant couldn't be previewed on this page, so nothing is shown.",
  pageMoved: "The page changed since this preview. Look at it again, then pick.",
  pickedPartly:
    "Picked. Steps that couldn't be applied stay part of this Edit and may apply later if the page changes.",
  otherPage: "These variants were made on another page. Open that page to preview them.",
  nothingApplied: "Nothing in this variant could be applied on this page, so it can't be picked.",
  commentNotSent: "Your comment wasn't sent. Check your connection, then send it again.",
  noLookTooLarge: "No automatic look: this variant grows past the block.",
  noLookRefused: "No automatic look: part of this variant couldn't be applied.",
  noLookFrame: "No automatic look: another site's frame is in the way.",
  noLookPage: "No automatic look: the page changed before it was taken.",
  // The looks seat's reasons for a dropped screenshot, said of the variant (E-4).
  noLookCovered: "No automatic look: something on the page covered this block.",
  noLookSeeThrough:
    "No automatic look: this block's frame is transparent, so the page behind it would show.",
  noLookTransformed: "No automatic look: this block's frame is rotated or skewed.",
  noLookScaled: "No automatic look: this block's frame is shrunk or stretched.",
  noLookUnplaced: "No automatic look: Onlay couldn't find this block's frame on the page.",
  frameGone: "The frame didn't answer. Reload the page, then try again.",
} as const;

/** The line for each reason the witness pass took no look (3b-C5). */
const NO_LOOK: Record<LookOmission, string> = {
  "too-large": VARIANT_COPY.noLookTooLarge,
  refused: VARIANT_COPY.noLookRefused,
  frame: VARIANT_COPY.noLookFrame,
  page: VARIANT_COPY.noLookPage,
  covered: VARIANT_COPY.noLookCovered,
  "see-through": VARIANT_COPY.noLookSeeThrough,
  transformed: VARIANT_COPY.noLookTransformed,
  scaled: VARIANT_COPY.noLookScaled,
  unplaced: VARIANT_COPY.noLookUnplaced,
};

function elementContext(t: Element): VariantElementContext {
  // Rendered text only (R2-C5): what is hidden in the block never travels.
  const textSnippet = renderedText(t, LIMITS.MAX_TEXT_SNIPPET * 4)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, LIMITS.MAX_TEXT_SNIPPET);
  const sourcePointer = readSourcePointer(t)?.slice(0, LIMITS.MAX_SOURCE_POINTER);
  return {
    selector: cssPath(t).slice(0, LIMITS.MAX_SELECTOR),
    tag: t.localName.slice(0, LIMITS.MAX_TAG),
    classes: [...t.classList]
      .slice(0, LIMITS.MAX_CLASSES)
      .map((c) => c.slice(0, LIMITS.MAX_CLASS_LEN)),
    textSnippet,
    // Never raw outerHTML: the one transport sanitizer, which redacts values.
    markup: sanitizeElement(t, LIMITS.MAX_ELEMENT_MARKUP, { keepSelectors: true }).html,
    ...(sourcePointer ? { sourcePointer } : {}),
  };
}

function chromeBookmarks(): NonNullable<VariantControllerDeps["bookmarks"]> {
  const keyOf = (scope: string): string => `${ACTIVE_VARIANT_SETS_KEY}:${scope}`;
  // The unscoped map belonged to whoever was signed in before: nobody now.
  try {
    void chrome.storage.local.remove(ACTIVE_VARIANT_SETS_KEY).catch(() => {});
  } catch {
    /* stale context */
  }
  return {
    async load(scope) {
      try {
        const got = (await chrome.storage.local.get(keyOf(scope))) as Record<string, unknown>;
        return readBookmarks(got[keyOf(scope)]);
      } catch {
        return {};
      }
    },
    async save(scope, map) {
      try {
        await chrome.storage.local.set({ [keyOf(scope)]: map });
      } catch {
        /* stale context — the bookmark is a convenience */
      }
    },
    async clear(scope) {
      try {
        await chrome.storage.local.remove(keyOf(scope));
      } catch {
        /* stale context */
      }
    },
  };
}

const CAPTURE_LATCH_KEY = "onlayEditCaptured";
/** The latch keeps the newest entries only. */
const MAX_LATCH = 500;

function chromeCaptureLatch(): NonNullable<VariantControllerDeps["captureLatch"]> {
  // The old latch lived in the page's own localStorage: take it away.
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k?.startsWith("onlayEditCap:")) localStorage.removeItem(k);
    }
  } catch {
    /* storage blocked */
  }
  return {
    async load() {
      try {
        const got = (await chrome.storage.local.get(CAPTURE_LATCH_KEY)) as Record<string, unknown>;
        const raw = got[CAPTURE_LATCH_KEY];
        const out: Record<string, number> = {};
        if (raw && typeof raw === "object")
          for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out[k] = v;
        return out;
      } catch {
        return {};
      }
    },
    save(map) {
      const newest = Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_LATCH);
      try {
        void chrome.storage.local
          .set({ [CAPTURE_LATCH_KEY]: Object.fromEntries(newest) })
          .catch(() => {});
      } catch {
        /* stale context: the in-memory latch holds this page */
      }
    },
  };
}

async function chromeFetchSet(
  setId: string,
  spaceId: string | undefined,
): Promise<{ variants: VariantStateMessage["variants"]; url?: string } | null> {
  try {
    const r = (await chrome.runtime.sendMessage({
      type: "getVariantSet",
      id: setId,
      ...(spaceId ? { spaceId } : {}),
    })) as
      | {
          ok?: boolean;
          set?: { variants?: VariantStateMessage["variants"]; expectUrlPrefix?: string };
        }
      | undefined;
    if (!r?.ok || !Array.isArray(r.set?.variants)) return null;
    return {
      variants: r.set.variants,
      ...(typeof r.set.expectUrlPrefix === "string" ? { url: r.set.expectUrlPrefix } : {}),
    };
  } catch {
    return null;
  }
}

function chromeUploadPage(
  spaceId: string,
  interactionId: string,
  content: string,
  truncated: boolean,
): Promise<boolean> {
  try {
    return chrome.runtime
      .sendMessage({
        type: "uploadPageContent",
        ...uploadOrigin(),
        spaceId,
        interactionId,
        content,
        truncated,
      })
      .then(
        (r: { ok?: boolean } | undefined) => r?.ok === true,
        () => false,
      );
  } catch {
    return Promise.resolve(false);
  }
}

export function createVariantController(app: App, deps: VariantControllerDeps): VariantController {
  const layer = deps.layer;
  const bookmarks = deps.bookmarks ?? chromeBookmarks();
  const scopeOf = deps.scope ?? (() => null);
  const fetchSet = deps.fetchSet ?? chromeFetchSet;
  const uploadPage = deps.uploadPageContent ?? chromeUploadPage;
  const previewLabel = el("div", "preview-label", "Indicative preview — not applied");
  const views = new Map<string, SetView>();
  const pending = new Map<string, PendingCreate>();
  /** The pinned block of each set created here, for its looks (3-E1). */
  const setPins = new Map<string, PinnedBlock>();
  onLookOmission((setId) => {
    const view = views.get(setId);
    if (view) renderLookNote(view);
  });
  /** The last bookmarked set on reload: its sidecar opens once, as before. */
  let autoOpenSetId: string | null = null;

  // Edit-context capture state, per Edit (F32/F34.1): bounded retries, and a
  // done-latch in extension storage (scoped per person, server and space) so a
  // reload doesn't mint duplicates and the page learns nothing.
  const captureDone = new Set<string>();
  const captureInFlight = new Set<string>();
  const captureAttempts = new Map<string, number>();
  const pageUploaded = new Set<string>();
  const blockUploaded = new Set<string>();
  /**
   * Per set made here, the copy taken at the pick that its outcome reports are
   * computed against; only this document has it, and it goes with the set's view.
   */
  const setCopies = new Map<string, RedactedCopy>();
  /** The redacted markup of each block picked for an Edit, taken at the pick. */
  const pickSnapshots = new WeakMap<Element, BlockSnapshot>();
  const MAX_CAPTURE_ATTEMPTS = 3;
  const CAPTURE_RETRY_MS = 8_000;

  function frameUrl(): string {
    return app.frameUrl();
  }

  /** Where a variant's outcome is reported from: this frame, for the Edit's author only. */
  const outcomeDeps = {
    selfId: () => app.selfId(),
    account: () => app.account(),
    ownsEdit: (id: string) => ownsEditHere(app, id),
    frameUrl,
    send: (frame: { type: string; [k: string]: unknown }) => app.send(frame),
  };

  /** This frame's own pill text while shown. */
  let labelShown: string | null = null;
  /**
   * The child-frame sets reported last and accepted here, by document and set
   * (top frame): two frames with one address each have their own (2-E4).
   */
  const latest = new Map<string, { documentId: string; mirror: SetMirror }>();
  const latestKey = (documentId: string, setId: string): string => `${documentId}|${setId}`;
  const changed = (): void => deps.onChange?.();

  /**
   * The pill for a child frame's preview, derived only from a set this frame
   * accepted and shows a panel for (2-E3): never text the frame sent as such.
   */
  function remotePill(): string | null {
    for (const v of views.values()) {
      const m = v.remote ? v.mirror : null;
      if (!m?.previewing || m.status !== "previewing" || !m.full) continue;
      if (m.displayIndex < 0) return "Original — unchanged";
      const shown = m.variants[m.displayIndex];
      if (shown && !m.nothingApplied) return `Indicative preview — ${shown.label}`;
    }
    return null;
  }

  function paintLabel(): void {
    if (!app.isTopFrame) return;
    const text = labelShown ?? remotePill();
    previewLabel.textContent = text ?? "";
    previewLabel.style.display = text !== null ? "block" : "none";
  }

  function setPreviewLabel(visible: boolean, text = "Indicative preview — not applied"): void {
    labelShown = visible ? text : null;
    paintLabel();
  }

  function rootOf(v: SetView): PreviewRoot {
    return v.state?.rootKind === "page" ? PAGE_ROOT : v.state?.selector;
  }

  function sendFrame(v: SetView, type: string, payload: Record<string, unknown>): void {
    if (v.spaceId) app.noteSet(v.setId, v.spaceId);
    void app
      .send({
        type,
        frameUrl: frameUrl(),
        setId: v.setId,
        ...(v.spaceId ? { spaceId: v.spaceId } : {}),
        ...payload,
      })
      .then((res) => {
        if (!res.ok) app.toast(`${type} not sent: ${res.error ?? "no response"}`);
      });
  }

  // Bookmark writes are read-modify-write over one stored map: one at a time,
  // or two sets landing together would each erase the other's entry.
  let bookmarkChain: Promise<unknown> = Promise.resolve();
  function serialBookmarks(fn: () => Promise<unknown>): Promise<void> {
    const next = bookmarkChain.then(fn, fn);
    bookmarkChain = next.catch(() => {});
    return next.then(() => {});
  }

  function bookmark(v: SetView, live: boolean): Promise<void> {
    const url = frameUrl();
    return serialBookmarks(async () => {
      const scope = scopeOf();
      if (!v.spaceId || scope === null) return;
      const map = await bookmarks.load(scope);
      if (scopeOf() !== scope) return; // signed out or switched while loading
      await bookmarks.save(
        scope,
        updateBookmarks(map, url, { setId: v.setId, spaceId: v.spaceId }, live),
      );
    });
  }

  /** The page the set's Edit lives on: its snapshot here, else what we know of the set. */
  function editUrl(v: SetView): string | undefined {
    const id = v.state?.changeInteractionId;
    const edit = id ? app.byId(id) : undefined;
    return edit?.url ?? v.knownUrl;
  }

  /** A truncated frame left variants out: read the whole set before cycling or picking. */
  function fillTruncated(v: SetView): void {
    v.full = false;
    const seq = ++v.fetchSeq;
    void fetchSet(v.setId, v.spaceId).then((full) => {
      if (seq !== v.fetchSeq || !v.state || !full) return;
      v.state = { ...v.state, variants: [...full.variants] };
      delete v.state.truncated;
      if (full.url !== undefined) v.knownUrl = full.url;
      v.full = true;
      renderState(v);
    });
  }

  function guest(v: SetView): boolean {
    return v.spaceId !== undefined && app.isGuest(v.spaceId);
  }

  /* ── one set's panel ── */

  function buildPanel(setId: string, v: () => SetView): SetPanel {
    const panel = el("div", "card variant-panel");
    panel.style.display = "none";
    const body = el("div", "card-body");
    const target = el("div", "variant-target");
    const changeLine = el("div", "micro");
    changeLine.style.display = "none";
    const cycleRow = el("div", "row");
    cycleRow.style.display = "none";
    const prev = el("button", "btn sm", "‹");
    const current = el("span", "variant-current", "No preview");
    const next = el("button", "btn sm", "›");
    const more = el("button", "btn sm", "+") as HTMLButtonElement;
    more.title = VARIANT_COPY.moreTitle;
    cycleRow.append(prev, current, next, more);
    const terminalRow = el("div", "row");
    terminalRow.style.display = "none";
    const pick = el("button", "btn primary k-change", "Pick active") as HTMLButtonElement;
    const discard = el("button", "btn danger", "Discard") as HTMLButtonElement;
    const pickNote = el("span", "variant-note", VARIANT_COPY.nothingApplied);
    pickNote.style.display = "none";
    terminalRow.append(pick, pickNote, discard);
    const refusedNote = el("div", "variant-note");
    refusedNote.style.display = "none";
    const comment = richInput(
      app,
      "Comment on active variant… @mention to notify",
      () => commentOnActive(v(), comment),
      // The mention list is the set's space's people, not every space's.
      // Its unsent text is a draft like any reply: kept across a reload (D-1).
      { spaceId: () => v().spaceId ?? null, draftKey: `variant-comment:${setId}` },
    );
    comment.wrap.style.display = "none";
    const commentRow = el("div", "row");
    const commentSend = el("button", "btn sm", "Comment") as HTMLButtonElement;
    commentRow.append(commentSend);
    comment.wrap.appendChild(commentRow);
    const status = el("div", "variant-status", "idle");
    const lookNote = el("div", "variant-note");
    lookNote.style.display = "none";
    body.append(
      target,
      changeLine,
      cycleRow,
      terminalRow,
      refusedNote,
      comment.wrap,
      status,
      lookNote,
    );
    panel.append(body);

    // Every privileged act needs a real gesture (the shadow root is open).
    prev.addEventListener("click", (e) => {
      if (e.isTrusted) cycle(v(), -1);
    });
    next.addEventListener("click", (e) => {
      if (e.isTrusted) cycle(v(), 1);
    });
    more.addEventListener("click", (e) => {
      if (e.isTrusted) askMore(v());
    });
    pick.addEventListener("click", (e) => {
      if (e.isTrusted) pickShown(v());
    });
    discard.addEventListener("click", (e) => {
      if (e.isTrusted) discardSet(v());
    });
    commentSend.addEventListener("click", (e) => {
      if (e.isTrusted) commentOnActive(v(), comment);
    });
    return {
      panel,
      target,
      changeLine,
      cycleRow,
      current,
      more,
      terminalRow,
      pick,
      pickNote,
      discard,
      commentWrap: comment.wrap,
      commentSend,
      status,
      lookNote,
      refusedNote,
    };
  }

  /** Ask the agent for one more variant (a member's act). */
  function askMore(view: SetView): boolean {
    const s = view.state;
    if (s?.status !== "previewing" || s.variants.length >= LIMITS.MAX_VARIANTS_PER_SET)
      return false;
    if (guest(view)) return false;
    if (view.remote) return remoteAct(view, { act: "more" });
    view.ui.status.textContent = "asked the agent for one more variant";
    sendFrame(view, "variant-steer", {
      instruction: VARIANT_COPY.moreInstruction,
    });
    changed();
    return true;
  }

  /** The applied and refused steps a result shows, as one comparable string. */
  function shownKeyOf(result: ApplyResult | { ok: false; reason: "other-page" }): string {
    if (!result.ok) return result.reason;
    return `${result.applied}|${(result.refused ?? []).map((r) => `${r.index}:${r.reason}`).join(",")}`;
  }

  /** Pick the variant on preview, by identity: a truncated frame's index is not the set's. */
  function pickShown(view: SetView, expect?: { variantId: string; version: number }): boolean {
    const s = view.state;
    const shown = s?.status === "previewing" ? s.variants[view.displayIndex] : undefined;
    if (!shown || view.nothingApplied) return false;
    if (view.remote) {
      return remoteAct(view, { act: "pick", variantId: shown.variantId, version: shown.version });
    }
    // Asked from the top frame's panel: only the variant this frame shows (E-1).
    if (expect && (expect.variantId !== shown.variantId || expect.version !== shown.version))
      return false;
    // What is on the page now must still be what the panel says: a re-render
    // may have taken a target away since. If not, the panel is refreshed and
    // the person looks again.
    const now = layer.previewNow(view.setId);
    if (!now || shownKeyOf(now) !== view.shownKey) {
      applyPreview(view, view.displayIndex, false);
      view.ui.status.textContent = VARIANT_COPY.pageMoved;
      changed();
      return false;
    }
    noteHumanVariantInput();
    view.ui.status.textContent = "pick sent";
    sendFrame(view, "variant-pick", { variantId: shown.variantId, version: shown.version });
    // The stored program is kept whole: steps skipped here may apply on a later load.
    if ((view.outcome?.refused.length ?? 0) > 0) app.toast(VARIANT_COPY.pickedPartly);
    changed();
    return true;
  }

  function discardSet(view: SetView): boolean {
    if (view.state?.status !== "previewing" || guest(view)) return false;
    if (view.remote) return remoteAct(view, { act: "discard" });
    noteHumanVariantInput();
    view.ui.status.textContent = "discard sent";
    sendFrame(view, "variant-discard", {});
    changed();
    return true;
  }

  /** Ask the frame that owns the set to act; the panel follows its next report. */
  function remoteAct(view: SetView, act: RemoteAct): boolean {
    const doc = view.remote;
    if (!doc || !deps.remote) return false;
    void deps.remote.act(doc, view.setId, act).then((ok) => {
      if (!ok && views.get(view.setId) === view)
        view.ui.status.textContent = VARIANT_COPY.frameGone;
    });
    return true;
  }

  function commentOnActive(v: SetView, input: ReturnType<typeof richInput>): void {
    const s = v.state;
    if (s?.status !== "previewing" || s.changeInteractionId === undefined) return;
    if (v.displayIndex < 0) return;
    const variant = s.variants[v.displayIndex];
    if (!variant) return;
    const body = input.value();
    if (!body.text) return;
    const prefix = `Variant ${v.displayIndex + 1}/${s.variants.length} — ${variant.label}: `;
    const sent = withPrefix(body, prefix, LIMITS.MAX_COMMENT_TEXT);
    // A retry of an unconfirmed send reuses its id: the server answers it once (M-1).
    const place = `variant-comment:${v.setId}`;
    const clientId = clientIdFor(place, sent);
    // The comment box's draft key is the same place: its revision now is what was sent.
    const revision = draftRevision(place);
    const frame = {
      type: "interaction-reply",
      interactionId: s.changeInteractionId,
      ...(v.spaceId ? { spaceId: v.spaceId } : {}),
      body: sent,
      clientId,
    };
    // The draft stays until the server's receipt (3b-C10). A set in a child
    // frame: its Edit is bound to that frame's address, which sends it (E-1).
    const sending =
      v.remote && deps.remote
        ? deps.remote.reply(v.remote, frame)
        : app.sendForReceipt(frame as never, "reply", s.changeInteractionId);
    void sending.then((r) => {
      if (r.ok) {
        confirmSend(place, clientId);
        if (clearDraftIfUnchanged(place, revision) && sameRevision(input.value(), body))
          input.clear();
        v.ui.status.textContent = VARIANT_COPY.commented;
      } else {
        v.ui.status.textContent = VARIANT_COPY.commentNotSent;
      }
    });
  }

  function viewFor(setId: string, spaceId?: string): SetView {
    let v = views.get(setId);
    if (!v) {
      const holder: { v: SetView | null } = { v: null };
      const created: SetView = {
        setId,
        spaceId,
        state: null,
        displayIndex: 0,
        previewing: false,
        deferredRender: false,
        dockedMount: null,
        openedSidecar: false,
        full: true,
        fetchSeq: 0,
        knownUrl: undefined,
        nothingApplied: false,
        outcome: null,
        shownKey: "",
        remote: null,
        mirror: null,
        ui: buildPanel(setId, () => holder.v as SetView),
      };
      holder.v = created;
      views.set(setId, created);
      v = created;
    }
    if (spaceId && !v.spaceId) v.spaceId = spaceId;
    if (v.spaceId) app.noteSet(setId, v.spaceId);
    return v;
  }

  function dock(v: SetView, mount?: HTMLElement): void {
    v.dockedMount = mount ?? null;
    v.ui.panel.classList.toggle("inline", v.dockedMount !== null);
    if (v.dockedMount && v.ui.panel.parentElement !== v.dockedMount)
      v.dockedMount.appendChild(v.ui.panel);
    if (!v.dockedMount && v.ui.panel.parentNode !== app.shadow) app.shadow.appendChild(v.ui.panel);
    if (app.isTopFrame) v.ui.panel.style.display = "flex";
  }

  /* ── preview ── */

  /** Say which steps of the variant on preview couldn't be applied, and why. */
  function renderOutcome(v: SetView): void {
    const line = v.outcome ? outcomeLine(v.outcome) : "";
    v.ui.refusedNote.textContent = line;
    v.ui.refusedNote.style.display = line ? "" : "none";
  }

  function clearPreview(v: SetView): void {
    v.nothingApplied = false;
    v.outcome = null;
    renderOutcome(v);
    v.ui.lookNote.style.display = "none";
    layer.clearPreview(v.setId);
    v.ui.cycleRow.style.display = "none";
    if (![...views.values()].some((o) => o !== v && o.previewing && o.displayIndex >= 0))
      setPreviewLabel(false);
  }

  function renderCycle(v: SetView): void {
    const s = v.state;
    if (s?.status !== "previewing" || s.variants.length === 0 || !v.full) {
      v.ui.cycleRow.style.display = "none";
      return;
    }
    v.ui.cycleRow.style.display = "flex";
    if (v.displayIndex < 0) v.ui.current.textContent = "Original — unchanged";
    else {
      const variant = s.variants[v.displayIndex];
      v.ui.current.textContent = `${v.displayIndex + 1}/${s.variants.length} — ${variant?.label ?? "variant"}`;
    }
    v.ui.more.disabled = s.variants.length >= LIMITS.MAX_VARIANTS_PER_SET;
    v.ui.more.style.display = guest(v) ? "none" : "";
  }

  function renderTerminal(v: SetView): void {
    const s = v.state;
    const canPreview = s?.status === "previewing";
    const hasActive = canPreview && v.full && (s?.variants.length ?? 0) > 0 && v.displayIndex >= 0;
    const canComment = hasActive && s?.changeInteractionId !== undefined;
    v.ui.terminalRow.style.display = canPreview ? "flex" : "none";
    v.ui.commentWrap.style.display = canComment ? "flex" : "none";
    v.ui.pick.disabled = !hasActive || v.nothingApplied;
    v.ui.pickNote.style.display = hasActive && v.nothingApplied ? "" : "none";
    v.ui.discard.disabled = !canPreview;
    // A guest picks and comments; discarding and steering are a member's acts.
    v.ui.discard.style.display = guest(v) ? "none" : "";
    v.ui.commentSend.disabled = !canComment;
  }

  function applyPreview(v: SetView, index: number, notify: boolean): void {
    const s = v.state;
    if (s?.status !== "previewing") return;
    v.displayIndex = index;
    v.nothingApplied = false;
    v.outcome = null;
    renderOutcome(v);
    if (index < 0) {
      layer.clearPreview(v.setId);
      renderCycle(v);
      renderTerminal(v);
      setPreviewLabel(true, "Original — unchanged");
      return;
    }
    const variant = s.variants[index];
    if (!variant) {
      clearPreview(v);
      v.ui.status.textContent = VARIANT_COPY.noVariant;
      return;
    }
    // The URL is revalidated here, at every apply: an SPA may have moved on.
    const result = layer.showPreview(v.setId, rootOf(v), variant.program, {
      url: editUrl(v),
      spaceId: v.spaceId,
    });
    // What happened on the live page: the panel's alone, never reported.
    // A preview held off while a look is taken tells nothing yet (a zero token).
    const held = result.ok && result.token === 0;
    // On the page now is none of this variant: there is nothing to pick (R3-C9).
    v.nothingApplied = !held && (!result.ok || result.applied === 0);
    v.outcome = liveOutcomeOf(result, variant.program.length);
    v.shownKey = shownKeyOf(result as ApplyResult);
    renderOutcome(v);
    renderCycle(v);
    renderTerminal(v);
    if (!result.ok) {
      setPreviewLabel(false);
      v.ui.status.textContent =
        result.reason === "other-page"
          ? VARIANT_COPY.otherPage
          : result.reason === "failed"
            ? VARIANT_COPY.previewFailed
            : OUTCOME_COPY.rootMissing;
      return;
    }
    v.state = { ...s, activeIndex: index };
    const refused = result.refused?.length ?? 0;
    v.ui.status.textContent = `previewing ${index + 1}/${s.variants.length}: ${variant.label} — indicative${refused > 0 ? ` · ${VARIANT_COPY.refused(refused)}` : ""}`;
    setPreviewLabel(true, `Indicative preview — ${variant.label}`);
    renderLookNote(v);
    if (notify) sendFrame(v, "variant-cycle", { index });
  }

  /** Say why the variant on preview has no automatic look, when the pass took none. */
  function renderLookNote(v: SetView): void {
    const s = v.state;
    const shown =
      s?.status === "previewing" && v.displayIndex >= 0 ? s.variants[v.displayIndex] : undefined;
    const why = shown ? lookOmission(v.setId, shown.variantId, shown.version ?? 1) : undefined;
    v.ui.lookNote.textContent = why ? NO_LOOK[why] : "";
    v.ui.lookNote.style.display = why ? "" : "none";
    changed();
  }

  function cycle(v: SetView, delta: number): void {
    const s = v.state;
    if (s?.status !== "previewing" || s.variants.length === 0 || !v.full) return;
    if (v.remote) {
      remoteAct(v, { act: "cycle", delta: delta < 0 ? -1 : 1 });
      return;
    }
    noteHumanVariantInput(); // the human wins: a running witness pass aborts
    v.previewing = true;
    const n = s.variants.length;
    let d = v.displayIndex + delta;
    if (d < -1) d = n - 1;
    if (d > n - 1) d = -1;
    applyPreview(v, d, d >= 0);
    changed();
  }

  function normalizedActive(s: VariantStateMessage): number {
    if (s.variants.length === 0) return 0;
    const a = s.activeIndex ?? 0;
    return a >= 0 && a < s.variants.length ? a : 0;
  }

  function renderState(v: SetView): void {
    if (v.remote) {
      renderRemote(v);
      return;
    }
    renderLocal(v);
    changed();
  }

  /** A child frame's set (top frame): the panel shows what that frame last reported. */
  function renderRemote(v: SetView): void {
    const m = v.mirror;
    if (!m) {
      v.ui.cycleRow.style.display = "none";
      v.ui.terminalRow.style.display = "none";
      v.ui.commentWrap.style.display = "none";
      v.ui.status.textContent = "syncing variants…";
      return;
    }
    v.state = {
      setId: m.setId,
      ...(m.spaceId !== undefined ? { spaceId: m.spaceId } : {}),
      status: m.status,
      ...(m.outcome !== undefined ? { outcome: m.outcome } : {}),
      ...(m.selector !== undefined ? { selector: m.selector } : {}),
      ...(m.rootKind !== undefined ? { rootKind: m.rootKind } : {}),
      ...(m.changeInteractionId !== undefined
        ? { changeInteractionId: m.changeInteractionId }
        : {}),
      // The programs stay in the frame that applies them.
      variants: m.variants.map((x) => ({ ...x, program: [] })),
    };
    if (m.spaceId && !v.spaceId) v.spaceId = m.spaceId;
    v.displayIndex = m.displayIndex;
    v.full = m.full;
    v.nothingApplied = m.nothingApplied;
    v.ui.target.textContent = m.rootKind === "page" ? VARIANT_COPY.wholePage : (m.selector ?? "");
    if (m.changeInteractionId) {
      v.ui.changeLine.style.display = "block";
      v.ui.changeLine.textContent = `edit ${m.changeInteractionId.slice(0, 8)} · ${m.status}`;
    }
    renderCycle(v);
    renderTerminal(v);
    v.ui.status.textContent = m.statusText;
    v.ui.lookNote.textContent = m.lookNote;
    v.ui.lookNote.style.display = m.lookNote ? "" : "none";
    v.ui.refusedNote.textContent = m.refusedNote ?? "";
    v.ui.refusedNote.style.display = m.refusedNote ? "" : "none";
  }

  function renderLocal(v: SetView): void {
    const s = v.state;
    if (!s) return;
    // The capture queue owns the page while busy (F30): defer wholesale.
    if (captureQueueBusy()) {
      v.deferredRender = true;
      return;
    }
    const page = s.rootKind === "page";
    v.ui.target.textContent = page ? VARIANT_COPY.wholePage : (s.selector ?? "");
    if (s.changeInteractionId) {
      const change = app.byId(s.changeInteractionId);
      v.ui.changeLine.style.display = "block";
      v.ui.changeLine.textContent = `edit ${s.changeInteractionId.slice(0, 8)} · ${change?.state ?? s.status}`;
    }
    renderTerminal(v);
    if (s.status === "generating") {
      clearPreview(v);
      v.ui.status.textContent = "generating";
      return;
    }
    if (s.status === "previewing") {
      if (s.variants.length === 0) {
        clearPreview(v);
        v.ui.status.textContent = "previewing — no variants";
        return;
      }
      if (!v.full) {
        renderCycle(v);
        v.ui.status.textContent = "syncing variants…";
        return;
      }
      // Whether or not the person previews, the agent hears how each of its
      // variants applies to the captured copy of the block.
      reportOutcomes(v);
      if (!v.previewing) {
        renderCycle(v);
        v.ui.status.textContent = `${s.variants.length} variant(s) ready`;
        return;
      }
      applyPreview(v, v.displayIndex >= 0 ? normalizedActive(s) : -1, false);
      return;
    }
    v.ui.cycleRow.style.display = "none";
    if (s.outcome === "picked" && s.changeInteractionId) {
      // Pick is keep: the picked program stays on and the kept layer takes it.
      layer.handOff(v.setId, s.changeInteractionId);
    } else {
      clearPreview(v);
    }
    v.ui.status.textContent = `${s.status}${s.outcome ? ` — ${s.outcome}` : ""}`;
  }

  /* ── creation evidence: block edit-context, or the page's body ── */

  const latchStore = deps.captureLatch ?? chromeCaptureLatch();
  let latch: Record<string, number> | null = null;
  const latchReady = latchStore.load().then(
    (m) => {
      latch = { ...m, ...(latch ?? {}) };
    },
    () => {
      latch = latch ?? {};
    },
  );
  /** The latch key: this person, this server, the Edit's space, the Edit. */
  const doneKey = (id: string): string | null => {
    const account = app.account();
    const spaceId = app.byId(id)?.spaceId ?? spaceOfInteraction(id);
    return account && spaceId ? `${account}|${spaceId}|${id}` : null;
  };
  const persistedDone = (id: string): boolean => {
    const key = doneKey(id);
    return key !== null && latch?.[key] !== undefined;
  };
  const markDone = (id: string): void => {
    const key = doneKey(id);
    if (key === null) return;
    latch = { ...(latch ?? {}), [key]: Date.now() };
    latchStore.save(latch);
  };

  /**
   * Captures waiting for this tab's own snapshot to show the Edit (a set can
   * land before the snapshot that holds its Edit). Bounded; run or dropped by
   * `snapshotsChanged`.
   */
  /** Per Edit, each kind of waiting work on its own: one never overwrites another. */
  const deferred = new Map<string, Map<string, () => void>>();
  const MAX_DEFERRED = 24;

  /**
   * Edit context and page bodies are captured only for this person's own
   * Edit, held by this tab's snapshot, on its exact page (ownership.ts). An
   * Edit not in the snapshot yet waits for it; anyone else's Edit never.
   */
  function mayCapture(changeId: string, retry: () => void, kind = "capture"): boolean {
    if (ownsEditHere(app, changeId)) return true;
    if (app.byId(changeId) !== undefined) return false;
    const waiting = deferred.get(changeId);
    if (waiting) waiting.set(kind, retry);
    else if (deferred.size < MAX_DEFERRED) deferred.set(changeId, new Map([[kind, retry]]));
    return false;
  }

  /**
   * `picked` is the block pinned when it was picked (3-E1): it is captured
   * only while that pin holds, and a capture or retry whose pin failed stops,
   * never looks the block up again by selector.
   */
  function maybeCapture(
    changeId: string | undefined,
    selector?: string,
    picked?: PinnedBlock,
  ): void {
    // In whichever frame holds the Edit's block, top or child (E-1).
    if (!changeId) return;
    if (captureDone.has(changeId) || captureInFlight.has(changeId)) return;
    if (latch === null) {
      void latchReady.then(() => maybeCapture(changeId, selector, picked));
      return;
    }
    if (persistedDone(changeId)) return;
    if (!mayCapture(changeId, () => maybeCapture(changeId, selector, picked))) return;
    const attempts = captureAttempts.get(changeId) ?? 0;
    if (attempts >= MAX_CAPTURE_ATTEMPTS) return;
    if (picked && !picked.held()) {
      captureAttempts.set(changeId, MAX_CAPTURE_ATTEMPTS);
      return;
    }
    const found = picked ? null : selector ? document.querySelector(selector) : null;
    const pin = picked ?? (found ? { el: found, held: pinBlock(found) } : null);
    if (!pin) return;
    const block = pin.el;
    captureAttempts.set(changeId, attempts + 1);
    captureInFlight.add(changeId);
    // Bound to this page and account, to the Edit staying this person's here,
    // and to the block staying where it was pinned (3-E1).
    const bound = bindCapture(
      app,
      () => ownsEditHere(app, changeId) && block.isConnected && pin.held(),
    );
    void captureFull(block, changeId, "edit-context", bound)
      .then((outcome) => {
        captureInFlight.delete(changeId);
        if (outcome?.ok) {
          captureDone.add(changeId);
          markDone(changeId);
          return;
        }
        if (outcome?.refusal === "not-yours") {
          // Final: the server says this capture is not this person's to make.
          captureAttempts.set(changeId, MAX_CAPTURE_ATTEMPTS);
          return;
        }
        console.warn(
          `[onlay] edit-context capture failed (attempt ${attempts + 1}/${MAX_CAPTURE_ATTEMPTS})`,
          outcome ? `refusal: ${outcome.refusal}` : "capture did not reach upload",
        );
        // A retry captures the same pinned block, or nothing (3-E1).
        if (attempts + 1 < MAX_CAPTURE_ATTEMPTS && pin.held())
          setTimeout(() => maybeCapture(changeId, selector, pin), CAPTURE_RETRY_MS);
      })
      .catch(() => captureInFlight.delete(changeId));
  }

  /**
   * A page edit's agent reads the page: upload, once, the sanitized body taken
   * when the Edit was asked for (every preview off), only while that snapshot
   * still holds (same document, page and account).
   */
  function uploadPageOnce(spaceId: string, changeId: string, snapshot: BlockSnapshot): void {
    if (pageUploaded.has(changeId)) return;
    if (!snapshot.copy.bound()) return;
    if (!mayCapture(changeId, () => uploadPageOnce(spaceId, changeId, snapshot), "page")) return;
    pageUploaded.add(changeId);
    const page = snapshot.capture;
    // A body reduced to fit is not the whole page either: the agent is told it was cut.
    const cut = page.truncated || page.reduced !== undefined;
    void uploadPage(spaceId, changeId, page.html, cut).then((ok) => {
      if (!ok) app.toast(VARIANT_COPY.pageNotSent);
    });
  }

  /**
   * A block Edit's agent reads the block: upload, once, the redacted markup
   * taken while the person could see it (at the pick; class and id kept for
   * selectors, reduced to fit when too large). Never a fresh read of the live
   * block, which may have been hidden since. Sent only while that snapshot
   * still holds (same document, page, account, block where it was pinned).
   */
  function uploadBlockOnce(changeId: string | undefined, snapshot: BlockSnapshot): void {
    if (!changeId || blockUploaded.has(changeId)) return;
    if (!snapshot.copy.bound()) return;
    if (!mayCapture(changeId, () => uploadBlockOnce(changeId, snapshot), "block")) return;
    blockUploaded.add(changeId);
    if (!snapshot.capture.html) return;
    // Immediately before the send: still what it was taken for (R3-C4).
    app.uploadCapture(changeId, snapshot.capture, snapshot.copy.bound);
  }

  /**
   * The snapshot of a block (or, with `null`, the page) now, with every
   * preview off, bound to this document, page key and account (and, for a
   * block, to its pin: still where it was picked).
   */
  function takeSnapshot(t: Element | null, held: () => boolean): BlockSnapshot {
    let capture: SanitizedAnchor = { html: "", truncated: false };
    let context: VariantElementContext | undefined;
    layer.lifted(() => {
      if (t) {
        context = elementContext(t);
        capture = sanitizeElement(t, LIMITS.MAX_ANCHOR_CONTENT, { keepSelectors: true });
      } else capture = sanitizePage(document.body, app.host);
    });
    return {
      ...(context ? { context } : {}),
      capture,
      copy: {
        html: capture.html,
        page: t === null,
        reduced: capture.truncated || capture.reduced !== undefined,
        base: frameUrl(),
        bound: bindCapture(app, held),
      },
    };
  }

  /** Reports waiting their turn, one variant per slice of main-thread time. */
  const reportQueue: Array<() => void> = [];
  const reportQueued = new Set<string>();
  let reportScheduled = false;
  function scheduleReports(): void {
    if (reportScheduled || reportQueue.length === 0) return;
    reportScheduled = true;
    const run = (): void => {
      reportScheduled = false;
      reportQueue.shift()?.();
      scheduleReports(); // the next one in a later slice: input goes first
    };
    const idle = (
      globalThis as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }
    ).requestIdleCallback;
    if (idle) idle(run, { timeout: 1000 });
    else setTimeout(run, 0);
  }

  /**
   * Report, once per variant version, how each variant written for this
   * person applies to the copy taken at the pick for this Edit, in this
   * document, while it still holds. No such copy (another tab, a reload, a
   * pick that moved or a page that changed since): no report, silently. One
   * variant per slice, the binding checked again right before each send.
   */
  function reportOutcomes(v: SetView): void {
    const s = v.state;
    if (s?.status !== "previewing" || !v.full || v.remote) return;
    if (!setCopies.get(v.setId)?.bound()) return;
    for (const variant of s.variants) {
      const target = {
        setId: v.setId,
        spaceId: v.spaceId,
        changeInteractionId: s.changeInteractionId,
        variant: {
          variantId: variant.variantId,
          version: variant.version ?? 1,
          program: variant.program,
          ...(variant.by !== undefined ? { by: variant.by } : {}),
        },
      };
      const key = `${v.setId}|${variant.variantId}@${variant.version ?? 1}`;
      if (reportQueued.has(key) || !owesReport(outcomeDeps, target)) continue;
      reportQueued.add(key);
      reportQueue.push(() => {
        reportQueued.delete(key);
        const copy = setCopies.get(v.setId);
        if (copy?.bound()) reportVariantOutcome(outcomeDeps, target, copy);
      });
    }
    scheduleReports();
  }

  /* ── public ── */

  /**
   * Ask for variants: resolves once the set lands (its first `variant-state`
   * echoes the nonce), or with the reason it didn't (refused, socket closed,
   * timeout), so the composer keeps its text until then (M-2). A retry of an
   * unconfirmed request reuses its nonce; the server answers it with the
   * first set.
   */
  function startFromChange(
    t: Element | null,
    cmd: string,
    count: number,
    intent: "change" | "insert-after",
    spaceId: string,
    opts: { pickGeneration?: number | null } = {},
  ): Promise<CreateResult> {
    // A block in a frame without an address of its own has no document of its
    // own to preview in: no set is rooted there (A-3).
    if (t && t.ownerDocument !== document) return Promise.resolve({ ok: false, reason: "invalid" });
    // Everything about the block that leaves the browser was read at the pick
    // (or, without one, right now, once): never re-read from the live block.
    const held = t ? pinBlock(t) : null;
    const snapshot = (t && pickSnapshots.get(t)) || takeSnapshot(t, held ?? (() => true));
    const element = snapshot.context;
    if (t && !element) return Promise.resolve({ ok: false, reason: "invalid" });
    const root: VariantRoot = element ? { kind: "block", element } : { kind: "page" };
    const provenance = t ? undefined : documentProvenance();
    const frame = {
      type: "variant-create",
      frameUrl: frameUrl(),
      root,
      command: cmd.slice(0, LIMITS.MAX_COMMAND_INTENT),
      count: Math.min(count, LIMITS.MAX_VARIANTS_PER_SET),
      ...(intent !== "change" ? { intent } : {}),
      ...(provenance ? { provenance } : {}),
      // Checked by the service worker right before it sends, then dropped (3-F3).
      ...(opts.pickGeneration !== undefined ? { pickGeneration: opts.pickGeneration } : {}),
      spaceId,
    };
    const place = `variant-create:${spaceId}`;
    const nonce = clientIdFor(place, frame);
    // Pinned now (3-E1): the pin travels with the create through its receipt,
    // with the snapshot taken at the pick.
    pending.set(nonce, {
      spaceId,
      block: t && held ? { el: t, held } : null,
      snapshot,
      openOnLand: true,
      url: frameUrl(),
    });
    const landed = app.awaitCreate(nonce, spaceId);
    void app.send({ ...frame, nonce }).then((res) => {
      if (res.ok) return;
      app.settleCreate(nonce, { ok: false, reason: res.error ?? "no-response" });
    });
    return landed.then((r) => {
      if (r.ok) confirmSend(place, nonce);
      else pending.delete(nonce);
      return r;
    });
  }

  function openSet(setId: string, mount?: HTMLElement): void {
    const v = viewFor(setId);
    dock(v, mount);
    v.openedSidecar = true;
    if (!v.previewing) {
      v.previewing = true;
      v.displayIndex = 0;
    }
    if (v.state) {
      renderState(v);
      return;
    }
    v.ui.status.textContent = "syncing variants…";
    sendFrame(v, "variant-sync", {});
  }

  function onVariantState(msg: VariantStateMessage): void {
    // A child frame's set: that frame holds its state; this panel mirrors it (E-1).
    if (views.get(msg.setId)?.remote) return;
    const created = msg.nonce !== undefined ? pending.get(msg.nonce) : undefined;
    if (!created && !views.has(msg.setId)) return; // not a set this page tracks
    if (created && msg.nonce) {
      pending.delete(msg.nonce);
      app.settleCreate(msg.nonce, {
        ok: true,
        ...(msg.changeInteractionId ? { interactionId: msg.changeInteractionId } : {}),
      });
    }
    const v = viewFor(msg.setId, msg.spaceId ?? created?.spaceId);
    if (created) {
      v.previewing = true;
      v.knownUrl = created.url;
    }
    v.state = { ...msg, variants: [...msg.variants] };
    if (msg.truncated === true && msg.status === "previewing") fillTruncated(v);
    else {
      v.fetchSeq += 1; // a whole frame supersedes a fetch still in flight
      v.full = true;
    }

    if (created) {
      // Only the document that made the pick keeps its copy: reports come from here alone.
      setCopies.set(msg.setId, created.snapshot.copy);
      if (created.block) {
        setPins.set(msg.setId, created.block);
        maybeCapture(msg.changeInteractionId, msg.selector, created.block);
        uploadBlockOnce(msg.changeInteractionId, created.snapshot);
      } else if (msg.changeInteractionId && v.spaceId)
        uploadPageOnce(v.spaceId, msg.changeInteractionId, created.snapshot);
    } else if (msg.rootKind !== "page") {
      maybeCapture(msg.changeInteractionId, msg.selector);
    }

    void bookmark(v, msg.status !== "resolved").catch(() => {});
    renderState(v);

    // A child frame's `openChangeJob` opens the Edit in the top frame (E-1).
    const owner = msg.changeInteractionId;
    if (!owner || msg.status === "resolved" || v.openedSidecar) return;
    if (created?.openOnLand || autoOpenSetId === msg.setId) {
      v.openedSidecar = true;
      if (autoOpenSetId === msg.setId) autoOpenSetId = null;
      deps.openChangeJob?.(owner, v.spaceId);
    }
  }

  function sync(): void {
    for (const v of views.values()) if (v.spaceId && !v.remote) sendFrame(v, "variant-sync", {});
    const scope = scopeOf();
    if (scope === null) return;
    void bookmarks
      .load(scope)
      .then((map) => {
        if (scopeOf() !== scope) return;
        const list = map[frameUrl()] ?? [];
        const last = list.at(-1);
        // The top page reopens its last set's side panel; a child frame's would
        // be the top frame's modal over the page, so it waits to be opened.
        if (last && !views.has(last.setId) && app.isTopFrame) autoOpenSetId = last.setId;
        for (const b of list) {
          if (views.has(b.setId)) continue;
          const v = viewFor(b.setId, b.spaceId);
          v.previewing = b.setId === last?.setId;
          sendFrame(v, "variant-sync", {});
        }
      })
      .catch(() => {});
  }

  /** Forget one set here: its panel, its preview, its pending fetch. */
  function dropView(v: SetView): void {
    setPins.delete(v.setId);
    setCopies.delete(v.setId);
    layer.clearPreview(v.setId);
    v.fetchSeq += 1;
    v.ui.panel.remove();
    views.delete(v.setId);
    if (autoOpenSetId === v.setId) autoOpenSetId = null;
  }

  function scopeChanged(prev: string | null, next: string | null, spaceIds: readonly string[]) {
    const keep = new Set(spaceIds);
    if (prev !== next) {
      for (const v of [...views.values()]) dropView(v);
      // What child frames reported belonged to the old account too (E-1).
      latest.clear();
      pending.clear();
      deferred.clear();
      autoOpenSetId = null;
      cancelVariantPasses(() => true);
      if (prev !== null) void serialBookmarks(() => bookmarks.clear(prev)).catch(() => {});
      setPreviewLabel(false);
      return;
    }
    const lost = [...views.values()].filter((v) => v.spaceId !== undefined && !keep.has(v.spaceId));
    for (const v of lost) dropView(v);
    for (const [key, k] of [...latest])
      if (k.mirror.spaceId !== undefined && !keep.has(k.mirror.spaceId)) latest.delete(key);
    paintLabel();
    for (const [nonce, p] of pending) if (!keep.has(p.spaceId)) pending.delete(nonce);
    if (next === null) return;
    void serialBookmarks(async () => {
      const map = await bookmarks.load(next);
      const pruned: Record<string, SetBookmark[]> = {};
      let changed = false;
      for (const [url, list] of Object.entries(map)) {
        const kept = list.filter((b) => keep.has(b.spaceId));
        if (kept.length !== list.length) changed = true;
        if (kept.length > 0) pruned[url] = kept;
      }
      if (changed && scopeOf() === next) await bookmarks.save(next, pruned);
    }).catch(() => {});
  }

  function openRemoteSet(
    setId: string,
    mount: HTMLElement,
    documentId: string,
    changeId: string,
  ): void {
    const v = viewFor(setId, spaceOfInteraction(changeId));
    if (v.remote !== documentId) {
      // Another document of the frame (it reloaded): it is asked afresh.
      v.remote = documentId;
      v.mirror = latest.get(latestKey(documentId, setId))?.mirror ?? null;
      v.previewing = false;
    }
    dock(v, mount);
    v.openedSidecar = true;
    if (!v.previewing) {
      v.previewing = true;
      remoteAct(v, { act: "open", changeId });
    }
    renderRemote(v);
    paintLabel();
  }

  function mirror(documentId: string, sets: readonly SetMirror[]): void {
    const reported = new Set(sets.map((m) => m.setId));
    for (const [key, k] of [...latest])
      if (k.documentId === documentId && !reported.has(k.mirror.setId)) latest.delete(key);
    for (const m of sets) {
      latest.set(latestKey(documentId, m.setId), { documentId, mirror: m });
      const v = views.get(m.setId);
      if (v?.remote !== documentId) continue;
      v.mirror = m;
      renderRemote(v);
    }
    // A set the frame showed before and no longer holds (its Edit gone for
    // this person, an access change): its panel goes too.
    for (const v of [...views.values()])
      if (v.remote === documentId && v.mirror !== null && !reported.has(v.setId)) dropView(v);
    paintLabel();
  }

  function forgetFrame(documentId: string): void {
    for (const [key, k] of [...latest]) if (k.documentId === documentId) latest.delete(key);
    for (const v of [...views.values()]) if (v.remote === documentId) dropView(v);
    paintLabel();
  }

  function forgetFrameSpaces(which: (spaceId: string | undefined) => boolean): void {
    for (const [key, k] of [...latest]) if (which(k.mirror.spaceId)) latest.delete(key);
    for (const v of [...views.values()]) if (v.remote && which(v.spaceId)) dropView(v);
    paintLabel();
  }

  function mirrors(): { sets: SetMirror[] } {
    const sets: SetMirror[] = [];
    for (const v of views.values()) {
      const s = v.state;
      if (!s || v.remote) continue;
      sets.push({
        setId: v.setId,
        ...(v.spaceId !== undefined ? { spaceId: v.spaceId } : {}),
        status: s.status,
        ...(s.outcome !== undefined ? { outcome: s.outcome } : {}),
        ...(s.selector !== undefined ? { selector: s.selector.slice(0, LIMITS.MAX_SELECTOR) } : {}),
        ...(s.rootKind !== undefined ? { rootKind: s.rootKind } : {}),
        ...(s.changeInteractionId !== undefined
          ? { changeInteractionId: s.changeInteractionId }
          : {}),
        variants: s.variants.slice(0, LIMITS.MAX_VARIANTS_PER_SET).map((x) => ({
          variantId: x.variantId,
          label: x.label.slice(0, LIMITS.MAX_VARIANT_LABEL),
          version: x.version ?? 1,
        })),
        displayIndex: v.displayIndex,
        full: v.full,
        nothingApplied: v.nothingApplied,
        previewing: v.previewing,
        statusText: (v.ui.status.textContent ?? "").slice(0, MIRROR_TEXT),
        lookNote:
          v.ui.lookNote.style.display === "none"
            ? ""
            : (v.ui.lookNote.textContent ?? "").slice(0, MIRROR_TEXT),
        refusedNote:
          v.ui.refusedNote.style.display === "none"
            ? ""
            : (v.ui.refusedNote.textContent ?? "").slice(0, MIRROR_TEXT),
      });
    }
    return { sets: sets.slice(-MAX_MIRRORED_SETS) };
  }

  function drive(setId: string, act: RemoteAct): boolean {
    if (act.act === "open") {
      // A set this frame made or keeps, or one its own snapshot names as its Edit's.
      const own = views.get(setId);
      const edit = app.byId(act.changeId);
      const named = edit?.kind === "change" && edit.change?.variantSetId === setId;
      if (own?.remote || (!own && !named)) return false;
      openSet(setId);
      return true;
    }
    const v = views.get(setId);
    if (!v || v.remote) return false;
    switch (act.act) {
      case "cycle":
        cycle(v, act.delta);
        return true;
      case "pick":
        return pickShown(v, act);
      case "discard":
        return discardSet(v);
      case "more":
        return askMore(v);
    }
  }

  return {
    previewLabel,
    openSet,
    openRemoteSet,
    mirror,
    forgetFrame,
    forgetFrameSpaces,
    mirrors,
    drive,
    pinOf: (setId) => setPins.get(setId),
    startFromChange,
    notePick(t: Element) {
      const snap = takeSnapshot(t, pinBlock(t));
      pickSnapshots.set(t, snap);
      return { large: snap.copy.reduced };
    },
    onVariantState,
    scopeChanged,
    dropForEdits(editIds) {
      const gone = [...views.values()].filter((v) => {
        const id = v.state?.changeInteractionId;
        return id !== undefined && editIds.has(id);
      });
      for (const v of gone) dropView(v);
      for (const id of editIds) deferred.delete(id);
      const setIds = new Set(gone.map((v) => v.setId));
      if (setIds.size > 0) cancelVariantPasses((setId) => setIds.has(setId));
    },
    snapshotsChanged() {
      for (const [changeId, jobs] of [...deferred]) {
        if (app.byId(changeId) === undefined) continue; // still waiting for its Edit
        deferred.delete(changeId);
        // Each job runs only if the Edit turned out to be this person's, here.
        for (const retry of jobs.values()) retry();
      }
      // An Edit may have become this person's here: its variants can be reported now.
      for (const v of views.values()) reportOutcomes(v);
    },
    pageChanged() {
      for (const v of views.values()) renderState(v);
    },
    onVariantReceipt(msg) {
      if (msg.ok) app.toast(`variant ${msg.kind} ✓`);
      else if (msg.reason === "variant-changed") app.toast(VARIANT_COPY.pickChanged);
      else app.toast(`variant ${msg.kind} rejected: ${msg.reason ?? "unknown"}`);
    },
    sync,
    settle() {
      for (const v of views.values()) {
        if (!v.deferredRender) continue;
        v.deferredRender = false;
        renderState(v);
      }
    },
    displaced(setId) {
      const v = views.get(setId);
      if (!v) return;
      v.displayIndex = -1;
      renderCycle(v);
      renderTerminal(v);
    },
    setIds: () => [...views.keys()],
  };
}
