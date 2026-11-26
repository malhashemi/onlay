// The demo layer: Onlay, simulated on this one page. It mounts the way the
// extension's overlay does (a host that is a direct child of <html>, a shadow
// root, the launcher at the corner) and then behaves like a page with Onlay
// on it: pick a block, comment, ask for an Edit, step through Variants on the
// live page, keep one, read the Inbox. Variant programs go onto the page
// through @onlay/render's preview engine, the one the extension runs.
//
// Everything is local. The store is memory, the agent is a script, and
// nothing in this file makes a request.
import { createPreviewEngine } from "@onlay/render";
import { COPY, OWN } from "../copy";
import { createCommandBar } from "../overlay/bar";
import { createComposerWindow } from "../overlay/composer";
import { clear, el, GLYPHS, icon, type Person } from "../overlay/dom";
import { createLauncher } from "../overlay/launcher";
import type { BlockAnchor, Directory, Item, Kind } from "../overlay/model";
import { isLive } from "../overlay/model";
import type { RichDeps } from "../overlay/rich";
import {
  COMMANDS,
  COMPOSER,
  type CommandId,
  KIND_LABEL,
  PICK_HINTS,
  VARIANTS,
} from "../overlay/strings";
import { createThreadPanel } from "../overlay/thread";
import { createAgent } from "./agent";
import { blockLabel, describeBlock, keyboardBlocks, pickTarget, resolveBlock } from "./blocks";
import { createChords, isEditable } from "./chords";
import { createPreviews } from "./previews";
import { preparedVariants } from "./programs";
import { createStore, type DemoStore, SELF } from "./store";

/** The extension's default overlay zoom: the sheet's px are multiplied by it at build. */
const ZOOM = 1.25;
const scaled = (n: number): number => Math.round(n * ZOOM);

/** What the demo can run of the product's commands. */
const RUNNABLE: ReadonlySet<CommandId> = new Set<CommandId>([
  "copyBlock",
  "editBlock",
  "commentBlock",
  "commentPage",
  "inbox",
  "keptEdits",
  "toggleTheme",
]);

type PickKind = "comment" | "edit" | "copy";

/** What the page around the layer needs to know to guide a first-time visitor. */
export interface Surface {
  /** Where the command bar is while it shows an empty Inbox; null otherwise. */
  emptyInbox: DOMRect | null;
  /** A block pick is under way, and it was started from the keyboard. */
  pickingByKeys: boolean;
  /** The block the arrows are on during such a pick. */
  block: string | null;
}

export interface DemoLayer {
  store: DemoStore;
  /** Start a block pick: the same pick the product's "Comment on block" starts. */
  startPick(): void;
  /** Hear what the page's own guide follows: an empty Inbox, a keyboard pick. */
  onSurface(fn: (s: Surface) => void): void;
  /** Do what the Esc key does (for a screen with no Esc key). */
  escape(): void;
  /** Clear everything the visitor made and put the page back. */
  startOver(): void;
  /** Hear the first time the visitor opens the layer. */
  onEngaged(fn: () => void): void;
  /** What a click on the launcher does. */
  openLauncher(): void;
  /**
   * Take the whole layer away: every preview off the page, the host and its
   * listeners gone. For when the visitor's own Onlay turns out to be here.
   */
  destroy(): void;
}

export interface LayerDeps {
  /** The overlay's stylesheet, as the page already links it. */
  overlayCss: string;
  rich: Pick<RichDeps, "highlighter" | "copy">;
}

