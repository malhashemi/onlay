import {
  attrRefusalFor,
  classNameProblem,
  FRAGMENT_TAGS,
  isNavigationalHref,
  isSafeElementAttribute,
  type MutationOp,
  type MutationProgram,
  maxOpsFor,
  NEVER_INSERTED,
  type StepRefusalReason,
  styleStaticRefusal,
  VOID_RENDERABLE_TAGS,
} from "@onlay/protocol";

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
 * Why an op was left out of an otherwise applied program: the shared closed
 * set (`@onlay/protocol` `step-refusal.ts`). The `url-*`, `style-*`,
 * `text-target`, `attr-*` and `class-name` reasons are the live-page policy
 * (see `PagePolicy`); `target-missing`, `target-kind` and `fragment-*` are a
 * step that found nothing to act on or nothing to insert.
 */
export type RefusalReason = StepRefusalReason;

/** One op the engine refused to apply; the rest of the program still lands. */
export interface RefusedOp {
  index: number;
  reason: RefusalReason;
}

/**
 * `applied` counts the ops whose write landed; `refused` names the ones left
 * out, each for its own reason, while the rest of the program lands. A result
 * with refused ops did NOT render the stored program: callers never present it
 * as if it had (R2-C7). Only a root that isn't on the page fails the whole
 * program (`target-missing`); anything that throws while it applies takes back
 * every write it made and fails it too (`failed`).
 */
export type ApplyResult =
  | { ok: true; token: number; applied: number; refused?: RefusedOp[] }
  | { ok: false; reason: "target-missing" | "failed" };

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
  /**
   * Re-apply the active programs after a framework re-render clobbered them
   * (MutationObserver-driven; every engine on the document, in the order they
   * went on). One that no longer lands the same steps comes off whole.
   */
  reapply(): void;
  readonly active: boolean;
  /** True while the exact application `token` names is live on the DOM (F30). */
  applied(token: number): boolean;
  /** Document-space rects of nodes the active program inserted (F30 geometry). */
  insertedRects(): Array<{ x: number; y: number; width: number; height: number }>;
}

/** The set's root is not on the page: the one failure that takes the whole program down. */
type ApplyFailure = "target-missing" | "failed";

class ElementSnapshot implements NodeSnapshot {
  readonly attrs = new Map<string, string | null>();
  classAttr: string | null | undefined;
  /**
   * The element's whole `style` attribute before the first style write. Put
   * back as it was when the page wrote nothing there since (exact: a shorthand
   * awaiting `var()` substitution, or one with only some longhands set, has
   * no per-property value that could restore it); otherwise only the
   * properties the engine wrote come back, from this string's own declarations.
   */
  styleAttr: string | null | undefined;
  /** The style properties the engine wrote on this element, as the ops named them. */
  readonly styleProps = new Set<string>();
  /** The `style` attribute as the engine last left it (after its own last write). */
  private engineStyle: string | null | undefined;
  /** Each written property's value and priority as the engine last left it. */
  private engineValues = new Map<string, string>();
  /** The page wrote to the `style` attribute since the engine's first write here. */
  private pageWroteStyle = false;
  /** The element's own child nodes before a `setText`: restore puts the
   *  markup back (the same nodes, so a framework's references stay valid). */
  children: Node[] | undefined;

  /** What this engine wrote, as it stood right after its last apply (3-E2). */
  private written:
    | {
        children: Node[] | undefined;
        classAttr: string | null | undefined;
        attrs: Map<string, string | null>;
      }
    | undefined;

  constructor(readonly el: Element) {}

  /** Before the engine writes again: a style attribute that isn't as it left it was the page's write. */
  notePageWrites(): void {
    if (this.engineStyle === undefined) return;
    if (this.el.getAttribute("style") !== this.engineStyle) this.pageWroteStyle = true;
  }

  /** Remember what is on the element now: this engine's writes. */
  markWritten(): void {
    const el = this.el;
    this.written = {
      children: this.children !== undefined ? [...el.childNodes] : undefined,
      classAttr: this.classAttr !== undefined ? el.getAttribute("class") : undefined,
      attrs: new Map([...this.attrs.keys()].map((n) => [n, el.getAttribute(n)])),
    };
    if (this.styleAttr !== undefined && el instanceof HTMLElement) {
      this.engineStyle = el.getAttribute("style");
      this.engineValues = new Map(
        [...this.styleProps].map((p) => [p, styleValueOf(el, p)] as [string, string]),
      );
    }
  }

