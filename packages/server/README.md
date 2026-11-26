# @onlay/server

The hosted Onlay service: one Cloudflare Worker, `onlay`, on two hostnames. The service (`PUBLIC_ORIGIN`) serves the web app at `/app/`, sign-in under `/auth/`, `/api/`, `/s/`, `/mcp`, `/.well-known/` and `/healthz`. The public site (`SITE_ORIGIN`) serves `/` (the landing page, built from `packages/site`) and its files at `/site/*`, `/install`, `/privacy`, `/download/*` and `/healthz`, and nothing there reads or sets a credential. The official deployment is `https://app.onlay.dev` and `https://onlay.dev` (`wrangler.jsonc`); a deployment of your own starts from `wrangler.example.jsonc`, with `https://app.example.com` and `https://example.com` standing in below.

| Path | On the service | On the site |
|---|---|---|
| `/` | 302 to `/app/` (other methods 405) | the landing page, the same for everyone (other methods 405); never clears storage |
| `/site/*` | 404 | GET/HEAD: the landing page's files its build's manifest lists, immutable, with byte ranges; anything else 404 |
| `/app/sw.js` | the web app's service worker | 404; clears storage |
| `/app`, other `/app/*` | the web app | GET/HEAD: 302 to the same path on the service; other methods 404; clears storage |
| `/auth/login` | sign-in | GET/HEAD: 302 to the same path and query on the service; other methods 404 |
| every other `/auth/*`, `/api/*`, `/s/*`, `/mcp`, `/.well-known/*` | served | 404 `not_found`, no credential read |
| `/install`, `/privacy`, `/download/*` | GET/HEAD: 302 to the same path on the site; other methods 405 | served |
| `/healthz` | served | served |
| anything else | 404 | 404 |

"Clears storage" is `Clear-Site-Data: "storage"`, sent only by the site host and only on `/app` and `/app/*`, which only a browser that had an older web app on the site's origin asks for: it removes what that web app left there (its service worker, Cache Storage, IndexedDB, localStorage), never cookies and never anything on the service (`retireOldAppStorage` in `src/edge/site.ts`). The official site served the web app until the service moved to `app.onlay.dev`; on a new deployment the header simply never finds anything to clear. The edge's pages, the landing page and the web app shell carry `Cross-Origin-Opener-Policy: same-origin`.

