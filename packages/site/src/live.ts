// What loads after the page is usable: the section fragments come alive in
// place of their built markup, the code samples get their Copy buttons, and,
// unless the visitor's own Onlay answered, the demo layer mounts.
import { createPreviewEngine, type PreviewEngine } from "@onlay/render";
import type { CodeHighlighter } from "@onlay/render/code-block";
import { mountDemoLayer, pingLauncher } from "./demo/layer";
import { wireRail } from "./demo/rail";
import type { DemoMode } from "./ext";
import { buildFragment, FRAGMENTS, type FragmentName, SAMPLE_PLAN_ID } from "./fragments";
import { useDocument } from "./overlay/dom";
import type { Variant } from "./overlay/model";
import { bakedHighlighter, bakedKey, fencedBlock, runsFromDom } from "./overlay/rich";

function writeClipboard(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** The colors the build painted, read back from the markup: no highlighter loads for them. */
function bakedRuns(): Map<string, unknown> {
  const baked = new Map<string, unknown>();
  for (const block of document.querySelectorAll<HTMLElement>(".code-block[data-lang]")) {
    const code = block.querySelector(".code-text");
    const key = code ? bakedKey(block.dataset.lang ?? null, code.textContent ?? "") : null;
    if (code && key) baked.set(key, runsFromDom(code));
  }
  return baked;
}

/** Code a visitor writes in the demo is colored by the product's highlighter, fetched then. */
async function loadRuns(lang: string, code: string): Promise<unknown> {
  const { highlightRuns } = await import("@onlay/render/highlight");
  return highlightRuns(lang, code);
}

function hydrateCode(highlighter: CodeHighlighter): void {
  for (const slot of document.querySelectorAll<HTMLElement>("[data-code]")) {
    const code = slot.querySelector(".code-text")?.textContent;
    if (code === undefined || code === null) continue;
    const lang = slot.dataset.lang || null;
    slot.replaceChildren(fencedBlock(code, lang, { highlighter, copy: writeClipboard }));
  }
}

function hydrateFragments(highlighter: CodeHighlighter): void {
  // The Edit fragment's Variants go onto its sample plan through the preview
  // engine, once the fragment is in the document.
  let engine: PreviewEngine | null = null;
  let mounted = false;
  let waiting: Variant | null | undefined;
  const apply = (variant: Variant | null): void => {
    engine ??= createPreviewEngine(document);
    if (variant) engine.apply(variant.program, `#${SAMPLE_PLAN_ID}`);
    else engine.restore();
  };
  const now = Date.now();
  for (const name of FRAGMENTS) {
    const mount = document.querySelector<HTMLElement>(`[data-fragment="${name}"]`);
    if (!mount) continue;
    mounted = false;
    waiting = undefined;
    const node = buildFragment(name as FragmentName, {
      now,
      rich: { highlighter, copy: writeClipboard },
      applyVariant: (_plan, variant) => {
        if (mounted) apply(variant);
        else waiting = variant;
      },
    });
    mount.replaceChildren(node);
    mounted = true;
    if (waiting !== undefined) apply(waiting);
  }
}

/** What `start` hands back: the way to take the simulation away again. */
export interface Live {
  /** The visitor's own Onlay answered after all: remove the simulation, completely. */
  standDown(): void;
}

export function start(mode: DemoMode): Live {
  useDocument(document);
  const highlighter = bakedHighlighter(bakedRuns(), loadRuns);
  hydrateFragments(highlighter);
  hydrateCode(highlighter);
  // From here the fragments' controls and every Copy button work.
  document.documentElement.dataset.live = "";

  const own = (): void => {
    // The visitor's own Onlay is on this page: the simulation stands down
    // completely, and the invitation points at theirs.
    document.documentElement.dataset.demo = "own";
  };
  const overlayCss = document.querySelector<HTMLLinkElement>("link[data-overlay-css]")?.href;
  if (mode === "own" || !overlayCss) {
    if (mode === "own") own();
    return { standDown: own };
  }

  const layer = mountDemoLayer({ overlayCss, rich: { highlighter, copy: writeClipboard } });
  const rail = wireRail(layer);
  document.documentElement.dataset.demo = "sim";

  // The launcher is at the corner, as on any page: the page points at it once,
  // and again whenever the invitation is touched.
  const life = new AbortController();
  const first = setTimeout(pingLauncher, 700);
  const invite = document.querySelector("[data-invite]");
  invite?.addEventListener("mouseenter", pingLauncher, { signal: life.signal });
  for (const glyph of document.querySelectorAll("[data-open-launcher]")) {
    glyph.addEventListener("click", () => layer.openLauncher(), { signal: life.signal });
  }

  let gone = false;
  return {
    standDown() {
      if (gone) return;
      gone = true;
      clearTimeout(first);
      life.abort();
      rail.destroy();
      layer.destroy();
      own();
    },
  };
}
