---
name: onlay-brand
description: "Generate anything on-brand for Onlay — product UI, HTML/CSS/JS artifacts, prototypes, docs, slides, blogs, copy, or production code. Contains the Onlay brand strategy and messaging, voice with per-context registers, design tokens, component library, real assets, and a portable brand card, and refines its showcase live through the current Onlay product. This skill is a LIVING design system: reuse its components before building new ones, and absorb good new work back into it. Invoke when building anything that should look, read, or behave like Onlay."
---

You are working in the **Onlay** brand. This skill is the source of truth for
how Onlay looks, sounds, and behaves — and it is a LIVING design system:
it grows as good work is absorbed back into it.

**Where this lives, who owns it.** This kit is PROJECT-LOCAL by design
(`.claude/skills/onlay-brand/`, committed with the repo): brand truth
belongs to and travels with the project, and its history is the project's
git history. The `-brand` name suffix is the discovery convention — fleet
agents whose work depends on brand context carry a `*-brand` skill
permission and find this kit automatically when working in this project.
The kit's identity belongs to the MAKER (the project's owner): any agent may
propose, only the maker commits identity changes.

## Read first
- `index.html` — **open this first**: the brand at a glance (palette, type,
  components, sample surface, voice, and the brand's signature moments),
  rendered from the tokens.
- `readme.md` — the brand guidelines: who Onlay is (strategy), messaging,
  voice & registers, visual foundations, signature elements, the
  non-negotiables, and the manifest & changelog.
- `styles.css` — link this one file to inherit every Onlay token.
- `tokens/` — the CSS custom properties. Use them; never invent new hues,
  fonts, or scales.
- `components/` — the component library. **Reuse before rebuild**: check here
  before authoring any UI element from scratch.
- `assets/` — real logos, fonts, icons, illustrations, signature-element
  stand-ins. Copy them out; never redraw a logo or hand-roll an icon.
- `brand-card.md` — portable brand values (hex, faces, scale) AND the Pantone
  print mapping with the brand's print posture, for surfaces where CSS
  doesn't reach.

## Make something on-brand
- **Product UI & visual artifacts** (apps, mocks, prototypes, pages, slides):
  start from `components/` — compose and extend existing components; write
  HTML/CSS/JS that links `styles.css`; follow the visual foundations; honor the
  non-negotiables and play inside the flexible zones. When a surface implies
  imagery, ship imagery (real assets or verified stock — never a colored div
  where a photo belongs, never an unverified URL), with alt text written in the
  Onlay voice.
- **Written content** (docs, blogs, announcements, emails, UI copy, support
  replies): build on the MESSAGING house (value proposition, pillars, proof —
  never invent new claims), write in the Onlay voice using the REGISTER
  that fits the context (marketing / product UI / docs / support), and use the
  LEXICON (our terms, our casing, our banned words).
- **Non-web surfaces** (print, decks in native formats, documents): pull values
  from `brand-card.md` — the portable equivalents of the tokens, including the
  Pantone codes + print posture. For any NEW color, match it with
  `npx -y pantone-cli match "#hex" --json` — never guess Pantone codes from
  memory (matching is CIEDE2000 approximation; verify production-critical
  color against a physical guide).
- **Production code**: read the rules here and apply the tokens to match Onlay.

## Grow the design system (absorb)
When work you've built contains something reusable — a component, a widget, a
pattern, a surface — offer to absorb it:
1. **Distill** it into `components/{name}.html` (or `components/{group}/{name}.html`)
   — a self-contained specimen linking `styles.css`, showing key states/variants.
2. **Tag** it: first line `<!-- @component name="..." group="..." desc="..." origin="absorbed" -->`.
3. **Purify** it: every value from a token (no raw hex where a token exists),
   canonical HTML, copy checked against the voice, named per the lexicon.
4. **Register** it: add a line to readme.md's Manifest & changelog (name — group
   — one line — date).
5. **Reflect** it: if it's a core primitive, refresh its specimen in index.html's
   components section.

Absorb rules: absorb what EXPRESSES the identity, not one-off content; prefer
refining an existing component over adding a near-duplicate; anything that would
CHANGE the identity (a new hue, a new face) is a token/guidelines decision for
the maker first — never a side effect of absorption.

**Composition repairs the kit — surface the gaps, don't swallow them.** When
building a real artifact reveals a PRIMITIVE the kit lacks — a type tier, a
theme commitment, a motif missing from the signature language, a spacing step
every layout reached for — that discovery is a first-class outcome, not a
workaround to bury in the artifact. PROPOSE it to the maker explicitly; on
acceptance, land it in tokens/ + the readme and log it in the changelog. The
identity-change rule above governs WHO decides — it never means the gap goes
unreported. (This kit's display tier, theme commitment, and micro/kbd motifs
all entered exactly this way.)

## Edit it live (Onlay)
Refine the showcase with the current **Onlay** product. Serve the kit
statically (`python3 -m http.server` from this dir), open `index.html` (or
`logo-lab.html`) in the browser, and use the current **Onlay** interaction skill
for setup, identity, and interaction commands. That skill is dogfooding
infrastructure, not the source of brand language; this kit's `readme.md` is the
brand source of truth. The human points at any element and requests a change; you make it
on-brand from THESE tokens/components (on-brand by construction); Onlay never
writes source — YOU implement it.
- `index.html` is a **static** page (no HMR): implement a change by editing the
  HTML and `tokens/` directly, then refresh to verify.
- **Keep the guide true**: tokens are the truth for VALUES, readme.md is the
  truth for INTENT — if a change contradicts the readme's prose, update the prose
  (and log it in the changelog).

**If invoked with no guidance, take stock before asking.** This system knows its
own state — read it and lead with the 2-3 highest-value next actions, each with
a one-line reason, then ask what to build:
- readme.md's Manifest & changelog: how stale is the last entry? Anything
  absorbed but unregistered?
- `components/`: thin or missing groups (no forms? no feedback components?)
  relative to what the brand ships.
- `brand-card.md`: Pantone block unfilled, or print posture undecided?
- `index.html`: does the showcase still match the tokens and components, or has
  the kit outgrown its self-portrait?
- Refining index.html live with Onlay is always on the menu when the user wants
  to iterate visually.
Then act as an expert Onlay designer-writer who outputs on-brand artifacts
or production code.
