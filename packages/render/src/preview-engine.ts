import { type MutationOp, type MutationProgram, maxOpsFor } from "@onlay/protocol";

/** Per-node snapshot of exactly the properties a program will touch (restore
 *  discipline). Named `NodeSnapshot` so it never collides with the interaction
 *  `Snapshot` the full-page view also carries (fallow duplicate-export gate). */
export interface NodeSnapshot {
  restore(): void;
}

/** The whole page as a program's root (spec §8): `:scope` is `document.body`. */
export interface PageRoot {
  kind: "page";
}

/**
 * Where a program applies: a block's selector (`:scope` is that block), the
 * whole page, or nothing (legacy document-wide resolution).
 */
export type PreviewRoot = string | PageRoot | undefined;

/**
 * Why an op was left out of an otherwise applied program. The `url-*`,
 * `style-*`, `text-target` and `attr-denied` reasons are the live-page policy
 * (see `PagePolicy`): what a program from anyone may do on someone's page.
 */
export type RefusalReason =
  | "page-root-text"
  | "page-root-replace"
  | "over-budget"
  /** A resource URL from an origin the page does not already load from. */
  | "url-origin"
  /** A link or resource URL with a scheme the policy does not allow. */
  | "url-scheme"
  /** A style value that loads, scripts or imports something the policy refuses. */
  | "style-value"
  /** A style property name outside the plain CSS grammar. */
  | "style-property"
  /** Text or markup aimed into a raw-text, embedding or head element. */
  | "text-target"
  /** An attribute no program may set. */
  | "attr-denied";

/** One op the engine refused to apply; the rest of the program still lands. */
export interface RefusedOp {
  index: number;
  reason: RefusalReason;
}

/**
 * `applied` counts the ops whose write landed; `refused` names the ones left
 * out. A result with refused ops did NOT render the stored program: callers
 * never present it as if it had (R2-C7).
 */
export type ApplyResult =
  | { ok: true; token: number; applied: number; refused?: RefusedOp[] }
  | { ok: false; reason: "sanitization-rejected" | "target-missing" };

export interface PreviewEngine {
  /**
   * Apply a program as an indicative preview; captures snapshots BEFORE first
   * touch. `root` is the set's root: a block selector (op targets resolve
   * relative to it, ":scope" IS the block), `{kind: "page"}` (":scope" is
   * `document.body`; `setText` or a `replace` insert aimed at the body is
   * refused), or absent (pre-root-capture sets: document-wide). Ops past the
   * root's budget (`maxOpsFor`) are refused, never applied.
   */
  apply(program: MutationProgram, root?: PreviewRoot): ApplyResult;
  /** Revert everything this engine applied (cycling / discard). */
  restore(): void;
  /** Restore, and stop re-applying after page mutations (the engine is done). */
  dispose(): void;
  /** Re-apply the active program after a framework re-render clobbered it (MutationObserver-driven). */
  reapply(): void;
  readonly active: boolean;
  /** True while the exact application `token` names is live on the DOM (F30). */
  applied(token: number): boolean;
  /** Document-space rects of nodes the active program inserted (F30 geometry). */
  insertedRects(): Array<{ x: number; y: number; width: number; height: number }>;
}

type ApplyFailure = "sanitization-rejected" | "target-missing";

interface StyleValue {
  had: boolean;
  value: string;
  priority: string;
}

class ElementSnapshot implements NodeSnapshot {
  readonly style = new Map<string, StyleValue>();
  readonly attrs = new Map<string, string | null>();
  classAttr: string | null | undefined;
  /** The element's own child nodes before a `setText`: restore puts the
   *  markup back (the same nodes, so a framework's references stay valid). */
  children: Node[] | undefined;

  /** What this engine wrote, as it stood right after its last apply (3-E2). */
  private written:
    | {
        children: Node[] | undefined;
        classAttr: string | null | undefined;
        attrs: Map<string, string | null>;
        style: Map<string, { value: string; priority: string }>;
      }
    | undefined;

  constructor(readonly el: Element) {}

  /** Remember what is on the element now: this engine's writes. */
  markWritten(): void {
    const el = this.el;
    const style = new Map<string, { value: string; priority: string }>();
    if (el instanceof HTMLElement)
      for (const prop of this.style.keys())
        style.set(prop, {
          value: el.style.getPropertyValue(prop),
          priority: el.style.getPropertyPriority(prop),
        });
    this.written = {
      children: this.children !== undefined ? [...el.childNodes] : undefined,
      classAttr: this.classAttr !== undefined ? el.getAttribute("class") : undefined,
      attrs: new Map([...this.attrs.keys()].map((n) => [n, el.getAttribute(n)])),
      style,
    };
  }

