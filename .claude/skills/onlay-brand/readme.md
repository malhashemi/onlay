# Onlay — Brand Guidelines

The source of truth for how **Onlay** looks, sounds, and behaves. Link
`styles.css` to inherit the tokens; read this guide for the rules; check
`components/` before building UI from scratch. The chain this document serves:
*strategy decides who the brand is; identity makes it legible; these guidelines
make it reproducible.* Every rule below carries a one-line reason — rules with
reasons survive; bare rules get re-litigated.

## Who we are (brand strategy)

**Primary audience.** Onlay is for builders and teams working with doing-agents who need human judgment to happen in the right context: sometimes in a disciplined Inbox, often directly on the page being judged. The first buyer is the maker/operator already using coding agents, browser-based review surfaces, and local development loops; Onlay chooses this audience over generic web annotation users.

**Category / frame of reference.** Onlay is a browser-resident human↔agent interaction layer. It is not a browser annotation tool, not an agent chat app, not a design editor, and not a source-code writer. The extension is the user-facing product; the CLI/server/harness adapters are the infrastructure that make the loop durable.

**Positioning.** Onlay owns the space between agent intent and human judgment. Other tools put agent work in terminals, chat panes, PR comments, or generic task queues; Onlay places the work where judgment belongs — anchored to the page when context exists, held in the Inbox when an agent needs context before it exists.

**Promise.** Onlay lets agents ask and humans answer, comment, anchor, and edit through any web page without pretending the browser is the source of truth. Human intent starts in context; agent requests can wait in the Inbox until a human places them.

**Proof.** The product already has Comment, Ask, and Edit as one visual grammar; server-computed attention; a draggable launcher and command bar; human/agent Actor identity; strict extension isolation; durable server state; and a confirmed product-model decision in DR-009: humans initiate anchored interactions, agents may initiate only unanchored Asks, and Anchor is the human action that places a live Ask onto a page/block.

**Personality.** Precise, calm, sovereign, infrastructural, and quietly magical. Onlay should feel like a disciplined layer of intent: it makes agent work visible and placeable without turning the page into a toy canvas or the Inbox into agent chatter.

**Mission.** Keep human judgment close to the work it governs.

**Values.** Context over transcript. Attention over notification spam. Human placement over agent presumption. Durable state over ephemeral chat. Honest previews over fake truth.

**Value pair.** Functionally, Onlay gives humans and agents a shared interaction surface across any page. Emotionally, it gives the maker control: nothing source-affecting starts floating loose, and nothing important disappears into a terminal scrollback.

## Messaging (the message house)

### Value proposition

Onlay keeps human judgment for agents where it belongs: in the Inbox when context is missing, on the page when context matters.

### Message pillars

