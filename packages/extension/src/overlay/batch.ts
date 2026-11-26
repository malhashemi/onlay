// Manual batch tray (ADR-0004 §4, B-5): human edits apply immediately as
// indicative previews and compile to mutation-program ops that accumulate in
// a tray. A contenteditable text-edit becomes a setText op; Delete
// on a picked element becomes a display:none removal op. Nothing reaches the
// agent per-keystroke — Send once creates a Change (method manual-batch,
// lazily) and emits it as one change-batch frame.
//
// Every frame of the tab is in Edit page mode together (E-3): the edits made
// in a document stay that document's, in its own tray, and the top frame's
// tray lists them all. Send makes one Edit per document, each sent by its own
// document and bound to its own address.

import { LIMITS, type MutationOp, type MutationProgram, programBytes } from "@onlay/protocol";
import { HOSTED_COPY } from "../hosted-copy";
import { cssPath, documentProvenance } from "./anchors";
import type { App } from "./app";
import { el } from "./dom";
import type { ReportedOp } from "./frame-edits";
import type { KeptLayer } from "./kept-layer";
import { SPACE_PICKER_COPY, type SpacePicker, spacePicker } from "./space-picker";
import { type SubtreeSnapshot, snapshotSubtree } from "./subtree";
import { uuid4 } from "./uuid";

export interface BatchTrayDeps {
  /** Sent edits hand over to the kept layer once the Edit is kept. */
  layer?: KeptLayer;
  /** Open the page-scope Edit composer (describe an edit, or ask for variants). */
  describe?(): void;
  /**
   * The page and account the first edit was made under (2-F3): a send after
   * either changed sends nothing. The account generation rides the create.
   */
  binding?(): { page: string | null; generation: number | null };
  /** What `listOps` reports changed (a child frame reports it). */
  onChange?(): void;
  /** Top frame: the edits made in each child frame's document, and how to act on them (E-3). */
  remote?: {
    /** Each child frame commits a text edit in progress and says what it holds now. */
    settle(): Promise<void>;
    lists(): Array<{ documentId: string; host: string; ops: ReportedOp[] }>;
    remove(documentId: string, index: number): void;
    send(documentId: string, spaceId: string): Promise<SendOutcome>;
    dismiss(documentId: string): void;
  };
}

/** How a document's send went: `note` is the tray's line when it didn't. */
export type SendOutcome = { ok: true } | { ok: false; error: string; note: string };

/** The tray's words. */
export const BATCH_COPY = {
  tooMany: "Too many edits to send at once. Remove a few and send them in two goes.",
  notKept: "Those edits weren't kept, so they're off the page now.",
  describe: "Describe an edit",
  describeTitle: "Describe an edit for the whole page, or ask for variants of it",
  pageChanged: "The page changed after you made these edits. Close the tray and make them again.",
} as const;

export interface BatchTray {
  element: HTMLElement;
  beginTextEdit(target: Element): void;
  addRemoval(target: Element): void;
  cancelEdit(): void;
  /** The block currently in an inline text-edit session, if any. */
  editingTarget(): Element | null;
  /** Edits in the tray, this document's and every child frame's. */
  opCount(): number;
  /** Edits made in this document. */
  localOpCount(): number;
  /** This document's edits as the top frame's tray lists them (a child frame reports them). */
  listOps(): ReportedOp[];
  /** Take one of this document's edits out (the top frame's ×). */
  removeAt(index: number): boolean;
  /** Send this document's edits as one Edit bound to this document's address. */
  sendHere(spaceId: string): Promise<SendOutcome>;
  /** Commit a text edit in progress here (the top frame's Send). */
  commitEdit(): void;
  /**
   * The account or server changed (2-E2): every edit here goes, previews and
   * all, with the Edit a failed send was retrying into; nothing carries over.
   */
  reset(): void;
  /** A child frame's edits changed: the open tray lists them anew. */
  remoteChanged(): void;
  setOpen(on: boolean): void;
  isOpen(): boolean;
  /**
   * Dismiss the tray: unsent edits are a DRAFT — discard them and restore
   * the page to its original state. Send is the only way edits survive.
   */
  dismiss(): void;
}

interface TextSession {
  target: HTMLElement;
  selector: string;
  originalText: string;
  /** The block's inside as the session found it: the page's own nodes, never
   *  copies (subtree.ts), so links, emphasis and the page's listeners come back. */
  before: SubtreeSnapshot;
  prevEditable: string | null;
  onBlur: () => void;
  onKeydown: (e: KeyboardEvent) => void;
}