  /**
   * Take off only the writes that are still on the element (3-E2): a page
   * that re-rendered a part keeps what it rendered there.
   */
  restoreOwn(): void {
    const w = this.written;
    if (!w || !this.el.isConnected) return;
    const el = this.el;
    if (this.children !== undefined && w.children !== undefined) {
      const now = [...el.childNodes];
      if (now.length === w.children.length && now.every((n, i) => n === w.children?.[i]))
        el.replaceChildren(...this.children);
    }
    if (this.classAttr !== undefined && el.getAttribute("class") === w.classAttr)
      restoreAttr(el, "class", this.classAttr);
    for (const [name, value] of this.attrs)
      if (el.getAttribute(name) === w.attrs.get(name)) restoreAttr(el, name, value);
    if (el instanceof HTMLElement) {
      for (const [prop, value] of this.style) {
        const was = w.style.get(prop);
        if (
          was?.value !== el.style.getPropertyValue(prop) ||
          was?.priority !== el.style.getPropertyPriority(prop)
        )
          continue;
        if (value.had) el.style.setProperty(prop, value.value, value.priority);
        else el.style.removeProperty(prop);
      }
    }
  }

  restore(): void {
    if (this.children !== undefined) this.el.replaceChildren(...this.children);
    if (this.classAttr !== undefined) restoreAttr(this.el, "class", this.classAttr);
    for (const [name, value] of this.attrs) restoreAttr(this.el, name, value);
    if (this.el instanceof HTMLElement) {
      for (const [prop, value] of this.style) {
        if (value.had) this.el.style.setProperty(prop, value.value, value.priority);
        else this.el.style.removeProperty(prop);
      }
    }
  }
}

interface InsertedFragment {
  nodes: Node[];
}