**The landing page** (`src/edge/landing.ts`). `bun run build:web` builds the web app and the site, then `scripts/stage-site.ts` copies `packages/site/dist` into the assets directory as `packages/pwa/dist/landing/` (`index.html`, `site/<name>`, `asset-manifest.json`). It refuses a build whose manifest fails the Worker's own rules (`src/edge/landing-manifest.ts`: each path once, a known extension and its type, `immutable`, a length), whose files are missing, of another size or unlisted, whose page, stylesheets or scripts name a `/site/<name>` (or import a `./<name>`) the manifest lacks, or that is older than any of the site's, render's or protocol's sources. (That the page sends and stores nothing, as it says, is the site build's own check, `packages/site/scripts/scan.ts`, and the e2e smoke set's `landing.spec.ts`.) `scripts/stage-site.ts --check` stages nothing and refuses unless the staged copy is exactly that fresh build; CI's deploy step and `bun run --filter @onlay/server deploy` run it first. `/` answers `index.html` with `Cache-Control: no-cache` and the page's own Content-Security-Policy (`default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; media-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and COOP; a failed read of it is a plain 503. Neither ever carries `Clear-Site-Data`. `/site/<name>` answers exactly the files the manifest lists, with its content type, `Cache-Control: public, max-age=31536000, immutable`, `nosniff`, `Accept-Ranges: bytes` and the strong `ETag` `"<length>-<name>"` (names are content-hashed). The answer is decided from the manifest before any byte is read, in RFC 9110's order: a matching `If-None-Match` is `304` (whatever `Range` says); only GET has ranges, so a HEAD's `Range` is ignored (`200`); one `bytes` range, the unit in any case, is `206` with `Content-Range` (an open end or a suffix too), and one past the end `416` with `Content-Range: bytes */<length>`; several ranges, a malformed or reversed one, or an `If-Range` that is not the `ETag` get the whole file. A range reads only up to its last byte: the assets binding is asked for that range and its answer is passed on when it is exactly that range; otherwise (as `wrangler dev`'s binding does) the file is streamed and cut, never held whole. A `HEAD` carries no `Content-Length` (the runtime drops it from a body-less response). The manifest, unlisted files and other paths are 404. Without a staged build, `/` is a plain 503 and `/site/*` 404. The page's links name the service it was built for (`ONLAY_SERVICE_ORIGIN`, default `https://app.onlay.dev`; `dev` and e2e set their own origin). The web app's allowlist never serves anything under `landing/`, and its service worker's scope is `/app/`. `scripts/check-landing.ts <site> <service>` checks a running deployment against this checkout's build (CI runs it after each deploy).

`PUBLIC_ORIGIN` and `SITE_ORIGIN` must each be exactly an origin: an absolute `https:` URL (`http:` only for `localhost`, `127.0.0.1` or `[::1]`) with no path beyond `/`, no query, no fragment and no credentials. Case and a trailing `/` are normalised, and every part of the Worker uses the normalised value (`src/edge/hosts.ts`). With either setting invalid, every request is a 503 `unavailable` and no credential is read; the site's `/app` and `/app/*` still clear storage when `SITE_ORIGIN` itself is valid (its `/` does not). Swapped or equal values are valid settings, so CI's post-deploy checks pin both origins by behaviour.

A request for any other origin (another host, `http://`, another port, or a `Host` header that disagrees with the URL) is 404, in both modes. With `SITE_ORIGIN` empty, unset or equal to `PUBLIC_ORIGIN`, the one origin `PUBLIC_ORIGIN` serves every service and site row above (without the clearing header) and nothing else is answered, as `env.dev`, e2e and the tests do (`src/edge/hosts.ts`). So a production config that lost its `SITE_ORIGIN` takes the site's host offline rather than serving the service there; locally, `http://127.0.0.1:8787` is refused when `PUBLIC_ORIGIN` is `http://localhost:8787`.

- `src/edge/` — the host split (`hosts.ts`, and `site.ts` for the public pages, `landing.ts` for `/` and `/site/*`), sign-in (WorkOS AuthKit, the extension hand-off, the dev stub), the caller and the one authorization read, `/api/*`, routing into spaces, rate limits, `/app/*`, `/privacy`, `/install`, and `/download/onlay-extension.zip` and `/download/onlay-stamp.tgz` (written beside the web app build at deploy).
- `src/directory/` — people, spaces, members, invitations, creators, shares and credentials in D1, and the outbox of control calls owed to spaces (`notify.ts`).
- `src/space/`, `src/space-do.ts` — the space runtime and its Durable Object (one per space, named by the space id).
- `src/mcp/` — `POST /mcp`, the OAuth discovery documents under `/.well-known/`, and the ten tools.
- `migrations/` — D1 SQL migrations (`0001_directory` to `0011_person_profile`). Applied migrations are never edited; each must work with both the old and the new Worker, because migrations run before deploy.

`wrangler.jsonc` is the official deployment's configuration and `wrangler.example.jsonc` a starting point for yours (no script reads it; see "Deploying your own instance"). In both, the top level is production, with a custom-domain route for each of the site and the service; `env.dev` is local development on `http://localhost:8787` with `DEV_AUTH=1` and one origin (`SITE_ORIGIN` is empty). The `dev` environment is for `wrangler dev` on this machine only and must never be deployed: it has no route, and the dev sign-in stub answers only when `DEV_AUTH` is `1`, `PUBLIC_ORIGIN` is `localhost` or `127.0.0.1`, and the request arrived for that same host. Both environments run two crons: every minute (retry the outbox) and daily at 04:17 (expired sessions and sign-in codes, old rate windows).

The Worker reads the vars `PUBLIC_ORIGIN`, `SITE_ORIGIN`, `AUTHKIT_ISSUER`, `WORKOS_CLIENT_ID`, `WORKOS_API_BASE`, `EXTENSION_IDS`, `MIN_CLIENT_PROTOCOL`, `PUSH_CONTACT` (optional: who push services may contact about the deployment's web push, a `mailto:` address or an `https:` URL; without it the VAPID `sub` is `PUBLIC_ORIGIN`), `DEV_AUTH` (dev only), and `SHA` and `EXTENSION_VERSION` (set at deploy), and the secrets `WORKOS_API_KEY`, `SESSION_SECRET`, `SUPER_ADMINS`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_JWK` (`src/env.ts`).

## Local development

The whole stack on one machine: the Worker, the space Durable Objects and a local D1 under `wrangler dev` on `http://localhost:8787` (the `dev` environment, `DEV_AUTH=1`), the web app at `/app/` from the PWA build, and the extension built to talk to it. From the repository root:

```sh
bun install
cp packages/server/.dev.vars.example packages/server/.dev.vars
# set SESSION_SECRET in packages/server/.dev.vars, e.g. to the output of: openssl rand -base64 48
# optional: SUPER_ADMINS=you@example.com (lets you create workspaces), the VAPID pair (web push)
bun run --filter @onlay/server dev:db     # once, and after every new migration: the local D1
bun run --filter @onlay/server dev        # builds the web app and the landing page, then wrangler dev on :8787
```

`dev:db` applies `migrations/` to the local database under `packages/server/.wrangler/state` (gitignored); delete that folder to start over. `dev` serves `/app/` from `packages/pwa/dist` and the landing page from its `landing/` folder (`bun run build:web` with `ONLAY_SERVICE_ORIGIN=http://localhost:8787`), both rebuilt on every start. With one origin, `/` sends a signed-in browser on to `/app/` and shows anyone else the landing page.

**Signing in.** With `DEV_AUTH=1`, `http://localhost:8787/auth/login` is a one-field email form: any email signs in as that person (a person and their personal space are made at first sign-in). Scripts and tests use the JSON form of the same stub:

```sh
xh POST http://localhost:8787/auth/dev/session email=ada@example.com name="Ada Lovelace"
# → {person, token}; Set-Cookie: __Host-onlay.session=… (the web app's session)
# token: an extension-class client token, for Authorization: Bearer and the bearer.<token> subprotocol
```

A cookie counts only under the cookie rule (`AGENTS.md`, "The caller header is the only identity a space trusts"), so a scripted web app call carries what the browser would: `Sec-Fetch-Site: same-origin` on reads, plus `Origin: http://localhost:8787` and `Onlay-CSRF: 1` on writes. For example, as Ada's extension then her web app:

```sh
xh POST http://localhost:8787/s/<spaceId>/interaction "Authorization:Bearer <token>" \
  kind=comment url=https://shop.example.com/pricing body:='{"text":"Is this price right?"}'
xh GET http://localhost:8787/api/inbox "Cookie:__Host-onlay.session=<value>" Sec-Fetch-Site:same-origin
```

**The extension against the local stack.** Build it with the dev origin, then load `packages/extension/dist` unpacked in Chrome (`chrome://extensions`, developer mode). The manifest's pinned key gives it the id `env.dev` lists in `EXTENSION_IDS`, and the build puts `http://localhost:8787` in its host permissions and `externally_connectable`, so Sign in in the popup opens `/auth/extension` here and the dev form signs you in:

```sh
ONLAY_SERVER_ORIGIN=http://localhost:8787 bun run build:ext
```

For real sign-in against a WorkOS staging environment instead, put that environment's AuthKit domain and client id in `env.dev`'s `AUTHKIT_ISSUER` and `WORKOS_CLIENT_ID` (the ones in `wrangler.jsonc` are the official deployment's staging environment), set its `WORKOS_API_KEY` in `.dev.vars`, and remove `DEV_AUTH` from `env.dev`. Register `http://localhost:8787/auth/callback` as a redirect URI there. Signing out then goes through AuthKit's logout and returns to `http://localhost:8787/`, which must be a sign-out URI of that environment.

**An agent against the local stack.** Point an MCP client at `http://localhost:8787/mcp` with `Authorization: Bearer dev:<email>`; that bearer is the dev stub too, so it works only under the same loopback conditions.

**Tests.** `bun run --filter @onlay/server test` runs the space runtime under `bun test`. `bun run --filter @onlay/server test:workers` (or `bun run test:workers` from the root) runs workerd suites with the D1 migrations applied: `edge` (the real edge and D1 with stand-ins for WorkOS and the space) and `shell` (the real Worker, the real space Durable Object and D1: the outbox, MCP, identity, and `test/shell/system.test.ts`, the one suite that drives the whole system through public routes).

## Deploying production (the official deployment)

CI deploys every push to `main` of `malhashemi/onlay` (the `deploy` job in `.github/workflows/ci.yml`). Its Cloudflare credentials, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, are secrets of a GitHub environment named `production` (repository Settings → Environments → `production`: deployment branches limited to `main`, then the two environment secrets), never repository secrets: a repository secret is readable by a workflow run from any branch, an environment secret only by a job that names the environment and runs from a branch it allows. The job runs only in that repository: a fork, or a renamed copy, that pushes to its own `main` builds and keeps the packages but never deploys, even with credentials. With `0.2.<run number>` as the release version (the 0.2 series began with the public repository, whose run numbers start again at 1, so each 0.2 release is newer than every 0.1 one already shipped), it:

1. installs Bun from its release archive, checked against the SHA-256 Bun publishes for that version and platform, and builds, with the three official origins pinned in the job's environment (`ONLAY_SERVER_ORIGIN`, `ONLAY_SITE_ORIGIN`, `ONLAY_SERVICE_ORIGIN`), the web app and the landing page (`bun run build:web`: the site staged as `packages/pwa/dist/landing/`), the extension as an unpacked zip and as a Chrome Web Store package (`bun run build:ext:release`, `bun run build:ext:store`), and the stamp tarball (`bun run build:stamp:tarball`); then checks that both extension packages' manifests name exactly the service as host and the service and the site as the pages that may message the extension;
2. copies `onlay-extension.zip` and `onlay-stamp.tgz` into `packages/pwa/dist/download/`, beside the web app;
3. keeps the three packages as the run's `packages-<version>-attempt-<n>` artifact (90 days); these steps run even without the Cloudflare token;
4. applies the D1 migrations, checks that the staged landing page is exactly this run's fresh build (`scripts/stage-site.ts --check`), then deploys with the commit as `SHA` and the version as `EXTENSION_VERSION`;
5. checks that `/healthz` on both `https://app.onlay.dev` and `https://onlay.dev` reports that commit and version; that `https://onlay.dev/download/onlay-extension.zip`, `/download/onlay-stamp.tgz` and `/install` answer; that the landing page is served as this run built it (`scripts/check-landing.ts`: `https://onlay.dev/` is `200`, byte for byte the built document by SHA-256, under its exact Content-Security-Policy, linking to `https://app.onlay.dev/app/` and without `Clear-Site-Data`, while `/app/sw.js` is `404` with it; the script and stylesheets it names answer `200` with their type, `immutable` and byte for byte; the film's `bytes=0-1` is a `206` with exactly `Content-Range: bytes 0-1/<length>` and exactly those two bytes; the stylesheet is `404` on `https://app.onlay.dev`; and `/site/asset-manifest.json` is `404`); that the Worker has `WORKOS_API_KEY`, `SESSION_SECRET` and `SUPER_ADMINS`; that `https://app.onlay.dev/auth/login` redirects to WorkOS's authorize URL whose query holds exactly one `redirect_uri`, the service's callback (a failure prints only those fields, never the redirect's state); that the protected-resource document names `https://app.onlay.dev/mcp`, which with the two redirects below pins the service to `https://app.onlay.dev` and the site to `https://onlay.dev` (swapped or equal settings fail here); that `https://onlay.dev/auth/login` and `/app/` redirect to the service, and `https://app.onlay.dev/install` to the site and `https://app.onlay.dev/` to `/app/`, each compared with the exact `Location`; that `https://onlay.dev/api/me`, `POST /mcp`, `/.well-known/oauth-protected-resource` and `/app/sw.js` there answer 404; and that `Clear-Site-Data: "storage"` comes with `https://onlay.dev/app/` and `/app/sw.js` and with nothing on `https://onlay.dev/`, `https://onlay.dev/install` or `https://app.onlay.dev`, each probe first answering its expected status.

These probes name the official hosts, and a failing redirect probe prints only its status and whether the host and path were the ones expected, never the location it got. A deployment of your own that copies the workflow changes the repository in the job's condition, the pinned origins and the hosts in these steps to its own, and creates its own `production` environment with the two secrets.

## Deploying your own instance

You need a Cloudflare account (Workers, D1 and Durable Objects, and a zone for your domain) and a WorkOS account with AuthKit. The steps below are the one-time setup and a manual deploy. Run them from `packages/server`, signed in with `bunx wrangler login`. The values are examples: the service at `https://app.example.com`, the site at `https://example.com`.

1. **Configuration.** Copy `wrangler.example.jsonc` over `wrangler.jsonc` (or keep it beside and pass `--config wrangler.example.jsonc` to every `wrangler` command) and replace each example value: the routes and zone, `PUBLIC_ORIGIN` and `SITE_ORIGIN` (leave `SITE_ORIGIN` empty to serve everything from one origin, then keep only the service's route), `AUTHKIT_ISSUER` and `WORKOS_CLIENT_ID` (step 5), `EXTENSION_IDS` (step 6), and `PUSH_CONTACT` (a `mailto:` address or an `https:` URL push services may use to reach you; without it they see `PUBLIC_ORIGIN`). Keep the Durable Object class, its migration tag and the crons as they are.

2. **The D1 database.** Create it and put the id it prints in `d1_databases`:

   ```sh
   bunx wrangler d1 create onlay-production
   ```

3. **The migrations** (before every deploy that adds one):

   ```sh
   bunx wrangler d1 migrations apply onlay-production --remote
   ```

4. **The secrets** (each prompts for its value; `.dev.vars.example` says how to make each). The first three are required:

   ```sh
   bunx wrangler secret put WORKOS_API_KEY    # your production WorkOS environment's API key
   bunx wrangler secret put SESSION_SECRET    # 32+ random bytes, made fresh, e.g. `openssl rand -base64 48`
   bunx wrangler secret put SUPER_ADMINS      # comma-separated emails, e.g. you@example.com
   ```

   Web push needs one VAPID key pair for the whole deployment (every space signs with it; without both secrets push is simply off). Mint it once, keep it, and set both values:

   ```sh
   bun -e 'import {generateVapidKeys} from "./src/space/webpush"; console.log(await generateVapidKeys())'
   bunx wrangler secret put VAPID_PUBLIC_KEY   # the publicKey value
   bunx wrangler secret put VAPID_PRIVATE_JWK  # the privateJwk value (a JSON string)
   ```

   Rotating the pair strands every existing subscription until each web app re-subscribes at its next start. Never use the test pair in `src/space/testing/test-vapid.ts`.

5. **WorkOS** (the dashboard, your production environment; its client id and AuthKit domain are `WORKOS_CLIENT_ID` and `AUTHKIT_ISSUER`). Every value here is on the service, except the sign-out URI, which is the site's home page.
   - **Redirect URI:** `https://app.example.com/auth/callback` (the Worker sends `<PUBLIC_ORIGIN>/auth/callback` as `redirect_uri`).
   - **Initiate login URI:** `https://app.example.com/auth/login` (it starts AuthKit sign-in).
   - **Sign-out URI** (Redirects): `https://example.com/`, the default. Signing out of the web app (and signing out everywhere) sends the browser to AuthKit's logout for its sign-in with `return_to` set to `<SITE_ORIGIN>/`, so AuthKit forgets the browser and the next visit asks who you are; WorkOS accepts only a registered sign-out URI there. The web app follows only that logout endpoint (`<WORKOS_API_BASE>/user_management/sessions/logout`, which `/api/me` names as `signOutEndpoint`). With one origin, the sign-out URI is `<PUBLIC_ORIGIN>/`.
   - **MCP** (Connect → Configuration): turn on **Client ID Metadata Document (CIMD)**, and **Dynamic Client Registration (DCR)** for MCP clients that don't support CIMD yet. Add `https://app.example.com/mcp` as a **Resource Indicator** and set it as the default: the Worker accepts only tokens whose audience is `<PUBLIC_ORIGIN>/mcp`, and its `/.well-known/oauth-protected-resource` names that resource.
   - **Sign-in methods** (Authentication). Onlay has no code per method: AuthKit's hosted page offers whatever is enabled here, and the Worker accepts any sign-in whose email is verified. An email code (Magic Auth) needs nothing more. Google and Microsoft each need an OAuth client of your own in that provider's console (WorkOS's shared demo credentials work only in staging), with the redirect URI WorkOS shows for it; their client ids and secrets are entered in WorkOS, and the Worker never sees them. A client secret expires (a Microsoft one after at most two years): note its expiry where you will see it, because until it is replaced that method fails and the others keep working. WorkOS accepts personal Microsoft accounts by default; work and school (Entra ID) accounts are enabled by WorkOS support on request. To check a method after changing it: open `https://app.example.com/auth/login`, choose it, and confirm the provider's own sign-in page appears without an error.

6. **The extension.** Build it for your service (`ONLAY_SERVER_ORIGIN=https://app.example.com ONLAY_SITE_ORIGIN=https://example.com bun run build:ext:release` from the repository root). A release build (`build:ext:release`, `build:ext:store`) refuses an `http:` or loopback origin, so a development `.env` can never ship; `bun run build:ext` is the build for a local server. The manifest's public `key` (`packages/extension/src/manifest.json`) pins the unpacked id; the build prints it, and `EXTENSION_IDS` must list it. Keeping the key gives your build the official unpacked id, so it cannot be installed beside the official one; replace the key with one of your own (see `packages/extension/README.md`) for an id of your own. A store item has an id of its own (below). The landing page (`packages/site/src/config.ts`) and the plugin (`plugin/`) name the official origins and ids too: change them, and the tests that pin them, if you ship those.

7. **Build the web app and the downloads, and deploy** (the routes attach the custom domains; the Durable Object migration `v1` runs on first deploy). Pick a version newer than the one `/healthz` reports, or unpacked installs are not told to update:

   ```sh
   export ONLAY_EXTENSION_VERSION=0.2.<n> ONLAY_STAMP_VERSION=0.2.<n>
   export ONLAY_SERVICE_ORIGIN=https://app.example.com ONLAY_SERVER_ORIGIN=https://app.example.com ONLAY_SITE_ORIGIN=https://example.com
   (cd ../.. && bun run build:web && bun run build:ext:release && bun run build:stamp:tarball)
   mkdir -p ../pwa/dist/download
   cp ../extension/release/onlay-extension.zip ../stamp/release/onlay-stamp.tgz ../pwa/dist/download/
   bun run scripts/stage-site.ts --check
   bunx wrangler deploy --var SHA:$(git rev-parse HEAD) --var EXTENSION_VERSION:$ONLAY_EXTENSION_VERSION
   ```

   The Worker serves only those two names from `download/` (`/download/onlay-extension.zip`, `/download/onlay-stamp.tgz`, with `Cache-Control: no-cache`); a deploy without them answers 404 there, and `/install` still renders.

8. **Check:** `xh https://app.example.com/healthz` and `xh https://example.com/healthz` both answer `{"ok":true,"sha":"<sha>","protocol":2,"extension":"0.2.<n>"}`, `xh -h https://example.com/download/onlay-extension.zip` is `200` with `application/zip`, and `xh -h https://app.example.com/auth/login` redirects to `https://api.workos.com/user_management/authorize`. `bun run scripts/check-landing.ts https://example.com https://app.example.com` checks the landing page against this checkout's build.

`bun run --filter @onlay/server deploy` runs steps 3 and 7's `wrangler deploy` without building the web app or the downloads or setting `SHA`; prefer the steps above. It refuses to deploy unless the staged landing page is exactly the current site build and that build is newer than every source it is made from (`scripts/stage-site.ts --check`, which CI's deploy step runs too): run `bun run build:web` first.

The `dev` environment is never deployed: it has no route, and its `DEV_AUTH` would let anyone sign in as anyone if it ever were reachable.

## The Chrome Web Store

`bun run build:ext:store` writes `packages/extension/release/onlay-extension-store.zip` (CI keeps it in each run's `packages-<version>-attempt-<n>` artifact): the production build without the manifest `key` and without any localhost host permission or `externally_connectable` entry. Nothing uploads it. A store item has an id of its own, different from the unpacked id; the official `EXTENSION_IDS` lists both. Sign-in from a store build works only when the Worker accepts its id, so a new store item (another listing, another account) needs these steps:

1. Copy the id from the item's page in the Chrome Web Store developer dashboard.
2. Add it to `EXTENSION_IDS` in the top level of the Worker's configuration, comma-separated after the unpacked id (keep both: unpacked installs keep signing in): `"EXTENSION_IDS": "<unpacked id>,<store id>"`. `env.dev` needs it only to test the store build locally.
3. Deploy. Until then the store build's Sign in ends on a page saying "This extension can't sign in to Onlay."

A store install updates itself, so its popup never shows the update note; the store build reaches only its service origin, and lets pages on it and on the site message it (only the service's `/auth/extension` page can sign it in; the site may only ask `onlay-ping`).
