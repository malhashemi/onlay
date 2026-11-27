/**
 * The edge's own small pages: the dev sign-in form, the extension hand-off,
 * the install and privacy pages, and sign-in errors. Static HTML in onlay's
 * colors, no external resources; scripts only by nonce. (The landing page at
 * `/` is the site's own build: src/edge/landing.ts.)
 */
import { base64url, randomBytes } from "../directory/crypto";
import type { Links } from "./hosts";

/** The space runtime's retention for resolved interactions (spec §7, ADR-0010). */
const RETENTION_RESOLVED_DAYS = 30;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON safe inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

const STYLE = `
:root { color-scheme: light dark; --bg: oklch(99.24% 0 0); --fg: oklch(24.8% 0.0274 228.9);
  --muted: oklch(45.16% 0.0315 220.9); --border: oklch(85.26% 0.0171 203.9);
  --primary: oklch(51.53% 0.1147 206.3); --primary-fg: oklch(99.24% 0 0); }
@media (prefers-color-scheme: dark) { :root { --bg: oklch(17.11% 0.0282 229.7);
  --fg: oklch(97.71% 0.0024 192.1); --muted: oklch(74.12% 0.0249 209.9);
  --border: oklch(24.8% 0.0274 228.9); --primary: oklch(74.74% 0.1307 206.3);
  --primary-fg: oklch(17.11% 0.0282 229.7); } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 3rem 1rem; }
h1 { font-size: 1.35rem; margin: 0 0 1rem; } h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
p, li { color: var(--fg); } .muted { color: var(--muted); }
label { display: block; font-weight: 600; margin-bottom: .35rem; }
input { width: 100%; padding: .55rem .7rem; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: var(--fg); font: inherit; }
button { margin-top: 1rem; padding: .55rem 1rem; border: 0; border-radius: 8px;
  background: var(--primary); color: var(--primary-fg); font: inherit; font-weight: 600; cursor: pointer; }
a { color: var(--primary); }
a.button { display: inline-block; margin: .5rem 0; padding: .55rem 1rem; border-radius: 8px;
  background: var(--primary); color: var(--primary-fg); font-weight: 600; text-decoration: none; }
li { margin: .35rem 0; }
code { font: .92em ui-monospace, SFMono-Regular, Menlo, monospace; padding: .1rem .3rem;
  border: 1px solid var(--border); border-radius: 4px; }
`;

export interface Page {
  html: string;
  csp: string;
}

function page(title: string, body: string, script?: string): Page {
  const nonce = base64url(randomBytes(16));
  const scriptTag = script ? `<script nonce="${nonce}">${script}</script>` : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><main>${body}</main>${scriptTag}</body></html>
`;
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    script ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return { html, csp };
}

export function htmlResponse(
  { html, csp }: Page,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      // A cross-origin opener keeps no handle on these windows (sign-in, the hand-off).
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/** One origin: every link relative, as the pages always were. */
const ONE_ORIGIN: Links = { service: "", site: "" };

/** The signed-out pages' way to the extension, on the public site. */
function installLink(links: Links): string {
  return `<p class="muted">New to Onlay? <a href="${escapeHtml(links.site)}/install">Install the extension</a>.</p>`;
}

/** What Onlay is, in the privacy page's own words. */
const WHAT_ONLAY_IS =
  "Onlay lets people and their agents comment on and edit live web pages together.";

/** `/auth/login` when `DEV_AUTH` is "1": one email field posting to the dev stub. */
export function devLoginPage(returnTo: string, links: Links = ONE_ORIGIN): Page {
  return page(
    "Sign in to Onlay",
    `<h1>Sign in to Onlay</h1>
<p class="muted">Development sign-in. Any email signs in as that person.</p>
<form method="post" action="/auth/dev/session">
<label for="email">Email</label>
<input id="email" name="email" type="email" required autocomplete="email" autofocus>
<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
<button type="submit">Sign in</button>
</form>${installLink(links)}`,
  );
}

/** The extension hand-off: gives the one-time code to the extension that asked for it. */
/**
 * The extension hand-off. It names the account the browser is signed in as,
 * since a browser that already has a session signs the extension in without
 * asking (after the extension's own Sign out too), and says how to switch.
 */
export function handoffPage(ext: string, code: string, state: string, email: string): Page {
  const data = scriptJson({ ext, code, state });
  return page(
    "Signing in to Onlay",
    `<h1>Signing in to Onlay</h1><p id="status">Sending your sign-in to the extension…</p><p class="muted">Signed in as ${escapeHtml(email)}. Wrong account? <a href="/app/#/settings/account">Sign out in the web app</a>, then sign in again from the extension.</p>`,
    `(() => {
  const data = ${data};
  const status = document.getElementById("status");
  const failed = () => { status.textContent = "The extension didn't answer. Close this tab and sign in again from the extension."; };
  const runtime = globalThis.chrome && globalThis.chrome.runtime;
  if (!runtime || !runtime.sendMessage) { failed(); return; }
  try {
    runtime.sendMessage(data.ext, { type: "onlay-auth", code: data.code, state: data.state }, (answer) => {
      if (runtime.lastError) { failed(); return; }
      if (!answer || answer.ok !== true) {
        status.textContent = "The extension couldn't finish signing in. Close this tab and sign in again from the extension.";
        return;
      }
      status.textContent = "You're signed in. You can close this tab.";
    });
  } catch { failed(); }
})();`,
  );
}

/** A sign-in error; "Sign in again" carries `returnTo`, when known, through the next sign-in. */
export function errorPage(
  title: string,
  message: string,
  returnTo?: string,
  links: Links = ONE_ORIGIN,
): Page {
  const again =
    returnTo === undefined
      ? "/auth/login"
      : `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(again)}">Sign in again</a></p>${installLink(links)}`,
  );
}