function restoreAttr(el: Element, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

function hasInlineStyleProp(style: CSSStyleDeclaration, prop: string): boolean {
  for (let i = 0; i < style.length; i += 1) {
    if (style.item(i) === prop) return true;
  }
  return false;
}

function childScope(root: Document | ShadowRoot): ParentNode {
  return root;
}

function observeTarget(root: Document | ShadowRoot): Node {
  if (root instanceof Document) return root.documentElement ?? root;
  return root;
}

/**
 * Every engine on one document shares ONE observer and ONE suppression
 * depth. Stacked previews (kept edits under a cycled variant) would otherwise
 * ping-pong: each engine's writes look like a framework re-render to every
 * other engine's observer. Only mutations no engine made trigger a reapply,
 * and the reapply runs every active engine in the order they were applied,
 * so stacked programs land the same way each time.
 */
class EngineGroup {
  readonly engines = new Set<Engine>();
  private suppressDepth = 0;
  private reapplyQueued = false;
  private applySeq = 0;
  private readonly observer: MutationObserver;

  constructor(root: Document | ShadowRoot) {
    this.observer = new MutationObserver(() => {
      if (this.suppressDepth > 0 || this.reapplyQueued) return;
      if (![...this.engines].some((e) => e.active)) return;
      this.reapplyQueued = true;
      queueMicrotask(() => {
        this.reapplyQueued = false;
        const active = [...this.engines].filter((e) => e.active);
        active.sort((a, b) => a.appliedSeq - b.appliedSeq);
        for (const engine of active) engine.reapply();
      });
    });
    this.observer.observe(observeTarget(root), {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  nextSeq(): number {
    this.applySeq += 1;
    return this.applySeq;
  }

  suppressed<T>(fn: () => T): T {
    this.suppressDepth += 1;
    try {
      return fn();
    } finally {
      this.observer.takeRecords();
      this.suppressDepth -= 1;
    }
  }
}

const groups = new WeakMap<Document | ShadowRoot, EngineGroup>();

function groupFor(root: Document | ShadowRoot): EngineGroup {
  let g = groups.get(root);
  if (!g) {
    g = new EngineGroup(root);
    groups.set(root, g);
  }
  return g;
}

function isPageRoot(root: PreviewRoot): root is PageRoot {
  return typeof root === "object" && root !== null && root.kind === "page";
}

/** A root's op budget; ops past it are refused (a page root has the larger one). */
function budgetOf(root: PreviewRoot): number {
  return maxOpsFor(isPageRoot(root) ? "page" : "block");
}

/** A page root may not lose its body: no `setText`, no `replace` insert there. */
function pageRootRefusal(op: MutationOp): RefusalReason | null {
  if (op.op === "setText") return "page-root-text";
  if (op.op === "insertFragment" && op.position === "replace") return "page-root-replace";
  return null;
}

/**
 * Rooted resolution (the picked element is the program's world):
 *   1. ":scope" → the root element itself.
 *   2. Any other selector → the root itself when it matches, else the first
 *      matching descendant of the root.
 *   3. Nodes the active program inserted — a before/after/replace fragment
 *      lands BESIDE the root, outside its subtree, and later ops legitimately
 *      style it (the insert sub-flow's styling pattern).
 * Never falls through to document-wide search: a target outside the picked
 * element's blast radius is a program bug, and reporting `target-missing`
 * beats silently mutating an unrelated element.
 */
function resolveWithinRoot(rootEl: Element, selector: string, inserted: Node[]): Element | null {
  if (selector === ":scope") return rootEl;
  try {
    if (rootEl.matches(selector)) return rootEl;
    const descendant = rootEl.querySelector(selector);
    if (descendant) return descendant;
    for (const node of inserted) {
      if (!(node instanceof Element)) continue;
      if (node.matches(selector)) return node;
      const inFragment = node.querySelector(selector);
      if (inFragment) return inFragment;
    }
    return null;
  } catch {
    return null;
  }
}

/** Legacy document-wide resolution for sets that predate root capture. */
function resolveTarget(root: Document | ShadowRoot, selector: string): Element | null {
  if (selector === ":scope") {
    // A document-root :scope would target <html>; setText there destroys the app DOM.
    if (root instanceof Document) return null;
    return root.host;
  }
  try {
    return childScope(root).querySelector(selector);
  } catch {
    return null;
  }
}

function ownerDocumentOf(node: Node): Document {
  // A node parsed by the renderer belongs to a DETACHED document, never the
  // ambient one — deriving the owner from the target keeps the op core pure
  // (no live-DOM global) so the same applier drives the live Engine and the
  // portable renderer's parsed capture doc.
  return (node.ownerDocument ?? (globalThis as { document: Document }).document) as Document;
}

function insertFragment(target: Element, position: string, fragment: DocumentFragment): Node[] {
  const nodes = [...fragment.childNodes];
  switch (position) {
    case "before":
      target.before(fragment);
      break;
    case "after":
      target.after(fragment);
      break;
    case "prepend":
      target.prepend(fragment);
      break;
    case "append":
      target.append(fragment);
      break;
    case "replace":
      target.after(fragment);
      break;
  }
  return nodes;
}

/**
 * Apply one op's DOM write to an ALREADY-RESOLVED target — the pure mutation,
 * with no snapshotting. Shared by the live Engine (which captures first, so it
 * can restore) and the detached-root applier (which re-clones a pristine root
 * per variant instead of restoring). Returns the nodes an insertFragment added
 * (empty for the in-place ops) or a failure reason the caller reports.
 */
function mutateTarget(
  target: Element,
  op: MutationOp,
  policy: PagePolicy,
): Node[] | ApplyFailure | Refusal {
  switch (op.op) {
    case "setStyle": {
      if (!(target instanceof HTMLElement)) return "target-missing";
      for (const { prop, value } of op.props) target.style.setProperty(prop, value);
      return [];
    }
    case "setClass": {
      for (const name of op.remove) target.classList.remove(name);
      for (const name of op.add) target.classList.add(name);
      return [];
    }
    case "setAttr": {
      const name = normalizeAttrName(op.name);
      if (!isSafeElementAttribute(target.localName, name, op.value)) return "sanitization-rejected";
      if (op.value === null) target.removeAttribute(name);
      else target.setAttribute(name, op.value);
      // A link whose destination a program changed never hands the page over;
      // one whose destination it removed keeps no ping either (R3-C11).
      if (isNavigationalHref(target.localName, name)) {
        if (op.value !== null) hardenLink(target);
        else target.removeAttribute("ping");
      }
      return [];
    }
    case "setText": {
      target.textContent = op.text;
      return [];
    }
    case "insertFragment": {
      let fragment: DocumentFragment;
      try {
        fragment = buildFragment(op.html, ownerDocumentOf(target), policy);
      } catch (err) {
        if (err instanceof PolicyRefusal) return { refuse: err.reason };
        return "sanitization-rejected";
      }
      if (op.position === "replace") {
        if (!(target instanceof HTMLElement)) return "target-missing";
        target.style.setProperty("display", "none", "important");
      }
      return insertFragment(target, op.position, fragment);
    }
  }
}

/** How a program landed on a detached root — a tally, never a whole-stage fail. */
export interface RootApplyResult {
  /** Ops whose write landed on a target inside the captured block. */
  applied: number;
  /** Ops whose selector resolved to nothing within the block — the variant
   *  edits outside the captured element (a quiet per-variant note, not fatal). */
  misses: number;
  /** Ops the fragment/attr sanitizer refused (unsafe payload). */
  rejected: number;
}

/**
 * Apply a variant program against a DETACHED root element — the standalone
 * preview stage's sanitized clone, where ":scope" IS that root (interaction.ts).
 * Unlike the live Engine this snapshots nothing and NEVER aborts: the caller
 * re-clones a pristine root per variant, and an op that misses inside the block
 * is tallied, not fatal. Reuses the same rooted resolution and per-op mutation
 * the live preview runs, so the page-less twin renders what the on-page cycle
 * would — the origin stylesheets aside (indicative, structural fidelity only).
 */
export function applyProgramToRoot(
  rootEl: Element,
  program: MutationProgram,
  opts: { page?: boolean } = {},
): RootApplyResult {
  const inserted: Node[] = [];
  const result: RootApplyResult = { applied: 0, misses: 0, rejected: 0 };
  const budget = maxOpsFor(opts.page ? "page" : "block");
  // The detached document is rendered in a page of ours: the same policy keeps
  // a program from loading anything the capture did not already load.
  const policy = policyFor(ownerDocumentOf(rootEl));
  for (const [index, op] of program.entries()) {
    if (index >= budget) {
      result.rejected += 1;
      continue;
    }
    const target = resolveWithinRoot(rootEl, op.target, inserted);
    if (!target) {
      result.misses += 1;
      continue;
    }
    // A page root (the body) keeps its content: refused, like the live engine.
    if (opts.page && target === rootEl && pageRootRefusal(op) !== null) {
      result.rejected += 1;
      continue;
    }
    if (policyRefusal(target, op, policy) !== null) {
      result.rejected += 1;
      continue;
    }
    const outcome = mutateTarget(target, op, policy);
    if (typeof outcome === "string") {
      if (outcome === "sanitization-rejected") result.rejected += 1;
      else result.misses += 1;
      continue;
    }
    if (!Array.isArray(outcome)) {
      result.rejected += 1;
      continue;
    }
    result.applied += 1;
    for (const node of outcome) inserted.push(node);
  }
  return result;
}

class Engine implements PreviewEngine {
  private readonly snapshots = new Map<Element, ElementSnapshot>();
  private inserted: InsertedFragment[] = [];
  private activeProgram: MutationProgram | null = null;
  private activeRoot: PreviewRoot;
  private readonly group: EngineGroup;
  /** When this engine last applied, in its group: reapply order. */
  appliedSeq = 0;
  // F30 application identity: bumped on every apply/restore; INVALIDATED (set
  // to 0 on the active record) when a reapply-after-clobber FAILS — a boolean
  // `active` can't distinguish "applied" from "was applied, the framework ate
  // it, reapply missed" (sol-2), and a capture keyed on the stale answer would
  // commit unmutated pixels as ground truth.
  private generation = 0;
  private appliedGeneration = 0;
  /** The page key the active program was applied on (3-E2); null without a reader. */
  private boundPage: string | null = null;

  constructor(
    private readonly root: Document | ShadowRoot,
    private readonly pageKey?: () => string | null,
  ) {
    this.group = groupFor(root);
    this.group.engines.add(this);
  }

  get active(): boolean {
    return this.activeProgram !== null;
  }

  apply(program: MutationProgram, root?: PreviewRoot): ApplyResult {
    this.restore();
    this.group.engines.add(this);
    const refused: RefusedOp[] = [];
    const tally = { applied: 0 };
    const result = this.withObserverSuppressed(() =>
      this.applyProgram(program, true, root, refused, tally),
    );
    if (result !== null) {
      this.restore();
      return { ok: false, reason: result };
    }
    this.activeProgram = program;
    this.activeRoot = root;
    this.boundPage = this.pageKey?.() ?? null;
    for (const snapshot of this.snapshots.values()) snapshot.markWritten();
    this.appliedSeq = this.group.nextSeq();
    this.generation += 1;
    this.appliedGeneration = this.generation;
    return refused.length > 0
      ? { ok: true, token: this.generation, applied: tally.applied, refused }
      : { ok: true, token: this.generation, applied: tally.applied };
  }

  dispose(): void {
    this.restore();
    this.group.engines.delete(this);
  }

  /** True while the EXACT application `token` names is live on the DOM —
   *  false after any restore, later apply, or a FAILED reapply-after-clobber.
   *  The capture pass proves this immediately before every grab (F30 sol-2). */
  applied(token: number): boolean {
    return token > 0 && this.appliedGeneration === token && this.activeProgram !== null;
  }

  /** Document-space bounding rects of the nodes the active program INSERTED —
   *  an insert-after variant's payload sits OUTSIDE the picked block's rect,
   *  and a witness cropped without this union shows no insertion at all
   *  (F30 fable-serious geometry). Empty when nothing was inserted. */
  insertedRects(): Array<{ x: number; y: number; width: number; height: number }> {
    const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const fragment of this.inserted) {
      for (const node of fragment.nodes) {
        if (!node.isConnected) continue;
        if (!(node instanceof Element)) {
          // A top-level TEXT insertion renders too — measure it via a Range.
          if (node.nodeType === 3 && node.ownerDocument) {
            const range = node.ownerDocument.createRange();
            range.selectNode(node);
            const tr = range.getBoundingClientRect();
            const twin = node.ownerDocument.defaultView;
            if (tr.width > 0 || tr.height > 0)
              rects.push({
                x: tr.left + (twin?.scrollX ?? 0),
                y: tr.top + (twin?.scrollY ?? 0),
                width: tr.width,
                height: tr.height,
              });
          }
          continue;
        }
        const r = node.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) continue;
        const win = node.ownerDocument.defaultView;
        rects.push({
          x: r.left + (win?.scrollX ?? 0),
          y: r.top + (win?.scrollY ?? 0),
          width: r.width,
          height: r.height,
        });
      }
    }
    return rects;
  }

  restore(): void {
    this.withObserverSuppressed(() => {
      this.rollBack();
      this.activeProgram = null;
      this.activeRoot = undefined;
      this.appliedGeneration = 0;
    });
  }

  reapply(): void {
    const program = this.activeProgram;
    if (program === null) return;
    // The document moved to another page (an SPA route) since the program
    // went on: it comes off instead of going back on there (3-E2).
    if (this.pageKey && this.pageKey() !== this.boundPage) {
      this.dropOffPage();
      return;
    }
    const root = this.activeRoot;
    this.withObserverSuppressed(() => {
      this.removeInserted();
      // Capture stays on: a framework may have handed us a NEW node, and a
      // write on it without a snapshot could never be taken back.
      const failure = this.applyProgram(program, true, root, [], { applied: 0 });
      if (failure === null) {
        for (const snapshot of this.snapshots.values()) snapshot.markWritten();
        return;
      }
      // A missed reapply rolls back whatever it reached, so the page shows
      // the Original rather than half a program, and `applied()` answers
      // honestly (the UI keeps its optimistic state; the next re-render tries
      // again from fresh snapshots).
      this.rollBack();
      this.appliedGeneration = 0;
    });
  }

  /**
   * The document is on another page now (3-E2): the program goes, onlay's
   * inserted nodes go, and of its writes only those still on the page are
   * taken back; whatever the page rendered since stays as it is.
   */
  private dropOffPage(): void {
    this.withObserverSuppressed(() => {
      this.removeInserted();
      for (const snapshot of [...this.snapshots.values()].reverse()) snapshot.restoreOwn();
      this.snapshots.clear();
      this.activeProgram = null;
      this.activeRoot = undefined;
      this.appliedGeneration = 0;
    });
  }

  /** Take every write of this engine off the page, keeping the active program. */
  private rollBack(): void {
    this.removeInserted();
    for (const snapshot of [...this.snapshots.values()].reverse()) snapshot.restore();
    this.snapshots.clear();
  }

  private withObserverSuppressed<T>(fn: () => T): T {
    return this.group.suppressed(fn);
  }

  private removeInserted(): void {
    for (const fragment of this.inserted) {
      for (const node of fragment.nodes) {
        if (node.parentNode) node.parentNode.removeChild(node);
      }
    }
    this.inserted = [];
  }

  private snapshotFor(el: Element): ElementSnapshot {
    let snapshot = this.snapshots.get(el);
    if (!snapshot) {
      snapshot = new ElementSnapshot(el);
      this.snapshots.set(el, snapshot);
    }
    return snapshot;
  }

  private captureStyle(el: Element, prop: string): void {
    if (!(el instanceof HTMLElement)) return;
    const snapshot = this.snapshotFor(el);
    if (snapshot.style.has(prop)) return;
    snapshot.style.set(prop, {
      had: hasInlineStyleProp(el.style, prop),
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop),
    });
  }

  private captureClass(el: Element): void {
    const snapshot = this.snapshotFor(el);
    if (snapshot.classAttr === undefined) snapshot.classAttr = el.getAttribute("class");
  }

  private captureAttr(el: Element, name: string): void {
    const snapshot = this.snapshotFor(el);
    if (!snapshot.attrs.has(name)) snapshot.attrs.set(name, el.getAttribute(name));
  }

  private captureText(el: Element): void {
    const snapshot = this.snapshotFor(el);
    if (snapshot.children === undefined) snapshot.children = [...el.childNodes];
  }

  /**
   * Re-resolve the set's root fresh on every apply/reapply: an HMR re-render
   * may have replaced the picked node. An unresolvable root is the stale-set
   * signal (AC16), not a license to fall back to document-wide mutation.
   * Returns `null` for rootless (legacy) sets — document-wide resolution. A
   * page root is the document's body.
   */
  private resolveRoot(root: PreviewRoot): Element | null | "target-missing" {
    if (root === undefined) return null;
    if (isPageRoot(root)) {
      // nodeType, not instanceof: a document from another realm is still a document.
      const body = this.root.nodeType === 9 ? (this.root as Document).body : null;
      return body ?? "target-missing";
    }
    try {
      return childScope(this.root).querySelector(root) ?? "target-missing";
    } catch {
      return "target-missing";
    }
  }

  private applyProgram(
    program: MutationProgram,
    capture: boolean,
    root: PreviewRoot,
    refused: RefusedOp[],
    tally: { applied: number },
  ): ApplyFailure | null {
    const rootEl = this.resolveRoot(root);
    if (rootEl === "target-missing") return "target-missing";
    const page = isPageRoot(root);
    const budget = budgetOf(root);
    const policy = policyFor(
      this.root.nodeType === 9 ? (this.root as Document) : ownerDocumentOf(this.root),
    );

    for (const [index, op] of program.entries()) {
      if (index >= budget) {
        refused.push({ index, reason: "over-budget" });
        continue;
      }
      const target: Element | null =
        rootEl !== null
          ? resolveWithinRoot(
              rootEl,
              op.target,
              this.inserted.flatMap((f) => f.nodes),
            )
          : resolveTarget(this.root, op.target);
      if (!target) return "target-missing";
      // A page root's body is never emptied or hidden wholesale: `:scope`,
      // `body` or any selector landing on it is refused for those ops.
      if (page && target === rootEl) {
        const why = pageRootRefusal(op);
        if (why !== null) {
          refused.push({ index, reason: why });
          continue;
        }
      }

      // Snapshot exactly what this op will touch BEFORE the shared write runs,
      // so restore/cycle is exact. The write itself is `mutateTarget` — the one
      // per-op mutation the detached-root applier reuses (no duplicate switch).
      const why = policyRefusal(target, op, policy);
      if (why !== null) {
        refused.push({ index, reason: why });
        continue;
      }
      if (capture) this.captureForOp(target, op);
      const result = mutateTarget(target, op, policy);
      if (typeof result === "string") return result;
      if (!Array.isArray(result)) {
        refused.push({ index, reason: result.refuse });
        continue;
      }
      if (result.length > 0) this.inserted.push({ nodes: result });
      tally.applied += 1;
    }
    return null;
  }

  /** Capture just the properties `mutateTarget` is about to overwrite for `op`. */
  private captureForOp(target: Element, op: MutationOp): void {
    switch (op.op) {
      case "setStyle":
        for (const { prop } of op.props) this.captureStyle(target, prop);
        break;
      case "setClass":
        this.captureClass(target);
        break;
      case "setAttr": {
        const name = normalizeAttrName(op.name);
        this.captureAttr(target, name);
        // A changed link destination also sets rel and referrerpolicy, and drops ping.
        if (isNavigationalHref(target.localName, name)) {
          this.captureAttr(target, "rel");
          this.captureAttr(target, "referrerpolicy");
          this.captureAttr(target, "ping");
        }
        break;
      }
      case "setText":
        this.captureText(target);
        break;
      case "insertFragment":
        // A replace hides the target via inline display — snapshot that one prop.
        if (op.position === "replace") this.captureStyle(target, "display");
        break;
    }
  }
}

/**
 * `opts.pageKey` reads the document's current page key: a program applied on
 * one page is never put back on another (3-E2). Without it (the web app's
 * portable render, which has no page) the engine behaves as before.
 */
export function createPreviewEngine(
  root: Document | ShadowRoot,
  opts: { pageKey?: () => string | null } = {},
): PreviewEngine {
  return new Engine(root, opts.pageKey);
}

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "button",
  "caption",
  "code",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "var",
]);