  /**
   * Put the style back: the original string exactly when the page never wrote
   * to the attribute since the engine's first write there; otherwise
   * only the properties in `props`, from the original's declarations,
   * leaving every other declaration as the page has it now.
   */
  private restoreStyle(props: readonly string[]): void {
    const el = this.el;
    if (this.styleAttr === undefined || !(el instanceof HTMLElement)) return;
    if (!this.pageWroteStyle && el.getAttribute("style") === this.engineStyle) {
      restoreAttr(el, "style", this.styleAttr);
      return;
    }
    restoreStyleProps(el, this.styleAttr, props);
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
    if (el instanceof HTMLElement) {
      // Only the properties still as the engine left them are taken back.
      const ours = [...this.styleProps].filter(
        (p) => styleValueOf(el, p) === this.engineValues.get(p),
      );
      this.restoreStyle(ours);
    }
    for (const [name, value] of this.attrs)
      if (el.getAttribute(name) === w.attrs.get(name)) restoreAttr(el, name, value);
  }

  restore(): void {
    if (this.children !== undefined) this.el.replaceChildren(...this.children);
    if (this.classAttr !== undefined) restoreAttr(this.el, "class", this.classAttr);
    this.restoreStyle([...this.styleProps]);
    for (const [name, value] of this.attrs) restoreAttr(this.el, name, value);
  }
}

/** A property's inline value and priority, as one comparable string. */
function styleValueOf(el: HTMLElement, prop: string): string {
  return `${el.style.getPropertyValue(prop)}!${el.style.getPropertyPriority(prop)}`;
}

/** The shorthands a longhand belongs to, nearest first (`border-left-width` → `border-left`, `border`). */
function shorthandsOf(prop: string): string[] {
  const out: string[] = [];
  for (let cut = prop.lastIndexOf("-"); cut > 0; cut = prop.lastIndexOf("-", cut - 1))
    out.push(prop.slice(0, cut));
  return out;
}

/**
 * Take back only `props` (the engine's writes), from the original `style`
 * string as the browser itself reads it (a detached element in the same
 * document parses it: comments, escapes, `!important`, odd whitespace and
 * duplicate declarations behave exactly as on the page). Each is removed,
 * then set again to the original's value and priority: the property itself
 * (a `var()` shorthand comes back as written), else the shorthand the
 * original set it through, else the longhands of it the original set one by
 * one. Every other declaration stays as the page has it now.
 */
