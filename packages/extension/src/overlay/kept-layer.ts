// The kept layer and the preview stack (spec §8). Everything onlay applies to
// the live page as a preview goes through here, so stacked programs always
// come off in reverse and go back on in order:
//   1. kept Edits — each through its own preview engine, in `at` order,
//      shown per viewer (default on for the person who kept it, off for
//      everyone else; the choice is stored locally per Edit);
//   2. the variant sets being previewed — at most one per root; a kept
//      program on the same root steps aside while a preview is shown;
//   3. the witness pass's preview, which owns the page while the capture
//      queue runs (the layer is suspended then, so looks never carry
//      someone's kept edit unless it is the variant being captured).
// The layer is a pure view of `interactions-state.kept`: entries come and go
// with the snapshots, and an Edit that reached implemented, verifying,
// resolved or dropped is never shown. Nothing applies off the Edit's own page
// (`page-url.ts`), and everything belongs to one person on one server: the
// viewer's choices are kept per person, origin and space, and an account
// change takes every program and preview off the page.
import type { KeptEdit, MutationProgram, VariantRoot } from "@onlay/protocol";
import type { ApplyResult, PreviewEngine, PreviewRoot } from "@onlay/render";
import { pageKey, samePage } from "./page-url";

/** States from which an Edit's program is no longer kept on the page. */
const RETIRED = new Set(["implemented", "verifying", "resolved", "dropped"]);

/** How long a picked preview waits for its kept entry before letting go. */
const HANDOFF_MS = 8_000;

/** The chrome.storage.local key holding each Edit's shown/hidden choice. */
const KEPT_SHOWN_KEY = "onlayKeptShown";

/**
 * The viewer's per-Edit choices, persisted (chrome.storage.local in the
 * extension). Keys are `<person>|<server origin>|<space>|<interactionId>|<kept
 * identity>`, so a choice never follows a different person, server or space —
 * nor a different program than the one the viewer switched on.
 */
export interface ShownStore {
  load(): Promise<Record<string, boolean>>;
  save(choices: Record<string, boolean>): void;
}

export interface KeptLayerDeps {
  /** `onEnded`: a re-render ended the engine's application (it came off whole). */
  createEngine(onEnded?: () => void): PreviewEngine;
  selfId(): string | null;
  /** `<person>|<server origin>` while signed in, else null. */
  scope(): string | null;
  /** The page's URL right now (an SPA moves it under us). */
  pageUrl(): string;
  /** The Edit's own URL when this page holds its snapshot. */
  urlOf(interactionId: string): string | undefined;
  /** The Edit's current state when this page holds its snapshot. */
  stateOf(interactionId: string): string | undefined;
  store: ShownStore;
  /** Something the launcher, bar or rows show changed. */
  onChange(): void;
  /** Another set took this set's root: its controller drops back to Original. */
  onDisplaced?(setId: string): void;
  /** The page changed under this set's preview: it came off, and the panel says so. */
  onPreviewEnded?(setId: string): void;
  /** Timers (tests drive them). */
  setTimer?(fn: () => void, ms: number): unknown;
}

/** One kept Edit as the bar and rows show it. */
export interface KeptRow {
  interactionId: string;
  /** The child document this kept edit is applied in (top frame, 2-E4); absent for this one. */
  documentId?: string;
  spaceId: string;
  label: string;
  by: string;
  at: number;
  on: boolean;
  /** Its root or a target is missing here: it can't be shown on this page. */
  unresolved: boolean;
  /** Ops of its program this page refused (the edit shows, but not all of it). */
  refused: number;
}

/** A preview the layer would not put on this page: its Edit lives on another one. */
export type PreviewResult = ApplyResult | { ok: false; reason: "other-page" };

