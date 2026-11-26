// Kind + actor glyphs (design-language §5): lucide-style 24×24 line icons built
// through the SVG NS API — never innerHTML — so the "no innerHTML anywhere" CSP
// posture holds. Path data is the SAME geometry the overlay draws
// (overlay/kinds.ts), so a kind reads identically at every altitude.
import type { InteractionKind } from "@onlay/protocol";
import { svg } from "../dom";

const KIND_PATHS: Record<InteractionKind, string[]> = {
  comment: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  ask: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
    "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3",
    "M12 17h.01",
  ],
  change: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
};

function iconFrom(paths: string[], size: number): SVGElement {
  const node = svg("svg", {
    viewBox: "0 0 24 24",
    width: String(size),
    height: String(size),
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.9",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  for (const d of paths) node.appendChild(svg("path", { d }));
  return node;
}

/** The kind's line glyph. `currentColor` inherits the kind hue from the chip. */
export function kindGlyph(kind: InteractionKind, size = 14): SVGElement {
  return iconFrom(KIND_PATHS[kind], size);
}

// The lucide `settings` gear — a drawn icon, not the ⚙ text glyph, which
// mobile renders as a mismatched emoji or a hairline serif character.
const GEAR_PATHS = [
  "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
];

/** The settings gear (header icon button) — same stroke voice as every glyph. */
export function gearGlyph(size = 20): SVGElement {
  return iconFrom(GEAR_PATHS, size);
}

// The lucide `search` magnifier — the SAME geometry the extension command
// bar wears (SEARCH_GLYPH in overlay/commands.ts), so search reads
// identically at every altitude.
const SEARCH_PATHS = ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "m21 21-4.3-4.3"];

/** The search magnifier (F25 — the Inbox search bar). */
export function searchGlyph(size = 16): SVGElement {
  return iconFrom(SEARCH_PATHS, size);
}

/** THE mark for the app header — one drawing at every
 *  size, never a simplified variant. */
export function mark(size = 22): SVGElement {
  const node = svg("svg", {
    viewBox: "0 0 512 512",
    width: String(size),
    height: String(size),
    "aria-hidden": "true",
  });
  node.appendChild(
    svg("path", {
      d: "M 357.3 100 A 186 186 0 1 0 431.9 195.4",
      fill: "none",
      stroke: "#007886",
      "stroke-width": "34",
      "stroke-linecap": "round",
    }),
  );
  node.appendChild(svg("circle", { cx: "403", cy: "141", r: "32", fill: "#007886" }));
  node.appendChild(
    svg("circle", {
      cx: "256",
      cy: "256",
      r: "118",
      fill: "none",
      stroke: "#00C4D7",
      "stroke-width": "30",
    }),
  );
  node.appendChild(
    svg("path", {
      d: "M 229 277 L 325 202",
      fill: "none",
      stroke: "#00C4D7",
      "stroke-width": "20",
      "stroke-linecap": "round",
    }),
  );
  node.appendChild(svg("circle", { cx: "229", cy: "277", r: "36", fill: "#00C4D7" }));
  return node;
}
