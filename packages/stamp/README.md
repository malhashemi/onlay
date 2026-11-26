# @onlay/stamp

Build plugins that tell Onlay which source file a block on a page came from. In a dev build, each element gets `data-onlay-source="<file>:<line>:<column>"` (the file relative to the project root, for example `src/App.tsx:12:5`), and the page gets `data-onlay-provenance` (the git remote, commit, branch and whether the tree is dirty). With those, an Edit made on that page reads `Source: known` to the person's agent, which can then change the source instead of only posting variants. Production builds are untouched: no attribute, no git call.

## Install

It is not on the npm registry; install the tarball the service publishes, as a dev dependency:

```sh
npm i -D https://onlay.dev/download/onlay-stamp.tgz
pnpm add -D https://onlay.dev/download/onlay-stamp.tgz
bun add -d https://onlay.dev/download/onlay-stamp.tgz
```

The package has no dependencies of its own.

## Configure

**Vite** with React or another JSX framework (stamps `.jsx` and `.tsx`), in `vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import onlayStamp from "@onlay/stamp/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [onlayStamp(), react()],
});
```

**Next** 15 or newer, webpack or Turbopack dev, in `next.config.mjs` (or `next.config.ts`): wrap the existing config.

```js
import { withOnlayStampNext } from "@onlay/stamp/next";

export default withOnlayStampNext({
  // the existing config
});
```

On Next 15.0 to 15.2 with `next dev --turbo`, pass `{ turbopackRuleTarget: "experimentalTurbo" }` as the second argument.

**SvelteKit**, in `vite.config.ts` (Svelte with Vite and no SvelteKit: the same, with `svelte()` from `@sveltejs/vite-plugin-svelte` in place of `sveltekit()`):

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import onlayStampSvelte from "@onlay/stamp/svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [onlayStampSvelte(), sveltekit()],
});
```

**Astro** (stamps `.astro` templates and JSX islands), in `astro.config.mjs`:

```js
import onlayStamp from "@onlay/stamp/astro";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [onlayStamp()],
});
```

Every plugin takes `{ root }` when the project root is not the dev server's root.

## Check it works

Restart the dev server, then:

- Next, SvelteKit, Astro: the served HTML carries the stamps. `curl -s http://localhost:3000/ | grep -o 'data-onlay-source="[^"]*"' | head -3`
- Vite: the page is filled in by script, so check a transformed module instead. `curl -s http://localhost:5173/src/App.tsx | grep -o 'data-onlay-source[^,]*' | head -3`

In the browser, `document.querySelector("[data-onlay-source]")` finds a stamped block. The page's provenance (`document.documentElement.dataset.onlayProvenance`) is there only when the project is a git repository, and only with Vite and Astro: Next and SvelteKit pages get none. SvelteKit 3 warns at startup that `onlay:svelte-source-stamp` uses `transformIndexHtml`; that is the provenance hook, and the stamps still work.

Edits keep the source state they were made with: make a new Edit on the reloaded page.
