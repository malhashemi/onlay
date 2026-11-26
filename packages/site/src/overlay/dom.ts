// DOM primitives for the overlay views. The same views draw the demo layer in
// the browser and the section fragments at build time (a happy-dom document),
// so every node is made through the document given here, and nothing writes
// an inline style: the page's policy is `style-src 'self'`, and a built
// fragment may not carry a `style` attribute. State that the extension writes
// as a style (hidden, a tint) is a `hidden` attribute or a class here.

const SVG_NS = "http://www.w3.org/2000/svg";

let doc: Document | null = null;

/** The document the views build in (the page's, or the build's). */
export function useDocument(d: Document): void {
  doc = d;
}

export function currentDocument(): Document {
  if (doc) return doc;
  if (typeof document !== "undefined") return document;
  throw new Error("no document");
}

/** Programmatic element factory: the only way a view makes a node. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = currentDocument().createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** SVG path data on a 24×24 grid. */
export interface Glyph {
  paths: readonly string[];
}

export function icon(glyph: Glyph, cls = "icon"): SVGSVGElement {
  const d = currentDocument();
  const svg = d.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const path of glyph.paths) {
    const p = d.createElementNS(SVG_NS, "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
  }
  return svg;
}

/** The mark, one drawing at every size (`src/assets/favicon.svg` draws the same mark). */
export function markSvg(cls = "orb-mark"): SVGSVGElement {
  const d = currentDocument();
  const svg = d.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 512 512");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag: "path" | "circle", attrs: Record<string, string>): void => {
    const node = d.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
  };
  shape("path", {
    d: "M 357.3 100 A 186 186 0 1 0 431.9 195.4",
    fill: "none",
    stroke: "#007886",
    "stroke-width": "34",
    "stroke-linecap": "round",
  });
  shape("circle", { cx: "403", cy: "141", r: "32", fill: "#007886" });
  shape("circle", {
    cx: "256",
    cy: "256",
    r: "118",
    fill: "none",
    stroke: "#00C4D7",
    "stroke-width": "30",
  });
  shape("path", {
    d: "M 229 277 L 325 202",
    fill: "none",
    stroke: "#00C4D7",
    "stroke-width": "20",
    "stroke-linecap": "round",
  });
  shape("circle", { cx: "229", cy: "277", r: "36", fill: "#00C4D7" });
  return svg;
}

/* ── glyphs (the extension's, kinds.ts and commands.ts) ── */

export const GLYPHS = {
  comment: { paths: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"] },
  change: { paths: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"] },
  search: { paths: ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "m21 21-4.3-4.3"] },
  grip: { paths: ["M7 9h.01", "M12 9h.01", "M17 9h.01", "M7 15h.01", "M12 15h.01", "M17 15h.01"] },
  copy: {
    paths: [
      "M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
      "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    ],
  },
  editPage: {
    paths: [
      "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
      "M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z",
    ],
  },
  commentPage: {
    paths: [
      "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
      "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
    ],
  },
  space: { paths: ["m12 2 10 5-10 5L2 7z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"] },
  kept: {
    paths: [
      "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z",
      "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    ],
  },
  clipboard: {
    paths: [
      "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
      "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
    ],
  },
  inbox: {
    paths: [
      "M22 12h-6l-2 3h-4l-2-3H2",
      "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
    ],
  },
  theme: {
    paths: [
      "M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4",
      "M12 2v2",
      "M12 20v2",
      "m4.9 4.9 1.4 1.4",
      "m17.7 17.7 1.4 1.4",
      "M2 12h2",
      "M20 12h2",
      "m6.3 17.7-1.4 1.4",
      "m19.1 4.9-1.4 1.4",
    ],
  },
  settings: {
    paths: [
      "M21 4h-7",
      "M10 4H3",
      "M14 2v4",
      "M21 12h-9",
      "M8 12H3",
      "M8 10v4",
      "M21 20h-5",
      "M12 20H3",
      "M16 18v4",
    ],
  },
} as const satisfies Record<string, Glyph>;

/** A person as the overlay shows them. */
export interface Person {
  name: string;
  initials: string;
  /** The tint class (`tint-you`, `tint-a`, …): the directory's colors, as classes. */
  tint: string;
}

export function avatar(person: Person, size: "sm" | "md" = "md"): HTMLElement {
  const node = el("span", `avatar avatar-${size} avatar-round ${person.tint}`);
  node.title = person.name;
  node.textContent = person.initials;
  return node;
}

/** The small tag beside the name of someone whose agent wrote this. */
export function agentTag(text: string, title: string): HTMLElement {
  const tag = el("span", "chip chip-waiting agent-tag", text);
  tag.title = title;
  return tag;
}

export function microLabel(text: string): HTMLElement {
  return el("span", "micro", text);
}

/** "now", "4m", "2h", "3d": the overlay's age label. */
export function ageLabel(ts: number, now: number): string {
  const d = now - ts;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}