interface PendingOp {
  op: MutationOp;
  /** Restore the state this op's preview found when it was last put on the page. */
  undo: () => void;
  /**
   * Put this op's indicative preview on the page again, remembering what it
   * finds first: a replay after another edit was taken out starts from a page
   * that edit is no longer on, so what `undo` holds is taken anew each time.
   */
  apply: () => void;
}

/** Hide a block for a removal's preview; the answer puts its `display` back as it was. */
function hide(t: HTMLElement): () => void {
  const hadStyle = t.hasAttribute("style");
  const value = t.style.getPropertyValue("display");
  const priority = t.style.getPropertyPriority("display");
  t.style.setProperty("display", "none");
  return () => {
    if (value) t.style.setProperty("display", value, priority);
    else t.style.removeProperty("display");
    // A block that had no style attribute gets none left behind.
    if (!hadStyle && t.getAttribute("style") === "") t.removeAttribute("style");
  };
}

/**
 * A batch fits when its `change-batch` frame fits the socket's frame limit and
 * its program fits `MAX_PROGRAM_BYTES` (measured with a placeholder id of the
 * real length, so the check runs before the Edit exists).
 */
export function batchFits(program: MutationProgram, frameUrl: string, spaceId: string): boolean {
  if (programBytes(program) > LIMITS.MAX_PROGRAM_BYTES) return false;
  const frame = JSON.stringify({
    v: 1,
    frameUrl,
    type: "change-batch",
    interactionId: "00000000-0000-4000-8000-000000000000",
    ops: program,
    spaceId,
  });
  return frame.length <= LIMITS.MAX_FRAME_CHARS;
}

