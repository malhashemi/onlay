// What is inside a block, remembered so it can be put back as it was: the
// page's OWN nodes, each under the parent and in the place it had, and each
// text node's words. Putting it back moves those nodes home again and takes
// out whatever came since. It never swaps a node for a copy: a copy has none
// of the page's listeners, the page's framework no longer knows it, and an
// earlier edit that still holds the first node could no longer undo itself.

export interface SubtreeSnapshot {
  /** Put the inside of the block back. Touches only what differs now. */
  restore(): void;
}

interface Kept {
  node: Node;
  /** An element's children, in order. */
  children?: Node[];
  /** A text, comment or CDATA node's words. */
  data?: string;
}

const ELEMENT = 1;
const HOLDS_TEXT = new Set([3, 4, 7, 8]);

export function snapshotSubtree(root: Element): SubtreeSnapshot {
  // Parents before their children, so a restore rebuilds from the block down.
  const kept: Kept[] = [];
  const todo: Node[] = [root];
  for (let node = todo.pop(); node; node = todo.pop()) {
    if (node.nodeType === ELEMENT) {
      const children = [...node.childNodes];
      kept.push({ node, children });
      for (let i = children.length - 1; i >= 0; i--) todo.push(children[i] as Node);
    } else if (HOLDS_TEXT.has(node.nodeType)) {
      kept.push({ node, data: (node as CharacterData).data });
    }
  }
  return {
    restore() {
      for (const k of kept) {
        try {
          if (k.children) restoreChildren(k.node, k.children);
          else if ((k.node as CharacterData).data !== k.data)
            (k.node as CharacterData).data = k.data ?? "";
        } catch {
          // A page that rebuilt itself around the block: the rest still goes back.
        }
      }
    },
  };
}

/** Make `children` the parent's children again, moving only what is out of place. */
function restoreChildren(parent: Node, children: Node[]): void {
  const wanted = new Set(children);
  let at = parent.firstChild;
  const dropStrangers = (): void => {
    while (at && !wanted.has(at)) {
      const next = at.nextSibling;
      parent.removeChild(at);
      at = next;
    }
  };
  for (const want of children) {
    dropStrangers();
    if (at === want) at = at.nextSibling;
    else parent.insertBefore(want, at);
  }
  // Everything wanted now sits before `at`: the rest came later.
  while (at) {
    const next = at.nextSibling;
    parent.removeChild(at);
    at = next;
  }
}