const GLOBAL_ATTRS = new Set(["class", "id", "title", "role", "aria-label", "aria-hidden"]);
const TAG_ATTRS = new Map<string, Set<string>>([
  ["a", new Set(["href", "target", "rel"])],
  ["button", new Set(["type", "disabled", "aria-pressed"])],
  ["img", new Set(["src", "alt", "width", "height", "loading", "decoding"])],
  ["td", new Set(["colspan", "rowspan"])],
  ["th", new Set(["colspan", "rowspan", "scope"])],
]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "formaction", "action", "poster"]);
const ALLOWED_HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const ALLOWED_SRC_SCHEMES = new Set(["http", "https"]);
const VOID_RENDERABLE_TAGS = new Set(["br", "hr", "img"]);
/** Rule (e): never inserted, whatever the allowlist says now or later. */
const NEVER_INSERTED = new Set([
  "form",
  "input",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "meta",
  "base",
  "link",
  "style",
  "script",
]);

function normalizeAttrName(name: string): string {
  return name.toLowerCase();
}

function normalizeTagName(tag: string): string {
  return tag.toLowerCase();
}

function isAttrAllowed(tag: string, name: string): boolean {
  if (!ALLOWED_TAGS.has(tag)) return false;
  if (name.startsWith("data-") || name.startsWith("aria-")) return true;
  if (GLOBAL_ATTRS.has(name)) return true;
  return TAG_ATTRS.get(tag)?.has(name) ?? false;
}

