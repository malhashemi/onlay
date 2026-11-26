// Caret plumbing for contenteditable token editors. A caret position is a
// plain character offset into the editor's wire text (token-input.ts's
// `serializeEditor`), stable across the overlay's teardown/rebuild renders.
// The wire text is the editor's text, pills' text included, with one "\n" for
// each line break (<br>) except the placeholder <br> that ends the editor:
// `breakLength`, which serialization uses too, so capture, restore and the
// text agree. Pills (`[data-token]`, contenteditable=false) and breaks are
// atomic: an offset landing inside one snaps to its boundary. Shadow-DOM
// aware: Chrome exposes selection via ShadowRoot.getSelection().

/** The Selection that governs `node`, looking through an open shadow root. */
export function selectionIn(node: Node): Selection | null {
  const root = node.getRootNode() as { getSelection?: () => Selection | null };
  if (typeof root.getSelection === "function") {
    const sel = root.getSelection();
    if (sel) return sel;
  }
  return node.ownerDocument?.getSelection() ?? null;
}

function isAtomicPill(n: Node): boolean {
  return n.nodeType === 1 && (n as Element).getAttribute("data-token") !== null;
}

/** A line break element. */
export function isLineBreak(n: Node): boolean {
  return n.nodeType === 1 && (n as Element).tagName === "BR";
}

/**
 * How many wire characters a <br> of `editor` stands for: one "\n", except a
 * <br> that is the editor's last child. That one draws no line of its own (the
 * placeholder token-input.ts keeps after a break that ends the text): zero.
 */
export function breakLength(br: Node, editor: Node): number {
  return br.parentNode === editor && editor.lastChild === br ? 0 : 1;
}

interface Atom {
  node: Node;
  len: number;
}

/** Flatten an editor into caret-addressable units: text nodes, atomic pills and line breaks. */
function atoms(editor: Node): Atom[] {
  const out: Atom[] = [];
  const walk = (root: Node): void => {
    for (const c of Array.from(root.childNodes)) {
      if (c.nodeType === 3) out.push({ node: c, len: (c as Text).data.length });
      else if (isAtomicPill(c)) out.push({ node: c, len: (c.textContent ?? "").length });
      else if (isLineBreak(c)) out.push({ node: c, len: breakLength(c, editor) });
      else if (c.nodeType === 1) walk(c);
    }
  };
  walk(editor);
  return out;
}

/** The length of `editor`'s wire text. */
function wireLength(editor: HTMLElement): number {
  let n = 0;
  for (const a of atoms(editor)) n += a.len;
  return n;
}

/** Character offset (into the wire text) of a collapsed caret inside `editor`, or null. */
export function caretOffset(editor: HTMLElement): number | null {
  const sel = selectionIn(editor);
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.focusNode;
  const off = sel.focusOffset;
  if (!node || !editor.contains(node)) return null;
  let acc = 0;
  for (const { node: a, len } of atoms(editor)) {
    if (a === node) return a.nodeType === 3 ? acc + Math.min(off, len) : acc;
    // caret parked on an element boundary: count whole units strictly before it
    if (node.nodeType === 1 && a.parentNode === node) {
      const idx = Array.prototype.indexOf.call(node.childNodes, a);
      if (idx >= off) return acc;
    }
    if (a.contains(node)) return acc;
    acc += len;
  }
  return acc;
}

/** Place a collapsed caret at character `offset` of `editor`'s wire text. */
export function setCaretOffset(editor: HTMLElement, offset: number): void {
  const doc = editor.ownerDocument;
  const sel = selectionIn(editor);
  if (!doc || !sel) return;
  const range = doc.createRange();
  let remaining = Math.max(0, offset);
  let placed = false;
  for (const { node: a, len } of atoms(editor)) {
    if (remaining <= len) {
      if (a.nodeType === 3) {
        range.setStart(a, remaining);
      } else {
        // inside/at a pill or a break: snap to its nearest edge (both are atomic)
        const parent = a.parentNode ?? editor;
        const idx = Array.prototype.indexOf.call(parent.childNodes, a);
        range.setStart(parent, remaining === 0 ? idx : idx + 1);
      }
      placed = true;
      break;
    }
    remaining -= len;
  }
  if (!placed) range.setStart(editor, editor.childNodes.length);
  range.collapse(true);
  try {
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // selection API unavailable (detached node) — focus alone is enough
  }
}

/** Focus `editor` with the caret at the end of its text. */
export function focusEnd(editor: HTMLElement): void {
  editor.focus();
  setCaretOffset(editor, wireLength(editor));
}
