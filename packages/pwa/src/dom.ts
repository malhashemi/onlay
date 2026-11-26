// createElement-only DOM helpers (D-PKG-PWA: no innerHTML anywhere — the same
// CSP posture the extension holds as an invariant). Every node the PWA draws is
// built here or through these, so `script-src 'self'` needs no inline-script
// escape hatch and no string of user content is ever parsed as markup.

/** Build an element: `el("div", "cls", "text")` or with an attribute bag. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Append a run of children, skipping nulls, and return the parent. */
export function add<T extends Node>(parent: T, ...kids: (Node | null | undefined)[]): T {
  for (const k of kids) if (k) parent.appendChild(k);
  return parent;
}

/** Remove every child of a node (re-render a region without innerHTML=""). */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A real, focusable button with a trusted click handler (touch target ≥ 44px
 *  is enforced in CSS). Never a div-with-role. */
export function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    onClick();
  });
  return b;
}

/** An SVG element built through the NS API (glyphs are path arrays, never
 *  innerHTML — mirrors overlay/kinds.ts construction discipline). */
export function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Put text on the clipboard; false when the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