export function createBatchTray(app: App, deps: BatchTrayDeps = {}): BatchTray {
  const tray = el("div", "card batch-tray");
  const head = el("div", "card-head");
  const title = el("span", "title", "Edit set");
  // ONE way out besides Send: Close discards the unsent draft and restores
  // the page (Esc matches). A separate Clear would be a competing close.
  const close = el("button", "btn ghost sm", "Close");
  close.title = "Discard unsent edits (Esc)";
  head.append(title, close);
  const body = el("div", "card-body");
  const list = el("div");
  const row = el("div", "row");
  const send = el("button", "btn primary k-change", "Send edits");
  row.append(send);
  if (deps.describe) {
    const describe = el("button", "btn ghost", BATCH_COPY.describe);
    describe.title = BATCH_COPY.describeTitle;
    describe.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      deps.describe?.();
    });
    row.append(describe);
  }
  const status = el("div", "dim");
  // The edit set posts to the composing space, like the Edit composer; the
  // slot rebuilds on each refresh so a space change elsewhere shows here.
  const spaceSlot = el("div");
  body.append(list, spaceSlot, status, row);
  tray.append(head, body);

  const ops: PendingOp[] = [];
  let session: TextSession | null = null;
  /** The tray's space field as last built (each refresh builds it anew). */
  let picker: SpacePicker | null = null;

  function setOpen(on: boolean): void {
    tray.style.display = on ? "flex" : "none";
    if (on) {
      tray.style.width = "300px";
    } else {
      // A closed tray leaves no menu of its own open.
      picker?.close();
    }
  }
  function refresh(): void {
    picker?.close();
    while (spaceSlot.firstChild) spaceSlot.removeChild(spaceSlot.firstChild);
    picker = spacePicker(app);
    if (picker.element) spaceSlot.appendChild(picker.element);
    while (list.firstChild) list.removeChild(list.firstChild);
    const total = opCount();
    if (total === 0) {
      list.appendChild(el("div", "dim", "Edit text or press Delete on a block."));
    }
    for (const pending of ops) {
      const op = pending.op;
      const line = el("div", "batch-op");
      const kind = el("span", "op-kind", op.op);
      const detail = describeOp(op);
      const remove = el("button", "op-remove", "×");
      remove.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        // Ops on the same element chain their captured states: unwind ALL
        // previews in reverse, drop this one, then replay the rest in order
        // so the page matches exactly what the tray will send.
        unwindAll();
        const i = ops.indexOf(pending);
        if (i >= 0) ops.splice(i, 1);
        for (const p of ops) p.apply();
        createNonce = null; // another batch now (3-E6)
        refresh();
      });
      line.append(kind, el("span", "op-detail", detail), remove);
      list.appendChild(line);
    }
    // Edits made inside a child frame, under the frame's host (E-3).
    for (const frame of remoteLists()) {
      const head = el("div", "micro", frame.host);
      head.title = `In a frame from ${frame.host}`;
      list.appendChild(head);
      frame.ops.forEach((op, index) => {
        const line = el("div", "batch-op");
        const remove = el("button", "op-remove", "×");
        remove.addEventListener("click", (e) => {
          if (!e.isTrusted) return;
          deps.remote?.remove(frame.documentId, index);
        });
        line.append(el("span", "op-kind", op.op), el("span", "op-detail", op.detail), remove);
        list.appendChild(line);
      });
    }
    title.textContent = `Edit set · ${total}`;
    // A send in progress keeps it off until every document's create settled (2-E5).
    (send as HTMLButtonElement).disabled = total === 0 || clicking;
    setOpen(true);
    deps.onChange?.();
  }

  function remoteLists(): Array<{ documentId: string; host: string; ops: ReportedOp[] }> {
    return (deps.remote?.lists() ?? []).filter((l) => l.ops.length > 0);
  }

  function opCount(): number {
    return ops.length + remoteLists().reduce((n, l) => n + l.ops.length, 0);
  }

  /** The page and account the first edit in the tray was made under. */
  let bound: { page: string | null; generation: number | null } | null = null;

  function addOp(pending: PendingOp): boolean {
    if (ops.length >= LIMITS.MAX_MUTATION_OPS) {
      app.toast("batch full");
      return false;
    }
    if (ops.length === 0) bound = deps.binding?.() ?? null;
    ops.push(pending);
    createNonce = null; // another batch now (3-E6)
    refresh();
    return true;
  }

  function unwindAll(): void {
    for (let i = ops.length - 1; i >= 0; i--) ops[i]?.undo();
  }

  function teardown(s: TextSession): void {
    s.target.removeEventListener("blur", s.onBlur);
    s.target.removeEventListener("keydown", s.onKeydown);
    if (s.prevEditable === null) s.target.removeAttribute("contenteditable");
    else s.target.setAttribute("contenteditable", s.prevEditable);
  }

  function commit(s: TextSession): void {
    if (session !== s) return;
    session = null;
    teardown(s);
    const nextText = (s.target.textContent ?? "").slice(0, LIMITS.MAX_MUTATION_TEXT);
    if (nextText === s.originalText) {
      // Unchanged text can still carry DOM damage from the edit session —
      // put the inside back so abandoning is truly invisible. A session that
      // changed nothing touches nothing.
      s.before.restore();
      return;
    }
    // keep the indicative edit visible in the page (it's already applied)
    const pending: PendingOp = {
      op: { op: "setText", target: s.selector, text: nextText },
      undo: () => s.before.restore(),
      apply: () => {
        const found = snapshotSubtree(s.target);
        s.target.textContent = nextText;
        pending.undo = () => found.restore();
      },
    };
    if (!addOp(pending)) pending.undo();
  }

  function beginTextEdit(t: Element): void {
    cancelEdit();
    if (!(t instanceof HTMLElement)) return;
    const s: TextSession = {
      target: t,
      selector: cssPath(t).slice(0, LIMITS.MAX_SELECTOR),
      originalText: t.textContent ?? "",
      before: snapshotSubtree(t),
      prevEditable: t.getAttribute("contenteditable"),
      onBlur: () => commit(s),
      onKeydown: (e: KeyboardEvent) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        t.blur();
        commit(s);
      },
    };
    session = s;
    t.setAttribute("contenteditable", "true");
    t.addEventListener("blur", s.onBlur);
    t.addEventListener("keydown", s.onKeydown);
    (t as HTMLElement).focus();
  }

  function cancelEdit(): void {
    if (!session) return;
    const s = session;
    session = null;
    teardown(s);
    s.before.restore();
  }

  function addRemoval(t: Element): void {
    if (!(t instanceof HTMLElement)) return;
    const selector = cssPath(t).slice(0, LIMITS.MAX_SELECTOR);
    if (ops.length >= LIMITS.MAX_MUTATION_OPS) {
      app.toast("batch full");
      return;
    }
    const pending: PendingOp = {
      op: { op: "setStyle", target: selector, props: [{ prop: "display", value: "none" }] },
      undo: () => {},
      apply: () => {
        pending.undo = hide(t);
      },
    };
    pending.apply(); // indicative preview
    addOp(pending);
  }

  function dismiss(): void {
    cancelEdit();
    unwindAll();
    ops.length = 0;
    bound = null;
    // A dismissed batch's create, and the Edit it made, are not the next batch's (3-E6).
    createNonce = null;
    pendingEdit = null;
    // Every child frame's unsent edits go too, and its page comes back.
    for (const l of remoteLists()) deps.remote?.dismiss(l.documentId);
    refresh(); // repaint the (now empty) list for the next open…
    setOpen(false); // …then close (refresh re-opens as a side effect)
  }

  close.addEventListener("click", () => dismiss());
  // The Edit a send created: a failed send retries into it, never a second one.
  let pendingEdit: { id: string; spaceId: string; provenance: string | undefined } | null = null;
  /**
   * The create of an unconfirmed batch: one nonce, reused by every retry of
   * that batch to that space (2-E5), retired when the batch changes (3-E6).
   */
  let createNonce: { nonce: string; spaceId: string } | null = null;
  /** A send of this document's edits in progress: a second one joins it (2-E5). */
  let sending: Promise<SendOutcome> | null = null;
  /** The top frame's Send is in progress. */
  let clicking = false;
  /** Sent edits whose kept entry hasn't landed yet: their raw edits, to take off. */
  const awaitingKept = new Map<string, () => void>();

  /** Send this document's edits as one Edit bound to its own address. */
  function sendHere(spaceId: string): Promise<SendOutcome> {
    if (sending) return sending;
    const run = sendOnce(spaceId).finally(() => {
      if (sending === run) sending = null;
    });
    sending = run;
    return run;
  }

  async function sendOnce(spaceId: string): Promise<SendOutcome> {
    if (ops.length === 0) return { ok: true };
    const fail = (error: string, note: string): SendOutcome => ({ ok: false, error, note });
    const program: MutationProgram = ops.map((pending) => pending.op);
    // Measured BEFORE the Edit exists: the socket frame and the program limit.
    if (!batchFits(program, app.frameUrl(), pendingEdit?.spaceId ?? spaceId))
      return fail("too-large", BATCH_COPY.tooMany);
    // Made on another page or under another account than now: nothing goes (2-F3).
    const now = deps.binding?.();
    if (bound && now && (bound.page !== now.page || bound.generation !== now.generation))
      return fail("page-changed", BATCH_COPY.pageChanged);
    // A stamped page's source is known: the server then hands the batch to an
    // agent instead of keeping it (spec §8).
    let edit = pendingEdit;
    if (!edit) {
      status.textContent = "creating edit…";
      const provenance = documentProvenance();
      if (createNonce?.spaceId !== spaceId) createNonce = { nonce: uuid4().slice(0, 32), spaceId };
      const held = createNonce;
      const nonce = held.nonce;
      const created = await app.createInteraction(
        {
          kind: "change",
          anchor: { level: "page" },
          change: {
            intent: `Manual batch of ${ops.length} edit(s)`,
            method: "manual-batch",
            ...(provenance ? { provenance } : {}),
          },
          // Checked by the service worker right before it sends (3-F3).
          ...(bound ? { pickGeneration: bound.generation } : {}),
        },
        spaceId,
        nonce,
      );
      // Reset or changed under it: what it made is not this batch's.
      if (createNonce !== held) return fail("page-changed", BATCH_COPY.pageChanged);
      if (!created.ok || !created.interactionId) {
        const reason = created.reason ?? "unknown";
        return fail(reason, `not sent: ${reason}`);
      }
      edit = { id: created.interactionId, spaceId, provenance };
      pendingEdit = edit;
      createNonce = null;
    }
    const created = { interactionId: edit.id };
    const provenance = edit.provenance;
    // The tray keeps every undo record until the server has the batch.
    const receipt = app.awaitReceipt("batch", created.interactionId);
    const r = await app.send({
      type: "change-batch",
      interactionId: created.interactionId,
      ops: program,
      // The account generation it was made under: the service worker checks it (3-E3).
      ...(bound ? { pickGeneration: bound.generation } : {}),
    });
    const got = r.ok ? await receipt : r;
    if (!got.ok) {
      const reason = got.error ?? "unknown";
      return fail(reason, `batch not sent: ${reason}`);
    }
    pendingEdit = null;
    const sentOps = [...ops];
    const unwind = (): void => {
      for (let i = sentOps.length - 1; i >= 0; i--) sentOps[i]?.undo();
    };
    if (provenance) {
      // Gone to an agent to implement in source: nothing is kept here, so the
      // tray's temporary edits come off the page now.
      if (deps.layer) deps.layer.lifted(unwind);
      else unwind();
    } else if (deps.layer) {
      // Kept: the raw edits stay until the kept layer shows the same program
      // through its engine, and then come off underneath.
      // If the kept entry never arrives, the raw edits come off after 15 s.
      const id = created.interactionId;
      awaitingKept.set(id, unwind);
      const settle = (): void => {
        if (awaitingKept.get(id) !== unwind) return;
        awaitingKept.delete(id);
        unwind();
      };
      deps.layer.whenKept(id, settle, 15_000, () => {
        if (awaitingKept.get(id) !== unwind) return;
        settle();
        app.toast(BATCH_COPY.notKept);
      });
    }
    ops.length = 0;
    bound = null;
    refresh();
    return { ok: true };
  }

  send.addEventListener("click", async (e) => {
    if (!e.isTrusted) return;
    if (opCount() === 0) return;
    const spaceId = pendingEdit?.spaceId ?? app.currentSpaceId();
    if (!spaceId) {
      status.textContent = HOSTED_COPY.noSpace;
      return;
    }
    // The space the tray shows, lost since it was chosen: nothing goes (the
    // edits stay), and the field is built again from the spaces there are now.
    if (!pendingEdit && picker?.element && !picker.usable()) {
      refresh();
      status.textContent = SPACE_PICKER_COPY.lost;
      return;
    }
    if (clicking) return;
    clicking = true;
    (send as HTMLButtonElement).disabled = true;
    try {
      await sendEverywhere(spaceId);
    } finally {
      clicking = false;
      (send as HTMLButtonElement).disabled = opCount() === 0;
    }
  });

  async function sendEverywhere(spaceId: string): Promise<void> {
    // A text edit still open in a frame is committed first, as a blur here does.
    await deps.remote?.settle();
    // One Edit per document: this one's, then each child frame's (E-3).
    const outcomes: SendOutcome[] = [];
    if (ops.length > 0) outcomes.push(await sendHere(spaceId));
    for (const l of remoteLists()) {
      outcomes.push(
        await (deps.remote as NonNullable<BatchTrayDeps["remote"]>).send(l.documentId, spaceId),
      );
    }
    const failed = outcomes.find((o): o is Extract<SendOutcome, { ok: false }> => !o.ok);
    if (failed) {
      status.textContent = failed.note;
      return;
    }
    status.textContent = "";
    app.toast("Edits sent.");
    refresh();
    setOpen(false);
  }

  return {
    element: tray,
    beginTextEdit,
    addRemoval,
    cancelEdit,
    editingTarget: () => session?.target ?? null,
    opCount,
    localOpCount: () => ops.length,
    // Only edits made under the account held now are reported (2-E2).
    listOps: () =>
      bound && deps.binding && deps.binding().generation !== bound.generation
        ? []
        : ops.map((p) => ({ op: p.op.op, detail: describeOp(p.op).slice(0, 240) })),
    removeAt(index) {
      const pending = ops[index];
      if (!pending) return false;
      // As the tray's own ×: unwind every preview, drop it, replay the rest.
      unwindAll();
      ops.splice(index, 1);
      for (const p of ops) p.apply();
      if (ops.length === 0) bound = null;
      createNonce = null; // another batch now (3-E6)
      refresh();
      return true;
    },
    sendHere,
    commitEdit() {
      if (session) commit(session);
    },
    reset() {
      cancelEdit();
      unwindAll();
      ops.length = 0;
      bound = null;
      pendingEdit = null;
      createNonce = null;
      // Sent edits still waiting for their kept entry come off now too.
      const raw = [...awaitingKept.values()];
      awaitingKept.clear();
      const takeOff = (): void => {
        for (const unwind of raw.reverse()) unwind();
      };
      if (deps.layer) deps.layer.lifted(takeOff);
      else takeOff();
      status.textContent = "";
      refresh();
      setOpen(false);
    },
    remoteChanged() {
      if (tray.style.display === "flex") refresh();
    },
    setOpen,
    isOpen: () => tray.style.display === "flex",
    dismiss,
  };
}

/** One tray edit as its line shows it. */
function describeOp(op: MutationOp): string {
  return op.op === "setText"
    ? op.text.slice(0, 30)
    : op.op === "setStyle"
      ? op.props.map((p) => `${p.prop}:${p.value}`).join(",")
      : op.target;
}