/**
 * `/install`: how to install the extension from the download, and how to
 * update it. Static: the only value in it is the deployed extension version.
 */
export function installPage(version: string | undefined, links: Links = ONE_ORIGIN): Page {
  const latest = version ? `<p class="muted">Latest version: ${escapeHtml(version)}</p>` : "";
  return page(
    "Install Onlay",
    `<h1>Install the Onlay extension</h1>
<p>Onlay runs in Chrome, Edge, Brave, and other Chromium browsers. It isn't in the Chrome Web Store yet, so you install it from a download. It takes about a minute.</p>
<p><a class="button" href="/download/onlay-extension.zip">Download Onlay</a></p>
${latest}
<h2>Install</h2>
<ol>
<li>Click <strong>Download Onlay</strong> above and unzip <code>onlay-extension.zip</code>. Move the unzipped folder somewhere it can stay, such as your Documents folder, because your browser runs Onlay from it.</li>
<li>Open a new tab, type or paste <code>chrome://extensions</code> into the address bar, and press Enter. Web pages can't link there.</li>
<li>Turn on <strong>Developer mode</strong> (top right in Chrome).</li>
<li>Click <strong>Load unpacked</strong> and select the unzipped Onlay folder, not the <code>.zip</code> file.</li>
<li>Pin Onlay: click the puzzle-piece icon at the top right of your browser, then click the pin next to Onlay.</li>
<li>Click the Onlay button in your toolbar, then click <strong>Sign in</strong>.</li>
</ol>
<h2>Update</h2>
<p>Installed this way, Onlay doesn't update itself. When a newer version is out, clicking the Onlay button in your toolbar shows a note.</p>
<ol>
<li>Download <code>onlay-extension.zip</code> again and unzip it.</li>
<li>Copy the files from the new folder into your existing Onlay folder, replacing the old ones.</li>
<li>Open <code>chrome://extensions</code> and click the reload button (the circular arrow) on Onlay's card. If you don't see it, turn <strong>Developer mode</strong> back on.</li>
</ol>
<p>You stay signed in. Refresh any open tabs where you want to use Onlay.</p>
<p class="muted">Already installed? Open <a href="${escapeHtml(links.service)}/app/">your Inbox</a>. See <a href="/privacy">Privacy</a> for what Onlay stores and for how long.</p>`,
  );
}

export function privacyPage(): Page {
  return page(
    "Privacy · Onlay",
    `<h1>Privacy</h1>
<p>${WHAT_ONLAY_IS} This page explains what Onlay stores and for how long.</p>
<h2>What Onlay stores</h2>
<ul>
<li>Your account: your email address, your name, and your profile picture: the one from your sign-in provider, or one you choose.</li>
<li>What you write: messages, replies, reactions, and edits in threads, and who wrote them. Messages an agent writes for you are marked as written by an agent.</li>
<li>Page content you attach to a thread: the markup of the block or page a thread is about, and screenshots of it.</li>
<li>Files you attach to a thread.</li>
<li>Sign-in records: hashed session and extension tokens, so you stay signed in.</li>
</ul>
<h2>When page content is uploaded</h2>
<p>Browsing a page with the extension installed does not send its content to Onlay. When you create or update a thread, the extension uploads the markup and a screenshot of only the block or page the thread is about. When you have requested an Edit and your agent answers with Variants, the extension in your browser also takes a screenshot and a structured capture of that same block with each variant applied, and uploads them to the thread without a further click from you. For each of those variants it also reports how many of its steps applied to the captured copy of that block and why any did not: counts and reasons only, which the people who can read the Edit and their agents can read. Content is uploaded in no other case, and nothing else on the page is captured: form values, hidden inputs, and page data attributes are left out, and addresses inside the markup are cut to their origin and path.</p>
<h2>When a page's address is sent</h2>
<p>The extension sends a page's address to Onlay when you start a thread on that page (a Comment or an Edit), including the first thread on a site. It also sends the address when you visit pages of a site where one of your spaces already has threads, so the extension can show them. On every other site, nothing about the page is sent.</p>
<h2>How long it is kept</h2>
<ul>
<li>Open threads are kept until they are resolved.</li>
<li>Resolved threads, with their messages and captures, are deleted ${RETENTION_RESOLVED_DAYS} days after they are resolved.</li>
<li>When you delete your account, your sessions, tokens, memberships, and personal space are removed. Messages you wrote in shared workspaces stay, shown as written by "Deleted person".</li>
<li>When a workspace is deleted, everything in it is removed.</li>
</ul>
<h2>Who can see it</h2>
<p>A thread is visible to the members of the space it belongs to, and to the people it is shared with by email. Onlay does not sell your data or use it for advertising.</p>`,
  );
}
