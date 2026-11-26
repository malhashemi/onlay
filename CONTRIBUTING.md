# Contributing to Onlay

Thank you for your interest in contributing to Onlay. Onlay is built to sit cleanly on top of any live web page while keeping human judgment, privacy boundaries, and agent tooling predictable. Before making changes, read [`AGENTS.md`](AGENTS.md) for the architecture, security invariants, and known limits so your change fits the existing design.

## What helps most

- **Bug fixes with tests:** Reproducible fixes backed by a unit test, a Workers-runtime test, or a Playwright end-to-end test.
- **Real-world page edge cases:** Fixes for strict CSP sites, embedded frames, shadow DOM isolation, keyboard routing, and block capture fidelity.
- **Source stamps (`packages/stamp`):** Improvements and bug fixes for dev-server source stamping across Vite, Next.js, SvelteKit, and Astro.
- **Accessibility and responsive polish:** Keyboard navigation, screen-reader labels, and mobile web app usability in `packages/pwa`.
- **Documentation and clear bug reports:** Concrete reproduction steps, browser versions, and clearer setup or architecture notes.

If you plan to work on a large feature, protocol update, or structural refactor, open an issue first so we can agree on the approach before you invest time in a pull request.

## Expectations

- **Keep pull requests small and focused.** Limit each pull request to one logical fix or improvement, with tests that cover the new behavior. Avoid mixing unrelated refactors or formatting sweeps into feature branches.
- **Run the checks before opening a pull request.** Formatting, typechecking, architecture dependency rules, and tests must pass locally before review. Applied D1 migrations in `packages/server/migrations/` are never edited after merge; add a new migration file instead.
- **Respect package boundaries.** `packages/extension`, `packages/pwa`, and `packages/site` never import each other; shared client code belongs in `packages/render` or `packages/protocol`.
- **Follow the Onlay lexicon.** User-facing copy and documentation use a strict vocabulary enforced by `packages/extension/src/overlay/lexicon.test.ts`. Always use **block**, **Comment**, **Edit**, **Inbox**, and **space** in product strings, keep prose plain and direct without exclamation marks or hype, and check `lexicon.test.ts` and `.claude/skills/onlay-brand/readme.md` for the full rules. When extension overlay wording changes, update `packages/site` to stay in step.

Comments and test names cite ids such as `ADR-0024`, `F25`, `D1` or `spec §4`. They refer to the project's private design records; each rule is stated where it is cited, so you never need the record to follow the code.

## Development and check commands

You need [Bun](https://bun.sh) 1.3 (CI uses 1.3.14) and, for the end-to-end tests, Chromium from Playwright. Everything else, `fallow` (the architecture check) included, is a pinned dev dependency that `bun install` brings.

```sh
bun install                                   # dependencies, biome, tsc and fallow
cd e2e && bunx playwright install chromium && cd ..   # once, for the e2e suites

bun run check            # the fast gate: biome, tsc for every package, fallow, the notices check, unit tests
bun run test:workers     # the Workers-runtime suite (vitest in workerd): edge, D1, MCP, the space Durable Object
bun run test:e2e         # the smoke set: builds both clients, runs wrangler dev, drives the extension in Chromium
bun run test:e2e:extra   # the longer e2e specs (not in CI)
bun run check:all        # all of the above, both builds and the capture fidelity gate
```

To run the whole stack locally (the Worker on `http://localhost:8787` with a dev sign-in form, no accounts needed):

```sh
cp packages/server/.dev.vars.example packages/server/.dev.vars   # then set SESSION_SECRET in it
bun run --filter @onlay/server dev:db    # once, and after every new migration
bun run --filter @onlay/server dev       # builds the web app and the landing page, then wrangler dev
ONLAY_SERVER_ORIGIN=http://localhost:8787 bun run build:ext   # then load packages/extension/dist unpacked
```

The client builds read build settings from a root `.env` (see `.env.example`); `packages/server/README.md` is the full local and deployment runbook.

**Third-party notices.** `THIRD-PARTY-NOTICES.md` lists everything Onlay ships that others made. Its "Bundled packages" part is generated from the builds' own module graphs: after adding, removing or upgrading a dependency that ends up in a build, run `bun run notices` and commit the result. `bun run check` fails while it is out of date. Fonts, icons and other copied work are listed by hand in the same file.
