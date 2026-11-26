import { expect, type Page, test } from "@playwright/test";
import { type PageServer, startPageServer } from "../harness/page-server";
import { RENDER_BUNDLE } from "./harness/bundle";
import { comparePngs } from "./harness/compare";
import { FIXTURES_DIR } from "./harness/fixtures-dir";
import { maskRect } from "./harness/raster";

/**
 * The Stage-1 fidelity gate (render spec §4). Captures each fixture block with
 * the REAL walker, renders it with the REAL portable renderer into a `sandbox=""`
 * frame, and diffs the reconstruction block against the live block with
 * pixelmatch + ssim.js. This gate owns the unit-transport fidelity + isolation
 * core. See `fidelity/README.md`.
 */

type Program = Array<Record<string, unknown>>;

let server: PageServer;

test.beforeAll(async () => {
  server = await startPageServer({ host: "localhost", fixturesDir: FIXTURES_DIR, csp: {} });
});
test.afterAll(async () => {
  await server?.stop();
});

async function loadFixture(page: Page, file: string): Promise<void> {
  await page.goto(`${server.base}/${file}`);
  await page.addScriptTag({ path: RENDER_BUNDLE });
  await page.evaluate(() => document.fonts.ready);
}

/** Run the in-page capture→render for a block (Original or a variant program). */
function renderInPage(page: Page, blockSel: string, program?: Program): Promise<OnlayRenderReport> {
  return page.evaluate(([sel, prog]) => window.__onlayFidelity.render(sel as string, prog), [
    blockSel,
    program,
  ] as const);
}

/** Screenshot the reconstruction block inside the sandboxed srcdoc frame
 *  (CDP reaches into `sandbox=""` — pinned in the prototype gate §4.1). */
function reconShot(page: Page): Promise<Buffer> {
  return page
    .frameLocator("#onlay-fidelity-frame")
    .locator("[data-oc-block]")
    .screenshot({ timeout: 15000 });
}

/** The reconstruction frame is fixed at top-left (on-screen so its element
 *  screenshot stabilizes); remove it before any post-render LIVE screenshot so
 *  it never occludes the live block (variant spot checks screenshot live last). */
function removeFrame(page: Page): Promise<void> {
  return page.evaluate(() => document.getElementById("onlay-fidelity-frame")?.remove());
}

function logActual(label: string, cmp: ReturnType<typeof comparePngs>): void {
  // Recorded so the [S1-DECISION R9] starting thresholds can be tightened.
  console.log(
    `[fidelity] ${label}: mismatch=${(cmp.mismatchRatio * 100).toFixed(3)}% ssim=${cmp.ssim.toFixed(4)} box=${cmp.width}x${cmp.height}`,
  );
}

// ── Original-fidelity fixtures ────────────────────────────────────────────
const ORIGINAL_FIXTURES: Array<{ id: string; file: string; block: string }> = [
  { id: "a-marketing-hero", file: "a-marketing-hero.html", block: "#hero" },
  { id: "b-web-components", file: "b-web-components.html", block: "#frame" },
  { id: "c-class-variant", file: "c-class-variant.html", block: "#panel" },
  { id: "d-tall-block", file: "d-tall-block.html", block: "#tall" },
  { id: "e-pseudo-theme", file: "e-pseudo-theme.html", block: "#card" },
];

for (const fx of ORIGINAL_FIXTURES) {
  test(`Original fidelity — ${fx.id}`, async ({ page }, testInfo) => {
    await loadFixture(page, fx.file);
    const live = await page.locator(fx.block).screenshot({ timeout: 15000 });
    const report = await renderInPage(page, fx.block);
    const recon = await reconShot(page);
    const cmp = comparePngs(live, recon);
    logActual(fx.id, cmp);
    await testInfo.attach(`${fx.id}-live.png`, { body: live, contentType: "image/png" });
    await testInfo.attach(`${fx.id}-recon.png`, { body: recon, contentType: "image/png" });
    await testInfo.attach(`${fx.id}-diff.png`, { body: cmp.diffPng, contentType: "image/png" });

    // The srcdoc is a self-contained, scriptless, offline reconstruction.
    expect(report.srcdoc).toContain("default-src 'none'");
    expect(report.srcdoc).toContain("oc-base");
    expect(report.srcdoc.toLowerCase()).not.toContain("<script");

    // [S1-DECISION R9] starting thresholds (a/b/d/e: ≤2.0% AND ssim ≥0.98).
    expect(cmp.mismatchRatio, `${fx.id} mismatch ratio`).toBeLessThanOrEqual(0.02);
    expect(cmp.ssim, `${fx.id} ssim`).toBeGreaterThanOrEqual(0.98);
  });
}

