// The page, as markup. Run by the build only: it writes the whole document as
// static HTML (so it is complete with JavaScript off) from the copy module,
// the config, and the fragments and code blocks the build rendered.
import { FILM, installHref, PAGE_ORIGIN, PATHS, serviceUrl } from "./config";
import { COPY, OWN } from "./copy";
import type { FragmentName } from "./fragments";

/** The agent setup's commands (the web app's Settings → Agent is their source: packages/pwa/src/copy-for-agent.ts). */
export const AGENT_SETUP = {
  claude: "claude plugin marketplace add malhashemi/onlay\nclaude plugin install onlay@onlay",
  codex: "codex plugin marketplace add malhashemi/onlay\ncodex plugin add onlay@onlay",
  others: "npx skills add malhashemi/onlay --skill onlay",
  mcpUrl: () => serviceUrl("/mcp"),
  mcpConfig: () =>
    JSON.stringify({ mcpServers: { onlay: { type: "http", url: serviceUrl("/mcp") } } }, null, 2),
} as const;

export type CodeSlot = "claude" | "codex" | "others" | "mcpUrl" | "mcpConfig";

export interface PageParts {
  /** Served paths of the built files. */
  css: string;
  overlayCss: string;
  js: string;
  favicon: string;
  film: string;
  poster: string;
  /** Onlay's licence and the third-party notices, as plain text. */
  license: string;
  notices: string;
  /** Font files to preload. */
  preload: string[];
  fragments: Record<FragmentName, string>;
  code: Record<CodeSlot, string>;
}

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The mark, as `src/assets/favicon.svg` draws it. `parts` names each stroke so the hero can draw them in turn. */
function mark(cls: string, parts = false, label?: string): string {
  const c = (name: string) => (parts ? ` class="${name}" pathLength="1"` : "");
  const d = (name: string) => (parts ? ` class="${name}"` : "");
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="${cls}" viewBox="0 0 512 512" ${a11y}>
<circle${c("m-context")} cx="256" cy="256" r="118" fill="none" stroke="#00C4D7" stroke-width="30" transform="rotate(-38 256 256)"/>
<circle${d("m-point")} cx="229" cy="277" r="36" fill="#00C4D7"/>
<path${c("m-boundary")} d="M 431.9 195.4 A 186 186 0 1 1 357.3 100" fill="none" stroke="#007886" stroke-width="34" stroke-linecap="round"/>
<circle${d("m-signal")} cx="403" cy="141" r="32" fill="#007886"/>
<path${c("m-reach")} d="M 229 277 L 325 202" fill="none" stroke="#00C4D7" stroke-width="20" stroke-linecap="round"/>
</svg>`;
}

const PLAY = `<svg class="cta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>`;

/** The invitation's sentence: its shortcut as a key, and the launcher shown beside its name. */
function inviteLine(text: string, when: "sim" | "own"): string {
  const orb = `<span class="invite-orb" data-open-launcher aria-hidden="true">${mark("")}</span>`;
  const html = esc(text)
    .replace("Ctrl+.", '<kbd class="key">Ctrl+.</kbd>')
    .replace("the launcher", `the launcher${when === "sim" ? orb : ""}`);
  return `<p class="invite-line" data-when="${when}"><span class="invite-dot" aria-hidden="true"></span><span>${html}</span></p>`;
}

function sectHead(no: string, label: string, headline: string, body: string, id: string): string {
  return `<header class="sect-head">
<p class="sect-tag micro"><span class="sect-no">${no}</span><span class="sect-rule" aria-hidden="true"></span><span>${esc(label)}</span></p>
<h2 id="${id}">${esc(headline)}</h2>
${body ? `<p class="sect-body" id="${id}-desc">${esc(body)}</p>` : ""}
</header>`;
}

function stage(name: FragmentName, html: string): string {
  return `<div class="stage" data-fragment="${name}">${html}</div>`;
}

function codeSlot(slot: CodeSlot, lang: string, html: string): string {
  return `<div class="code-slot" data-code="${slot}" data-lang="${lang}">${html}</div>`;
}

export function renderPage(p: PageParts): string {
  const install = installHref();
  const webApp = serviceUrl("/app/");
  const tabs = COPY.agent.tabs;
  const tabIds = ["claude", "codex", "others", "mcp"] as const;
  const preloads = p.preload
    .map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(COPY.meta.title)}</title>
<meta name="description" content="${esc(COPY.meta.description)}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#04161d">
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="canonical" href="${PAGE_ORIGIN}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${PAGE_ORIGIN}/">
<meta property="og:title" content="${esc(COPY.meta.title)}">
<meta property="og:description" content="${esc(COPY.meta.description)}">
<meta property="og:image" content="${PAGE_ORIGIN}${p.poster}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="${p.favicon}">
${preloads}
<link rel="stylesheet" href="${p.css}">
<link rel="stylesheet" href="${p.overlayCss}" data-overlay-css>
<script type="module" src="${p.js}"></script>
</head>
<body>
<a class="skip" href="#main">${esc(OWN.skip)}</a>

<header class="mast">
<div class="wrap mast-in">
<a class="brand" href="/">${mark("brand-mark")}<span>${esc(OWN.brand)}</span></a>
<nav class="mast-nav micro" aria-label="${esc(OWN.navLabel)}">
<a href="#on-the-page">${esc(COPY.nav.links.page)}</a>
<a href="#agents">${esc(COPY.nav.links.agent)}</a>
<a href="#inbox">${esc(COPY.nav.links.inbox)}</a>
<a href="#privacy">${esc(COPY.nav.links.privacy)}</a>
</nav>
<div class="mast-acts">
<a class="mast-app" href="${webApp}">${esc(COPY.nav.webApp)}</a>
<a class="cta cta-primary cta-sm" href="${install}">${esc(COPY.nav.install)}</a>
</div>
</div>
</header>

<main id="main">

<section class="hero" aria-labelledby="headline">
<div class="wrap hero-in">
<div class="hero-copy">
<h1 class="hero-title" id="headline" data-variants="headline">${esc(COPY.hero.headline)}</h1>
<p class="hero-sub">${esc(COPY.hero.sub)}</p>
<div class="hero-acts">
<a class="cta cta-primary" href="${install}">${esc(COPY.hero.ctaPrimary)}</a>
<a class="cta" href="#film" data-play-film>${PLAY}${esc(COPY.hero.ctaSecondary)}</a>
</div>
<div class="invite" data-invite>
${inviteLine(COPY.hero.invite.default, "sim")}
${inviteLine(COPY.hero.invite.installed, "own")}
<div class="invite-rest">
<ol class="steps" data-steps>
${COPY.demo.steps
  .map((label, i) =>
    // The first step is a control of the page: it starts a block pick.
    i === 0
      ? `<li class="step" data-step="0"><button type="button" class="step-go" data-pick-step><span class="step-n" aria-hidden="true">1</span><span class="step-label">${esc(label)}</span></button><span class="sr-only"></span></li>`
      : `<li class="step" data-step="${i}"><span class="step-n" aria-hidden="true">${i + 1}</span><span class="step-label">${esc(label)}</span><span class="sr-only"></span></li>`,
  )
  .join("\n")}
</ol>
<div class="invite-done" data-invite-done hidden>
<p>${esc(COPY.demo.done)}</p>
<a class="cta cta-primary cta-sm" href="${install}">${esc(COPY.install.cta)}</a>
</div>
<p class="invite-note"><span>${esc(COPY.demo.note)}</span><button type="button" class="text-btn" data-start-over hidden>${esc(OWN.demo.startOver)}</button></p>
</div>
</div>
</div>
<div class="hero-mark"><div class="hero-mark-fig">${mark("", true, OWN.markAlt)}</div></div>
</div>
</section>

<section class="sect sect-film" id="film" aria-labelledby="film-h">
<div class="wrap sect-in">
${sectHead("01", COPY.film.label, COPY.film.headline, COPY.film.body, "film-h")}
<div class="sect-main">
<figure class="film">
<div class="film-frame" data-film-frame>
<noscript><video controls playsinline preload="none" width="${FILM.width}" height="${FILM.height}" poster="${p.poster}" aria-label="${esc(OWN.filmLabel)}" aria-describedby="film-h-desc"><source src="${p.film}" type="video/mp4"></video></noscript>
<video data-film data-poster="${p.poster}" controls playsinline preload="none" width="${FILM.width}" height="${FILM.height}" aria-label="${esc(OWN.filmLabel)}" aria-describedby="film-h-desc">
<source src="${p.film}" type="video/mp4">
</video>
<button type="button" class="film-play" data-film-play aria-label="${esc(COPY.hero.ctaSecondary)}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg></button>
</div>
</figure>
</div>
</div>
</section>

<section class="sect" id="on-the-page" aria-labelledby="page-h">
<div class="wrap sect-in">
${sectHead("02", COPY.page.label, COPY.page.headline, COPY.page.body, "page-h")}
<div class="sect-main">${stage("comment", p.fragments.comment)}</div>
</div>
</section>

<section class="sect" id="edit" aria-labelledby="edit-h">
<div class="wrap sect-in">
${sectHead("03", COPY.edit.label, COPY.edit.headline, COPY.edit.body, "edit-h")}
<div class="sect-main">${stage("edit", p.fragments.edit)}</div>
</div>
</section>

<section class="sect" id="agents" aria-labelledby="agent-h">
<div class="wrap sect-in">
${sectHead("04", COPY.agent.label, COPY.agent.headline, COPY.agent.body, "agent-h")}
<div class="sect-main">
${stage("agent", p.fragments.agent)}
<div class="setup" role="group" aria-label="${esc(COPY.agent.label)}">
${tabIds
  .map(
    (id, i) =>
      `<input class="tab-radio" type="radio" name="agent-tab" id="tab-${id}"${i === 0 ? " checked" : ""}>`,
  )
  .join("\n")}
<p class="setup-intro">${esc(COPY.agent.setupIntro)}</p>
<div class="tabs">
${tabIds.map((id) => `<label class="tab" for="tab-${id}">${esc(tabs[id])}</label>`).join("\n")}
</div>
<div class="tab-panels">
<div class="tab-panel" data-tab="claude">${codeSlot("claude", "bash", p.code.claude)}</div>
<div class="tab-panel" data-tab="codex">${codeSlot("codex", "bash", p.code.codex)}</div>
<div class="tab-panel" data-tab="others">${codeSlot("others", "bash", p.code.others)}</div>
<div class="tab-panel" data-tab="mcp">${codeSlot("mcpUrl", "", p.code.mcpUrl)}${codeSlot("mcpConfig", "json", p.code.mcpConfig)}</div>
</div>
<p class="setup-note">${esc(COPY.agent.signin)}</p>
</div>
</div>
</div>
</section>

<section class="sect" id="inbox" aria-labelledby="inbox-h">
<div class="wrap sect-in">
${sectHead("05", COPY.inbox.label, COPY.inbox.headline, COPY.inbox.body, "inbox-h")}
<div class="sect-main">
${stage("inbox", p.fragments.inbox)}
<p class="sect-more"><a class="text-link" href="${webApp}">${esc(COPY.nav.webApp)}</a></p>
</div>
</div>
</section>

<section class="sect" id="privacy" aria-labelledby="privacy-h">
<div class="wrap sect-in">
${sectHead("06", COPY.privacy.label, COPY.privacy.headline, "", "privacy-h")}
<div class="sect-main">
<ul class="facts">
${COPY.privacy.statements.map((s) => `<li>${esc(s)}</li>`).join("\n")}
</ul>
<p class="sect-more"><a class="text-link" href="${PATHS.privacy}">${esc(OWN.privacyLink)}</a></p>
</div>
</div>
</section>

<section class="install" id="install" aria-labelledby="install-h">
<div class="wrap install-in">
<h2 id="install-h">${esc(COPY.install.headline)}</h2>
<div class="install-side">
<p class="install-body">${esc(COPY.install.body)}</p>
<div class="install-acts">
<a class="cta cta-primary" href="${install}">${esc(COPY.install.cta)}</a>
<a class="mast-app" href="${webApp}">${esc(COPY.nav.webApp)}</a>
</div>
${COPY.install.alt ? `<p class="install-alt"><a class="text-link" href="${PATHS.install}">${esc(COPY.install.alt)}</a></p>` : ""}
<p class="install-signin">${esc(COPY.install.signin)}</p>
</div>
</div>
</section>

</main>

<footer class="foot">
<div class="wrap foot-in">
<a class="brand" href="/">${mark("brand-mark")}<span>${esc(OWN.brand)}</span></a>
<p>${esc(COPY.footer.description)}</p>
<nav class="foot-links micro" aria-label="${esc(OWN.footerNavLabel)}">
<a href="${PATHS.privacy}">${esc(COPY.footer.links.privacy)}</a>
<a href="${PATHS.install}">${esc(COPY.footer.links.install)}</a>
<a href="${webApp}">${esc(COPY.footer.links.webApp)}</a>
<a href="${p.license}">${esc(OWN.footerLicense)}</a>
<a href="${p.notices}">${esc(OWN.footerNotices)}</a>
</nav>
</div>
</footer>

</body>
</html>
`;
}
