// The onlay design tokens (the brand's value truth, defined here) in the extension's two rendering contexts:
//
//   OVERLAY — the Shadow-DOM chrome riding arbitrary pages. Dark-committed,
//   px-based type (rem inside a shadow root resolves against the HOST page's
//   root font size, which varies by site), and system-stack fonts only:
//   @font-face cannot reach a shadow adopted sheet and page CSP may block
//   font loads, so the overlay wears the brand's FALLBACK stacks by design.
//
//   PAGES — extension-owned documents (popup, options, interaction view).
//   Self-hosted IBM Plex, rem-based type, dark by default with a light theme
//   available via [data-theme] or the OS preference.
//
// Values are the brand's (seed #0098A6). The web app's `tokens.css` and the
// landing page's `site.css` carry the same values; change all three together
// (src/ui/tokens.test.ts pins the web app's copy to this one).

/* ── color ramps (OKLCH, generated from seed #0098A6) ─────────────── */

const RAMP_VARS = `
  --color-primary-50: oklch(96% 0.0422 206.3);
  --color-primary-100: oklch(92.97% 0.0634 206.3);
  --color-primary-200: oklch(87.42% 0.0768 206.3);
  --color-primary-300: oklch(80.24% 0.1276 206.3);
  --color-primary-400: oklch(74.74% 0.1307 206.3);
  --color-primary-500: oklch(74.69% 0.1349 206.3);
  --color-primary-600: oklch(51.53% 0.1147 206.3);
  --color-primary-700: oklch(42.23% 0.0956 206.3);
  --color-primary-800: oklch(34.38% 0.0778 206.3);
  --color-primary-900: oklch(28.32% 0.0641 206.3);
  --color-primary-950: oklch(25% 0.0566 206.3);
  --color-neutral-50: oklch(99.24% 0 0);
  --color-neutral-100: oklch(97.71% 0.0024 192.1);
  --color-neutral-200: oklch(93.13% 0.0089 198);
  --color-neutral-300: oklch(85.26% 0.0171 203.9);
  --color-neutral-400: oklch(74.12% 0.0249 209.9);
  --color-neutral-500: oklch(59.77% 0.0301 215.6);
  --color-neutral-600: oklch(45.16% 0.0315 220.9);
  --color-neutral-700: oklch(33.42% 0.0303 225.4);
  --color-neutral-800: oklch(24.8% 0.0274 228.9);
  --color-neutral-900: oklch(19.45% 0.025 231.1);
  --color-neutral-950: oklch(17.11% 0.0282 229.7);
  --color-success: oklch(62% 0.15 150);
  --color-warning: oklch(75% 0.15 80);
  --color-danger: oklch(58% 0.2 27);
  --color-info: oklch(62% 0.14 250);
`;

/* ── interaction grammar: Comment teal · Ask amber · Edit green ───── */

const KIND_VARS = `
  --kind-comment: var(--color-primary-400);
  --kind-comment-strong: var(--color-primary-600);
  --kind-comment-soft: color-mix(in oklch, var(--kind-comment) 16%, transparent);
  --kind-ask: var(--color-warning);
  --kind-ask-strong: oklch(62% 0.14 80);
  --kind-ask-soft: color-mix(in oklch, var(--kind-ask) 16%, transparent);
  --kind-edit: var(--color-success);
  --kind-edit-strong: oklch(48% 0.13 150);
  --kind-edit-soft: color-mix(in oklch, var(--kind-edit) 16%, transparent);
  --attention-routine: var(--primary);
  --attention-careful: var(--color-warning);
  --attention-dangerous: var(--color-danger);
`;

/* ── semantic aliases ─────────────────────────────────────────────── */

/* Dark chrome reads better slightly looser (the dark theme's values). Applied AFTER
   the type vars so the override wins in the cascade. */
const DARK_TYPE_METRICS = `
  --leading-normal: 1.6;
  --tracking-normal: 0.005em;
`;

const ALIAS_DARK = `
  --background: var(--color-neutral-950);
  --foreground: var(--color-neutral-100);
  --card: var(--color-neutral-900);
  --card-foreground: var(--color-neutral-100);
  --popover: var(--color-neutral-900);
  --popover-foreground: var(--color-neutral-100);
  --muted: var(--color-neutral-900);
  --muted-foreground: var(--color-neutral-400);
  --primary: var(--color-primary-400);
  --primary-foreground: var(--color-neutral-950);
  --accent: var(--color-primary-400);
  --accent-foreground: var(--color-neutral-950);
  --border: var(--color-neutral-800);
  --input: var(--color-neutral-800);
  --ring: var(--color-primary-400);
`;

const ALIAS_LIGHT = `
  --leading-normal: 1.55;
  --tracking-normal: 0;
  --background: var(--color-neutral-50);
  --foreground: var(--color-neutral-900);
  --card: var(--color-neutral-100);
  --card-foreground: var(--color-neutral-900);
  --popover: var(--color-neutral-50);
  --popover-foreground: var(--color-neutral-900);
  --muted: var(--color-neutral-100);
  --muted-foreground: var(--color-neutral-500);
  --primary: var(--color-primary-500);
  --primary-foreground: var(--color-neutral-50);
  --accent: var(--color-primary-500);
  --accent-foreground: var(--color-neutral-50);
  --border: var(--color-neutral-200);
  --input: var(--color-neutral-200);
  --ring: var(--color-primary-500);
`;

/* ── effects: outline-first, dark-chrome depth, orienting motion ──── */

