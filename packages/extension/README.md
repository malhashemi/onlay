# @onlay/extension

The Chrome MV3 extension: Onlay's product surface. An isolated content script
mounts the overlay in a closed shadow root (styled only through
`adoptedStyleSheets`, so a strict page CSP has nothing to block); the service
worker signs in, holds one WebSocket per space, and keeps the badge; the popup
is sign-in and your mini Inbox; the options page holds keyboard shortcuts, the
theme and zoom, and your account at a glance (the account itself is managed in
the web app's settings); and the full-page interaction view
(`interaction.html?id=`) renders any interaction you may see from server truth
alone, the reliable path when the original page is gone. The look is the Onlay
design system: teal/cyan primary over tinted cool neutrals, IBM Plex on
extension-owned pages, Comment teal and Edit green.

## Build & load

```bash
bun run build          # → dist/, version 0.0.0 unless ONLAY_EXTENSION_VERSION is set
bun run build:release  # NODE_ENV=production → dist/ and release/onlay-extension.zip (the /download zip)
bun run build:store    # NODE_ENV=production → dist-store/ and release/onlay-extension-store.zip
```

`build:release` is what the site's `/download/onlay-extension.zip` serves and its
`/install` page explains how to load. `build:store` is the Chrome Web Store
package: no `key`, no localhost entries (see `packages/server/README.md` for the id
the store assigns), and both origins https.

The extension talks to the service at `https://app.onlay.dev` (`ONLAY_SERVER_ORIGIN`
overrides it at build time) and links to the public site at `https://onlay.dev`
(`ONLAY_SITE_ORIGIN`; when only `ONLAY_SERVER_ORIGIN` is set, as in dev and e2e, the
site is that same origin). `host_permissions` names the service alone;
`externally_connectable` names both, so the site's landing page can ask `onlay-ping`
whether the extension is installed. Only the service's `/auth/extension` page can hand
the extension a sign-in. CI sets `ONLAY_EXTENSION_VERSION=0.2.<run number>`; the popup shows
a one-line note linking to `/install` when an unpacked release build is older than the
version `/healthz` reports.

Load **`packages/extension/dist`** unpacked via `chrome://extensions`. `dist/` is
the only loadable directory — the source manifest lives in `src/`, so the package
root cannot be mistaken for a loadable extension.

The committed `key` in `src/manifest.json` is a PUBLIC key: it pins the unpacked
extension ID to `jpgekbcbbgdojakpjpefffljbmiimlbb` on every machine, which the
Worker's `EXTENSION_IDS` lists and e2e relies on. It cannot sign anything; the
private half is not needed to build or load the extension (`*.pem` is gitignored).
A store build has no key and gets the id the store assigns
(`packages/server/README.md`). For an extension of your own with an id of its own,
make a key pair (`openssl genrsa -out dev-key.pem 2048`), put its public half
(`openssl rsa -in dev-key.pem -pubout -outform DER | openssl base64 -A`) in
`key`, build, and list the id the build prints in your Worker's `EXTENSION_IDS`,
the dev environment's and the tests that pin it.

## How it works

- **Signing in.** The popup's Sign in opens `/auth/extension` on the service in a
  tab; that page hands the service worker a one-time code, which it redeems for a
  client token kept in `chrome.storage.local` (AGENTS.md, "Identity"). Sign out
  revokes the token.
- **State lives in storage, not in the worker.** MV3 stops the service worker
  often; the token, the person, their spaces and per-space session ids live in
  `chrome.storage`, and every connect resyncs each space in full. Nothing depends
  on the worker's memory.
- **The overlay is a pure view.** Each space's snapshots arrive tagged with their
  space and are merged; there is no local truth. A page's address reaches a space
  only when its origin already has threads there or you create something on it.
- **Attention.** The badge is the sum of each space's needs-you count, `notify`
  frames become notifications (the `notifications` permission), and the popup is
  the mini Inbox: on this page, unanchored, elsewhere, recent.
- **The launcher and the command bar.** The only persistent page chrome is the
  launcher orb, the mark itself in product-control dress. Clicking it opens your
  Inbox; `Ctrl+.` opens the command bar: Comment on a block or the page, Edit a
  block or the page, the Inbox, Kept edits, Copy for agent, Switch space, and
  Settings, each with a shortcut you can change on the options page.
- **Every frame.** The content script runs in all frames (`all_frames`,
  `match_about_blank`); the launcher, command bar, composers and thread panel live
  in the top frame, and each frame with an address of its own shows its own pins
  and owns its own blocks (AGENTS.md, "Frames of one tab work as one page").
- **The socket lives in the service worker**, never in a page or a content
  script: the service checks the extension's token, and a page never sees it.

## The offscreen-document lever (documented stub)

The SW-owned socket churns with worker lifetime; a full resync on every connect
makes that invisible to correctness. If a steadier socket is ever wanted, the
untested lever is an **offscreen document** as the socket host (longer lifetime
than the SW): add the `offscreen` permission, an `offscreen.html`,
`chrome.offscreen.createDocument` on boot, and move the sockets and keepalive there
behind the same message interface the SW exposes to content scripts today. Decide
only if measured churn ever hurts.