function schemeOf(value: string): string | null {
  let normalized = "";
  for (const ch of value.trim()) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) continue;
    normalized += ch;
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
  const scheme = match?.[1];
  return scheme ? scheme.toLowerCase() : null;
}

function isSafeUrlAttr(name: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("//")) return false;
  const scheme = schemeOf(value);
  if (scheme === null) return true;
  if (name === "href") return ALLOWED_HREF_SCHEMES.has(scheme);
  if (name === "src") return ALLOWED_SRC_SCHEMES.has(scheme);
  return false;
}

function isSafeElementAttribute(tag: string, name: string, value: string | null): boolean {
  const normalizedTag = normalizeTagName(tag);
  const normalizedName = normalizeAttrName(name);
  if (!isAttrAllowed(normalizedTag, normalizedName)) return false;
  if (value === null) return true;
  return !URL_ATTRS.has(normalizedName) || isSafeUrlAttr(normalizedName, value);
}

function copySafeAttributes(
  source: Element,
  target: Element,
  tag: string,
  policy: PagePolicy | undefined,
): void {
  for (const attr of [...source.attributes]) {
    const name = normalizeAttrName(attr.name);
    if (!isSafeElementAttribute(tag, name, attr.value)) continue;
    if (policy) {
      const why = attrUrlRefusal(tag, name, attr.value, policy);
      if (why !== null) throw new PolicyRefusal(why);
    }
    target.setAttribute(name, attr.value);
  }
  if (isNavigationalHref(tag, "href") && target.hasAttribute("href")) hardenLink(target);
  // An inserted button never submits a form it lands in.
  if (tag === "button") target.setAttribute("type", "button");
}

