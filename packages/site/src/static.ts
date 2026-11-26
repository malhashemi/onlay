// A fragment as a static example. Until the page's script takes a fragment
// over, nothing in it works, so nothing in it may look operable to a keyboard
// or a screen reader: the build passes every fragment through here. Buttons
// become plain text in the same dress, the editors and the search field show
// their placeholder as words, and the roles of controls go. What is read
// stays: the people, the messages, the labels, the code.
import { currentDocument } from "./overlay/dom";

/** Roles that promise an operation. */
const OPERABLE = new Set([
  "button",
  "combobox",
  "listbox",
  "option",
  "switch",
  "dialog",
  "textbox",
]);

/** Attributes that only mean something on a working control. */
const CONTROL_ATTRS = [
  "type",
  "tabindex",
  "aria-pressed",
  "aria-selected",
  "aria-checked",
  "aria-expanded",
  "aria-controls",
  "aria-activedescendant",
  "aria-autocomplete",
  "aria-label",
  "autocomplete",
  "spellcheck",
  "rows",
  "placeholder",
  "disabled",
  "title",
];

function standIn(node: Element, tag: string, text?: string): Element {
  const twin = currentDocument().createElement(tag);
  const cls = node.getAttribute("class");
  if (cls) twin.setAttribute("class", cls);
  if (text !== undefined) twin.textContent = text;
  else while (node.firstChild) twin.appendChild(node.firstChild);
  node.replaceWith(twin);
  return twin;
}

/** Make `root` a picture of the overlay: readable, with nothing to operate. */
export function asStaticExample(root: Element): void {
  for (const b of [...root.querySelectorAll("button")]) {
    const twin = standIn(b, "span");
    if (b.hasAttribute("disabled")) twin.classList.add("is-disabled");
  }
  for (const t of [...root.querySelectorAll("textarea")]) {
    standIn(t, "div", t.getAttribute("placeholder") ?? "").classList.add("is-placeholder");
  }
  for (const i of [...root.querySelectorAll("input")]) {
    standIn(i, "span", i.getAttribute("placeholder") ?? "").classList.add("is-placeholder");
  }
  for (const n of [root, ...root.querySelectorAll("*")]) {
    const role = n.getAttribute("role");
    if (role && OPERABLE.has(role)) n.removeAttribute("role");
    // A scrolling code block stays reachable: scrolling it needs no script.
    if (n.classList.contains("code-pre")) continue;
    for (const name of CONTROL_ATTRS) n.removeAttribute(name);
  }
}