// ── Inverted fixture f: the grade MUST lower ───────────────────────────────
test("Inverted — canvas/JS fidelity MUST lower (a meter that can't fail is a disclaimer)", async ({
  page,
}, testInfo) => {
  await loadFixture(page, "f-canvas-inverted.html");
  const live = await page.locator("#viz").screenshot();
  const report = await renderInPage(page, "#viz");
  const recon = await reconShot(page);
  const cmp = comparePngs(live, recon);
  logActual("f-canvas-inverted", cmp);
  await testInfo.attach("f-live.png", { body: live, contentType: "image/png" });
  await testInfo.attach("f-recon.png", { body: recon, contentType: "image/png" });

  const exceededThreshold = cmp.mismatchRatio > 0.02 || cmp.ssim < 0.98;
  // A canvas/JS block that somehow passed the threshold would be the meter
  // failing silently — the test fails if fidelity looks too good.
  expect(
    report.captureResidue.includes("canvas-video-content") || exceededThreshold,
    `canvas fidelity should be honest: residue=${report.captureResidue.join(",")} mismatch=${cmp.mismatchRatio}`,
  ).toBe(true);
  expect(report.captureResidue, "canvas must be metered").toContain("canvas-video-content");
});

// ── Hostile fixture g: zero egress + no script execution ──────────────────
test("Hostile — zero egress + no script execution in the reconstruction", async ({
  page,
}, testInfo) => {
  const canaryHits: Array<{ url: string; frame: string | undefined }> = [];
  await page.route("**/canary.invalid/**", async (route) => {
    canaryHits.push({ url: route.request().url(), frame: route.request().frame()?.url() });
    await route.abort();
  });

  await loadFixture(page, "g-hostile.html");
  const report = await renderInPage(page, "#card");
  await testInfo.attach("g-srcdoc.html", { body: report.srcdoc, contentType: "text/html" });

  // Belt: the built srcdoc carries no external reference and no active content.
  expect(report.srcdoc).not.toContain("canary.invalid");
  expect(report.srcdoc.toLowerCase()).not.toContain("<script");
  expect(report.srcdoc).toContain("default-src 'none'");
  // The external beacons were stripped + metered (placeholders and/or scrub).
  expect(report.residue.strippedPlaceholders + report.residue.strippedUrls).toBeGreaterThan(0);

  // Suspenders: the mounted sandbox="" frame carries no tokens.
  const sandboxAttr = await page.locator("#onlay-fidelity-frame").getAttribute("sandbox");
  expect(sandboxAttr).toBe("");

  // Give any (forbidden) reconstruction-frame beacon a chance to fire.
  await page.waitForTimeout(400);
  // The live page's own beacons are EXPECTED (it is a real hostile page) — they
  // prove the interception is live. Zero may originate from the srcdoc frame.
  const fromRecon = canaryHits.filter((h) => (h.frame ?? "").includes("srcdoc"));
  expect(canaryHits.length, "live hostile page must actually attempt egress").toBeGreaterThan(0);
  expect(fromRecon, "reconstruction frame must make ZERO external requests").toEqual([]);
});

// ── Variant-truth spot checks (per op kind) ────────────────────────────────
test("Variant — setClass on a light-DOM utility class MATCHES with authorsheet", async ({
  page,
}, testInfo) => {
  await loadFixture(page, "c-class-variant.html");
  const program: Program = [{ op: "setClass", target: "#cta", add: ["btn--brand"], remove: [] }];

  const report = await renderInPage(page, "#panel", program);
  const recon = await reconShot(page);
  await removeFrame(page);
  const tally = await page.evaluate(([prog]) => window.__onlayFidelity.applyLive("#panel", prog), [
    program,
  ] as const);
  const live = await page.locator("#panel").screenshot();

  const cmp = comparePngs(live, recon);
  logActual("c-setClass-variant", cmp);
  await testInfo.attach("c-variant-live.png", { body: live, contentType: "image/png" });
  await testInfo.attach("c-variant-recon.png", { body: recon, contentType: "image/png" });

  expect(tally.applied, "live op applied").toBeGreaterThanOrEqual(1);
  expect(report.residue.applied, "reconstruction op applied").toBeGreaterThanOrEqual(1);
  expect(report.residue.authorRulesMissing, "author rule covered → no honest note").toBe(false);
  // fixture c (author-rule cascade): ≤3.0% AND ssim ≥0.97
  expect(cmp.mismatchRatio).toBeLessThanOrEqual(0.03);
  expect(cmp.ssim).toBeGreaterThanOrEqual(0.97);
});

