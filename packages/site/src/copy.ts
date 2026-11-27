// Every word of the page, in one place.
//
// COPY is the copywriter's text, verbatim, by slot. OWN is what the page
// needed and the copywriter did not supply (labels of controls, sample
// content, accessible names): kept apart so it can be reviewed and replaced.
// The labels inside the demo layer are not here: they are the product's own
// strings (`overlay/strings.ts`, taken from the extension's source).
import { FILM, STORE_LISTED } from "./config";

/** "0:37" from the film's length. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The install button's words: the store's only once the listing is live. */
const INSTALL_CTA = STORE_LISTED ? "Add to Chrome" : "Install the extension";

export const COPY = {
  meta: {
    title: "Onlay — Comments and Edits on any live web page",
    description:
      "A Chrome extension for Comments and Edits on any live web page. Work with teammates and your own coding agent, and track what needs you in one Inbox.",
  },
  nav: {
    links: {
      page: "On the page",
      agent: "Agents",
      inbox: "Inbox",
      privacy: "Privacy",
    },
    webApp: "Open web app",
    install: INSTALL_CTA,
  },
  hero: {
    headline: "Put agent work where it belongs.",
    /** The copywriter's other two headlines: the demo agent's Variants for this one. */
    headlineAlternates: ["Comment and Edit on any live page.", "Work on the page with your agent."],
    sub: "Onlay is a Chrome extension that anchors Comments and Edits to any live web page. Review with teammates, hand work to your own coding agent, and track what needs you in one Inbox.",
    ctaPrimary: INSTALL_CTA,
    ctaSecondary: `Watch the film (${clock(FILM.seconds)})`,
    invite: {
      default: "This page is live. Open the launcher or press Ctrl+., then pick any block.",
      installed: "Onlay is active here. Open the launcher or press Ctrl+., then pick any block.",
    },
  },
  demo: {
    steps: ["Pick a block", "Comment or Edit", "Hand to @agent"],
    note: "Simulated in your browser. Nothing is sent or stored.",
    agentReply:
      "Posted Variants for this headline. Preview them on the live page and pick the one you want.",
    agentOther:
      "This demo only has Variants prepared for the headline. In Onlay, your own coding agent reads this block and answers here.",
    done: "That was Onlay, simulated on this page. The Chrome extension works the same way on every web page you open, with your team and your own coding agent.",
  },
  film: {
    label: "The film",
    headline: `See the loop in ${FILM.seconds} seconds.`,
    body: "From picking a block on a live page to previewing Variants and checking the Inbox.",
  },
  page: {
    label: "On the page",
    headline: "Comment on the exact block.",
    body: "Pick a heading, paragraph, button, image, or the whole page, including inside embedded frames. The thread stays anchored to that block while teammates reply, react, share highlighted code blocks with Copy, and resolve it when done.",
  },
  edit: {
    label: "Edit and Variants",
    headline: "Request an Edit, preview Variants live.",
    body: "Say what should change, or edit by hand in Edit page mode. Agents answer with Variants you compare on the live page. Previews are indicative: where source is known, the real render is the truth; elsewhere, a picked variant can be kept.",
  },
  agent: {
    label: "Your agent",
    headline: "Hand work to your own coding agent.",
    body: "Write @agent in any thread, or create an Edit. Your agent connects over MCP, reads the thread and block, replies, proposes Variants, or updates your source and marks the Edit implemented. It acts as you, and everything it writes is tagged “agent”.",
    setupIntro: "Connect Claude Code, Codex, or any agent that speaks MCP.",
    tabs: { claude: "Claude Code", codex: "Codex", others: "Other agents", mcp: "MCP URL" },
    signin: "Your agent prompts you to sign in the first time it connects.",
  },
  inbox: {
    label: "Inbox and spaces",
    headline: "One Inbox for what needs you.",
    body: "The Inbox shows what needs you, what waits on others or an agent, and what recently resolved across pages and spaces. Work in personal or shared spaces, or share one thread by email, from the extension or the web app on your phone.",
  },
  privacy: {
    label: "Privacy",
    headline: "What the extension reads and sends.",
    statements: [
      "Browsing sends no page content. Creating or updating a thread uploads markup and a screenshot of only that block or page.",
      "When your agent answers your Edit with Variants, your browser automatically captures and uploads each variant of that block.",
      "It also reports how each variant's steps applied to the block's captured copy, as counts and reasons the people who can read the Edit, and their agents, can see.",
      "Page addresses are sent only when you start a thread on any site, or visit sites where your spaces already have threads.",
      "Resolved threads, with their messages and captures, are deleted 30 days after they are resolved.",
      "Onlay does not sell data or use it for advertising.",
    ],
  },
  install: {
    headline: "Use Onlay on any live page.",
    body: STORE_LISTED
      ? "Add the extension from the Chrome Web Store, sign in, and start a Comment or Edit wherever the work lives. Connect your coding agent whenever you are ready."
      : "Install the extension, sign in, and start a Comment or Edit wherever the work lives. Connect your coding agent whenever you are ready.",
    cta: INSTALL_CTA,
    /** Shown only once the store listing is live (until then the button itself leads there). */
    alt: STORE_LISTED
      ? "Prefer to load the extension yourself? See the manual install instructions."
      : null,
    signin: "Sign in with an email code, Google, or Microsoft.",
  },
  footer: {
    description:
      "Onlay anchors Comments and Edits to any live web page, for teams and their coding agents.",
    links: { privacy: "Privacy", install: "Install", webApp: "Web app" },
  },
} as const;