1. **Context when it matters.** Pain: agent work often arrives detached from the thing being judged. Outcome: humans can answer in place, comment on the block, or Anchor an agent Ask to the right element. Proof: block/page commands, Anchor/re-anchor mechanics, typed `#` anchor tokens, and URL-bound interaction guards.
2. **Attention without spam.** Pain: agents and review tools compete for attention with noisy notifications. Outcome: Onlay shows only what needs you, what waits on others, and what recently resolved. Proof: server-computed attention, badge count, attention popup, stakes-aware asks, and durable outbox delivery.
3. **Three primitives, many workflows.** Pain: tools multiply special cases — review, question, change request, variant, approval — until users learn a new UI for every workflow. Outcome: Comment, Ask, and Edit compose the rest. Proof: a verdict is an Ask recipe (`onlay ask --wait` with options as data — the agent points at work in the human's world), Ask is the routed choice contract, and Edit owns the implementation loop with variants/manual batch as methods; Onlay hosts no pages of its own.
4. **Human placement, agent momentum.** Pain: agents need to ask, but unbounded agent posting turns into a feed. Outcome: agents may initiate only unanchored Asks; humans decide whether and where to Anchor them. Proof: DR-009 and the extension-first model: humans initiate anchored work; agents participate when routed or already in the interaction.

### Boilerplate

**One-liner.** Onlay is the browser extension where humans and agents ask, comment, anchor, and edit through any web page.

**~25 words.** Onlay gives coding agents and humans a shared web interaction layer: agent Asks land in an Inbox, human work starts on the page, and Anchor places context when it matters.

**~100 words.** Onlay is a human↔agent interaction layer built into the browser. Humans can comment, ask, and request edits directly on any page; agents can raise unanchored Asks when they need judgment before context exists; and the human-facing Anchor action places those Asks onto the right page or block. A server-backed attention model keeps needs-you, waiting, and resolved work durable across pages and harnesses. Onlay is not an annotation toy or an agent chat feed: it is a disciplined way to keep judgment, context, and agent momentum in the same loop.

### Elevator pitch

Agents need human judgment, but terminals and chat threads strip away the thing being judged. Onlay puts the judgment surface in the browser: humans start from the page, agents can ask from the Inbox, and Anchor brings loose questions into context when the human chooses where they belong.

### Tagline

**Put agent work where it belongs.**

Use it on high-level brand surfaces and the showcase. Do not use it as product UI microcopy; buttons stay concrete: Comment, Ask, Edit, Anchor.

### Audience variants

- **Solo maker / agent power user.** “Keep your agents moving without losing control of what they are asking you to judge.”
- **Team lead.** “Turn agent-human review loops into durable, routed interactions instead of scattered terminal, chat, and PR fragments.”
- **Harness / tooling builder.** “Give agents a web-native HITL surface with typed actors, attention, anchors, and durable delivery instead of inventing another notification path.”

## Voice & registers

### Tone

Precise, calm, direct, and situational. Onlay speaks like an instrument panel: it names what is waiting, where it belongs, and what the human can do next.

Reason: the product carries judgment and attention; hype or cuteness erodes trust.

### Personality in words

- **Situated.** Say where work belongs: Inbox, page, block, Anchor.
- **Disciplined.** Prefer small exact verbs over broad metaphors.
- **Sovereign.** The human decides; copy never implies agent presumption.
- **Quietly luminous.** Use vivid language sparingly, when context becomes visible.

### Person and energy

Use second person for human-facing product copy (“needs you”, “Anchor this Ask”). Use “Onlay” as the product subject in docs and brand copy. Avoid first-person product voice except in agent-authored messages where the agent is the speaker.

Reason: the product is a layer, not a character competing with the agent or human.

### Registers

**Marketing / brand-facing.** Promise-forward, concrete, no grand AI claims.

Example: “Put agent work where it belongs: answer from the Inbox, Anchor it to the page, or edit the thing in context.”

**Product UI.** Short, stateful, action-first. Labels should name the exact action.

Example: “Anchor Ask” · “2 need you” · “Ask waiting on Sara” · “Edit block”.

**Docs / technical.** Exact and boundary-aware. Name internal terms when they matter; separate user-facing labels from wire/model names.

Example: “The UI label is Edit; the protocol kind remains `change`.”

**Support & errors.** Calm cause + next action. No blame, no jokes.

Example: “Anchor not found on this page. Pick a new block to re-anchor it.”

### Lexicon

**Use**

- **Comment** — words on a page/block or interaction thread.
- **Ask** — the routed choice primitive; use “question” only as casual prose, not UI label.
- **Edit** — user-facing third interaction; internal model/wire may say `change`.
- **Anchor** — human-facing verb for attaching a live unanchored Ask to a page/block; also the resulting location in model prose when needed.
- **Captured anchor content** — technical/docs phrase for the existing CLI behavior that fetches sanitized page structure behind an anchored interaction. Do not confuse this with the human-facing **Anchor** action.
- **Inbox** — the home for unanchored Asks and cross-page attention.
- **needs you** — attention copy; concrete and personal.
- **block** — user-facing page unit; avoid “element” in UI.

**Avoid / ban**

- **Membrane** as brand spine — current dogfooding/integration copy may use it, but the brand language developed here supersedes that wording.
- **AI copilot / assistant / magic** — category clichés; Onlay is the interaction layer, not the agent.
- **Feedback** as a bucket term — say Comment, Ask, Edit, or Anchor.
- **Change** in user-facing copy — reserved for internal model/wire unless the user is reading technical docs.
- **Notification** when the product means attention — notification describes transport, not the state of work.
- **Element** in UI — say block; use element only in developer docs.
- **Anchor** as a vague noun — specify whether you mean the human placement action or the resulting location.

### Naming conventions

New user-facing actions should be short verbs with visible outcomes: Anchor, Pick, Verify, Steer, Tune. New surfaces should be nouns that name the place or state: Inbox, command bar, attention popup. Internal names can stay protocol-accurate when they protect architecture.

### Mechanics

- Product terms use Title Case only when naming the primitive: Comment, Ask, Edit, Anchor, Inbox. Normal sentence use can be lowercase for verbs (“anchor this Ask”).
- Use sentence case in UI and docs.
- Use em dashes sparingly for explanation; avoid exclamation marks.
- Emoji are not part of the brand voice except user-authored reactions.
- Prefer curly quotes in prose; code/docs examples use exact ASCII where necessary.

### On-brand / off-brand

**On-brand**

- “This Ask needs you. Answer now, or Anchor it to the page first.”
- “The preview is indicative. Verify the real render before resolving.”
- “Agent work starts loose only when it is asking for judgment.”

**Off-brand**

- “Your AI copilot magically collaborates everywhere!” — hype and category cliché.
- “Drop feedback here.” — hides the primitive and the next action.
- “Change element.” — internal language leaking into user UI.

**Register pair — product UI**

- On: “Anchor Ask”
- Off: “Attach floating feedback”

**Register pair — docs**

- On: “Unanchored Asks have no URL binding until a human anchors them.”
- Off: “Questions can float around until someone links them somewhere.”

**Register pair — errors**

- On: “Couldn’t reach the server. Your draft is still here.”
- Off: “Oops, something went wrong!”

## Visual foundations

### Color

- **Signature hue:** technical teal/cyan, generated from seed `#0098A6` into `--color-primary-*`. Reason: it reads as context becoming visible — precise, digital, and calmer than generic AI purple.
- **Surface system:** brand-tinted cool neutrals carry most UI: `--background`, `--card`, `--popover`, `--border`. Reason: the extension must sit above arbitrary pages without looking like page content.
- **Product commitment:** restrained in product UI — primary color appears in rings, active states, the launcher/orb, focus, and a few command accents. Reason: Onlay should guide attention, not flood it.
- **Brand commitment:** showcase/marketing may use committed teal/cyan fields and glow. Reason: brand surfaces can express the identity more loudly than the extension chrome.
- **Interaction grammar:** Comment uses primary teal/cyan; Ask uses amber; Edit uses green. Reason: Comment is context, Ask is attention/judgment, Edit is implementation movement.
- **Dark mode:** first-class and preferred for extension chrome. Reason: Onlay is used in dev/browser loops where dark surfaces and high-contrast overlays are common.
- **Accessibility:** never color-only; every colored state needs label, glyph, position, or chip copy. Reason: attention state is semantic, not decoration.

### Type

- **Posture:** instrument panel — engineered sans plus mono.
- **Faces:** IBM Plex Sans / IBM Plex Mono, self-hosted in `assets/fonts/` with system fallbacks. Reason: the brand needs human-machine precision, but the extension must stay fast.
- **Scale:** 1.2 minor-third scale, compact and hierarchical. Reason: extension real estate is tight; hierarchy should come from weight, color, and spacing, not oversized display type.
- **Display size:** `--text-display` (fluid ~44–76px, `--tracking-display`, `--leading-none`) exists for brand-surface hero moments only — never product UI. Reason: brand surfaces need one committed display moment; without it, showcase pages flatten into UI-sized type.
- **Weights:** 400 body, 500 labels, 600 headings, 700 rare emphasis. Reason: too many weights make dense UI muddy.
- **Caps:** use short tracked caps for micro-labels only (`--tracking-caps: 0.08em`). Reason: caps are a system signal, not a voice default.
- **Mono:** use for IDs, shortcuts, route/state labels, and protocol terms. Reason: monospace marks machine-readable structure.

### Spacing

- **Scale:** 4px base steps with product rows at 8–12px, panels at 16px, sections at 32px. Reason: dense agent/operator work needs compact rhythm, not marketing air.
- **Rule:** if a row carries attention state, give it enough vertical space to scan the actor, kind, state, and anchor. Reason: the user must know why it needs them before clicking.

### Backgrounds

- Product surfaces use flat tinted neutrals with hairline borders.
- Brand/showcase surfaces may add subtle teal glow behind signature moments.
- No decorative gradients behind functional rows.

Reason: Onlay is an overlay and Inbox product; visual noise competes with the page and the work.

### Motion

- **Easing:** `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)` for entrance; `--ease` for ordinary state changes.
- **Durations:** 120ms fast, 180ms default, 280ms slow.
- **Motion style:** appear, settle, reveal; no bounce.
- **Reduced motion:** all movement collapses to opacity/instant state.

Reason: the product is attention infrastructure; motion should orient, not entertain.

### Hover and press

- Hover: lift tone one step or reveal a hairline ring; do not scale rows.
- Press: darken/fill slightly or inset the control; keep layout fixed.
- Focus: `--ring-focus`, visible and kind/primary-tinted.

Reason: pointer states must be exact over arbitrary web pages; movement can obscure anchors.

### Borders, shadows, and radii

- Borders: 1px tinted neutral hairlines; functional boundaries before decoration.
- Shadows: dark-chrome elevation (`--shadow-sm`, `--shadow`, `--shadow-lg`) for floating extension surfaces.
- Radii: 6px small controls, 8–10px fields/buttons, 12–16px panels, full pills/orb.

Reason: the product should feel like precise browser instrumentation, not a soft SaaS card stack.

### Cards and panels

- Floating panels use border + shadow + dark/tinted surface.
- Inline rows use border or fill, not both unless selected.
- Ask cards must foreground the choice control; thread text never visually answers the Ask.

Reason: Onlay's interaction law must be legible from layout.

### Transparency and blur

- Use translucent surfaces only for overlay chrome sitting above a page.
- Avoid heavy blur in dense Inbox/product surfaces.

Reason: transparency says “layer above page”; too much blur makes content feel slippery.

### Imagery

No generic AI illustrations. If imagery appears, it should be product-grounded: browser chrome, anchored rings, command palette, Inbox rows, or real screenshots from Onlay. Abstract colored blobs are banned.

Reason: the product's visual proof is the interaction itself, not metaphor art.

## Iconography

Use outline icons with 1.75–2px stroke, rounded joins, and simple silhouettes. Current source set: lucide-style line icons in the extension/canvas; future icons should match that geometry.

- **Comment:** speech bubble.
- **Ask:** question-in-circle / decision control.
- **Edit:** pen line.
- **Anchor:** anchor/pin/crosshair hybrid; must read as “place this here,” not nautical decoration.
- **Inbox / attention:** tray or stacked rows; badge count is the state carrier.
- **Actor:** humans round avatars with initials; agents squared avatars with bot glyph or initials.

Default size is 16px in rows, 20px in cards/panels, 24px for command-bar leading icons. Emoji are user-authored reactions only, not system iconography.

Reason: icons are wayfinding for interaction kind and actor species; they should identify the state quickly without becoming illustration.

## Signature elements

### Signal orb

The launcher orb is the identity mark on duty: the mark itself inside product-control chrome, carrying connection state and the needs-you count. The orb WEARS the mark — one identity from favicon to launcher; the status dot and badge are the only additions (state on top of identity, never a second symbol). Canonical implementation: the showcase hero's composed orb (index.html `.orb`) — absorb it into `components/` on the next absorb pass; the earlier `.onlay-signal-orb` stand-in was superseded by it and retired.

Use it for the launcher, showcase moments, and examples of “agent work becoming visible.” Do not use it as a generic bullet or decorative planet.

### Anchor ring

The anchor ring is the clearest expression of Onlay's job: context made visible without becoming page content. The treatment is outline-only, applied directly: `outline: 2px solid var(--ring)` with a 3-4px offset (see the hero's mock block and §02's landed pin); the earlier `.onlay-anchor-ring` class was superseded by direct application and retired.

Use rings for selected/anchored blocks, focus moments, and before/after explanation. Never fill the page element; Onlay sits above the page.

### Kind chips

Comment, Ask, and Edit chips use distinct semantic hues through `.onlay-kind-chip[data-kind="..."]`.

Use kind chips anywhere a row or card must be parsed quickly. Never rely on color alone; keep the label.

### Micro-label and key chip

`.onlay-micro` is the tracked mono caps micro-label — the extension's system voice for section numbers, state labels, and provenance lines. `.onlay-kbd` is the key chip: shortcuts shown inline, because the binding is the documentation. Both are promoted product motifs; use them for system chrome, never for body copy.

### Logo mark

The working logo mark is `assets/logo.svg` — a clean geometric master redrawn from Logo Lab `mark-3` (the original trace is retained at `assets/logo-lab/mark-3.svg`). The composition is the product model drawn: a loose signal dot sits in the break of the boundary ring; the anchored point inside reaches toward it. Colors are exact ramp values: `primary-600` boundary, `primary-500` core.

One mark, everywhere (maker decision): the same drawing from favicon to hero — no simplified variants, no per-size redraws.

- `assets/logo.svg` — THE mark: hero moments, lockups, toolbar, favicon, the launcher orb.
- `assets/logo-mono.svg` — the same drawing in one ink, for reversed and single-color contexts only.

The mark's story is the product model (DR-009 in geometry), and brand surfaces should tell it: the boundary ring is Onlay's layer around the page, broken open in exactly one place — where an agent waits; the loose signal is an unanchored Ask holding that break; the context ring is the page's context made visible; the anchored point is human judgment, placed, reaching toward the waiting signal — that reach is Anchor.

Clear space: keep at least one inner-dot diameter around the symbol. The launcher orb wears the mark — it IS the mark in product-control dress, plus state (status dot, badge). On brand surfaces the mark stands free: filled-circle containers are the orb's uniform, reserved for the product control.

## Non-negotiables & flexible zones

### Non-negotiables

- **Product model.** Humans start anchored work; agents may initiate only unanchored Asks; Anchor is the human placement action. Reason: this is the trust boundary recorded in DR-009.
- **Primary hue family.** Technical teal/cyan remains the signature direction unless the maker explicitly reopens brand color. Reason: it separates Onlay from generic AI purple and expresses context becoming visible.
- **Voice spine.** Precise, calm, situated, and action-first. Reason: Onlay handles judgment and attention; hype breaks trust.
- **User-facing primitives.** Comment · Ask · Edit · Anchor · Inbox. Reason: the product model must stay learnable.
- **Extension-first identity.** The extension is the user-facing product truth; canvas/prototypes are exploratory. Reason: visual identity must serve the shipped surface.
- **Outline-only anchors.** Onlay marks context with rings and pins, never fills or mutates the page visually as truth. Reason: the layer must stay distinct from page content.
- **Tokens as value truth, readme as intent truth.** Reason: generated artifacts need one seam for values and one seam for meaning.

### Flexible zones

- **Density.** Product UI can be dense; brand/showcase pages can breathe more. Reason: usage context changes the register.
- **Layout.** Cards, command palettes, rows, and docs can vary as long as state and next action stay clear. Reason: the design system should grow without becoming brittle.
- **Tone by register.** Marketing can be more evocative; product UI stays terse; docs stay exact. Reason: one voice shifts by context.
- **Icon details.** Stroke set and exact glyphs may evolve. Reason: the geometry matters more than a specific icon library.
- **Logo mark.** The selected working mark is `assets/logo.svg`; refinements should preserve the signal point + ring idea unless the maker reopens the mark. Reason: the identity now has a chosen symbol direction.
- **Current dogfooding language.** Existing onlay skill/integration copy can change to match this kit. Reason: the product we are dogfooding is evidence of current behavior, not the authority for future brand language.

## Manifest & changelog

### Index

- `SKILL.md` — operating manual for making artifacts on-brand and growing the kit.
- `styles.css` — import-only entry point; consumers link this one file.
- `tokens/colors.css` — generated OKLCH teal/cyan palette, brand-tinted neutrals, semantic aliases, interaction grammar.
- `tokens/themes.css` — hand-maintained `[data-theme]` overrides so a surface can commit to dark or light instead of following the OS; brand surfaces commit to dark.
- `tokens/typography.css` — instrument-panel type posture: engineered sans + mono stacks, 1.2 scale, weights, leading, tracking.
- `tokens/spacing.css` — compact 4px-based spacing rhythm and semantic spacing aliases.
- `tokens/effects.css` — radii, shadows, rings, glow, easing, durations.
- `brand-card.md` — portable non-web values, including Pantone print mapping and online-first posture.
- `pantone.json` — generated Pantone mapping artifact.
- `assets/logo.svg` — THE mark, used at every size (redrawn from Logo Lab mark-3; viewBox-correct, two-tone ramp colors); favicon source.
- `assets/logo-mono.svg` — the same drawing in one ink, for reversed/constrained contexts.
- `assets/signature-elements.css` — token-bound signal orb, anchor ring, and kind chip specimens derived from extension/source motifs.
- `assets/logo-lab/` + `logo-lab.html` — generated Logo Lab references; PNG intermediates removed, runner-up SVGs retained.
- `components/button.html` — core — primary/secondary/ghost action buttons for exact Onlay verbs.
- `components/field.html` — core — compact instrument-panel text input.
- `components/kind-chip.html` — core — labeled semantic chips for Comment, Ask, and Edit.
- `components/attention-row.html` — core — needs-you row showing actor, state, location, and kind.

### Changelog

- 2026-07-08 — Scaffolded `onlay-design` kit.
- 2026-07-08 — Anchored strategy around human-starts-in-context, agent-initiated unanchored Asks, and Anchor as human placement action (DR-009).
- 2026-07-08 — Chose teal/cyan hue family and generated palette from seed `#0098A6`; recorded online-first print posture.
- 2026-07-08 — Set type posture to instrument panel and wired self-hosted IBM Plex Sans + IBM Plex Mono font files.
- 2026-07-08 — Selected Logo Lab `mark-3` as working logo and promoted it to `assets/logo.svg`.
- 2026-07-08 — Built `index.html` showcase ceiling with hero, components, Inbox sample, voice, logo, signal orb, and anchor-ring sections.
- 2026-07-08 — Seeded core components: Button, Field, Kind chip, Attention row.
- 2026-07-09 — Taste pass: rebuilt `index.html` as a committed dark brand page — CSS diorama hero (Onlay chrome above a light foreign page), numbered instrument-panel sections, DR-009 Anchor story, composed foundations instead of token dumps.
- 2026-07-09 — Kit refinements from the taste pass: added `tokens/themes.css` (`[data-theme]` commitment), `--text-display`/`--tracking-display`/`--leading-none` display tier, and promoted `.onlay-micro` + `.onlay-kbd` extension motifs into signature elements.
- 2026-07-09 — Redrew the mark as exact geometry: replaced the ~1MB vtracer trace with a viewBox-correct three-file system (`logo.svg` master, `logo-glyph.svg` ≤24px, `logo-mono.svg` one-color), same composition and ramp colors; trace retained in `logo-lab/`. Showcase wordmark, orb, ladder, and favicon now use the system.
- 2026-07-09 — Maker decision (onlay change 8f79af70): the orb IS the logo — flipped the former "orb is not the logo" rule. The launcher orb wears the mark; status dot and badge are the only additions. Rebuilt showcase §06 as an annotated anatomy telling the mark's story.
- 2026-07-09 — Maker decision: one mark, everywhere — retired the ≤24px glyph tier and deleted `logo-glyph.svg`; `logo.svg` is used at every size including the favicon and orb. Scrubbed DR references from the showcase (brand surfaces speak brand language; traceability lives in this guide).
- 2026-07-09 — Manual batch (onlay change 0e417bf1): showcase shortcut chips corrected to the extension's real accelerator Ctrl+. (⌘K was invented); dropped the redundant "one mark, everywhere" rule bullet from §06 — the policy stays recorded here and in the brand card, the ladder demonstrates it.
- 2026-07-09 — Pillar 3 proof updated to shipped reality (ADR-0021): the review vertical and page hosting are gone; a verdict is an Ask recipe over `onlay ask --wait`, and Onlay hosts no pages. The product's actor tint palette was regenerated brand-adjacent (kernel TINTS: brand teal + calm mid-lightness companions).
- 2026-07-16 — MIGRATED to the project: `onlay-design` (global skills root) → the project's skills folder (now `.claude/skills/onlay-brand/`) per the -brand discovery convention; skill renamed `onlay-brand`; brand truth now versions with the repo.
- 2026-07-16 — Stripped generator scaffolding (showcase slot markers, template caption); removed the retained icon placeholder PNG.
- 2026-07-16 — Retired superseded specimens `.onlay-signal-orb` / `.onlay-anchor-ring` (the showcase's composed orb and direct outline treatment are canonical); readme re-pointed. Absorb pass for the hero's reusable surfaces (orb, thread card, inbox panel) remains open.
- 2026-07-10 — Maker decision: written form in prose is capitalized **Onlay**; lowercase `onlay` reserved for technical identifiers (CLI, packages, paths, code). Rule recorded in the brand card's new Naming section; this guide and the showcase reconciled to match.