// ── the live-page policy (what a program from anyone may do) ──
//
// Programs come from people and agents other than the viewer, and they run on
// the viewer's live page — sometimes automatically (a kept Edit, the witness
// pass). So a program may restyle and rewrite what is there, but it may not
// make the page fetch from somewhere new, script it, or rewrite its raw-text
// and head elements. One refusal refuses its op; nothing is rewritten.

/** What one apply knows about the page: its base URL and the origins it already loads from. */
interface PagePolicy {
  base: string;
  origins: ReadonlySet<string>;
}

class PolicyRefusal extends Error {
  constructor(readonly reason: RefusalReason) {
    super(reason);
  }
}

interface Refusal {
  refuse: RefusalReason;
}

/** Elements whose loaded resources tell us which origins the page already uses. */
const RESOURCE_SOURCE_SELECTOR = "img, video, audio, link[href], script[src]";

function httpOrigin(raw: string, base: string): string | null {
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

function srcsetUrls(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((u) => u.length > 0);
}

/** The page's own origin, plus every origin an element already in it loads from. */
function policyFor(doc: Document): PagePolicy {
  const base = doc.baseURI || doc.URL || "about:blank";
  const origins = new Set<string>();
  const own = httpOrigin(doc.URL || base, base);
  if (own) origins.add(own);
  let sources: Element[] = [];
  try {
    sources = [...doc.querySelectorAll(RESOURCE_SOURCE_SELECTOR)];
  } catch {
    /* a document without selectors: only the page's own origin */
  }
  // What the page actually loads: a media element's chosen source
  // (`currentSrc`), never every `srcset` candidate it might have picked.
  for (const el of sources) {
    const tag = el.localName;
    let url: string | null = null;
    if (tag === "link") {
      const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      if (!rel.includes("stylesheet")) continue;
      url = el.getAttribute("href");
    } else if (tag === "script") {
      url = el.getAttribute("src");
    } else {
      const chosen = (el as HTMLMediaElement | HTMLImageElement).currentSrc;
      url = typeof chosen === "string" && chosen !== "" ? chosen : el.getAttribute("src");
    }
    const o = url ? httpOrigin(url, base) : null;
    if (o) origins.add(o);
  }
  return { base, origins };
}

function stripControls(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** Rule (a): a URL the page would fetch. Only origins the page already loads from. */
function resourceUrlRefusal(
  raw: string,
  policy: PagePolicy,
  opts: { dataImage?: boolean } = {},
): RefusalReason | null {
  const value = stripControls(raw);
  if (opts.dataImage && /^data:image\//i.test(value)) return null;
  let u: URL;
  try {
    u = new URL(value, policy.base);
  } catch {
    return "url-scheme";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "url-scheme";
  return policy.origins.has(u.origin) ? null : "url-origin";
}

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Rule (b): a destination a person may follow. Web, mail and phone links only. */
function linkUrlRefusal(raw: string, policy: PagePolicy): RefusalReason | null {
  try {
    return LINK_SCHEMES.has(new URL(stripControls(raw), policy.base).protocol)
      ? null
      : "url-scheme";
  } catch {
    return "url-scheme";
  }
}

function isNavigationalHref(tag: string, name: string): boolean {
  return name === "href" && (tag === "a" || tag === "area");
}

/** A link a program inserted or redirected opens nothing that can reach back, and pings nobody. */
function hardenLink(el: Element): void {
  el.setAttribute("rel", "noopener noreferrer");
  el.setAttribute("referrerpolicy", "no-referrer");
  el.removeAttribute("ping");
}

/**
 * Attributes the engine owns on every mutation, not only at insertion: a
 * button's `type` (an inserted one stays `button`, a page's keeps the page's)
 * and a link's `rel`, `referrerpolicy` and `ping` (set by `hardenLink`).
 */
function engineManaged(tag: string, name: string): boolean {
  if (tag === "button") return name === "type";
  if (tag === "a" || tag === "area")
    return name === "rel" || name === "referrerpolicy" || name === "ping";
  return false;
}

/** Attributes that load a resource, per element (`href` only where it fetches). */
function isResourceAttr(tag: string, name: string): boolean {
  if (name === "src" || name === "srcset" || name === "poster") return true;
  if (name === "data") return tag === "object" || tag === "embed";
  if (name === "xlink:href") return true;
  if (name === "href") return tag === "link" || tag === "use" || tag === "image";
  return false;
}

/** Rules (a) and (b) for one attribute value. */
function attrUrlRefusal(
  tag: string,
  name: string,
  value: string | null,
  policy: PagePolicy,
): RefusalReason | null {
  if (value === null) return null;
  if (isNavigationalHref(tag, name)) return linkUrlRefusal(value, policy);
  if (!isResourceAttr(tag, name)) return null;
  if (name === "srcset") {
    for (const u of srcsetUrls(value)) {
      const why = resourceUrlRefusal(u, policy);
      if (why !== null) return why;
    }
    return null;
  }
  return resourceUrlRefusal(value, policy);
}

const DENIED_ATTRS = new Set([
  "srcdoc",
  "action",
  "formaction",
  "http-equiv",
  "integrity",
  "nonce",
  "is",
  "style",
]);

/** Rule (d): attributes no program may set, whatever the element. */
function attrDenied(tag: string, name: string): boolean {
  if (name.startsWith("on")) return true;
  if (name === "content" && tag === "meta") return true;
  return DENIED_ATTRS.has(name);
}

/** Text or markup never goes into (or inside) these. */
const TEXT_REFUSED_IN =
  "style, script, noscript, template, iframe, object, embed, textarea, title, head";

const STYLE_PROPERTY = /^-{0,2}[a-z][a-z0-9-]*$/;
const STYLE_FORBIDDEN = ["expression(", "@import", "-moz-binding", "behavior"];

/** CSS escapes decoded, so `u\72l(` reads as what the browser would see. */
function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string, ch: string) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ch;
  });
}