export interface KeptLayer {
  /** Adopt one space's kept entries for this page (from `interactions-state`). */
  setKept(spaceId: string, entries: readonly KeptEdit[]): void;
  /** Forget spaces that are gone: their kept programs and previews come off. */
  keepSpaces(spaceIds: readonly string[]): void;
  /**
   * The signed-in person or server changed (or signed out): every kept program
   * and preview comes off and is forgotten. Returns true when it changed.
   */
  setScope(scope: string | null): boolean;
  /** The page's URL changed (an SPA route): everything is re-checked against it. */
  pageChanged(): void;
  rows(): KeptRow[];
  /** Kept programs applied right now (the launcher's "edits shown" count). */
  shownCount(): number;
  isOn(interactionId: string): boolean;
  setOn(interactionId: string, on: boolean): void;
  isUnresolved(interactionId: string): boolean;
  /**
   * Show (or replace) one set's preview; at most one set per root. `url` is
   * the Edit's page: the preview only goes on when this page is that page.
   */
  showPreview(
    setId: string,
    root: PreviewRoot,
    program: MutationProgram,
    where: { url: string | undefined; spaceId?: string | undefined },
  ): PreviewResult;
  /** Take one set's preview off the page. */
  clearPreview(setId: string): void;
  /** True while this exact preview application is live (capture verification). */
  previewApplied(setId: string, token: number): boolean;
  /** The set's preview result while that very application is still on the page; else null. */
  previewNow(setId: string): ApplyResult | null;
  /**
   * A picked preview stays on until the Edit's kept entry arrives (then the
   * layer shows it instead), the Edit retires, or a few seconds pass.
   */
  handOff(setId: string, interactionId: string): void;
  /** The capture queue owns the page: everything comes off until resume. */
  suspend(): void;
  resume(): void;
  isSuspended(): boolean;
  /** Take every preview off, run `fn` (raw page edits), put them back. */
  lifted(fn: () => void): void;
  /**
   * When this Edit's kept entry lands, run `fn` with every preview off (the
   * hand-edit tray unwinds its raw edits there), then show the layer. Given
   * up after `timeoutMs`: an Edit that went to an agent instead is never kept.
   */
  whenKept(interactionId: string, fn: () => void, timeoutMs?: number, onTimeout?: () => void): void;
  /** The witness pass's engine: it applies alone while the layer is suspended. */
  readonly passEngine: PreviewEngine;
}

/**
 * What exactly was kept: the picked variant at the revision that was picked,
 * or for a hand-made batch the moment it was kept. An entry from a server that
 * names no revision is identified by its program itself. A viewer's switch
 * holds only while this stays the same; a revised pick starts from the default
 * again (on only for the person who kept it).
 */