export function mountDemoLayer(deps: LayerDeps): DemoLayer {
  const you: Person = { name: OWN.demo.you, initials: "Y", tint: "tint-you" };
  const people: Directory = { [SELF]: you };
  let seq = 0;
  const store = createStore({
    now: () => Date.now(),
    id: () =>
      typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `demo-${Date.now()}-${++seq}`,
  });

  /* ── the host: a direct child of <html>, like the extension's ── */
  const host = document.createElement("div");
  host.setAttribute("data-onlay-demo", "");
  const shadow = host.attachShadow({ mode: "open" });
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = deps.overlayCss;
  const root = el("div", "ov ov-live");
  // Nothing shows unstyled: the layer appears once its sheet is in.
  root.hidden = true;
  sheet.addEventListener("load", () => {
    root.hidden = false;
  });
  sheet.addEventListener("error", () => host.remove());
  shadow.append(sheet, root);

  const isOverlay = (node: Element): boolean => node === host;
  // Every listener the layer puts on the page goes with this, at once.
  const life = new AbortController();
  const { signal } = life;

  /* ── small pieces ── */
  const hoverBox = el("div", "box");
  hoverBox.hidden = true;
  const selBox = el("div", "box sel");
  selBox.hidden = true;
  const ring = el("div", "ring");
  ring.hidden = true;
  const pinLayer = el("div", "pin-layer");
  const previewLabel = el("div", "preview-label");
  previewLabel.hidden = true;
  const toastEl = el("div", "toast");
  toastEl.setAttribute("role", "status");
  toastEl.hidden = true;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function toast(text: string, ms = 4000): void {
    toastEl.textContent = text.slice(0, 400);
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, ms);
  }

  /* ── state the layer keeps beside the store ── */
  let pick: PickKind | null = null;
  let hoverEl: Element | null = null;
  let selEl: Element | null = null;
  let pending: { kind: Kind; anchor: BlockAnchor | null } | null = null;
  let engaged = false;
  const engagedSubs: Array<() => void> = [];
  const engage = (): void => {
    if (engaged) return;
    engaged = true;
    for (const fn of engagedSubs) fn();
  };
  // How the visitor last acted: a pick started from the keyboard is steered by it.
  let lastInput: "keys" | "pointer" = "pointer";
  let pickByKeys = false;
  const surfaceSubs: Array<(s: Surface) => void> = [];
  let mounted = false;
  const tellSurface = (): void => {
    if (!mounted) return;
    const state: Surface = {
      emptyInbox: bar.emptyInbox(),
      pickingByKeys: pick !== null && pickByKeys,
      block: pick !== null && pickByKeys && hoverEl ? blockLabel(hoverEl) : null,
    };
    for (const fn of surfaceSubs) fn(state);
  };

  /* ── the agent ── */
  const agent = createAgent({
    store,
    prepared: preparedVariants,
    words: { variants: COPY.demo.agentReply, other: COPY.demo.agentOther },
    // The variants go straight onto the page when their block is in view.
    previewNow: (id) => {
      const anchor = store.get(id)?.anchor;
      const block = anchor ? resolveBlock(document, anchor) : null;
      if (!block) return false;
      const r = block.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  /* ── views ── */
  const rich: RichDeps = { people, highlighter: deps.rich.highlighter, copy: deps.rich.copy };
  const away = (): void => toast(OWN.demo.extensionOnly);

  const thread = createThreadPanel({
    people,
    selfId: SELF,
    now: () => Date.now(),
    rich,
    get: (id) => store.get(id),
    floating: true,
    canAskMore: (item) => agent.hasMore(item.id),
    actions: {
      reply: (id, text, to) => store.reply(id, text, to),
      react: (id, msgId, emoji, on) => store.react(id, msgId, emoji, on),
      editMsg: (id, msgId, text) => store.editMsg(id, msgId, text),
      deleteMsg: (id, msgId) => store.deleteMsg(id, msgId),
      resolve: (id) => store.resolve(id),
      reopen: (id) => store.reopen(id),
      cycle: (id, delta) => store.cycle(id, delta),
      pick: (id) => {
        store.pick(id);
        toast(VARIANTS.pickSent);
      },
      discard: (id) => {
        store.discard(id);
        toast(VARIANTS.discardSent);
      },
      more: (id) => {
        store.askMore(id);
        toast(VARIANTS.askedMore);
      },
      commentVariant: (id, text) => {
        store.commentVariant(id, text, VARIANTS.prefix);
        toast(VARIANTS.commented);
      },
      away,
      close: () => closeThread(),
    },
  });

  const composer = createComposerWindow({
    scaled,
    onComment: (text) => {
      const at = pending;
      if (!at) return;
      const item = store.comment(at.anchor, text);
      toast(COMPOSER.commentPosted);
      openThread(item.id, false);
    },
    onEdit: (req) => {
      const at = pending;
      if (!at) return;
      const item = store.edit(at.anchor, req);
      toast(COMPOSER.editSent);
      openThread(item.id, false);
    },
    onClosed: () => {
      pending = null;
      if (!thread.isOpen()) setSelected(null);
    },
  });

  const bar = createCommandBar({
    people,
    now: () => Date.now(),
    items: () => store.items(),
    canRun: (id) => RUNNABLE.has(id),
    run: runCommand,
    away: () => {
      bar.close();
      away();
    },
    openItem: (id) => openThread(id, true),
    setKept: (id, on) => store.setKept(id, on),
    awayChip: OWN.demo.extensionOnlyChip,
    onState: tellSurface,
  });

  // A click opens the Inbox, or closes the bar when it is open: the product's
  // own launcher (extension content.ts, `createLauncherOrb`'s `onOpen`).
  const openLauncher = (): void => {
    engage();
    setPick(null);
    if (bar.isOpen()) bar.close();
    else bar.open("inbox");
  };
  const launcher = createLauncher({
    onOpen: openLauncher,
    onKeptNote: () => {
      engage();
      bar.open("kept");
    },
    onAgentNote: away,
  });

  root.append(
    hoverBox,
    selBox,
    toastEl,
    thread.element,
    composer.element,
    pinLayer,
    ring,
    previewLabel,
    bar.element,
    launcher.element, // after the bar: the orb rides above the backdrop
  );
  document.documentElement.appendChild(host);
  mounted = true;

  /* ── geometry: boxes and pins follow their blocks ── */

  function placeBox(box: HTMLElement, target: Element | null, grow = 0): void {
    if (!target?.isConnected) {
      box.hidden = true;
      return;
    }
    const r = target.getBoundingClientRect();
    box.hidden = false;
    box.style.left = `${r.left - grow}px`;
    box.style.top = `${r.top - grow}px`;
    box.style.width = `${r.width + grow * 2}px`;
    box.style.height = `${r.height + grow * 2}px`;
  }

  function setSelected(target: Element | null): void {
    selEl = target;
    placeBox(selBox, selEl);
  }

  const pins = new Map<string, HTMLButtonElement>();

  function renderPins(): void {
    interface Group {
      block: Element;
      kind: Kind;
      ids: string[];
      needs: boolean;
      label: string;
    }
    const groups = new Map<string, Group>();
    for (const item of store.items()) {
      if (!isLive(item.state) || !item.anchor) continue;
      const block = resolveBlock(document, item.anchor);
      if (!block) continue;
      const key = `${item.kind}::${item.anchor.selector}`;
      const g = groups.get(key);
      if (g) {
        g.ids.push(item.id);
        g.needs = g.needs || item.needsYou;
      } else {
        groups.set(key, {
          block,
          kind: item.kind,
          ids: [item.id],
          needs: item.needsYou,
          label: item.anchor.label,
        });
      }
    }
    for (const [key, pin] of pins) {
      if (groups.has(key)) continue;
      pin.remove();
      pins.delete(key);
    }
    // Several kinds on one block stack, so each hue shows.
    const perBlock = new Map<Element, number>();
    for (const [key, g] of groups) {
      const r = g.block.getBoundingClientRect();
      const stack = perBlock.get(g.block) ?? 0;
      perBlock.set(g.block, stack + 1);
      let pin = pins.get(key);
      if (!pin) {
        pin = el("button", "pin");
        pin.type = "button";
        const opens = g.ids[0] as string;
        pin.addEventListener("click", (e) => {
          e.stopPropagation();
          const id = pin?.dataset.opens ?? opens;
          openThread(id, false);
        });
        pins.set(key, pin);
        pinLayer.appendChild(pin);
      }
      pin.className = `pin ${g.kind === "comment" ? "k-comment" : "k-change"}${g.needs ? " needs" : ""}`;
      pin.dataset.opens = g.ids[0] as string;
      const name = `${KIND_LABEL[g.kind]} — ${g.label}`;
      pin.title = name;
      pin.setAttribute("aria-label", name);
      clear(pin);
      pin.appendChild(icon(GLYPHS[g.kind], "icon-sm"));
      if (g.ids.length > 1) pin.appendChild(el("span", "pin-count", String(g.ids.length)));
      pin.hidden = r.bottom < 0 || r.top > window.innerHeight;
      pin.style.left = `${Math.min(r.right + 6, window.innerWidth - scaled(30))}px`;
      pin.style.top = `${Math.max(2, r.top + 2 + stack * scaled(28))}px`;
    }
  }

  let frame = 0;
  function reflow(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      placeBox(selBox, selEl);
      if (pick) placeBox(hoverBox, hoverEl);
      renderPins();
    });
  }
  window.addEventListener("scroll", reflow, { capture: true, passive: true, signal });
  window.addEventListener(
    "resize",
    () => {
      launcher.reclamp();
      reflow();
    },
    { signal },
  );
  // A variant changes how tall its block is; the page's own layout can move too.
  const watcher = typeof ResizeObserver === "function" ? new ResizeObserver(reflow) : null;
  watcher?.observe(document.body);

  let ringTimer: ReturnType<typeof setTimeout> | null = null;
  let ringFollow: ReturnType<typeof setInterval> | null = null;
  function flash(item: Item): void {
    const block = item.anchor ? resolveBlock(document, item.anchor) : null;
    if (!block) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    block.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    ring.className = `ring ${item.kind === "comment" ? "k-comment" : "k-change"}`;
    const place = (): void => placeBox(ring, block, 3);
    place();
    if (ringFollow) clearInterval(ringFollow);
    const follow = setInterval(place, 50);
    ringFollow = follow;
    if (ringTimer) clearTimeout(ringTimer);
    ringTimer = setTimeout(() => {
      clearInterval(follow);
      ring.hidden = true;
    }, 1600);
  }

  /* ── threads ── */

  function openThread(id: string, reveal: boolean): void {
    const item = store.get(id);
    if (!item) return;
    composer.close();
    thread.open(id);
    setSelected(item.anchor ? resolveBlock(document, item.anchor) : null);
    if (reveal) flash(item);
    thread.focusReply();
  }

  function closeThread(): void {
    thread.close();
    if (!composer.isOpen()) setSelected(null);
    launcher.element.focus({ preventScroll: true });
  }

  /* ── previews: variant programs on the live page, through the product's engine ── */

  // One engine per block (previews.ts): whatever the visitor does with several
  // Edits on the headline, taking everything off puts it back exactly.
  const previews = createPreviews(() => createPreviewEngine(document));

  function syncPreviews(): void {
    const pill = previews.sync(store.items());
    previewLabel.textContent =
      pill === null ? "" : pill.kind === "variant" ? VARIANTS.pill(pill.label) : VARIANTS.original;
    previewLabel.hidden = pill === null;
  }

  /* ── pick mode ── */

  function setPick(kind: PickKind | null): void {
    pick = kind;
    pickByKeys = kind !== null && lastInput === "keys";
    hoverEl = null;
    hoverBox.hidden = true;
    document.documentElement.classList.toggle("onlay-picking", kind !== null);
    tellSurface();
  }

  function enterPick(kind: PickKind): void {
    bar.close();
    composer.close();
    setPick(kind);
    toast(PICK_HINTS[kind]);
  }

  function choose(target: Element, at: { x: number; y: number }): void {
    const kind = pick;
    setPick(null);
    if (!kind) return;
    if (kind === "copy") {
      const html = target.outerHTML;
      void deps.rich
        .copy(html)
        .then((ok) =>
          toast(
            ok ? `block HTML copied (${html.length} chars)` : "copy failed — clipboard unavailable",
          ),
        );
      return;
    }
    store.picked();
    thread.close();
    setSelected(target);
    const anchor = describeBlock(target);
    const wire: Kind = kind === "edit" ? "change" : "comment";
    pending = { kind: wire, anchor };
    composer.open(wire, anchor.label, at);
  }

  window.addEventListener(
    "mousemove",
    (e) => {
      if (!pick) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      hoverEl = pickTarget(under, isOverlay);
      placeBox(hoverBox, hoverEl);
    },
    { capture: true, passive: true, signal },
  );

  window.addEventListener(
    "click",
    (e) => {
      if (!pick) return;
      const under = document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element | null);
      // The overlay's own controls stay themselves during a pick.
      if (under && isOverlay(under)) return;
      e.preventDefault();
      e.stopPropagation();
      const target = pickTarget(under, isOverlay);
      if (!target) return;
      choose(target, { x: e.clientX + 8, y: e.clientY + 8 });
    },
    { capture: true, signal },
  );

  /** A pick without a pointer: the arrows step through the page's blocks, Enter picks. */
  function stepPick(delta: 1 | -1): void {
    const blocks = keyboardBlocks(document);
    if (blocks.length === 0) return;
    const at = hoverEl ? blocks.indexOf(hoverEl) : -1;
    const next =
      at < 0 ? (delta > 0 ? 0 : blocks.length - 1) : (at + delta + blocks.length) % blocks.length;
    hoverEl = blocks[next] ?? null;
    hoverEl?.scrollIntoView({ block: "center" });
    placeBox(hoverBox, hoverEl);
    pickByKeys = true;
    tellSurface();
    reflow();
  }

  /* ── commands ── */

  function runCommand(id: CommandId): void {
    switch (id) {
      case "commentBlock":
        enterPick("comment");
        return;
      case "editBlock":
        enterPick("edit");
        return;
      case "copyBlock":
        enterPick("copy");
        return;
      case "commentPage":
        bar.close();
        thread.close();
        setSelected(null);
        pending = { kind: "comment", anchor: null };
        composer.open("comment", COMPOSER.page);
        return;
      case "inbox":
        setPick(null);
        bar.open("inbox");
        return;
      case "keptEdits":
        setPick(null);
        bar.open("kept");
        return;
      case "toggleTheme":
        bar.close();
        root.classList.toggle("theme-light");
        return;
      default:
        bar.close();
        away();
    }
  }

  const bindings: Record<string, () => void> = {};
  for (const c of COMMANDS) {
    if (!RUNNABLE.has(c.id)) continue;
    bindings[c.chord] = () => {
      engage();
      runCommand(c.id);
    };
  }
  const chords = createChords({
    bindings,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  window.addEventListener(
    "pointerdown",
    () => {
      lastInput = "pointer";
    },
    { capture: true, passive: true, signal },
  );
  window.addEventListener(
    "keydown",
    () => {
      lastInput = "keys";
    },
    { capture: true, signal },
  );
  /** What Esc does: one rung at a time (the pick, the bar's mode, the bar, the composer, the thread). */
  function pressEscape(): boolean {
    if (pick) setPick(null);
    else if (bar.isOpen()) bar.escape();
    else if (composer.isOpen()) composer.close();
    else if (thread.isOpen()) closeThread();
    else return false;
    return true;
  }

  const onKey = (e: KeyboardEvent): void => {
    // The accelerator, shown the same on every system: Ctrl+.
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === ".") {
      e.preventDefault();
      chords.reset();
      engage();
      setPick(null);
      bar.toggle();
      return;
    }
    if (e.key === "Escape") {
      chords.reset();
      if (e.defaultPrevented) return;
      if (pressEscape()) e.preventDefault();
      return;
    }
    if (pick && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      stepPick(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (pick && e.key === "Enter" && hoverEl) {
      e.preventDefault();
      const r = hoverEl.getBoundingClientRect();
      choose(hoverEl, { x: r.left + 8, y: Math.min(r.bottom + 8, window.innerHeight - 200) });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) {
      chords.reset();
      return;
    }
    if (bar.isOpen() || isEditable(e.composedPath()[0])) {
      chords.reset();
      return;
    }
    if (chords.key(e.key)) e.preventDefault();
  };
  window.addEventListener("keydown", onKey, { signal });

  /* ── the store drives everything ── */

  let lastNeeds = 0;
  function sync(): void {
    syncPreviews();
    if (thread.isOpen()) thread.render();
    bar.refresh();
    const needs = store.needsYou();
    launcher.setBadge(needs);
    launcher.setKeptShown(store.keptShown());
    launcher.setAgentPending(store.agentPending());
    // A new needs-you announces itself once.
    if (needs > lastNeeds) launcher.ping();
    lastNeeds = needs;
    reflow();
  }
  const unsubscribe = store.subscribe(sync);
  sync();

  /** Close every surface and forget everything typed and not sent. */
  function closeAll(): void {
    agent.stop();
    chords.reset();
    setPick(null);
    bar.close();
    composer.close();
    thread.close();
    composer.clearDrafts();
    thread.clearDrafts();
    setSelected(null);
  }

  return {
    store,
    startOver() {
      closeAll();
      store.reset();
      // The control that asked for this is gone with what it cleared.
      launcher.element.focus({ preventScroll: true });
    },
    onEngaged(fn) {
      engagedSubs.push(fn);
    },
    onSurface(fn) {
      surfaceSubs.push(fn);
    },
    startPick() {
      engage();
      enterPick("comment");
    },
    escape() {
      pressEscape();
    },
    openLauncher,
    destroy() {
      closeAll();
      surfaceSubs.length = 0;
      unsubscribe();
      // Every preview comes off: the page is the visitor's own Onlay's now.
      previews.clear();
      life.abort();
      watcher?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (toastTimer) clearTimeout(toastTimer);
      if (ringTimer) clearTimeout(ringTimer);
      if (ringFollow) clearInterval(ringFollow);
      host.remove();
    },
  };
}

/** One ring out of the launcher: the page's way of pointing at it. */
export function pingLauncher(): void {
  const host = document.querySelector("[data-onlay-demo]");
  const orb = host?.shadowRoot?.querySelector(".orb");
  if (!orb) return;
  orb.classList.remove("ping");
  void (orb as HTMLElement).offsetWidth;
  orb.classList.add("ping");
  orb
    .querySelector(".orb-ping")
    ?.addEventListener("animationend", () => orb.classList.remove("ping"), { once: true });
}