/** The URLs inside `url(…)` and `image-set(…)` in a declaration value. */
function cssUrls(value: string): string[] {
  const urls: string[] = [];
  for (const m of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g))
    urls.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const set of value.matchAll(/image-set\(([\s\S]*)\)/g)) {
    for (const m of (set[1] ?? "").matchAll(/(?:^|[\s,(])(?:"([^"]*)"|'([^']*)')/g))
      urls.push(m[1] ?? m[2] ?? "");
  }
  return urls;
}

/** Rule (c): one style declaration. */
function styleRefusal(prop: string, value: string, policy: PagePolicy): RefusalReason | null {
  if (!STYLE_PROPERTY.test(prop)) return "style-property";
  // No custom properties: a value set there is substituted later, past these checks.
  if (prop.startsWith("--")) return "style-property";
  // The binding properties are refused by name as well as by value.
  if (STYLE_FORBIDDEN.includes(prop)) return "style-value";
  const v = decodeCssEscapes(value).toLowerCase();
  if (STYLE_FORBIDDEN.some((bad) => v.includes(bad))) return "style-value";
  if (v.includes("url(") || v.includes("image-set(")) {
    const urls = cssUrls(v);
    if (urls.length === 0) return "style-value";
    for (const u of urls) {
      if (resourceUrlRefusal(u, policy, { dataImage: true }) !== null) return "style-value";
    }
  }
  return null;
}

/**
 * The policy's verdict on one resolved op, before anything is written. Fragment
 * contents are checked while the fragment is built (`buildFragment`).
 */
function policyRefusal(target: Element, op: MutationOp, policy: PagePolicy): RefusalReason | null {
  switch (op.op) {
    case "setStyle":
      for (const { prop, value } of op.props) {
        const why = styleRefusal(prop, value, policy);
        if (why !== null) return why;
      }
      return null;
    case "setClass":
      return null;
    case "setAttr": {
      const tag = target.localName;
      const name = normalizeAttrName(op.name);
      if (engineManaged(tag, name)) return "attr-denied";
      if (attrDenied(tag, name)) {
        // The allowlist answers first (a whole-program rejection, as before).
        return isSafeElementAttribute(tag, name, op.value) ? "attr-denied" : null;
      }
      return attrUrlRefusal(tag, name, op.value, policy);
    }
    case "setText":
    case "insertFragment":
      return target.closest(TEXT_REFUSED_IN) !== null ? "text-target" : null;
  }
}

/**
 * Build a sanitized DocumentFragment programmatically (strips scripts / on* /
 * dangerous URLs); THROWS for the receipt path. Nodes are minted in
 * `ownerDocument` so an insertFragment op lands in the same document as its
 * target — the live page for the Engine, the detached parsed capture for the
 * portable renderer (defaults to the ambient document for the receipt path).
 * With a `policy`, a resource from an origin the page does not already load
 * from (or a link outside web, mail and phone) refuses the whole fragment.
 */
export function buildFragment(
  html: string,
  ownerDocument: Document = (globalThis as { document: Document }).document,
  policy?: PagePolicy,
): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out = ownerDocument.createDocumentFragment();
  let renderable = false;

  const appendSafe = (source: Node, parent: Node): void => {
    if (source.nodeType === Node.TEXT_NODE) {
      const text = source.textContent ?? "";
      if (text.length === 0) return;
      parent.appendChild(ownerDocument.createTextNode(text));
      if (text.trim().length > 0) renderable = true;
      return;
    }
    if (source.nodeType !== Node.ELEMENT_NODE) return;

    const sourceEl = source as Element;
    const tag = normalizeTagName(sourceEl.localName);
    if (!ALLOWED_TAGS.has(tag) || NEVER_INSERTED.has(tag)) return;

    const clean = ownerDocument.createElement(tag);
    copySafeAttributes(sourceEl, clean, tag, policy);
    for (const child of [...sourceEl.childNodes]) appendSafe(child, clean);
    if (VOID_RENDERABLE_TAGS.has(tag) || clean.childNodes.length > 0) renderable = true;
    parent.appendChild(clean);
  };

  for (const child of [...parsed.body.childNodes]) appendSafe(child, out);
  if (!renderable || out.childNodes.length === 0) {
    throw new Error("sanitization-rejected");
  }
  return out;
}