test("Variant — setStyle beats the base sheet via inline specificity (always faithful)", async ({
  page,
}, testInfo) => {
  await loadFixture(page, "c-class-variant.html");
  const program: Program = [
    {
      op: "setStyle",
      target: "#cta",
      props: [{ prop: "background-color", value: "rgb(16, 185, 129)" }],
    },
  ];
  const report = await renderInPage(page, "#panel", program);
  const recon = await reconShot(page);
  await removeFrame(page);
  await page.evaluate(([prog]) => window.__onlayFidelity.applyLive("#panel", prog), [
    program,
  ] as const);
  const live = await page.locator("#panel").screenshot();
  const cmp = comparePngs(live, recon);
  logActual("c-setStyle-variant", cmp);
  await testInfo.attach("c-setStyle-recon.png", { body: recon, contentType: "image/png" });
  expect(report.residue.applied).toBeGreaterThanOrEqual(1);
  expect(cmp.mismatchRatio).toBeLessThanOrEqual(0.03);
  expect(cmp.ssim).toBeGreaterThanOrEqual(0.97);
});

test("Variant — setText replaces block text faithfully", async ({ page }) => {
  await loadFixture(page, "c-class-variant.html");
  const program: Program = [{ op: "setText", target: "#cta", text: "Start free trial" }];
  const report = await renderInPage(page, "#panel", program);
  const recon = await reconShot(page);
  await removeFrame(page);
  await page.evaluate(([prog]) => window.__onlayFidelity.applyLive("#panel", prog), [
    program,
  ] as const);
  const live = await page.locator("#panel").screenshot();
  const cmp = comparePngs(live, recon);
  logActual("c-setText-variant", cmp);
  expect(report.residue.applied).toBeGreaterThanOrEqual(1);
  expect(cmp.mismatchRatio).toBeLessThanOrEqual(0.03);
});

test("Variant — shadow-scoped setClass raises the honest note (no silent lie)", async ({
  page,
}) => {
  await loadFixture(page, "b-web-components.html");
  // ':host(.brand)' lives in the badge's shadow adoptedStyleSheet — excluded
  // from the document authorsheet (D14), so toggling it must raise the note.
  const program: Program = [{ op: "setClass", target: "wa-badge", add: ["brand"], remove: [] }];
  const report = await renderInPage(page, "#frame", program);
  expect(report.residue.authorRulesMissing, "shadow-scoped class → honest note").toBe(true);
});

// ── KNOWN capture-engine defect (surfaced by this gate) ───────────────────
// `-webkit-text-fill-color` takes precedence over `color` when painting text, so
// emitting it into `oc-base` whenever it merely equals `color` would silently
// shadow ANY text-color variant — a `.btn--brand{color}` author rule OR a
// `setStyle` on `color` — the reconstruction keeping the stale color while the
// live page changes it (render §1.4 non-negotiable). The walker now suppresses
// `-webkit-text-fill-color` when it equals the node's `color` (allowlist/curate),
// so a `setStyle color:#fff` repaints faithfully and this diffs near-zero.
test("text-color change reconstructs faithfully (not shadowed by text-fill-color)", async ({
  page,
}) => {
  await loadFixture(page, "c-class-variant.html");
  const program: Program = [
    { op: "setStyle", target: "#cta", props: [{ prop: "color", value: "rgb(255, 255, 255)" }] },
  ];
  const report = await renderInPage(page, "#panel", program);
  const recon = await reconShot(page);
  await removeFrame(page);
  await page.evaluate(([prog]) => window.__onlayFidelity.applyLive("#panel", prog), [
    program,
  ] as const);
  const live = await page.locator("#panel").screenshot();
  const cmp = comparePngs(live, recon);
  logActual("c-setStyle-color-DEFECT", cmp);
  // A faithful color change would be near-perfect (only the text pixels move,
  // and they must match). Currently fails: the reconstruction text stays dark.
  expect(report.residue.applied).toBeGreaterThanOrEqual(1);
  expect(cmp.mismatchRatio, "text color change must reconstruct faithfully").toBeLessThanOrEqual(
    0.001,
  );
});

