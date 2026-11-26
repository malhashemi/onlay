# @onlay/site

Onlay's public landing page: one static page, and a page you can use Onlay on.
A visitor opens the launcher at the corner (or presses Ctrl+.), picks a block of
the page, comments on it or asks for an Edit, and steps through Variants that
change the real headline. All of it is simulated in the browser: nothing is
sent, nothing is stored, and a reload starts clean. When the visitor's own
extension answers the `onlay-ping`, the simulation stands down and the real
Onlay works on the page instead; an answer that comes after the page's short
wait still counts, and takes a running simulation away completely.

```sh
bun run build:site                       # → packages/site/dist/
bun run --filter @onlay/site preview     # serves dist/ at http://localhost:4173 with the page's CSP
PORT=4180 bun run --filter @onlay/site preview
```

## What is where

- `src/config.ts`: the switches. `STORE_LISTED` (the install buttons lead to
  `/install` until it is true, then to `CHROME_WEB_STORE_URL`),
  `SERVICE_ORIGIN` (the web app link, the MCP URL and its config; a build may
  override it with `ONLAY_SERVICE_ORIGIN`), `FILM` (its files and its length),
  `EXTENSION_IDS` (who may answer the ping).
- `src/copy.ts`: every word of the page. `COPY` is the copywriter's text by
  slot; `OWN` is what the page needed beyond it.
- `src/overlay/`: the overlay's views, rebuilt for this page after the
  extension's (`packages/extension/src/overlay`), with the product's own
  strings in `strings.ts`. They draw both the demo layer and the section
  fragments.
- `src/demo/`: the demo's logic. `store.ts` (the threads, in memory),
  `agent.ts` (the scripted agent), `blocks.ts` (what a pick lands on),
  `programs.ts` (the headline's Variants, as mutation programs),
  `previews.ts` (what is on each block: one preview engine per block, kept
  edits in the order kept, then the one variant on preview), `layer.ts` (the
  shadow host, pick mode, pins), `rail.ts` (the page's three steps).
- `src/fragments.ts`: the working pieces inside the sections, built once by the
  build (so the page is whole without JavaScript) and again in the browser.
  The build passes each through `src/static.ts`: until the page's script
  takes a fragment over it is an example to read, with no button, field or
  control role in it, and Copy shows only once it works.
- `src/page.ts`: the document, as markup.
- `src/styles/`: `site.css` (the page, with the brand's tokens in its `:root`),
  `overlay.css` and `orb.css` (the overlay, written like the extension's sheet;
  the build scopes them under `.ov` and applies the overlay's 1.25 zoom).

## What is the product's own code

- Code blocks: `@onlay/render/code-block` draws every code sample and every
  fenced block in a thread; `@onlay/protocol`'s `parseFences` reads the fences.
- Syntax colors: `@onlay/render/highlight` (Shiki). The build colors the page's
  samples, so no highlighter loads for them; it is fetched only if a visitor
  writes a fenced block in the demo.
- Variants: `@onlay/render`'s preview engine applies the programs to the page,
  restores them, and keeps a picked one applied.

## The build

`scripts/build.ts` writes `dist/index.html` (no-cache), `dist/site/*` (every
other file, named by its content, immutable) and `dist/asset-manifest.json`
(each served path with its content type and caching). It builds beside
`dist/` and swaps the result in whole, so a failed build never takes a served
page down.

"Nothing is sent or stored" is checked three ways. The build reads the page's
own scripts (the entry, the demo and fragments chunk, and what they import
outright) and fails if one names an API that sends or stores
(`scripts/scan.ts`); the policy below has `connect-src 'none'`; and the demo's
store is tested with every storage API trapped. Not covered: a name put
together at run time, and the highlighter's chunks (their grammars list those
names as words to color), which load only if a visitor writes a fenced block. `scripts/preview.ts`
serves exactly that, with this Content-Security-Policy on every response:

```
default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self';
media-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

The page has no inline script, no inline event handler and no `style`
attribute in its markup (the build fails if a fragment carries one). The demo
layer positions its boxes and pins by setting style properties from script,
which the policy allows.

## The film

The film's master cut is made outside this repository; the film and its score
are original work (THIRD-PARTY-NOTICES.md, "Original assets"). To replace it,
encode a new master with `scripts/film.sh <master.mp4> <poster.png>` (it needs
`ffmpeg` and `cwebp`): it writes `src/media/film.mp4` (H.264, the sound copied
untouched, the index at the front) and `src/media/film-poster.webp` (1600 px
wide). Then set `FILM` in `src/config.ts`: `seconds` (the copy takes its "0:38"
and "38 seconds" from that number) and `width` and `height` if the size changed.
The build names the served copies by their content. The film has sound, so it
loads and plays only when asked, with the browser's controls showing.

## The fonts

`src/assets/fonts/` holds IBM Plex as IBM distributes it, unmodified: the split
files from `fonts/split/woff2/` of `@ibm/plex-sans` 1.1.0 (Sans 3.005) and
`@ibm/plex-mono` 2.5.0 (Mono 2.005), for Regular, Medium and SemiBold. Each face
has a Latin1 file (about 17–22 kB) and a Pi file (arrows and symbols, 7–14 kB);
`src/styles/site.css` gives each IBM's own `unicode-range`, so a browser fetches a
Pi file only when the page sets one of its characters, and the first view preloads
three Latin1 files. Plex's licence reserves the name "Plex" for IBM's own files, so
the site ships only files IBM published and never a subset of its own: to change
coverage, choose other IBM split files (Latin2, Latin3, Greek, Cyrillic) and add
their `@font-face` with the ranges in IBM's `IBMPlex*-<weight>.css` beside them.
The licence and IBM's notice are in `THIRD-PARTY-NOTICES.md`, which the page links from its footer.
