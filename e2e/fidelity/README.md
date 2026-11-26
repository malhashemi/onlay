# Stage-1 fidelity gate (`test:fidelity`)

The portable-visual-truth gate (render spec §4). Run it with:

```
bun run test:fidelity            # from repo root
# or: cd e2e && bunx playwright test -c playwright.fidelity.config.ts
```

It is a **separate Playwright project** from the smoke set: its own
config (`e2e/playwright.fidelity.config.ts`, `testDir: fidelity`), ephemeral
localhost ports only (no onlay server), `deviceScaleFactor: 1` + a fixed viewport
so font-rasterizer/subpixel variance is eliminated, and one Chromium rasterizing
both the live block and the reconstruction.

## What it proves (green today)

For each fixture it runs the **REAL landed engines** — `walk()` (capture spec
§1–§2) → `buildSrcdoc()` (render spec §1) → a `sandbox=""` srcdoc frame — and
diffs the reconstruction `[data-oc-block]` against the live block with
`pixelmatch` + `ssim.js`.

| fixture | proves | actual |
|---|---|---|
| a marketing hero | custom props, layered gradients, data: raster, brand button travel | 0.000% / ssim 0.9995 |
| b web components | open shadow + adoptedStyleSheets + slots flattened via the composed tree | 0.000% / ssim 1.000 |
| c class-variant | `setClass` on a light-DOM `.btn--brand` resolves via the appended authorsheet | 0.000% / ssim 1.000 |
| d tall block | a hero taller than the viewport reconstructs whole | 0.000% / ssim 0.9997 |
| e pseudo/theme | `::before`/`::after` incl. `content:url()`, `html[data-theme=dark]` state | 0.000% / ssim 1.000 |
| f canvas (inverted) | fidelity MUST lower + `canvas-video-content` metered | 66.4% / ssim 0.45 ✓ |
| g hostile | zero egress from the frame, no `<script>`, external URLs stripped+metered, `sandbox=""` | zero recon egress ✓ |

Plus variant-truth spot checks (`setClass` match + `authorRulesMissing=false`;
`setStyle` inline-specificity match; `setText`; shadow-scoped `setClass` raises
the honest note; custom-element op targets by real tag with `applied≥1, misses=0`)
and the **non-contamination (A25)** region diff: a `setClass` variant repaints
ONLY its target — the frame region outside the op's box diffs the baseline
variant at **0.000%** (the authorsheet resolves the toggle without repainting the
world).

## Capture-engine defect this gate surfaced (now fixed)

This gate surfaced a real capture-side defect: the walker emitted
`-webkit-text-fill-color` (in `CAPTURE_STYLE_PROPS`) into `oc-base`
unconditionally. Because it takes precedence over `color` in text painting, **any
variant that changes text color** — a `.btn--brand{color}` author rule or a
`setStyle` on `color` — was silently shadowed by the stale base value (the change
never painted). The walker now suppresses `-webkit-text-fill-color` whenever it
equals the node's computed `color`, keeping it only for genuine text-stroke
effects (`overlay/capture/walker.ts` `curate`/`pseudo`). The gate test
`text-color change reconstructs faithfully` now passes at **0.000% mismatch**.

## Not covered here

The end-to-end capture round-trip (pick → Edit → witness → harvest → upload →
commit → the full view's render) ran against the old local broker and was
removed with it (ADR-0024). Its pure legs stay unit-pinned in
`packages/extension/src/overlay/capture/{witness,harvest,upload}.test.ts`.

Not reachable through the current walk path: SVG `fill`/`stroke` paint (not in the
~90-prop allowlist), so the render-time scrub's fragment-url allowlist
(`url(#grad)`, A19) is covered by the renderer's `scrub` unit tests, not here.