// ── Custom-element op targeting (F10) ──────────────────────────────────────
test("Custom-element op targets by real tag (D10 — resolves, not a miss)", async ({ page }) => {
  await loadFixture(page, "b-web-components.html");
  const program: Program = [
    { op: "setStyle", target: "wa-card", props: [{ prop: "outline", value: "3px solid red" }] },
  ];
  const report = await renderInPage(page, "#frame", program);
  // capture D10 serializes custom elements under their real localName, so the op
  // resolves against <wa-card> in the flattened tree.
  expect(report.residue.applied, "wa-card op resolved").toBeGreaterThanOrEqual(1);
  expect(report.residue.misses, "no miss under the generic outside-scope note").toBe(0);
});

// ── Non-contamination (A25) ────────────────────────────────────────────────
// A `setClass` variant resolved through the authorsheet must repaint ONLY its
// target: the region of the reconstruction frame OUTSIDE the op's target box must
// diff ≈ the Original frame. This catches habitat truncation shifting
// `:nth-child`/sibling matches, or shadow-sheet leakage restyling untouched nodes
// (render §4.3 — "the authorsheet resolves the toggle without repainting the
// world").
test("Non-contamination — a setClass variant repaints only its target (A25)", async ({
  page,
}, testInfo) => {
  await loadFixture(page, "c-class-variant.html");

  // Settle the reconstruction frame (a paint) before each screenshot — back-to-
  // back renders can otherwise race the frame's text paint.
  const settleFrame = async (): Promise<void> => {
    const block = page.frameLocator("#onlay-fidelity-frame").locator("[data-oc-block]");
    await block.waitFor({ state: "visible" });
    await page.waitForTimeout(150);
    await block.screenshot(); // warmup — force the sandboxed frame to paint text
    await page.waitForTimeout(150);
  };

  // Compare TWO variant-mode renders (both carry the authorsheet — Original mode
  // omits it, so an Original-vs-variant diff would flag the authorsheet itself,
  // not contamination). Baseline: a no-op setClass adding the class #cta already
  // has. Variant: the real `btn--brand` toggle. Only #cta differs.
  const noop: Program = [{ op: "setClass", target: "#cta", add: ["btn"], remove: [] }];
  const program: Program = [{ op: "setClass", target: "#cta", add: ["btn--brand"], remove: [] }];

  // Warmup: the first cold render of a sandboxed frame can skip the heading's
  // text paint (font not yet warm); render once and discard so both MEASURED
  // renders below are warm and deterministic.
  await renderInPage(page, "#panel", noop);
  await settleFrame();

  await renderInPage(page, "#panel", noop);
  await settleFrame();
  const orig = await reconShot(page);

  const report = await renderInPage(page, "#panel", program);
  expect(report.residue.applied, "setClass applied").toBeGreaterThanOrEqual(1);
  await settleFrame();
  const variant = await reconShot(page);

  // The target box, relative to the reconstruction block's top-left.
  const frame = page.frameLocator("#onlay-fidelity-frame");
  const blockBox = await frame.locator("[data-oc-block]").boundingBox();
  const targetBox = await frame.locator("#cta").boundingBox();
  if (!blockBox || !targetBox) throw new Error("A25: missing block/target box");
  const pad = 6; // cover the target's own repaint + AA halo
  const rect = {
    x: targetBox.x - blockBox.x - pad,
    y: targetBox.y - blockBox.y - pad,
    width: targetBox.width + pad * 2,
    height: targetBox.height + pad * 2,
  };

  const maskedOrig = maskRect(orig, rect);
  const maskedVariant = maskRect(variant, rect);
  const cmp = comparePngs(maskedOrig, maskedVariant);
  logActual("c-A25-noncontamination", cmp);
  await testInfo.attach("A25-orig.png", { body: maskedOrig, contentType: "image/png" });
  await testInfo.attach("A25-variant.png", { body: maskedVariant, contentType: "image/png" });
  await testInfo.attach("A25-diff.png", { body: cmp.diffPng, contentType: "image/png" });

  // Outside the target box, Original and variant must be pixel-identical (only
  // an AA-gutter's worth of drift is tolerable).
  expect(cmp.mismatchRatio, "non-target region unchanged by the variant").toBeLessThanOrEqual(
    0.002,
  );
});