function restoreStyleProps(
  el: HTMLElement,
  original: string | null,
  props: readonly string[],
): void {
  if (props.length === 0) return;
  const probe = el.ownerDocument.createElement("div");
  if (original !== null) probe.setAttribute("style", original);
  const was = probe.style;
  for (const p of props) el.style.removeProperty(p);
  const put = (name: string): boolean => {
    const value = was.getPropertyValue(name);
    if (value === "") return false;
    el.style.setProperty(name, value, was.getPropertyPriority(name));
    return true;
  };
  for (const p of props) {
    if (put(p)) continue;
    if (shorthandsOf(p).some(put)) continue;
    for (let i = 0; i < was.length; i++) {
      const name = was.item(i);
      if (name.startsWith(`${p}-`)) put(name);
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
        this.reapplyAll();
      });
    });
    this.observer.observe(observeTarget(root), {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  /**
   * Put every active engine back on, in the order they went on, each over the
   * baselines it captured when it was applied (never recaptured). An engine
   * whose program no longer lands the same steps (or no longer lands at all)
   * comes off whole, and so does every engine above it, whose baselines hold
   * its writes; those then go back on over the page as it is now. The ended
   * ones are told once the pass is over.
   */
  reapplyAll(): void {
    const active = [...this.engines].filter((e) => e.active);
    active.sort((a, b) => a.appliedSeq - b.appliedSeq);
    const ended: Engine[] = [];
    this.suppressed(() => {
      for (const [i, engine] of active.entries()) {
        if (!engine.active || engine.reapplySame()) continue;
        for (let j = active.length - 1; j >= i; j -= 1) active[j]?.takeOff();
        engine.end();
        ended.push(engine);
      }
    });
    for (const engine of ended) engine.notifyEnded();
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
 * per variant instead of restoring). Every page-independent and policy check
 * has run (`policyRefusal`) before this, so nothing is written for a refused
 * op; only an inserted fragment is still judged here, built in full before it
 * touches the page. Returns the nodes an insertFragment added (empty for the
 * in-place ops) or the op's refusal.
 */
function mutateTarget(target: Element, op: MutationOp, policy: PagePolicy): Node[] | Refusal {
  switch (op.op) {
    case "setStyle": {
      for (const { prop, value } of op.props)
        (target as HTMLElement).style.setProperty(prop, value);
      return [];
    }
    case "setClass": {
      for (const name of op.remove) target.classList.remove(name);
      for (const name of op.add) target.classList.add(name);
      return [];
    }
    case "setAttr": {
      const name = normalizeAttrName(op.name);
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
        if (err instanceof PolicyRefusal || err instanceof FragmentRefusal)
          return { refuse: err.reason };
        return { refuse: "fragment-empty" };
      }
      if (op.position === "replace")
        (target as HTMLElement).style.setProperty("display", "none", "important");
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
  /** Ops refused for any other reason (the policy, an empty fragment, the budget). */
  rejected: number;
  /** Every op left out, with its reason (misses and rejections together). */
  refused: RefusedOp[];
  /** Something threw while applying: the tally is not to be trusted (it stopped there). */
  failed?: true;
}

/**
 * Apply a variant program against a DETACHED root element — the standalone
 * preview stage's sanitized clone, where ":scope" IS that root (interaction.ts).
 * Unlike the live Engine this snapshots nothing: the caller re-clones a
 * pristine root per variant. Like the live engine, an op that can't be applied
 * is refused on its own and the rest lands. Reuses the same rooted resolution
 * and per-op checks the live preview runs, so the page-less twin renders what
 * the on-page cycle would — the origin stylesheets aside (indicative,
 * structural fidelity only).
 */
export function applyProgramToRoot(
  rootEl: Element,
  program: MutationProgram,
  /** `base`: the page's address, for a copy parsed apart from the page. */
  opts: { page?: boolean; base?: string } = {},
): RootApplyResult {
  const inserted: Node[] = [];
  const result: RootApplyResult = { applied: 0, misses: 0, rejected: 0, refused: [] };
  const budget = maxOpsFor(opts.page ? "page" : "block");
  // The detached document is rendered in a page of ours: the same policy keeps
  // a program from loading anything the capture did not already load.
  const policy = policyFor(ownerDocumentOf(rootEl), opts.base);
  const refuse = (index: number, reason: RefusalReason): void => {
    result.refused.push({ index, reason });
    if (reason === "target-missing") result.misses += 1;
    else result.rejected += 1;
  };
  for (const [index, op] of program.entries()) {
    if (index >= budget) {
      refuse(index, "over-budget");
      continue;
    }
    const target = resolveWithinRoot(rootEl, op.target, inserted);
    if (!target) {
      refuse(index, "target-missing");
      continue;
    }
    // A page root (the body) keeps its content: refused, like the live engine.
    const rootWhy = opts.page && target === rootEl ? pageRootRefusal(op) : null;
    const why = rootWhy ?? policyRefusal(target, op, policy);
    if (why !== null) {
      refuse(index, why);
      continue;
    }
    let outcome: Node[] | Refusal;
    try {
      outcome = mutateTarget(target, op, policy);
    } catch {
      result.failed = true;
      break;
    }
    if (!Array.isArray(outcome)) {
      refuse(index, outcome.refuse);
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
  // to 0) when a reapply-after-clobber ends the application — a boolean
  // `active` can't distinguish "applied" from "was applied, the framework ate
  // it, reapply missed" (sol-2), and a capture keyed on the stale answer would
  // commit unmutated pixels as ground truth.
  private generation = 0;
  private appliedGeneration = 0;
  /** The page key the active program was applied on (3-E2); null without a reader. */
  private boundPage: string | null = null;
  /** Which ops the active application left out: a reapply that leaves out others ends it. */
  private refusedKey = "";

  constructor(
    private readonly root: Document | ShadowRoot,
    private readonly pageKey?: () => string | null,
    private readonly onEnded?: () => void,
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
    const result = this.withObserverSuppressed((): ApplyFailure | null => {
      try {
        return this.applyProgram(program, true, root, refused, tally);
      } catch {
        // Nothing should throw here; if something does, every write made so
        // far comes off (each was snapshotted before it ran).
        return "failed";
      }
    });
    if (result !== null) {
      this.restore();
      return { ok: false, reason: result };
    }
    this.activeProgram = program;
    this.activeRoot = root;
    this.refusedKey = refusedKeyOf(refused);
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
   *  false after any restore, later apply, or a reapply that ended it.
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
      this.takeOff();
      this.activeProgram = null;
      this.activeRoot = undefined;
      this.appliedGeneration = 0;
    });
  }

  reapply(): void {
    this.group.reapplyAll();
  }

  /**
   * Put the active program back on over its first baselines (a node a
   * framework swapped in gets its own before its first write). True when it
   * lands exactly the steps the person saw land, and refuses the same ones;
   * otherwise the group takes it off whole.
   */
  reapplySame(): boolean {
    const program = this.activeProgram;
    if (program === null) return true;
    // The document moved to another page (an SPA route) since the program
    // went on: it comes off instead of going back on there (3-E2).
    if (this.pageKey && this.pageKey() !== this.boundPage) {
      this.dropOffPage();
      return true;
    }
    // A re-render that wrote to a styled element's `style` was the page's own:
    // from now on restore takes back only the engine's properties there.
    for (const snapshot of this.snapshots.values()) snapshot.notePageWrites();
    this.removeInserted();
    const refused: RefusedOp[] = [];
    let failure: ApplyFailure | null;
    try {
      failure = this.applyProgram(program, true, this.activeRoot, refused, { applied: 0 });
    } catch {
      failure = "failed";
    }
    for (const snapshot of this.snapshots.values()) snapshot.markWritten();
    return failure === null && refusedKeyOf(refused) === this.refusedKey;
  }

  /** Take every write of this engine off the page by its snapshots, keeping the active program. */
  takeOff(): void {
    this.removeInserted();
    for (const snapshot of [...this.snapshots.values()].reverse()) snapshot.restore();
    this.snapshots.clear();
  }

  /** The page changed under this application: it is over (`applied()` is false, nothing reapplies). */
  end(): void {
    this.activeProgram = null;
    this.activeRoot = undefined;
    this.appliedGeneration = 0;
  }

  notifyEnded(): void {
    try {
      this.onEnded?.();
    } catch {
      /* a listener that throws never breaks the page */
    }
  }

  /**
   * The document is on another page now (3-E2): the program goes, onlay's
   * inserted nodes go, and of its writes only those still on the page are
   * taken back; whatever the page rendered since stays as it is.
   */
  private dropOffPage(): void {
    this.withObserverSuppressed(() => {
      // Before the inserts go: a `setText` target's child list, as the engine
      // left it, holds what was appended to it.
      for (const snapshot of [...this.snapshots.values()].reverse()) snapshot.restoreOwn();
      this.removeInserted();
      this.snapshots.clear();
      this.activeProgram = null;
      this.activeRoot = undefined;
      this.appliedGeneration = 0;
    });
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

  /** Snapshot the element's whole `style` attribute before its first style write. */
  private captureStyle(el: Element, props: readonly string[]): void {
    if (!(el instanceof HTMLElement)) return;
    const snapshot = this.snapshotFor(el);
    if (snapshot.styleAttr === undefined) snapshot.styleAttr = el.getAttribute("style");
    for (const p of props) snapshot.styleProps.add(p);
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
      // A step whose target isn't here is left out; the rest still lands. A
      // later step aimed into what a refused insert would have added misses too.
      if (!target) {
        refused.push({ index, reason: "target-missing" });
        continue;
      }
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
        this.captureStyle(
          target,
          op.props.map((x) => x.prop),
        );
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
        if (op.position === "replace") this.captureStyle(target, ["display"]);
        break;
    }
  }
}

/**
 * `opts.pageKey` reads the document's current page key: a program applied on
 * one page is never put back on another (3-E2). Without it (the web app's
 * portable render, which has no page) the engine behaves as before.
 * `opts.onEnded` hears when a re-render ended the application (the page no
 * longer lands the same steps): it came off whole and is not put back.
 */
export function createPreviewEngine(
  root: Document | ShadowRoot,
  opts: { pageKey?: () => string | null; onEnded?: () => void } = {},
): PreviewEngine {
  return new Engine(root, opts.pageKey, opts.onEnded);
}

function normalizeAttrName(name: string): string {
  return name.toLowerCase();
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

/**
 * The page's own origin, plus every origin an element already in it loads
 * from. `baseOverride` names the page for a detached copy, whose own address
 * is not the page's.
 */
function policyFor(doc: Document, baseOverride?: string): PagePolicy {
  const base = baseOverride ?? (doc.baseURI || doc.URL || "about:blank");
  const origins = new Set<string>();
  const own = httpOrigin(baseOverride ?? (doc.URL || base), base);
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

/** A link a program inserted or redirected opens nothing that can reach back, and pings nobody. */
function hardenLink(el: Element): void {
  el.setAttribute("rel", "noopener noreferrer");
  el.setAttribute("referrerpolicy", "no-referrer");
  el.removeAttribute("ping");
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

/** Text or markup never goes into (or inside) these. */
const TEXT_REFUSED_IN =
  "style, script, noscript, template, iframe, object, embed, textarea, title, head";

/**
 * Rule (c): one style declaration. The page-independent part is the shared
 * rule (`styleStaticRefusal`); what is left is whether each URL it loads comes
 * from an origin the page already loads from.
 */
function styleRefusal(prop: string, value: string, policy: PagePolicy): RefusalReason | null {
  const known = styleStaticRefusal(prop, value);
  if ("reason" in known) return known.reason;
  for (const u of known.urls) {
    if (resourceUrlRefusal(u, policy, { dataImage: true }) !== null) return "style-value";
  }
  return null;
}

/**
 * The verdict on one resolved op before anything is written: the shared
 * page-independent rule, the live-page policy and whether the target can take
 * the op. Fragment contents are checked while the fragment is built
 * (`buildFragment`), before it touches the page.
 */
function policyRefusal(target: Element, op: MutationOp, policy: PagePolicy): RefusalReason | null {
  switch (op.op) {
    case "setStyle":
      if (!hasStyle(target)) return "target-kind";
      for (const { prop, value } of op.props) {
        const why = styleRefusal(prop, value, policy);
        if (why !== null) return why;
      }
      return null;
    case "setClass":
      return classNameProblem(op.add) || classNameProblem(op.remove) ? "class-name" : null;
    case "setAttr": {
      const tag = target.localName;
      const name = normalizeAttrName(op.name);
      return attrRefusalFor(tag, name, op.value) ?? attrUrlRefusal(tag, name, op.value, policy);
    }
    case "setText":
      return target.closest(TEXT_REFUSED_IN) !== null ? "text-target" : null;
    case "insertFragment":
      if (target.closest(TEXT_REFUSED_IN) !== null) return "text-target";
      // A replace hides the target with an inline style: it needs one.
      return op.position === "replace" && !hasStyle(target) ? "target-kind" : null;
  }
}

/** Only an HTML element's inline style is snapshotted, so only it is written. */
function hasStyle(el: Element): boolean {
  return el instanceof HTMLElement;
}

/** The refused ops' indexes and reasons as one comparable string. */
function refusedKeyOf(refused: readonly RefusedOp[]): string {
  return refused.map((r) => `${r.index}:${r.reason}`).join(",");
}

/**
 * Build a sanitized DocumentFragment programmatically (strips scripts / on* /
 * dangerous URLs); THROWS for the receipt path. Nodes are minted in
 * `ownerDocument` so an insertFragment op lands in the same document as its
 * target — the live page for the Engine, the detached parsed capture for the
 * portable renderer (defaults to the ambient document for the receipt path).
 * With a `policy`, a resource from an origin the page does not already load
 * from (or a link outside web, mail and phone) refuses the whole fragment.
 * One with nothing in it that shows throws a `FragmentRefusal` naming why: the
 * same verdict `fragmentRefusal` (`@onlay/protocol`) gives without a DOM.
 */
export function buildFragment(
  html: string,
  ownerDocument: Document = (globalThis as { document: Document }).document,
  policy?: PagePolicy,
): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out = ownerDocument.createDocumentFragment();
  let renderable = false;
  let dropped = false;

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
    const tag = sourceEl.localName.toLowerCase();
    if (!FRAGMENT_TAGS.has(tag) || NEVER_INSERTED.has(tag)) {
      dropped = true;
      return;
    }

    const clean = ownerDocument.createElement(tag);
    copySafeAttributes(sourceEl, clean, tag, policy);
    for (const child of [...sourceEl.childNodes]) appendSafe(child, clean);
    if (VOID_RENDERABLE_TAGS.has(tag) || clean.childNodes.length > 0) renderable = true;
    parent.appendChild(clean);
  };

  for (const child of [...parsed.body.childNodes]) appendSafe(child, out);
  if (!renderable || out.childNodes.length === 0) {
    throw new FragmentRefusal(dropped ? "fragment-disallowed" : "fragment-empty");
  }
  return out;
}

/** A fragment that inserts nothing that shows (`buildFragment`). */
class FragmentRefusal extends Error {
  constructor(readonly reason: "fragment-empty" | "fragment-disallowed") {
    super(reason);
  }
}