/**
 * Strings the page needed that the copywriter did not supply. Product
 * register: short, exact, no exclamation marks.
 */
export const OWN = {
  skip: "Skip to content",
  brand: "Onlay",
  navLabel: "Sections",
  footerNavLabel: "Onlay links",
  footerLicense: "License",
  footerNotices: "Third-party notices",
  markAlt:
    "The Onlay mark: a ring around the page, open in one place where a signal waits, and a placed point reaching toward it.",
  filmLabel: "The Onlay film",
  demo: {
    /** The words under the rail once the demo is in use. */
    startOver: "Start over",
    /**
     * Beside the simulated bar while it shows an empty Inbox, which lists no
     * commands (as in the product): where the commands are, in the bar's own key.
     */
    emptyInbox: "Your Inbox is empty until you make something. Esc goes back to the commands.",
    /** The key in that sentence: shown as a key, and a control that does what it does. */
    escKey: "Esc",
    /** During a block pick started from the keyboard: its keys, in the bar footer's manner. */
    pickKeys: ["↑↓ move", "↵ pick", "esc cancel"],
    /** The fixed rail's accessible name. */
    railLabel: "Try Onlay on this page",
    dismiss: "Close",
    /** A control the demo shows as the product has it but cannot run. */
    extensionOnly: "Not in this demo. It works in the extension.",
    /** The same, as a chip on a command the demo lists but cannot run. */
    extensionOnlyChip: "extension",
    /** The demo agent's Variants for the headline, by label. */
    variantLabels: ["On any live page", "With your agent", "Lighter"],
    /** The visitor, as the demo names them. */
    you: "You",
    /** The one space the demo has. */
    space: "Personal",
  },
  /** The sample threads in the section fragments (the store listing's own sample page). */
  sample: {
    site: "acme.example/pricing",
    pageTitle: "Simple pricing for small teams",
    pageLede: "One plan, every feature, no seat limits.",
    planTeam: "Team",
    planTeamPrice: "Twelve dollars a month, billed yearly.",
    planStudio: "Studio",
    planStudioPrice: "Forty dollars a month, billed yearly.",
    planTeamPopular: "Team · most popular",
    badge: "Most popular",
    maya: "Maya Chen",
    daniel: "Daniel Ortiz",
    workspace: "acme-studio",
    commentAsk: "@Daniel Ortiz should this say the yearly total instead?",
    commentAnswer: "Monthly reads better. Keep billed yearly under it.",
    editIntent: "Make the Team plan stand out",
    variantLabels: ["Highlighted", "Badge"],
    agentAsk: "@agent can you tighten the headline and the line under it?",
    agentAnswer:
      'Here is a tighter pair, ready to paste:\n```json\n{\n  "headline": "Pricing for small teams",\n  "lede": "One plan with every feature."\n}\n```',
    inbox: [
      "Make the Team plan stand out",
      "@Maya Chen is forty still right for Studio?",
      "@agent could this line be shorter?",
      "Studio copy is approved.",
    ],
  },
  privacyLink: "Read the privacy page",
} as const;