const EFFECT_VARS = `
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius: 8px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;
  --shadow-sm: 0 2px 10px rgba(0, 18, 25, 0.26);
  --shadow: 0 8px 28px rgba(0, 18, 25, 0.32);
  --shadow-lg: 0 18px 52px rgba(0, 18, 25, 0.42);
  --ring-hairline: 0 0 0 1px color-mix(in oklch, var(--ring) 36%, transparent);
  --ring-focus: 0 0 0 3px color-mix(in oklch, var(--ring) 32%, transparent);
  --glow-signal: 0 0 24px color-mix(in oklch, var(--primary) 28%, transparent);
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --duration-fast: 120ms;
  --duration: 180ms;
  --duration-slow: 280ms;
`;

/* ── type ─────────────────────────────────────────────────────────── */

// The brand fallback stacks ARE the overlay faces (see module comment).
const FONT_STACK_SANS = `"IBM Plex Sans", "Aptos", "Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, sans-serif`;
const FONT_STACK_SANS_FALLBACK = `"Aptos", "Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, sans-serif`;
const FONT_STACK_MONO = `"IBM Plex Mono", "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace`;
const FONT_STACK_MONO_FALLBACK = `"SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace`;

const TYPE_SHARED = `
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;
  --leading-tight: 1.15;
  --leading-normal: 1.55;
  --tracking-tight: -0.015em;
  --tracking-normal: 0;
  --tracking-wide: 0.02em;
  --tracking-caps: 0.08em;
`;

// Shadow-DOM-safe px scale, instrument-panel dense (12–13px rows).
const TYPE_VARS_OVERLAY = `
  --font: ${FONT_STACK_SANS_FALLBACK};
  --mono: ${FONT_STACK_MONO_FALLBACK};
  --text-xs: 11px;
  --text-sm: 12px;
  --text-base: 13px;
  --text-md: 16px;
  --text-lg: 19px;
  ${TYPE_SHARED}
`;

// Extension documents own their root: rem scale, self-hosted Plex.
const TYPE_VARS_PAGE = `
  --font: ${FONT_STACK_SANS};
  --mono: ${FONT_STACK_MONO};
  --text-xs: 0.75rem;
  --text-sm: 0.833rem;
  --text-base: 1rem;
  --text-md: 1.2rem;
  --text-lg: 1.44rem;
  --text-xl: 1.728rem;
  ${TYPE_SHARED}
`;

/* ── composed exports ─────────────────────────────────────────────── */

/** Custom-property block for the overlay's `:host` — dark by default. */
export const OVERLAY_TOKEN_BLOCK = [
  RAMP_VARS,
  ALIAS_DARK,
  KIND_VARS,
  EFFECT_VARS,
  TYPE_VARS_OVERLAY,
  DARK_TYPE_METRICS,
].join("\n");

/**
 * The light alias set for the overlay's theme override blocks (the light
 * theme's values) — ramps/kinds/effects/type are theme-independent and
 * stay on `:host`.
 */
export const OVERLAY_LIGHT_ALIAS_BLOCK = ALIAS_LIGHT;

/**
 * tokens.css for extension pages (popup/options/interaction view): dark is
 * the brand default; the OS light preference and an explicit
 * [data-theme="light"] both get the light aliases; [data-theme="dark"] wins
 * back. Ramps/kinds/effects are theme-independent.
 */
export const PAGE_TOKENS_CSS = `:root {
${RAMP_VARS}
${ALIAS_DARK}
${KIND_VARS}
${EFFECT_VARS}
${TYPE_VARS_PAGE}
${DARK_TYPE_METRICS}
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root { ${ALIAS_LIGHT} color-scheme: light; }
}
:root[data-theme="light"] { ${ALIAS_LIGHT} color-scheme: light; }
:root[data-theme="dark"] { ${ALIAS_DARK} ${DARK_TYPE_METRICS} color-scheme: dark; }
`;

/** @font-face file for extension pages; assets/ is copied beside it. */
export const FONTS_CSS = [
  ["IBM Plex Sans", "IBMPlexSans-Regular.woff2", 400],
  ["IBM Plex Sans", "IBMPlexSans-Medium.woff2", 500],
  ["IBM Plex Sans", "IBMPlexSans-SemiBold.woff2", 600],
  ["IBM Plex Mono", "IBMPlexMono-Regular.woff2", 400],
  ["IBM Plex Mono", "IBMPlexMono-Medium.woff2", 500],
  ["IBM Plex Mono", "IBMPlexMono-SemiBold.woff2", 600],
]
  .map(
    ([family, file, weight]) => `@font-face {
  font-family: "${family}";
  src: url("assets/fonts/${file}") format("woff2");
  font-weight: ${weight};
  font-style: normal;
  font-display: swap;
}`,
  )
  .join("\n");

/* ── the mark ─────────────────────────────────────────────────────── */

/**
 * THE mark, inlined for the orb and page
 * headers: one drawing at every size. The boundary ring is onlay's layer,
 * broken where an agent waits; the loose signal holds the break; the
 * anchored point reaches toward it — that reach is Anchor.
 */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true">
  <path d="M 357.3 100 A 186 186 0 1 0 431.9 195.4" fill="none" stroke="#007886" stroke-width="34" stroke-linecap="round"/>
  <circle cx="403" cy="141" r="32" fill="#007886"/>
  <circle cx="256" cy="256" r="118" fill="none" stroke="#00C4D7" stroke-width="30"/>
  <path d="M 229 277 L 325 202" fill="none" stroke="#00C4D7" stroke-width="20" stroke-linecap="round"/>
  <circle cx="229" cy="277" r="36" fill="#00C4D7"/>
</svg>`;