function keptIdentity(e: KeptEdit): string {
  if (e.variantId !== undefined && e.version !== undefined) return `v:${e.variantId}@${e.version}`;
  if (e.setId === undefined) return `b:${e.at}`;
  return `p:${e.at}:${fnv1a(JSON.stringify(e.program))}`;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A kept or variant root as the engine reads it. */
function previewRootOf(root: VariantRoot): PreviewRoot {
  return root.kind === "page" ? { kind: "page" } : root.element.selector;
}

function rootKey(root: PreviewRoot): string {
  if (root === undefined) return "doc";
  return typeof root === "string" ? `block:${root}` : "page";
}

interface KeptSlot {
  entry: KeptEdit;
  spaceId: string;
  engine: PreviewEngine;
}

interface PreviewSlot {
  setId: string;
  spaceId: string | undefined;
  url: string | undefined;
  root: PreviewRoot;
  key: string;
  program: MutationProgram;
  engine: PreviewEngine;
  result: ApplyResult | null;
  handoffId?: string;
}

export function createKeptLayer(deps: KeptLayerDeps): KeptLayer {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const bySpace = new Map<string, KeptEdit[]>();
  const slots = new Map<string, KeptSlot>();
  const previews = new Map<string, PreviewSlot>();
  const unresolved = new Set<string>();
  /** Per shown kept Edit, how many of its ops this page refused. */
  const refusedCount = new Map<string, number>();
  const shown = new Set<string>();
  /**
   * Kept edits a re-render ended on this page, by their switch's key: not
   * shown again until the next load or a switch of that one.
   */
  const ended = new Set<string>();
  let choices: Record<string, boolean> = {};
  let ready = false;
  let suspended = false;
  let scope = deps.scope();
  /** Engines on the page right now, in the order they went on. */
  let applied: PreviewEngine[] = [];

  const waiters = new Map<string, () => void>();
  const passEngineReal = deps.createEngine();
  /** The look in progress: its program, root and the page key it was applied for (2-E1). */
  let pass: { program: MutationProgram; root: PreviewRoot; page: string | null } | null = null;
  let passResult: ApplyResult | null = null;

  void deps.store.load().then(
    (c) => {
      choices = { ...c, ...choices };
      ready = true;
      recompute();
    },
    () => {
      ready = true;
      recompute();
    },
  );

  function retired(id: string): boolean {
    const state = deps.stateOf(id);
    return state !== undefined && RETIRED.has(state);
  }

  /** The stored choice's key: this person, this server, the Edit's space, what was kept. */
  function choiceKey(slot: KeptSlot): string | null {
    if (scope === null) return null;
    return `${scope}|${slot.spaceId}|${slot.entry.interactionId}|${keptIdentity(slot.entry)}`;
  }

  function isOn(id: string): boolean {
    const slot = slots.get(id);
    if (!slot) return false;
    const key = choiceKey(slot);
    if (key === null) return false;
    const choice = choices[key];
    if (choice !== undefined) return choice;
    const self = deps.selfId();
    return self !== null && slot.entry.by === self;
  }

  /** The Edit (or the set's Edit) belongs to the page the viewer is on now. */
  function onThisPage(url: string | undefined): boolean {
    return samePage(url, deps.pageUrl());
  }

  /** A re-render ended this kept edit's application: it already came off whole. */
  function keptEnded(id: string): void {
    const slot = slots.get(id);
    const key = slot ? choiceKey(slot) : null;
    if (!slot || key === null) return;
    ended.add(key);
    applied = applied.filter((e) => e !== slot.engine);
    shown.delete(id);
    refusedCount.delete(id);
    unresolved.add(id);
    deps.onChange();
  }

  /**
   * A re-render ended this set's preview: it goes as a cleared preview does,
   * and what it held off on its root (a kept edit) comes back.
   */
  function previewEnded(setId: string, engine: PreviewEngine): void {
    if (previews.get(setId)?.engine !== engine) return;
    dropPreview(setId, false);
    recompute();
    deps.onPreviewEnded?.(setId);
  }

  function safeApply(
    engine: PreviewEngine,
    program: MutationProgram,
    root: PreviewRoot,
  ): ApplyResult {
    try {
      return engine.apply(program, root);
    } catch {
      // Whatever it wrote comes off: a half-applied program never stays.
      try {
        engine.restore();
      } catch {
        /* a page that fights back never breaks the overlay */
      }
      return { ok: false, reason: "failed" };
    }
  }

  function takeAllOff(): void {
    for (const engine of [...applied].reverse()) {
      try {
        engine.restore();
      } catch {
        /* a page that fights back never breaks the overlay */
      }
    }
    applied = [];
  }

  /**
   * Removing or replacing any engine starts from a bare page: every engine
   * comes off in reverse first, so none restores another's write (an upper
   * engine's snapshot holds the lower one's value). `recompute` re-applies
   * what remains, in order.
   */
  function syncSlots(): void {
    takeAllOff();
    const wanted = new Map<string, { entry: KeptEdit; spaceId: string }>();
    for (const [spaceId, list] of bySpace) {
      for (const entry of list) {
        if (retired(entry.interactionId)) continue;
        wanted.set(entry.interactionId, { entry, spaceId });
      }
    }
    for (const [id, slot] of slots) {
      if (wanted.has(id)) continue;
      slot.engine.dispose();
      slots.delete(id);
      unresolved.delete(id);
    }
    for (const [id, w] of wanted) {
      const slot = slots.get(id);
      if (slot) {
        slot.entry = w.entry;
        slot.spaceId = w.spaceId;
      } else {
        slots.set(id, { ...w, engine: deps.createEngine(() => keptEnded(id)) });
      }
    }
    // A picked preview hands over the moment its kept entry lands (or retires).
    for (const [setId, p] of previews) {
      if (!p.handoffId) continue;
      if (slots.has(p.handoffId) || retired(p.handoffId)) {
        p.engine.dispose(); // the stack is already off (top of syncSlots)
        previews.delete(setId);
      }
    }
  }

  /** A look's program goes on only while the document is still on the page it was for (2-E1). */
  function applyPass(p: NonNullable<typeof pass>): void {
    if (p.page === null || pageKey(deps.pageUrl()) !== p.page) {
      passResult = { ok: false, reason: "target-missing" };
      return;
    }
    passResult = safeApply(passEngineReal, p.program, p.root);
    if (passResult.ok) applied.push(passEngineReal);
  }

  function recompute(): void {
    takeAllOff();
    for (const [id, fn] of waiters) {
      if (!slots.has(id)) continue;
      waiters.delete(id);
      try {
        fn();
      } catch {
        /* the raw edits were already gone */
      }
    }
    const before = `${[...shown].sort().join()}|${[...unresolved].sort().join()}`;
    shown.clear();
    if (suspended) {
      if (pass) applyPass(pass);
    } else {
      const previewKeys = new Set([...previews.values()].map((p) => p.key));
      const handing = new Set([...previews.values()].flatMap((p) => p.handoffId ?? []));
      const ordered = [...slots.values()].sort(
        (a, b) =>
          a.entry.at - b.entry.at || a.entry.interactionId.localeCompare(b.entry.interactionId),
      );
      if (ready) {
        for (const slot of ordered) {
          const id = slot.entry.interactionId;
          if (!isOn(id) || handing.has(id)) continue;
          const key = choiceKey(slot);
          if (key !== null && ended.has(key)) {
            unresolved.add(id);
            continue;
          }
          // Revalidated at every apply: an SPA may have moved the page.
          if (!onThisPage(deps.urlOf(id))) continue;
          const root = previewRootOf(slot.entry.root);
          if (previewKeys.has(rootKey(root))) continue; // the preview wins while shown
          const r = safeApply(slot.engine, slot.entry.program, root);
          // Nothing of it landed: not shown, whatever the engine's verdict.
          if (r.ok && r.applied > 0) {
            applied.push(slot.engine);
            shown.add(id);
            unresolved.delete(id);
            refusedCount.set(id, r.refused?.length ?? 0);
          } else {
            if (r.ok) applied.push(slot.engine); // nothing to undo, but restore stays exact
            unresolved.add(id);
            refusedCount.delete(id);
          }
        }
      }
      for (const p of previews.values()) {
        if (!onThisPage(p.url)) {
          p.result = null;
          continue;
        }
        p.result = safeApply(p.engine, p.program, p.root);
        if (p.result.ok) applied.push(p.engine);
      }
      if (pass) applyPass(pass);
    }
    const after = `${[...shown].sort().join()}|${[...unresolved].sort().join()}`;
    if (before !== after) deps.onChange();
  }

  const passEngine: PreviewEngine = {
    apply(program, root) {
      pass = { program, root, page: pageKey(deps.pageUrl()) };
      recompute();
      return passResult ?? { ok: false, reason: "target-missing" };
    },
    restore() {
      if (!pass) return;
      pass = null;
      passResult = null;
      recompute();
    },
    dispose() {
      passEngine.restore();
    },
    reapply: () => passEngineReal.reapply(),
    get active() {
      return pass !== null;
    },
    applied: (token) => passEngineReal.applied(token),
    insertedRects: () => passEngineReal.insertedRects(),
  };

  /** Take one preview off for good (the stack is unwound first). */
  function dropPreview(setId: string, displaced: boolean): void {
    const p = previews.get(setId);
    if (!p) return;
    takeAllOff();
    p.engine.dispose();
    previews.delete(setId);
    if (displaced) deps.onDisplaced?.(setId);
  }

  /** Forget every kept entry, preview and pass: the scope they belonged to is gone. */
  function forgetAll(): void {
    takeAllOff();
    for (const slot of slots.values()) slot.engine.dispose();
    slots.clear();
    bySpace.clear();
    unresolved.clear();
    ended.clear();
    for (const setId of [...previews.keys()]) dropPreview(setId, true);
    waiters.clear();
    pass = null;
    passResult = null;
    passEngineReal.restore();
  }

  const rowsSig = (): string =>
    [...slots.values()]
      .map(
        (s) =>
          `${s.entry.interactionId}:${s.entry.at}:${s.entry.label}:${isOn(s.entry.interactionId)}`,
      )
      .join("|");

  return {
    setKept(spaceId, entries) {
      const before = rowsSig();
      bySpace.set(spaceId, [...entries]);
      syncSlots();
      recompute();
      if (rowsSig() !== before) deps.onChange();
    },
    keepSpaces(spaceIds) {
      const keep = new Set(spaceIds);
      let changed = false;
      for (const id of [...bySpace.keys()]) {
        if (keep.has(id)) continue;
        bySpace.delete(id);
        changed = true;
      }
      for (const [setId, p] of previews) {
        if (p.spaceId === undefined || keep.has(p.spaceId)) continue;
        dropPreview(setId, true);
        changed = true;
      }
      if (!changed) return;
      syncSlots();
      recompute();
      deps.onChange();
    },
    setScope(next) {
      if (next === scope) return false;
      scope = next;
      forgetAll();
      recompute();
      deps.onChange();
      return true;
    },
    pageChanged() {
      // Everything that belonged to the old page comes off before anything is
      // recomputed (2-E1): a look in progress, and the previews of other pages.
      takeAllOff();
      pass = null;
      passResult = null;
      for (const [setId, p] of [...previews]) if (!onThisPage(p.url)) dropPreview(setId, true);
      recompute();
      deps.onChange();
    },
    rows() {
      return [...slots.values()]
        .sort((a, b) => a.entry.at - b.entry.at)
        .map((s) => ({
          interactionId: s.entry.interactionId,
          spaceId: s.spaceId,
          label: s.entry.label,
          by: s.entry.by,
          at: s.entry.at,
          on: isOn(s.entry.interactionId),
          unresolved: unresolved.has(s.entry.interactionId),
          refused: refusedCount.get(s.entry.interactionId) ?? 0,
        }));
    },
    shownCount: () => shown.size,
    isOn,
    setOn(id, on) {
      const slot = slots.get(id);
      const key = slot ? choiceKey(slot) : null;
      if (key === null) return;
      choices = { ...choices, [key]: on };
      ended.delete(key);
      deps.store.save(choices);
      recompute();
      deps.onChange();
    },
    isUnresolved: (id) => unresolved.has(id),
    showPreview(setId, root, program, where) {
      const key = rootKey(root);
      for (const [other, p] of previews) {
        if (other === setId || p.key !== key) continue;
        dropPreview(other, true);
      }
      const existing = previews.get(setId);
      if (existing) {
        takeAllOff();
        existing.root = root;
        existing.key = key;
        existing.program = program;
        existing.url = where.url;
        existing.spaceId = where.spaceId;
        delete existing.handoffId;
      } else {
        const engine: PreviewEngine = deps.createEngine(() => previewEnded(setId, engine));
        previews.set(setId, {
          setId,
          spaceId: where.spaceId,
          url: where.url,
          root,
          key,
          program,
          engine,
          result: null,
        });
      }
      recompute();
      if (!onThisPage(where.url)) return { ok: false, reason: "other-page" };
      const slot = previews.get(setId);
      if (suspended) return { ok: true, token: 0, applied: 0 };
      return slot?.result ?? { ok: false, reason: "target-missing" };
    },
    clearPreview(setId) {
      if (!previews.has(setId)) return;
      dropPreview(setId, false);
      recompute();
    },
    previewApplied(setId, token) {
      return previews.get(setId)?.engine.applied(token) ?? false;
    },
    previewNow(setId) {
      // What the set's preview did, only while that application is still on the page.
      const r = previews.get(setId)?.result;
      if (suspended || !r || !r.ok || r.token === 0) return null;
      return previews.get(setId)?.engine.applied(r.token) ? r : null;
    },
    handOff(setId, interactionId) {
      const p = previews.get(setId);
      if (!p) return;
      p.handoffId = interactionId;
      syncSlots();
      recompute();
      setTimer(() => {
        const still = previews.get(setId);
        if (still?.handoffId !== interactionId) return;
        dropPreview(setId, false);
        recompute();
      }, HANDOFF_MS);
    },
    suspend() {
      if (suspended) return;
      suspended = true;
      recompute();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      recompute();
    },
    isSuspended: () => suspended,
    lifted(fn) {
      takeAllOff();
      try {
        fn();
      } finally {
        recompute();
      }
    },
    whenKept(interactionId, fn, timeoutMs = 15_000, onTimeout) {
      waiters.set(interactionId, fn);
      if (slots.has(interactionId)) {
        recompute();
        return;
      }
      setTimer(() => {
        if (waiters.get(interactionId) !== fn) return;
        waiters.delete(interactionId);
        // The kept entry never came: the caller takes its raw edits off, with
        // every preview lifted so nothing restores another's write.
        if (onTimeout) {
          takeAllOff();
          try {
            onTimeout();
          } finally {
            recompute();
          }
        }
      }, timeoutMs);
    },
    passEngine,
  };
}

/** The real store: one chrome.storage.local key, fail-soft. */
export function chromeShownStore(): ShownStore {
  return {
    async load() {
      try {
        const got = (await chrome.storage.local.get(KEPT_SHOWN_KEY)) as Record<string, unknown>;
        const raw = got[KEPT_SHOWN_KEY];
        const out: Record<string, boolean> = {};
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw)) if (typeof v === "boolean") out[k] = v;
        }
        return out;
      } catch {
        return {};
      }
    },
    save(choices) {
      try {
        // Bounded: the newest 500 choices are plenty for any one viewer.
        const entries = Object.entries(choices).slice(-500);
        void chrome.storage.local
          .set({ [KEPT_SHOWN_KEY]: Object.fromEntries(entries) })
          .catch(() => {});
      } catch {
        /* stale context (F-053) — the choice holds for this page */
      }
    },
  };
}
