// The full-page interaction view (ui-spec §4): the page-less surface. Reached
// at chrome-extension://…/interaction.html?id=<uuid> — the guaranteed
// resolution path for interactions whose origin page is offline or gone. It
// renders ENTIRELY from server truth (SW `getInteraction`), so a dead localhost
// tab is no obstacle: header, context, the whole thread, the ask control, and
// the Reply / Resolve actions all draw from the snapshot. Mutations ride the
// SW's participant-scoped HTTP proxy (`interactionCall`). Built with
// createElement only — no innerHTML, CSP-clean (the one static SVG mark is
// parsed, never injected as markup).

import {
  type CaptureRef,
  LIMITS,
  type MutationOp,
  type MutationProgram,
  type PersonSummary,
  parseFences,
  previewFirstLine,
  type RawInteractionSnapshot,
  type RawRichText,
  type Token,
} from "@onlay/protocol";
import { applyProgramToRoot, buildSrcdoc, type RenderResidue } from "@onlay/render";
import { type PlacedToken, placeOutsideFences, renderFencedBody } from "@onlay/render/code-block";
import {
  type AttentionIndex,
  age,
  anchorLabel,
  askIsOpen,
  attachmentCaptures,
  CHIP_LABEL,
  captureResidueLine,
  chipState,
  collectResidue,
  decodeBase64,
  editContextCapture,
  flatRasterRef,
  humanBytes,
  indexAttention,
  isImageMime,
  isLive,
  lookStagePart,
  needsReader,
  originalRungLine,
  type ResidueMeterEntry,
  type RungVerdict,
  residueCopy,
  selectedOptionIds,
  shownUrl,
  snapshotLooks,
  variantLooks,
  variantRungLine,
  variantRungVerdict,
} from "@onlay/render/interaction-view";
import { mentionSpellings, sameRevision, withPrefix } from "@onlay/render/mentions";
import { applyLocalReaction, REACTIONS } from "@onlay/render/reactions";
import { overlayCodeBlock } from "./overlay/code-blocks";
import {
  clearDraft,
  replyQuote,
  restoreDrafts,
  setDraftScope,
  setReplyQuote,
  writeRichDraft,
} from "./overlay/drafts";
import { AGENT_WORK_LABEL, agentWorkStatus, canFollowThrough, KINDS } from "./overlay/kinds";
import { AGENT_WIRE, initialsOf, knownAlias, knownName, unknownPerson } from "./overlay/people";
import { isCapturableAnchor, resnapOf } from "./overlay/resnap-model";
import { sanitizeMarkupForPreview } from "./overlay/sanitize";
import { clientIdFor, confirmSend } from "./overlay/send-ids";
import { type TokenInput, type TokenInputApp, tokenInput } from "./overlay/token-input";
import { paintPicture } from "./picture-face";
import { applyPageTheme, getPrefs, onPrefsChanged } from "./prefs";
import { MARK_SVG } from "./ui/tokens";

type Snapshot = RawInteractionSnapshot;
type ThreadMsg = Snapshot["thread"][number];

interface VariantSummary {
  variantId: string;
  label: string;
  program: MutationOp[];
  version: number;
}
/** The picked block's captured context (server `getVariantSet` proxy). `markup`
 *  is RAW, UNTRUSTED page HTML (may be truncated mid-tag) — parsed + sanitized
 *  before the stage ever mounts it. */
interface VariantElementCtx {
  selector: string;
  tag: string;
  classes: string[];
  textSnippet: string;
  markup: string;
  sourcePointer?: string;
}
interface VariantSetSummary {
  setId: string;
  status: string;
  outcome?: string;
  activeIndex?: number;
  pickedVariantId?: string;
  variants: VariantSummary[];
  element?: VariantElementCtx;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const root = document.getElementById("root") as HTMLElement;
const directory = new Map<string, PersonSummary>();
let selfId: string | null = null;
/** The person's Inbox by thread, from the service worker's last read (`getAttention`). */
let attention: AttentionIndex | null = null;

/** The space this view's interaction lives in (`interaction.html?space=…&id=…`). */
const SPACE_ID = ((): string => {
  try {
    return new URL(location.href).searchParams.get("space") ?? "";
  } catch {
    return "";
  }
})();

function personOf(id: string): PersonSummary {
  return directory.get(id) ?? unknownPerson(id);
}

/**
 * The editor's App slice (token-input.ts): people resolve from the space's
 * directory, and it lists no interactions — the full-page view runs the rich
 * editor with `noAnchors`, so the `#` menu never queries this.
 */
const editorApp: TokenInputApp = {
  person: personOf,
  people: () => [...directory.values()],
  interactions: () => [],
};

/* ── small DOM builders ───────────────────────────────────────────── */

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function svg(paths: string[]): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    s.appendChild(p);
  }
  return s;
}

/** The brand mark, parsed from the static token string (no markup injection). */
function markEl(): HTMLElement {
  const wrap = el("span", "mark");
  try {
    const doc = new DOMParser().parseFromString(MARK_SVG, "image/svg+xml");
    const node = doc.documentElement;
    if (node && node.nodeName.toLowerCase() === "svg") {
      wrap.appendChild(document.importNode(node, true));
    }
  } catch {
    /* wordmark stands alone */
  }
  return wrap;
}

function avatarEl(person: PersonSummary, size: "sm" | "md" = "md"): HTMLElement {
  const node = el("span", `avatar round ${size}`);
  node.title = person.name;
  node.style.background = person.tint || "#4b5563";
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", person.name);
  node.textContent = (person.initials || initialsOf(person.name)).toUpperCase();
  paintPicture(node, person.avatarUrl);
  return node;
}

/** avatar + name inline, for the who → who line and thread rows. */
function actorChip(actor: PersonSummary): HTMLElement {
  const wrap = el("span", "who");
  wrap.appendChild(avatarEl(actor, "sm"));
  wrap.appendChild(el("span", "who-name", actor.name));
  return wrap;
}

/** Every call names this view's space: by-id reads and writes live under it. */
function send<T>(msg: Record<string, unknown>): Promise<T | undefined> {
  return chrome.runtime.sendMessage({ spaceId: SPACE_ID, ...msg }).then(
    (r: T) => r,
    () => undefined,
  );
}

/* ── header ───────────────────────────────────────────────────────── */

function kindChip(kind: Snapshot["kind"]): HTMLElement {
  const spec = KINDS[kind] ?? KINDS.comment;
  const chip = el("span", `chip kind ${spec.cls.replace("k-", "")}`);
  const glyph = el("span", "chip-glyph");
  glyph.appendChild(svg(spec.glyph.paths));
  chip.append(glyph, el("span", undefined, spec.label));
  return chip;
}

function stateChip(state: string, waitsSelf: boolean): HTMLElement {
  const which = chipState(state, waitsSelf);
  return el("span", `chip state ${which}`, CHIP_LABEL[which]);
}

function stakesTick(stakes: string | undefined): HTMLElement | null {
  if (stakes !== "careful" && stakes !== "dangerous") return null;
  const tick = el("span", `stakes ${stakes}`);
  tick.appendChild(el("span", "dot"));
  tick.appendChild(el("span", undefined, stakes));
  return tick;
}

/** The header's chip: the server's attention, as the Inbox shows it (waitingOn until it knows the thread). */
function headerStateChip(s: Snapshot): HTMLElement {
  return stateChip(s.state, needsReader(s, selfId, attention));
}

function header(s: Snapshot): HTMLElement {
  const head = el("header", "head");

  const chips = el("div", "chips");
  chips.appendChild(kindChip(s.kind));
  chips.appendChild(headerStateChip(s));
  const tick = stakesTick(s.ask?.stakes);
  if (tick) chips.appendChild(tick);
  const work = agentWorkStatus(s.agentWork);
  if (work) chips.appendChild(el("span", "age", AGENT_WORK_LABEL[work]));
  chips.appendChild(el("span", "age", age(s.createdAt)));
  head.appendChild(chips);

  const who = el("div", "who-line");
  who.appendChild(actorChip(personOf(s.authorId)));
  if (s.waitingOn.length > 0) {
    who.appendChild(el("span", "arrow", "→"));
    for (const id of s.waitingOn) who.appendChild(actorChip(personOf(id)));
  }
  head.appendChild(who);
  return head;
}

/* ── context ──────────────────────────────────────────────────────── */

function contextBlock(s: Snapshot): HTMLElement {
  const ctx = el("section", "context");
  const label =
    s.anchor.level === "unanchored"
      ? "unanchored — answer here, or Anchor it to a page"
      : anchorLabel(s.anchor);
  ctx.appendChild(el("div", "ctx-line anchor", label));

  if (s.anchorLost) ctx.appendChild(el("div", "ctx-line lost", "anchor lost"));

  const page = shownUrl(s);
  if (page) {
    const line = el("div", "ctx-line url");
    line.appendChild(el("span", "ctx-url", page));
    const link = document.createElement("a");
    link.href = page;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "ctx-open";
    link.textContent = "open page ↗";
    line.appendChild(link);
    ctx.appendChild(line);
  }
  return ctx;
}

/* ── the edit brief — a change reads standalone: the REQUEST is the
   headline, with its method and lifecycle state under it. When the change
   carries a variant set, the Variants section below renders the comparison
   from a participant-scoped read (no live page needed). ── */

function changeOf(s: Snapshot): { intent: string; method?: string; variantSetId?: string } | null {
  const change = (s as { change?: { intent: string; method?: string; variantSetId?: string } })
    .change;
  return s.kind === "change" && change ? change : null;
}

/** An intent has no pills: nothing is ever placed. */
const noPill = (): Node => document.createTextNode("");

function editBrief(s: Snapshot): HTMLElement | null {
  const change = changeOf(s);
  if (!change) return null;
  const wrap = el("section", "edit-brief");
  const intent = el("div", "edit-intent");
  intent.appendChild(
    renderFencedBody(document, change.intent, parseFences(change.intent), [], noPill, (b) =>
      overlayCodeBlock(document, b),
    ),
  );
  wrap.appendChild(intent);
  const meta = el("div", "edit-meta");
  meta.appendChild(el("span", undefined, `method: ${change.method ?? "direct"}`));
  meta.appendChild(el("span", "sep", "·"));
  meta.appendChild(el("span", "edit-state", s.state));
  wrap.appendChild(meta);
  return wrap;
}

/* ── the ask brief — an ask reads standalone the same way: the QUESTION is
   the headline, its context (author-supplied text, never markup) beneath it.
   The options control renders separately, below the captured look. ── */

function askBrief(s: Snapshot): HTMLElement | null {
  const ask = s.ask;
  if (s.kind !== "ask" || !ask?.question) return null;
  const wrap = el("section", "ask-brief");
  wrap.appendChild(el("div", "ask-q", ask.question));
  if (ask.context) wrap.appendChild(el("div", "ask-ctx", ask.context));
  return wrap;
}

/* ── variants — one card per variant, its mutation program read plainly. All
   variant content is untrusted: every op field lands via textContent, never
   markup. ── */

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function opSummary(op: MutationOp): HTMLElement {
  const row = el("div", "variant-op");
  const kind = (label: string): void => void row.appendChild(el("span", "op-kind", label));
  if (op.op === "setText") {
    kind("text");
    row.appendChild(el("span", "op-val", `“${truncate(op.text, 140)}”`));
  } else if (op.op === "setStyle") {
    kind("style");
    if (op.props.length <= 3) {
      row.appendChild(
        el("span", "op-val", op.props.map((p) => `${p.prop}: ${p.value}`).join("; ")),
      );
    } else {
      // A theme swap sets DOZENS of custom properties — fold them behind a
      // count so the card reads as a decision, not a stylesheet.
      const fold = el("details", "op-fold");
      fold.appendChild(
        el(
          "summary",
          "op-val",
          `${op.props.length} properties — ${op.props
            .slice(0, 3)
            .map((p) => p.prop)
            .join(", ")}, …`,
        ),
      );
      const body = el("div", "op-fold-body");
      for (const p of op.props)
        body.appendChild(el("div", "op-prop", `${p.prop}: ${truncate(p.value, 80)}`));
      fold.appendChild(body);
      row.appendChild(fold);
    }
  } else if (op.op === "setClass") {
    kind("class");
    const parts: string[] = [];
    if (op.add.length > 0) parts.push(op.add.map((c) => `+${c}`).join(" "));
    if (op.remove.length > 0) parts.push(op.remove.map((c) => `−${c}`).join(" "));
    row.appendChild(el("span", "op-val", parts.join("  ")));
  } else if (op.op === "setAttr") {
    kind("attr");
    row.appendChild(
      el("span", "op-val", op.value === null ? `${op.name} (removed)` : `${op.name}: ${op.value}`),
    );
  } else {
    kind("insert");
    // Fragment markup shown as an inert monospace snippet — textContent only.
    row.appendChild(el("code", "op-frag", truncate(op.html, 160)));
  }
  return row;
}

function variantCard(
  v: VariantSummary,
  picked: boolean,
  onPick: ((btn: HTMLButtonElement) => void) | null,
): HTMLElement {
  const card = el("article", `variant-card${picked ? " picked" : ""}`);
  const head = el("div", "variant-card-head");
  head.appendChild(el("span", "variant-label", v.label || v.variantId));
  if (picked) head.appendChild(el("span", "variant-pick", "picked"));
  card.appendChild(head);
  const ops = el("div", "variant-ops");
  if (v.program.length === 0) ops.appendChild(el("div", "variant-op empty", "no changes"));
  const OPS_PREVIEW = 6;
  for (const op of v.program.slice(0, OPS_PREVIEW)) ops.appendChild(opSummary(op));
  if (v.program.length > OPS_PREVIEW) {
    const fold = el("details", "op-fold");
    fold.appendChild(el("summary", "op-val", `+${v.program.length - OPS_PREVIEW} more ops`));
    for (const op of v.program.slice(OPS_PREVIEW)) fold.appendChild(opSummary(op));
    ops.appendChild(fold);
  }
  card.appendChild(ops);
  if (onPick) {
    const foot = el("div", "variant-card-foot");
    const pickBtn = el("button", "btn primary sm", "Pick") as HTMLButtonElement;
    // isTrusted-gated: only a real user gesture picks (a variant lands the Edit).
    pickBtn.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      onPick(pickBtn);
    });
    foot.appendChild(pickBtn);
    card.appendChild(foot);
  }
  return card;
}

function pickedGuess(set: VariantSetSummary): number {
  // A concrete pickedVariantId wins; else, once implementing/verifying/picked,
  // the active index IS the chosen one.
  if (set.pickedVariantId !== undefined) {
    return set.variants.findIndex((v) => v.variantId === set.pickedVariantId);
  }
  const decided =
    set.status === "implementing" ||
    set.status === "verifying" ||
    (set.status === "resolved" && set.outcome === "picked");
  return decided && set.activeIndex !== undefined ? set.activeIndex : -1;
}

type VariantAct = (
  btn: HTMLButtonElement,
  op: "pick" | "discard",
  payload: Record<string, unknown>,
) => Promise<void>;

// The stage's shadow root gets a MINIMAL neutral base — `all: initial` resets
// every inherited page style at the boundary (the page's tokens must not leak
// IN), `contain` traps any position:fixed the untrusted block smuggles inside
// our own page, and a light canvas keeps the block legible under either theme.
// This is exactly the "indicative" contract: structure + inline/custom-property
// styling render, the origin stylesheets do not.
const STAGE_DOC_CSS = `
body { margin: 0; padding: 8px; background: #fff; color: #111;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.5; }
* { box-sizing: border-box; }
img, svg, video, canvas { max-width: 100%; height: auto; }
a { color: #2563eb; }
`;

/** Remembered display cursor per set (−1 = Original), so the page's quiet server
 *  re-pulls don't reset where the human navigated in the stage. */
const stageCursor = new Map<string, number>();

/**
 * Parse + sanitize the captured block into a detached root ready to clone per
 * variant — or null when the markup is missing/unparseable (the degrade-to-
 * cards signal). It stays in its own inert parsed document: captured markup is
 * never imported into this extension page; it is only ever shown inside a
 * `sandbox=""` frame (`stageSrcdoc`).
 */
function stagePristine(set: VariantSetSummary): Element | null {
  const markup = set.element?.markup;
  if (!markup) return null;
  return sanitizeMarkupForPreview(markup);
}

/**
 * The sandboxed document a legacy block preview renders in: no scripts, an
 * opaque origin, and a policy that loads nothing from anywhere (inline styles
 * and data: images only), so captured markup can neither run nor fetch.
 */
function stageSrcdoc(block: Element): string {
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    `<style>${STAGE_DOC_CSS}</style>`,
    "</head><body>",
    block.outerHTML,
    "</body></html>",
  ].join("");
}

/**
 * The preview STAGE — the standalone twin of the on-page cycle. It renders the
 * captured block VISUALLY inside an isolated shadow root and lets the human
 * navigate Original → each variant (‹ ›, pills, left/right when focused),
 * re-cloning the pristine block and applying the displayed variant's program on
 * top. Pick binds to the shown variant; a comment composer beneath the controls
 * routes a reply, prefixed like the on-page panel, to the owning edit thread.
 */
function variantStage(
  set: VariantSetSummary,
  pristine: Element,
  interactionId: string,
  act: VariantAct,
): HTMLElement {
  const variants = set.variants;
  const canPick = set.status === "previewing";
  const pickedIndex = pickedGuess(set);

  const stored = stageCursor.get(set.setId);
  let index: number =
    stored === undefined || stored >= variants.length
      ? pickedIndex >= 0
        ? pickedIndex
        : -1
      : stored;

  const stage = el("section", "variant-stage");

  // ── nav row ──
  const nav = el("div", "stage-nav");
  const prev = el("button", "btn sm", "‹") as HTMLButtonElement;
  const current = el("span", "stage-current");
  const next = el("button", "btn sm", "›") as HTMLButtonElement;
  nav.append(prev, current, next);

  // ── pills: Original + one per variant ──
  const pills = el("div", "stage-pills");
  const pillButtons: Array<[number, HTMLButtonElement]> = [];
  const pillFor = (i: number, label: string): HTMLButtonElement => {
    const p = el("button", "stage-pill", label) as HTMLButtonElement;
    p.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      index = i;
      paint();
    });
    return p;
  };
  pillButtons.push([-1, pillFor(-1, "Original")]);
  variants.forEach((v, i) => {
    pillButtons.push([i, pillFor(i, v.label || `#${i + 1}`)]);
  });
  for (const [, p] of pillButtons) pills.appendChild(p);

  // ── the stage: a sandboxed frame (captured markup never enters this page) ──
  const frame = el("div", "stage-frame");
  const host = el("div", "stage-host");
  host.tabIndex = 0;
  const view = document.createElement("iframe");
  // Attribute-present-empty = the most restrictive sandbox: opaque origin, no
  // scripts. Set before any srcdoc, and never given a token.
  view.setAttribute("sandbox", "");
  view.className = "cap-frame";
  view.title = "variant preview";
  host.appendChild(view);
  const micro = el("div", "stage-micro", "indicative preview — origin styles absent");
  const note = el("div", "stage-note");
  note.style.display = "none";
  frame.append(host, micro, note);

  // ── Pick binds to the DISPLAYED variant (disabled on Original) ──
  const actions = el("div", "stage-actions");
  const pickBtn = el("button", "btn primary sm", "Pick this variant") as HTMLButtonElement;
  pickBtn.addEventListener("click", (e) => {
    if (!e.isTrusted || index < 0) return;
    void act(pickBtn, "pick", { index });
  });
  actions.appendChild(pickBtn);

  // ── comment composer, bound to the DISPLAYED variant ──
  const commentWrap = el("div", "stage-comment");
  const commentEditor = tokenInput(editorApp, "Comment on this variant… @mention to route", {
    multiline: true,
    noAnchors: true,
    draftKey: `fullview-variant-comment:${set.setId}`,
    onSend: () => void sendComment(),
  });
  commentEditor.wrap.classList.add("stage-comment-editor");
  const commentBtn = el("button", "btn sm", "Comment") as HTMLButtonElement;
  const commentMsg = el("div", "stage-comment-msg");
  const commentRow = el("div", "stage-comment-row");
  commentRow.appendChild(commentBtn);
  commentWrap.append(commentEditor.wrap, commentRow, commentMsg);

  async function sendComment(): Promise<void> {
    if (index < 0) return;
    const v = variants[index];
    if (!v) return;
    const body = commentEditor.value();
    if (!body.text) return;
    commentMsg.textContent = "";
    commentMsg.classList.remove("err", "ok");
    // Prefix exactly as the on-page panel's commentOnActive, capped at the
    // comment limit, and routed on the owning edit through the same reply proxy
    // the page's main reply box uses.
    const prefix = `Variant ${index + 1}/${variants.length} — ${v.label || v.variantId}: `;
    const sent = withPrefix(body, prefix, LIMITS.MAX_COMMENT_TEXT);
    // A retry of an unconfirmed send reuses its id: the server answers it once (M-1).
    const place = `fullview-variant-comment:${set.setId}`;
    const clientId = clientIdFor(place, sent);
    commentBtn.disabled = true;
    const res = await send<{ ok: boolean }>({
      type: "interactionCall",
      id: interactionId,
      op: "reply",
      body: { body: sent, clientId },
    });
    commentBtn.disabled = false;
    if (res?.ok) {
      confirmSend(place, clientId);
      if (sameRevision(commentEditor.value(), body)) commentEditor.clear();
      commentMsg.textContent = "Comment posted to the edit thread.";
      commentMsg.classList.add("ok");
    } else {
      commentMsg.textContent = "Couldn't post that comment. Try again.";
      commentMsg.classList.add("err");
    }
  }
  commentBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void sendComment();
  });

  // ── paint: re-clone the pristine block, apply the displayed variant ──
  function paint(): void {
    stageCursor.set(set.setId, index);
    // Wrap the clone so the block has a parent: an insert-after variant lands a
    // sibling BESIDE the root (root.after needs a parent), and replace hides the
    // root and inserts beside it — both render inside the wrapper.
    // Built in the pristine block's own inert document, never this page's.
    const doc = pristine.ownerDocument;
    const wrapper = doc.createElement("div");
    const root = pristine.cloneNode(true) as Element;
    wrapper.appendChild(root);
    note.textContent = "";
    note.style.display = "none";
    if (index < 0) {
      current.textContent = "Original — unchanged";
    } else {
      const v = variants[index];
      current.textContent = v ? `${index + 1}/${variants.length} — ${v.label || v.variantId}` : "—";
      if (v) {
        const res = applyProgramToRoot(root, v.program);
        if (res.misses > 0 || res.rejected > 0) {
          note.textContent =
            res.applied === 0
              ? "this variant edits outside the captured block"
              : "some of this variant's changes fall outside the captured block";
          note.style.display = "block";
        }
      }
    }
    view.srcdoc = stageSrcdoc(wrapper);
    for (const [i, p] of pillButtons) p.classList.toggle("on", i === index);
    pickBtn.disabled = !canPick || index < 0;
    commentWrap.style.display = index >= 0 ? "flex" : "none";
  }

  // ── nav wiring (Original at −1, wrapping) ──
  const cycle = (delta: number): void => {
    const n = variants.length;
    let d = index + delta;
    if (d < -1) d = n - 1;
    if (d > n - 1) d = -1;
    index = d;
    paint();
  };
  prev.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    cycle(-1);
  });
  next.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    cycle(1);
  });
  // Left/right cycle only when the stage itself holds focus — the comment editor
  // lives outside the host, so its arrows are never stolen.
  host.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      cycle(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      cycle(1);
    }
  });

  stage.append(nav, pills, frame, actions, commentWrap);
  paint();
  return stage;
}

/* ── rung 1: the portable-capture stage (render spec §2) ─────────────── */

/** Fields the capture spec's §10 protocol edits derive onto `CaptureRef` (the
 *  residue summary + viewport/habitat geometry). Read defensively: they ride the
 *  ref once the capture-side edit lands, and the stage degrades gracefully until
 *  then (no meter residue, intrinsic sizing). `RESIDUE_RANK` / `residueCopy` /
 *  `collectResidue` now live in `@onlay/render/interaction-view` — the one
 *  honesty-meter model both the desk stage and the PWA render from (S-FINAL). */
interface CaptureExtras {
  residue?: ResidueMeterEntry[];
  viewport?: { innerWidth: number; innerHeight: number; dpr: number; layoutWidth: number };
  blockRect?: { x: number; y: number; width: number; height: number };
  habitatRect?: { x: number; y: number; width: number; height: number };
}

const idleCallback = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
  .requestIdleCallback;
/** Build a neighbor frame when the tab is idle, or on the next tick as a fallback. */
function whenIdle(cb: () => void): void {
  if (idleCallback) idleCallback(cb);
  else setTimeout(cb, 0);
}

/**
 * The stops×rungs preview STAGE (render §2.2 + the F30 display law, F34): the
 * same shell as `variantStage` — nav row, Original+per-variant pills, ‹ ›,
 * Pick, the per-variant comment composer — showing every stop's BEST evidence:
 * its live-page witness raster (rung 1/2 — the Original's edit-context witness,
 * a variant's automatic `variant-look`) when a fresh one exists, else the
 * portable reconstruction in a `sandbox=""` iframe (rung 3/4). The trust line
 * names the rung in the ONE shared grammar (@onlay/render — the PWA compare
 * card speaks it verbatim); Pick prominence follows `variantRungVerdict`; the
 * compare toggle (button, `w`, or press-and-hold on the stage) flips to the
 * Original's LIKE evidence — witness↔witness or recon↔recon, never mixed —
 * side-by-side when the pane is wide enough. The Original frame is persistent;
 * ±1 neighbors pre-build at idle; an LRU pool of ≤4 frames bounds memory.
 *
 * This path emits NO `"indicative preview — origin styles absent"` label and no
 * `all: initial` reset — the reconstruction is faithful, so the caveat that was
 * honest on rung 2 would be a lie here (render §2.6/§5).
 */
function captureStage(
  set: VariantSetSummary,
  cap: CaptureRef,
  s: Snapshot,
  interactionId: string,
  act: VariantAct,
): HTMLElement {
  const variants = set.variants;
  const canPick = set.status === "previewing";
  const pickedIndex = pickedGuess(set);
  const extras = cap as CaptureRef & CaptureExtras;

  // ── the F30 evidence map: each variant's freshest live-page witness ──
  const looks = variantLooks(s, set.setId, variants);
  /** Witness fetches that came back empty — the stop falls to the recon rung. */
  const failedWitness = new Set<string>();
  const capWitnessOk =
    cap.parts.some((p) => p.role === "witness" || p.name === "witness") && !flatRasterRef(cap);
  /** The ref whose witness raster this stop SHOWS — null = reconstruction. */
  const witnessRefOf = (i: number): CaptureRef | null => {
    if (i < 0) return capWitnessOk && !failedWitness.has(cap.captureId) ? cap : null;
    const v = variants[i];
    const look = v ? looks.get(v.variantId) : undefined;
    if (!look || look.stale || flatRasterRef(look.ref) || failedWitness.has(look.ref.captureId)) {
      return null;
    }
    return look.ref;
  };

  const stored = stageCursor.get(set.setId);
  let index: number =
    stored === undefined || stored >= variants.length
      ? pickedIndex >= 0
        ? pickedIndex
        : -1
      : stored;

  const stage = el("section", "variant-stage");

  // ── nav row ──
  const nav = el("div", "stage-nav");
  const prev = el("button", "btn sm", "‹") as HTMLButtonElement;
  const current = el("span", "stage-current");
  const next = el("button", "btn sm", "›") as HTMLButtonElement;
  nav.append(prev, current, next);

  // ── pills: Original + one per variant ──
  const pills = el("div", "stage-pills");
  const pillButtons: Array<[number, HTMLButtonElement]> = [];
  const pillFor = (i: number, label: string): HTMLButtonElement => {
    const p = el("button", "stage-pill", label) as HTMLButtonElement;
    p.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      index = i;
      show();
    });
    return p;
  };
  pillButtons.push([-1, pillFor(-1, "Original")]);
  variants.forEach((v, i) => {
    pillButtons.push([i, pillFor(i, v.label || `#${i + 1}`)]);
  });
  for (const [, p] of pillButtons) pills.appendChild(p);

  // ── the frame: a scrollable box holding the iframe stack + witness layers ──
  const frame = el("div", "stage-frame");
  const box = el("div", "cap-box");
  box.tabIndex = 0;
  const layers = el("div", "cap-layers");
  const layoutWidth = extras.viewport?.layoutWidth;
  const habitatHeight = extras.habitatRect?.height;
  // The RECON canvas metrics: the page's layout width, the habitat's height.
  if (layoutWidth && layoutWidth > 0) layers.style.setProperty("--cap-w", `${layoutWidth}px`);
  layers.style.setProperty(
    "--cap-h",
    `${habitatHeight && habitatHeight > 0 ? Math.min(habitatHeight, 4000) : 360}px`,
  );
  /** A lone witness renders PWA-native (F34.1/F34.2): no scroll canvas at all —
   *  the `.witness-native` class swaps the layers to fit-content and the img to
   *  static flow at its own CSS size (`--wit-w`, scaled down to fit the pane).
   *  Stretching a 727px raster across a 2259px recon canvas buried it in white
   *  overflow behind scrollbars (seen live, twice). Recon stops keep the
   *  scrollable layout-width canvas — a reconstruction is a live page fragment;
   *  a witness is a photograph. */
  const sizeLayersTo = (ref: CaptureRef | null): void => {
    const ex = ref as (CaptureRef & CaptureExtras) | null;
    const r = ex?.habitatRect ?? ex?.blockRect;
    box.classList.toggle("witness-native", ref !== null);
    if (ref && r && r.width > 0) layers.style.setProperty("--wit-w", `${r.width}px`);
    else layers.style.removeProperty("--wit-w");
    if (ref) box.scrollTo(0, 0); // a leftover canvas scroll must not hide the raster
  };
  box.appendChild(layers);

  const trust = el("div", "cap-trust");
  const caution = el("div", "cap-caution");
  caution.style.display = "none";
  const meter = el("div", "cap-meter");
  const note = el("div", "stage-note");
  note.style.display = "none";
  frame.append(box, trust, caution, meter, note);

  // ── part bytes ride the page-lifetime cache (a shared font fetched once —
  //    and, since the stage is rebuilt by every live poll, fetched once per
  //    REVISION rather than once per rebuild). Generalized per REF (F34): a
  //    variant stop's witness lives on its OWN variant-look capture. ──
  const fetchPartOf = (ref: CaptureRef, name: string): Promise<Uint8Array | null> => {
    const key = partKey(ref, name);
    let pending = partBytes.get(key);
    if (!pending) {
      const mime =
        ref.parts.find((p) => p.name === name)?.mime ??
        ref.parts.find((p) => p.role === name)?.mime ??
        "application/octet-stream";
      pending = send<{ ok: boolean; b64?: string }>({
        type: "getCapturePart",
        id: ref.interactionId,
        captureId: ref.captureId,
        name,
        mime,
      }).then((res) => {
        const bytes = res?.ok && res.b64 ? decodeBase64(res.b64) : null;
        if (bytes === null) {
          partBytes.delete(key); // a miss must retry next render
          partFetchMissed = true;
        }
        return bytes;
      });
      partBytes.set(key, pending);
    }
    return pending;
  };
  const fetchPart = (name: string): Promise<Uint8Array | null> => fetchPartOf(cap, name);

  // ── the witness layers, one per stop that HAS one (they reuse the .cap-witness
  //    styling the blink layer wore; bytes ride the page-lifetime part cache) ──
  const stopImgs = new Map<number, HTMLImageElement>();
  const stopImgFor = (i: number, ref: CaptureRef): HTMLImageElement => {
    const existing = stopImgs.get(i);
    if (existing) return existing;
    const img = document.createElement("img");
    img.className = "cap-witness";
    img.hidden = true;
    img.alt = i < 0 ? "original — captured screenshot" : "variant — captured on the live page";
    layers.appendChild(img);
    stopImgs.set(i, img);
    void fetchPartOf(ref, "witness").then((bytes) => {
      if (bytes) {
        const mime = ref.parts.find((p) => p.role === "witness")?.mime ?? "image/webp";
        img.src = cachedPartUrl(ref, "witness", bytes, mime);
      } else {
        // Bytes never arrived: demote honestly and re-show UNCONDITIONALLY —
        // this img may be the COMPARE layer for another stop (codex-f34-2).
        failedWitness.add(ref.captureId);
        show();
      }
    });
    return img;
  };

  // ── the double-buffered iframe pool (LRU ≤4; Original persistent) ──
  interface PoolFrame {
    iframe: HTMLIFrameElement;
    built: Promise<void>;
    residue: RenderResidue | null;
    /** BuildSrcdocResult.failed — the frame holds the honest failure page. */
    failed: boolean;
    shownAt: number;
  }
  const MAX_POOL = 4;
  const frames = new Map<number, PoolFrame>();
  let showTick = 0;

  const programFor = (i: number): MutationProgram | undefined =>
    i < 0 ? undefined : variants[i]?.program;

  const evictIfNeeded = (): void => {
    if (frames.size <= MAX_POOL) return;
    let victim: number | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [i, f] of frames) {
      if (i < 0 || i === index) continue; // Original + the shown frame are pinned
      if (f.shownAt < oldest) {
        oldest = f.shownAt;
        victim = i;
      }
    }
    if (victim !== null) {
      frames.get(victim)?.iframe.remove();
      frames.delete(victim);
    }
  };

  const frameFor = (i: number): PoolFrame => {
    const existing = frames.get(i);
    if (existing) return existing;
    const iframe = document.createElement("iframe");
    // Attribute-present-empty = the most restrictive sandbox (A24): opaque
    // origin, no allow-scripts, no allow-same-origin. Never add a token.
    iframe.setAttribute("sandbox", "");
    iframe.className = "cap-frame";
    iframe.hidden = true;
    layers.appendChild(iframe);
    const pf: PoolFrame = {
      iframe,
      built: Promise.resolve(),
      residue: null,
      failed: false,
      shownAt: 0,
    };
    // Omit `program` entirely for the Original (exactOptionalPropertyTypes: a
    // present-but-undefined `program` is not the same as absent).
    const program = programFor(i);
    pf.built = buildSrcdoc(
      program === undefined ? { ref: cap, fetchPart } : { ref: cap, fetchPart, program },
    ).then((r) => {
      iframe.srcdoc = r.srcdoc;
      pf.residue = r.residue;
      pf.failed = r.failed === true;
    });
    frames.set(i, pf);
    evictIfNeeded();
    return pf;
  };

  const prebuild = (i: number): void => {
    if (i < -1 || i >= variants.length || frames.has(i)) return;
    whenIdle(() => {
      if (!frames.has(i)) frameFor(i);
    });
  };

  // ── the verdict (F30 display law): Pick prominence follows the EVIDENCE PAIR ──
  const originalTrusted = (): boolean => {
    if (witnessRefOf(-1)) return true;
    const of = frames.get(-1);
    return of !== undefined && of.residue !== null && !of.failed;
  };
  const verdictOf = (i: number): RungVerdict | null => {
    const v = variants[i];
    if (!v) return null;
    const raw = looks.get(v.variantId);
    // A flat or unfetchable raster anchors NO rung-2 verdict — the stop shows
    // (and is judged as) its reconstruction.
    const look =
      raw && !flatRasterRef(raw.ref) && !failedWitness.has(raw.ref.captureId) ? raw : undefined;
    const pf = frames.get(i);
    const trusted = witnessRefOf(i) !== null ? witnessRefOf(-1) !== null : originalTrusted();
    return variantRungVerdict({
      look,
      render: pf?.residue ?? null,
      renderFailed: pf?.failed === true,
      originalTrusted: trusted,
    });
  };

  // ── Pick binds to the DISPLAYED variant (disabled on Original) ──
  const actions = el("div", "stage-actions");
  const pickBtn = el("button", "btn primary sm", "Pick this variant") as HTMLButtonElement;
  pickBtn.addEventListener("click", (e) => {
    if (!e.isTrusted || index < 0) return;
    void act(pickBtn, "pick", { index });
  });
  const compareBtn = el(
    "button",
    "btn sm cap-witness-btn",
    "Hold against the Original",
  ) as HTMLButtonElement;
  actions.append(pickBtn, compareBtn);

  // ── comment composer, bound to the DISPLAYED variant (verbatim rung-2 wiring) ──
  const commentWrap = el("div", "stage-comment");
  const commentEditor = tokenInput(editorApp, "Comment on this variant… @mention to route", {
    multiline: true,
    noAnchors: true,
    draftKey: `fullview-variant-comment:${set.setId}`,
    onSend: () => void sendComment(),
  });
  commentEditor.wrap.classList.add("stage-comment-editor");
  const commentBtn = el("button", "btn sm", "Comment") as HTMLButtonElement;
  const commentMsg = el("div", "stage-comment-msg");
  const commentRow = el("div", "stage-comment-row");
  commentRow.appendChild(commentBtn);
  commentWrap.append(commentEditor.wrap, commentRow, commentMsg);

  async function sendComment(): Promise<void> {
    if (index < 0) return;
    const v = variants[index];
    if (!v) return;
    const value = commentEditor.value();
    if (!value.text) return;
    commentMsg.textContent = "";
    commentMsg.classList.remove("err", "ok");
    const prefix = `Variant ${index + 1}/${variants.length} — ${v.label || v.variantId}: `;
    const sent = withPrefix(value, prefix, LIMITS.MAX_COMMENT_TEXT);
    // A retry of an unconfirmed send reuses its id: the server answers it once (M-1).
    const place = `fullview-variant-comment:${set.setId}`;
    const clientId = clientIdFor(place, sent);
    commentBtn.disabled = true;
    const res = await send<{ ok: boolean }>({
      type: "interactionCall",
      id: interactionId,
      op: "reply",
      body: { body: sent, clientId },
    });
    commentBtn.disabled = false;
    if (res?.ok) {
      confirmSend(place, clientId);
      if (sameRevision(commentEditor.value(), value)) commentEditor.clear();
      commentMsg.textContent = "Comment posted to the edit thread.";
      commentMsg.classList.add("ok");
    } else {
      commentMsg.textContent = "Couldn't post that comment. Try again.";
      commentMsg.classList.add("err");
    }
  }
  commentBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void sendComment();
  });

  // ── the like-evidence compare (F30/F34, replacing the §2.5 blink): while ON,
  //    the stage shows the ORIGINAL beside/instead of the shown stop — its LIKE
  //    evidence (witness↔witness, recon↔recon); on the Original stop itself the
  //    flip is the old §2.5 fidelity blink (witness ↔ reconstruction). ──
  let compareOn = false;
  const setCompare = (on: boolean): void => {
    if (compareOn === on) return;
    compareOn = on;
    compareBtn.classList.toggle("on", compareOn);
    show();
  };
  compareBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    setCompare(!compareOn);
  });
  // Press-and-hold on the stage content (the PWA gesture, desktop mouse) — on
  // `layers`, not the scrollable box, so a scrollbar drag never flips the view.
  // Pointer CAPTURE keeps the release with us even though the flip swaps the
  // element under the pointer (img ↔ iframe — codex-f34-5); a pointer starting
  // INSIDE a reconstruction iframe never reaches us, so the button + `w` stay
  // the compare path for recon stops.
  layers.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted) return;
    if (compareBtn.disabled) return;
    try {
      layers.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    setCompare(true);
  });
  for (const evt of ["pointerup", "pointercancel"] as const) {
    layers.addEventListener(evt, (e) => {
      if (!e.isTrusted) return;
      setCompare(false);
    });
  }
  layers.addEventListener("contextmenu", (e) => e.preventDefault());

  // ── the residue meter: the SHOWN stop's capture-time enum ∪ its frame's
  //    render residue, ranked + copied by the ONE shared model — a witness stop
  //    meters ITS OWN ref's residue, never the Original's (F34) ──
  const renderMeter = (refResidue: CaptureRef["residue"], r: RenderResidue | null): void => {
    meter.replaceChildren();
    const entries = collectResidue(refResidue, r);
    if (entries.length === 0) {
      meter.appendChild(el("span", "cap-meter-line", "Captured from the live page."));
      return;
    }
    const top = entries[0];
    if (top) meter.appendChild(el("span", "cap-meter-line", residueCopy(top)));
    if (top?.class === "declined-grant") {
      const link = el("button", "cap-meter-link", "Open settings") as HTMLButtonElement;
      link.addEventListener("click", (e) => {
        if (e.isTrusted) void send({ type: "openSettings" });
      });
      meter.appendChild(link);
    }
    if (entries.length > 1) {
      const more = el(
        "button",
        "cap-meter-more",
        `+${entries.length - 1} more`,
      ) as HTMLButtonElement;
      const list = el("ul", "cap-meter-list");
      list.hidden = true;
      for (const e of entries.slice(1))
        list.appendChild(el("li", "cap-meter-item", residueCopy(e)));
      more.addEventListener("click", (ev) => {
        if (!ev.isTrusted) return;
        list.hidden = !list.hidden;
        more.classList.toggle("open", !list.hidden);
      });
      meter.append(more, list);
    }
  };

  // ── the honest per-variant note (authorRulesMissing) stacked over the miss-tally ──
  const renderNote = (r: RenderResidue | null): void => {
    const lines: string[] = [];
    if (r?.authorRulesMissing) {
      lines.push(
        "This variant changes a class — the site's class styles weren't captured, so it's shown without them. Compare with the captured screenshot.",
      );
    }
    if (r && (r.misses > 0 || r.rejected > 0)) {
      lines.push(
        r.applied === 0
          ? "this variant edits outside the captured block"
          : "some of this variant's changes fall outside the captured block",
      );
    }
    note.replaceChildren();
    if (lines.length === 0) {
      note.style.display = "none";
      return;
    }
    for (const l of lines) note.appendChild(el("div", "stage-note-line", l));
    note.style.display = "block";
  };

  // ── show: an instant visibility swap (no reparse), then reflect residue ──
  function show(): void {
    stageCursor.set(set.setId, index);
    const wit = witnessRefOf(index);

    // The stop's OWN evidence layer: its witness raster when a fresh one
    // exists (rung 1/2), else its reconstruction frame (rung 3/4).
    const ownImg = wit ? stopImgFor(index, wit) : null;
    const ownFrame = ownImg ? null : frameFor(index);
    if (ownFrame) ownFrame.shownAt = ++showTick;
    const myTick = ownFrame ? ownFrame.shownAt : ++showTick;

    // The compare layer: the Original's LIKE evidence for a variant stop
    // (witness↔witness / recon↔recon); on the Original stop the flip is the
    // §2.5 fidelity blink (witness ↔ reconstruction of itself).
    let otherImg: HTMLImageElement | null = null;
    let otherFrame: PoolFrame | null = null;
    if (compareOn) {
      if (index < 0) {
        if (ownImg) otherFrame = frameFor(-1);
        else if (witnessRefOf(-1)) otherImg = stopImgFor(-1, cap);
      } else if (ownImg) {
        if (witnessRefOf(-1)) otherImg = stopImgFor(-1, cap);
      } else {
        otherFrame = frameFor(-1);
      }
    }
    const hasCompare = otherImg !== null || otherFrame !== null;

    const wide = hasCompare && box.clientWidth >= 2 * ((layoutWidth ?? 360) + 8);
    box.classList.toggle("split", wide);
    // Visibility: side-by-side (own + compare) when wide; the compare layer
    // ALONE when narrow (the blink); the own layer otherwise.
    const visible = new Set<HTMLElement>();
    const ownEl = ownImg ?? ownFrame?.iframe ?? null;
    const otherEl = otherImg ?? otherFrame?.iframe ?? null;
    if (wide) {
      if (ownEl) visible.add(ownEl);
      if (otherEl) visible.add(otherEl);
    } else if (hasCompare && otherEl) {
      visible.add(otherEl);
    } else if (ownEl) {
      visible.add(ownEl);
    }
    for (const [, f] of frames) f.iframe.hidden = !visible.has(f.iframe);
    for (const [, im] of stopImgs) im.hidden = !visible.has(im);
    // The stage adopts the SHOWN witness's own geometry (F34.1); any visible
    // recon frame (including the split) keeps the recon canvas metrics.
    const soleWitness = wide
      ? null
      : hasCompare && otherEl
        ? otherImg !== null
          ? cap
          : null
        : ownImg !== null
          ? wit
          : null;
    sizeLayersTo(soleWitness);

    const v = index >= 0 ? variants[index] : undefined;
    if (index < 0) {
      current.textContent = "Original — unchanged";
    } else {
      current.textContent = v ? `${index + 1}/${variants.length} — ${v.label || v.variantId}` : "—";
    }
    for (const [i, p] of pillButtons) p.classList.toggle("on", i === index);
    commentWrap.style.display = index >= 0 ? "flex" : "none";
    // The flip needs LIKE evidence on the other side (codex-f34-4): a recon
    // variant always has the Original's recon; a WITNESS variant needs the
    // Original's witness; the Original stop needs BOTH its rungs to blink.
    const compareAvailable = index < 0 ? wit !== null : wit === null || witnessRefOf(-1) !== null;
    compareBtn.disabled = !compareAvailable;
    compareBtn.title = compareAvailable ? "" : "No matching original evidence to compare against.";
    if (!compareAvailable && compareOn) {
      compareOn = false;
      compareBtn.classList.remove("on");
    }

    // ── the trust line + the verdict (the ONE shared grammar/law) ──
    const look = v ? looks.get(v.variantId) : undefined;
    const verdict = index >= 0 ? verdictOf(index) : null;
    trust.textContent =
      index < 0
        ? originalRungLine({
            ...(wit ? { witnessAt: cap.capturedAt } : {}),
            capExists: true,
          })
        : variantRungLine({
            ...(wit ? { witnessAt: wit.capturedAt } : {}),
            ...(look?.stale ? { stale: true } : {}),
            capExists: true,
          });
    caution.textContent = verdict?.caution ?? "";
    caution.style.display = verdict?.caution ? "block" : "none";
    pickBtn.disabled = !canPick || index < 0;
    pickBtn.classList.toggle("primary", verdict === null || verdict.pick === "primary");

    // A witness stop meters ITS OWN ref's residue — an absent list on a clean
    // variant-look must NOT fall through to the Original's (F34.2: the desk
    // showed "An image or font couldn't be captured" on a spotless witness).
    const refResidue = wit ? wit.residue : cap.residue;
    const reflect = (): void => {
      if (myTick !== showTick) return; // navigated away before the build settled
      renderMeter(refResidue, ownFrame?.residue ?? null);
      renderNote(ownFrame?.residue ?? null);
      // The verdict can sharpen once the frame settles (renderFailed/residue).
      const late = index >= 0 ? verdictOf(index) : null;
      caution.textContent = late?.caution ?? "";
      caution.style.display = late?.caution ? "block" : "none";
      pickBtn.classList.toggle("primary", late === null || late.pick === "primary");
    };
    reflect();
    if (ownFrame && ownFrame.residue === null) void ownFrame.built.then(reflect);
    // The verdict also sharpens when the ORIGINAL's frame settles later — a
    // clean Original recon flips `originalTrusted` (codex-f34-3).
    const origFrame = frames.get(-1);
    if (index >= 0 && origFrame && origFrame.residue === null) {
      void origFrame.built.then(reflect);
    }

    prebuild(index - 1);
    prebuild(index + 1);
  }

  // ── nav wiring (Original at −1, wrapping) ──
  const cycle = (delta: number): void => {
    const n = variants.length;
    let d = index + delta;
    if (d < -1) d = n - 1;
    if (d > n - 1) d = -1;
    index = d;
    show();
  };
  prev.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    cycle(-1);
  });
  next.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    cycle(1);
  });
  box.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      cycle(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      cycle(1);
    } else if (e.key === "w" || e.key === "W") {
      e.preventDefault();
      setCompare(!compareOn);
    }
  });

  stage.append(nav, pills, frame, actions, commentWrap);
  show();
  return stage;
}

/** The op-summary cards, DEMOTED beneath the stage into a details fold. */
function opDetails(set: VariantSetSummary): HTMLElement {
  const fold = el("details", "variants-details");
  fold.appendChild(el("summary", "variants-details-sum", "Details — the change as ops"));
  const pickedIndex = pickedGuess(set);
  const grid = el("div", "variant-grid");
  set.variants.forEach((v, i) => {
    grid.appendChild(variantCard(v, i === pickedIndex, null));
  });
  fold.appendChild(grid);
  return fold;
}

/** Degrade path: no renderable markup → the op cards carry per-card Pick. */
function fallbackGrid(set: VariantSetSummary, act: VariantAct): HTMLElement {
  const pickedIndex = pickedGuess(set);
  const canPick = set.status === "previewing";
  const grid = el("div", "variant-grid");
  set.variants.forEach((v, i) => {
    const onPick = canPick
      ? (btn: HTMLButtonElement): void => void act(btn, "pick", { index: i })
      : null;
    grid.appendChild(variantCard(v, i === pickedIndex, onPick));
  });
  return grid;
}

/** Discard is offered only while the set is still open (generating/previewing). */
function appendDiscard(body: HTMLElement, set: VariantSetSummary, act: VariantAct): void {
  if (set.status !== "generating" && set.status !== "previewing") return;
  const actions = el("div", "variants-actions");
  const discardBtn = el("button", "btn ghost sm", "Discard set") as HTMLButtonElement;
  discardBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void act(discardBtn, "discard", {});
  });
  actions.appendChild(discardBtn);
  body.appendChild(actions);
}

/**
 * Pick / Discard route through the SW's participant-scoped variant HTTP proxy
 * (`variantCall`) — the same server handlers the overlay's WS frames drive. On
 * success we re-fetch (the page is a pure view of server truth); on failure the
 * button re-enables and an inline error shows. The stage is the headline: the
 * captured block renders visually and the human navigates the variants on top of
 * it; the op cards live demoted in a fold beneath.
 */
function renderVariantSet(
  body: HTMLElement,
  set: VariantSetSummary,
  s: Snapshot,
  refresh: () => void,
): void {
  body.replaceChildren();
  const err = el("div", "variants-err");
  const act: VariantAct = async (btn, op, payload) => {
    err.textContent = "";
    btn.disabled = true;
    const res = await send<{ ok: boolean }>({
      type: "variantCall",
      id: set.setId,
      op,
      body: payload,
    });
    if (res?.ok) refresh();
    else {
      err.textContent = "Couldn't do that. Try again.";
      btn.disabled = false;
    }
  };

  body.appendChild(el("div", "variants-status", `set ${set.setId.slice(0, 8)} · ${set.status}`));
  if (set.variants.length === 0) {
    body.appendChild(el("div", "variants-note", "no variants yet"));
    appendDiscard(body, set, act);
    body.appendChild(err);
    return;
  }

  // The fidelity fallback ladder (render §2.1): (1) a committed edit-context
  // capture → the portable `sandbox=""` renderer (no caveat label); (2) the
  // legacy `sanitizeMarkupForPreview` stage (its "origin styles absent" label
  // stays honest); (3) op cards when there is no renderable markup.
  const cap = editContextCapture(s);
  const pristine = cap ? null : stagePristine(set);
  if (cap) {
    body.appendChild(captureStage(set, cap, s, s.id, act));
    body.appendChild(opDetails(set));
  } else if (pristine) {
    body.appendChild(variantStage(set, pristine, s.id, act));
    body.appendChild(opDetails(set));
  } else {
    body.appendChild(
      el("div", "variants-note", "visual preview unavailable — showing the change as ops"),
    );
    body.appendChild(fallbackGrid(set, act));
  }

  appendDiscard(body, set, act);
  body.appendChild(err);
}

function variantsSection(
  setId: string,
  set: VariantSetSummary | null,
  s: Snapshot,
  refresh: () => void,
): HTMLElement {
  const wrap = el("section", "variants");
  wrap.appendChild(el("div", "variants-title", "Variants"));
  const body = el("div", "variants-body");
  if (!set) {
    body.appendChild(
      el("div", "variants-note", `variants compare live on the page (set ${setId.slice(0, 8)})`),
    );
  } else {
    renderVariantSet(body, set, s, refresh);
  }
  wrap.appendChild(body);
  return wrap;
}

/* ── thread ───────────────────────────────────────────────────────── */

/**
 * Render a message body with its typed tokens: @actors as name chips, #anchors as
 * mono reference chips. An anchor token that carries a referenced `interactionId`
 * is clickable — it reveals that interaction's captured look (§4a). A body with no
 * tokens[] renders as plain text (legacy messages). textContent throughout — the
 * body is untrusted, never markup.
 */
function renderBody(m: ThreadMsg, onAnchorClick: (refId: string) => void): HTMLElement {
  const wrap = el("div", `msg-text${m.deleted ? " deleted" : ""}`);
  if (m.deleted) {
    wrap.textContent = "message deleted";
    return wrap;
  }
  const body = m.body;
  const blocks = parseFences(body.text);
  const placed = placeOutsideFences(body.text, body.tokens ?? [], blocks, (tok) =>
    mentionSpellings(
      tok,
      (id) => knownName(personOf, id),
      (id) => knownAlias(personOf, id),
    ),
  );
  const pill = ({ tok }: PlacedToken<Token>, run: string): HTMLElement => {
    if (tok.t === "agent") {
      const chip = el("span", "token-pill token-actor", AGENT_WIRE);
      chip.title = "Handed to an agent";
      return chip;
    }
    if (tok.t === "actor") {
      const who = personOf(tok.actorId);
      // An older spelling (`@<id>`, the alias they had then) reads as the name now.
      const older =
        run === `@${tok.actorId}` || (who.alias !== undefined && run === `@${who.alias}`);
      const chip = el("span", "token-pill token-actor", older ? `@${who.name}` : run);
      chip.title = who.name;
      return chip;
    }
    const chip = el("span", "token-pill token-anchor", `#${tok.label}`);
    const refId = tok.interactionId;
    if (refId) {
      chip.classList.add("clickable");
      chip.title = "reveal its captured look";
      chip.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        onAnchorClick(refId);
      });
    }
    return chip;
  };
  wrap.appendChild(
    renderFencedBody(document, body.text, blocks, placed, pill, (b) =>
      overlayCodeBlock(document, b),
    ),
  );
  return wrap;
}

/** The quoted original above a reply (ADR-0018 §1) — the panel's chip, here. */
function quoteChipEl(s: Snapshot, msgId: string, onCancel?: () => void): HTMLElement {
  const target = s.thread.find((t) => t.msgId === msgId);
  const chip = el("div", "quote-chip");
  if (!target || target.deleted || target.system) {
    chip.classList.add("missing");
    chip.appendChild(el("span", "quote-text", "original message removed"));
  } else {
    const author = personOf(target.authorId);
    chip.appendChild(el("span", "quote-text", `${author.name}: ${firstLineOf(target)}`));
  }
  if (onCancel) {
    const x = el("button", "quote-cancel", "×");
    x.setAttribute("aria-label", "Cancel the reply target");
    x.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      onCancel();
    });
    chip.appendChild(x);
  }
  return chip;
}

function firstLineOf(m: ThreadMsg): string {
  return previewFirstLine(m.body.text);
}

/** The panel's reaction grammar (F21): count chips (hover names reactors,
 *  click joins/leaves) + a quick-add row of un-chipped emoji while the thread
 *  follows through. Optimistic — paint the local copy, undo on refusal; the
 *  5s poll (and the post-send reload) reconcile to server truth. */
function msgReactions(s: Snapshot, m: ThreadMsg): HTMLElement {
  const wrap = el("div", "reactions");
  const toggle = (emoji: string, on: boolean): void => {
    const undo = selfId !== null ? applyLocalReaction(m, emoji, selfId, on) : (): void => {};
    repaintIntent();
    void send<{ ok: boolean }>({
      type: "interactionCall",
      id: s.id,
      op: "react",
      body: { msgId: m.msgId, emoji, on },
    }).then((res) => {
      if (res?.ok) {
        void load({ quiet: true });
        return;
      }
      undo();
      repaintIntent();
    });
  };
  for (const [emoji, actors] of Object.entries(m.reactions ?? {})) {
    if (actors.length === 0) continue;
    const on = selfId !== null && actors.includes(selfId);
    const chip = el("button", `react${on ? " on" : ""}`);
    chip.title = actors.map((id) => personOf(id).name).join(", ");
    chip.append(el("span", undefined, emoji), el("span", undefined, String(actors.length)));
    chip.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      toggle(emoji, !on);
    });
    wrap.appendChild(chip);
  }
  if (canFollowThrough(s.state)) {
    const bar = el("div", "react-bar");
    for (const emoji of REACTIONS) {
      if ((m.reactions?.[emoji]?.length ?? 0) > 0) continue;
      const b = el("button", "react", emoji);
      b.title = "react — counts as seen";
      b.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        toggle(emoji, true);
      });
      bar.appendChild(b);
    }
    wrap.appendChild(bar);
  }
  return wrap;
}

function threadMsgEl(
  s: Snapshot,
  m: ThreadMsg,
  onAnchorClick: (refId: string) => void,
): HTMLElement {
  if (m.system) {
    return el("div", "sys-note", m.body.text || "");
  }
  const row = el("div", "msg");
  const actor = personOf(m.authorId);
  row.appendChild(avatarEl(actor, "md"));
  const body = el("div", "msg-body");
  const meta = el("div", "msg-meta");
  meta.appendChild(el("span", "msg-name", actor.name));
  if (m.agent) meta.appendChild(el("span", "msg-edited", "agent"));
  meta.appendChild(el("span", "msg-age", age(m.ts)));
  if (m.editedAt) meta.appendChild(el("span", "msg-edited", "edited"));
  body.appendChild(meta);
  if (m.replyTo) body.appendChild(quoteChipEl(s, m.replyTo.msgId));

  // Inline own-message editor (F18) — the panel's edit lifecycle, with the
  // same rich token editor the reply composer uses (draft-seeded, so pills
  // rehydrate and the text survives a truth-driven repaint mid-edit).
  if (editingMsgId === m.msgId && !m.deleted) {
    const editKey = `fullview-edit:${s.id}:${m.msgId}`;
    const editor = tokenInput(editorApp, "", {
      multiline: true,
      noAnchors: true,
      draftKey: editKey,
      onSend: () => void saveEdit(),
    });
    let saving = false; // Enter-mash and Save-click share one in-flight edit
    const saveEdit = async (): Promise<void> => {
      const next = editor.value();
      if (!next.text || saving) return;
      saving = true;
      (save as HTMLButtonElement).disabled = true;
      const res = await send<{ ok: boolean }>({
        type: "interactionCall",
        id: s.id,
        op: "edit",
        body: { msgId: m.msgId, body: next },
      });
      if (res?.ok) {
        editingMsgId = null;
        clearDraft(editKey);
        void load();
      } else {
        saving = false;
        (save as HTMLButtonElement).disabled = false;
      }
    };
    const acts = el("div", "msg-acts");
    const save = el("button", "btn sm", "Save");
    save.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      void saveEdit();
    });
    const cancel = el("button", "btn ghost sm", "Cancel");
    cancel.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      editingMsgId = null;
      clearDraft(editKey);
      repaintIntent();
    });
    acts.append(save, cancel);
    body.append(editor.wrap, acts);
    row.appendChild(body);
    queueMicrotask(() => editor.focus());
    return row;
  }

  body.appendChild(renderBody(m, onAnchorClick));
  if (!m.deleted) body.appendChild(msgReactions(s, m));

  // Quiet per-message affordances (F18) — reply on every live message,
  // edit/delete on your own. The deleted tombstone keeps only its structure.
  // The thread outlives the resolution (the panel's rule): follow-through
  // until dropped/superseded; only Resolve keys on isLive.
  if (!m.deleted && canFollowThrough(s.state)) {
    const acts = el("div", "msg-acts");
    const replyAct = el("button", "msg-act", "reply");
    replyAct.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      setReplyQuote(`fullview-reply:${s.id}`, m.msgId);
      repaintIntent();
      replyEditorRef?.focus();
    });
    acts.appendChild(replyAct);
    if (selfId !== null && m.authorId === selfId) {
      const edit = el("button", "msg-act", "edit");
      edit.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        editingMsgId = m.msgId;
        writeRichDraft(`fullview-edit:${s.id}:${m.msgId}`, m.body);
        repaintIntent();
      });
      const del = el("button", "msg-act danger", "delete");
      del.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        if (del.textContent === "delete") {
          del.textContent = "confirm?";
          setTimeout(() => {
            del.textContent = "delete";
          }, 2500);
          return;
        }
        (del as HTMLButtonElement).disabled = true; // one delete per confirm
        void send<{ ok: boolean }>({
          type: "interactionCall",
          id: s.id,
          op: "delete",
          body: { msgId: m.msgId },
        }).then((res) => {
          if (res?.ok) void load();
          else (del as HTMLButtonElement).disabled = false;
        });
      });
      acts.append(edit, del);
    }
    body.appendChild(acts);
  }
  row.appendChild(body);
  return row;
}

function threadSection(s: Snapshot): HTMLElement {
  const wrap = el("section", "thread");
  for (const m of s.thread) wrap.appendChild(threadMsgEl(s, m, revealAnchorLook));
  return wrap;
}

/* ── attachments — EVIDENCE, never a render context ────────────────────
   An attachment is opaque bytes a participant offered as proof, not a page we
   are asked to trust or reproduce (strategy §1 role table: "plain evidence
   display, never a render context"). The card is deliberately unlike the
   variant STAGE and unlike an anchor snapshot: outline-only, neutral, a
   paperclip + the word "attachment" + an explicit untrusted marker, and the
   bytes never render as active content — an image draws from an object URL
   (inert raster), everything else is a click-to-download. No iframe, no stage,
   no shadow root, no kind hue. */

const PAPERCLIP_PATHS = [
  "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
];

// Page-lifetime caches for capture-part bytes and their blob: URLs, keyed by
// capture identity + REVISION. The live 5s poll re-renders this page wholesale;
// minting a fresh URL (and refetching) per tick is what made every screenshot
// visibly reload. A repaint of the same revision now reuses the same URL — the
// browser never re-decodes — while a superseded revision (resnap) is pruned on
// render so a genuinely new look still swaps in.
const partBytes = new Map<string, Promise<Uint8Array | null>>();
const partUrls = new Map<string, string>();
// True when any part fetch missed since the last full render: the skip-repaint
// guard must not skip while an image failed, or a transient miss would pin a
// broken placeholder forever (nothing else would ever retrigger the fetch).
let partFetchMissed = false;
function partKey(ref: { captureId: string; revision: number }, name: string): string {
  return `${ref.captureId}/r${ref.revision}/${name}`;
}
function cachedPartUrl(ref: CaptureRef, name: string, bytes: Uint8Array, mime: string): string {
  const key = partKey(ref, name);
  let url = partUrls.get(key);
  if (!url) {
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    partUrls.set(key, url);
  }
  return url;
}
function revokeAllPartUrls(): void {
  for (const u of partUrls.values()) URL.revokeObjectURL(u);
  partUrls.clear();
  partBytes.clear();
}
/** Drop cache entries no longer backed by a listed capture. A new revision is
 *  a NEW capture row (new captureId) in a lineage (capture-store.ts), so
 *  "stale" simply means the snapshot no longer lists the capture — a pruned
 *  revision or a gone lineage. Everything cached here belongs to this page's
 *  one interaction, so anything not live is dead weight to revoke. */
function pruneSupersededUrls(s: Snapshot): void {
  const live = new Set((s.captures ?? []).map((c) => `${c.captureId}/r${c.revision}/`));
  const stale = (key: string): boolean => !live.has(key.slice(0, key.lastIndexOf("/") + 1));
  for (const key of [...partUrls.keys()]) {
    if (!stale(key)) continue;
    const url = partUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    partUrls.delete(key);
  }
  for (const key of [...partBytes.keys()]) {
    if (stale(key)) partBytes.delete(key);
  }
}

/** Fetch one part's bytes via the SW proxy (base64 over chrome.runtime), decode
 *  to a Blob-ready byte array. Null on any miss — the card degrades in place.
 *  Read-through cached per capture revision: a re-render refetches nothing. */
function fetchAttachmentBytes(ref: CaptureRef, partName: string): Promise<Uint8Array | null> {
  const key = partKey(ref, partName);
  let pending = partBytes.get(key);
  if (!pending) {
    pending = send<{ ok: boolean; b64?: string }>({
      type: "getCapturePart",
      id: ref.interactionId,
      captureId: ref.captureId,
      name: partName,
      mime: ref.format,
    }).then((res) => {
      const bytes = res?.ok && res.b64 ? decodeBase64(res.b64) : null;
      // Never cache a miss — a transient failure must retry on the next
      // render, not pin a broken image for the page lifetime.
      if (bytes === null) {
        partBytes.delete(key);
        partFetchMissed = true;
      }
      return bytes;
    });
    partBytes.set(key, pending);
  }
  return pending;
}

function attachmentCard(ref: CaptureRef): HTMLElement {
  const card = el("article", "attachment-card");

  const head = el("div", "attachment-head");
  const glyph = el("span", "attachment-glyph");
  glyph.appendChild(svg(PAPERCLIP_PATHS));
  head.appendChild(glyph);
  head.appendChild(el("span", "attachment-tag", "attachment"));
  // The untrusted marker is not decoration: an attachment's bytes and caption
  // are participant-supplied and are never instructions (strategy §1).
  head.appendChild(el("span", "attachment-untrusted", "untrusted"));
  head.appendChild(el("span", "attachment-meta", `${ref.format} · ${humanBytes(ref.totalBytes)}`));
  card.appendChild(head);

  // Caption is human/PWA-authored untrusted text → textContent, never markup.
  if (ref.caption) card.appendChild(el("div", "attachment-caption", ref.caption));

  const partName = ref.parts[0]?.name ?? "file";
  const filename = `${ref.captureId.slice(0, 8)}-${partName}`;

  const body = el("div", "attachment-body");
  if (isImageMime(ref.format)) {
    const img = document.createElement("img");
    img.className = "attachment-image";
    img.alt = ref.caption || "attachment";
    img.loading = "lazy";
    body.appendChild(img);
    void fetchAttachmentBytes(ref, partName).then((bytes) => {
      if (bytes) img.src = cachedPartUrl(ref, partName, bytes, ref.format);
      else body.replaceChildren(el("div", "attachment-missing", "couldn't load this image"));
    });
  } else {
    // PDF / text: bytes are fetched only on an explicit, trusted click, and land
    // as a browser download — never inlined, never executed.
    const dl = el("button", "btn sm attachment-download", "Download") as HTMLButtonElement;
    const msg = el("div", "attachment-missing");
    msg.style.display = "none";
    dl.addEventListener("click", async (e) => {
      if (!e.isTrusted) return;
      dl.disabled = true;
      msg.style.display = "none";
      const bytes = await fetchAttachmentBytes(ref, partName);
      dl.disabled = false;
      if (!bytes) {
        msg.textContent = "couldn't fetch this attachment";
        msg.style.display = "block";
        return;
      }
      const a = document.createElement("a");
      a.href = cachedPartUrl(ref, partName, bytes, ref.format);
      a.download = filename;
      a.click();
    });
    body.append(dl, msg);
  }
  card.appendChild(body);

  card.appendChild(el("div", "attachment-file", filename));
  return card;
}

function attachmentsSection(s: Snapshot): HTMLElement | null {
  const refs = attachmentCaptures(s);
  if (refs.length === 0) return null;
  const wrap = el("section", "attachments");
  wrap.appendChild(el("div", "attachments-title", "Attachments"));
  for (const ref of refs) wrap.appendChild(attachmentCard(ref));
  return wrap;
}

/* ── the look history — evidence of how an anchored place looked over time
   (Stage 2 §4). The guaranteed path when the origin page is gone: newest-first
   witness display, a prev/next scrub across the (≤10) revisions, capture time +
   the honest residue meter per look, and the "Request a fresh look" affordance
   for participants. A snapshot is evidence-of-a-look, DISPLAYED — never a live
   variant stage (no portable-renderer re-run, S2-D15). ── */

/** The mime a capture part rides, for minting a correct object URL. */
function partMimeOf(ref: CaptureRef, name: string): string {
  return ref.parts.find((p) => p.name === name)?.mime ?? "image/webp";
}

/** The honest capture-time residue line for one look — the shared model's
 *  single most-severe line, spoken in the one register both surfaces use. */
const lookResidueLine = captureResidueLine;

/**
 * Fire a fresh-look request over the SW's participant proxy (§2.5). Reflects the
 * outcome on the button: a duty is journaled (or already pending), a closed place
 * is refused honestly, and on success the caller refreshes to reflect `s.resnap`.
 */
function wireRequestButton(btn: HTMLButtonElement, id: string, refresh: () => void): void {
  btn.addEventListener("click", async (e) => {
    if (!e.isTrusted) return;
    btn.disabled = true;
    const res = await send<{ ok?: boolean; reason?: string; pending?: boolean }>({
      type: "resnapRequest",
      id,
    });
    if (res?.ok) {
      btn.textContent = res.pending ? "a fresh look is already due" : "fresh look requested";
      refresh();
      return;
    }
    btn.disabled = false;
    btn.textContent =
      res?.reason === "closed" ? "this interaction is closed" : "couldn't request — try again";
  });
}

/** The scrubbable look gallery for a set of snapshot revisions (newest-first). */
function lookGallery(looks: CaptureRef[]): HTMLElement {
  const wrap = el("div", "looks-gallery");
  const stage = el("div", "look-stage");
  const img = document.createElement("img");
  img.className = "look-img";
  img.alt = "captured look";
  img.loading = "lazy";
  stage.appendChild(img);

  const nav = el("div", "look-nav");
  const prev = el("button", "btn sm", "‹") as HTMLButtonElement;
  const pos = el("span", "look-pos");
  const next = el("button", "btn sm", "›") as HTMLButtonElement;
  nav.append(prev, pos, next);

  const meta = el("div", "look-meta");
  const meter = el("div", "look-meter");

  let index = 0;
  const showLook = (i: number): void => {
    index = Math.max(0, Math.min(looks.length - 1, i));
    const ref = looks[index];
    if (!ref) return;
    pos.textContent = `${index + 1} / ${looks.length}`;
    prev.disabled = index === 0;
    next.disabled = index === looks.length - 1;
    meta.textContent = `captured ${age(ref.capturedAt)} ago · revision ${ref.revision}`;
    const line = lookResidueLine(ref);
    meter.replaceChildren();
    meter.appendChild(el("span", "look-meter-line", line ?? "Captured from the live page."));
    const part = lookStagePart(ref) ?? "witness";
    img.removeAttribute("src");
    void fetchAttachmentBytes(ref, part).then((bytes) => {
      if (bytes && looks[index] === ref)
        img.src = cachedPartUrl(ref, part, bytes, partMimeOf(ref, part));
    });
  };
  prev.addEventListener("click", (e) => {
    if (e.isTrusted) showLook(index - 1);
  });
  next.addEventListener("click", (e) => {
    if (e.isTrusted) showLook(index + 1);
  });

  wrap.append(stage, nav, meta, meter);
  showLook(0);
  return wrap;
}

/**
 * The "Looks" section: the interaction's own snapshot look history plus the
 * request affordance. Rendered when the place has a captured look OR the
 * interaction is live (so a participant can request the first look). Works with
 * no live page — it reads `s.captures` and fetches parts over HTTP.
 */
function looksSection(s: Snapshot, refresh: () => void): HTMLElement | null {
  const looks = snapshotLooks(s);
  const live = isLive(s.state);
  if (looks.length === 0 && !live) return null;

  const wrap = el("section", "looks");
  const head = el("div", "looks-head");
  head.appendChild(el("div", "looks-title", "Looks"));
  const pending = resnapOf(s);
  if (live) {
    if (pending) {
      // A duty may still ride a page/unanchored place (the server route is
      // anchor-agnostic — a CLI can request one), so admit it honestly even where
      // no overlay capture surface can discharge it.
      head.appendChild(el("span", "looks-due", "fresh look requested"));
    } else if (isCapturableAnchor(s)) {
      // Only offer the affordance on an element/selection anchor — a page-level or
      // unanchored place has no capture path, so requesting one would light a duty
      // no §3 surface will ever show (fable-4).
      const btn = el("button", "btn ghost sm", "Request a fresh look") as HTMLButtonElement;
      wireRequestButton(btn, s.id, refresh);
      head.appendChild(btn);
    }
  }
  wrap.appendChild(head);

  if (looks.length === 0) {
    wrap.appendChild(el("div", "looks-empty", "No captured look yet."));
  } else {
    wrap.appendChild(lookGallery(looks));
  }
  return wrap;
}

/* ── §4a: the #anchor captured-look reveal (strategy §10 Stage-2 deliverable).
   Clicking a #anchor token in a thread message reveals the referenced
   interaction's newest captured look; when none exists the reveal ADMITS it and
   offers the request path — never a dead reference (S2-D23). Reads the referenced
   interaction's by-id read (SW-proxied; `scoped` collapses an uninvolved/unknown
   ref to the byte-identical 404, so the reveal leaks nothing). ── */

// Object URLs minted for the reveal panel, kept OUT of the attachment pool so a
// quiet background re-pull's `revokeAttachmentUrls` never breaks the shown look.
let revealUrls: string[] = [];
function revokeRevealUrls(): void {
  for (const u of revealUrls) URL.revokeObjectURL(u);
  revealUrls = [];
}
function mintRevealUrl(bytes: Uint8Array, mime: string): string {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  revealUrls.push(url);
  return url;
}

let revealPanel: HTMLElement | null = null;
function ensureRevealPanel(): { panel: HTMLElement; body: HTMLElement } {
  if (revealPanel) {
    const body = revealPanel.querySelector(".reveal-body") as HTMLElement;
    return { panel: revealPanel, body };
  }
  const panel = el("aside", "look-reveal");
  const head = el("div", "reveal-head");
  head.appendChild(el("span", "reveal-title", "Captured look"));
  const close = el("button", "btn ghost sm", "Close") as HTMLButtonElement;
  close.addEventListener("click", () => {
    panel.style.display = "none";
    revokeRevealUrls();
  });
  head.appendChild(close);
  const body = el("div", "reveal-body");
  panel.append(head, body);
  document.body.appendChild(panel);
  revealPanel = panel;
  return { panel, body };
}

async function revealAnchorLook(refId: string): Promise<void> {
  const { panel, body } = ensureRevealPanel();
  panel.style.display = "flex";
  revokeRevealUrls();
  body.replaceChildren(el("div", "reveal-loading", "Loading captured look…"));
  const res = await send<{ ok: boolean; interaction?: Snapshot }>({
    type: "getInteraction",
    id: refId,
  });
  if (!res?.ok || !res.interaction) {
    body.replaceChildren(
      el("div", "reveal-empty", "That reference isn't yours to see, or it no longer exists."),
    );
    return;
  }
  const ref = snapshotLooks(res.interaction)[0];
  if (!ref) {
    // Honest empty state (never a dead reference): admit it, offer the request.
    body.replaceChildren();
    body.appendChild(el("div", "reveal-empty", "No captured look yet."));
    if (isLive(res.interaction.state) && isCapturableAnchor(res.interaction)) {
      const btn = el("button", "btn ghost sm", "Request a fresh look") as HTMLButtonElement;
      wireRequestButton(btn, refId, () => void revealAnchorLook(refId));
      body.appendChild(btn);
    }
    return;
  }
  body.replaceChildren();
  const img = document.createElement("img");
  img.className = "reveal-img";
  img.alt = "captured look";
  body.appendChild(img);
  body.appendChild(el("div", "reveal-meta", `captured ${age(ref.capturedAt)} ago`));
  const line = lookResidueLine(ref);
  if (line) body.appendChild(el("div", "reveal-meter", line));
  const part = lookStagePart(ref) ?? "witness";
  void fetchAttachmentBytes(ref, part).then((bytes) => {
    if (bytes) img.src = mintRevealUrl(bytes, partMimeOf(ref, part));
    else body.appendChild(el("div", "reveal-empty", "couldn't load this look"));
  });
}

/* ── the ask control (open asks answer here, never the thread) ─────── */

function askControl(s: Snapshot, onDone: () => void): HTMLElement {
  // "ask-control", never bare "ask" — the kind chip carries `ask` as a hue
  // class and a generic .ask rule would restyle it into a padded card.
  const wrap = el("section", "ask-control");
  const ask = s.ask;
  if (!ask) return wrap;

  if (!askIsOpen(s)) {
    // Answered / resolved: freeze the chosen options, no live control.
    const chosen = new Set(selectedOptionIds(s));
    const list = el("div", "ask-options frozen");
    for (const opt of ask.options) {
      const item = el("div", `ask-frozen${chosen.has(opt.id) ? " picked" : ""}`);
      item.appendChild(el("span", "ask-label", opt.label));
      if (chosen.has(opt.id)) item.appendChild(el("span", "ask-mark", "✓"));
      list.appendChild(item);
    }
    wrap.appendChild(list);
    return wrap;
  }

  // The real Ask contract (ADR-0003): min may be 0 (an explicit no-pick
  // answers), submit may be staged even for single-choice, and a comment can
  // ride the pick — optional or required.
  const max = ask.selection.max;
  const min = ask.selection.min ?? 0;
  const commentMode = ask.answerComment ?? "off";
  const immediate = ask.selection.submit === "immediate" && max <= 1 && commentMode === "off";
  const picked = new Set<string>();
  const err = el("div", "ask-err");

  const commentEditor = tokenInput(
    editorApp,
    commentMode === "required" ? "Why — a comment is required" : "Add a comment (optional)",
    { multiline: true, noAnchors: true, draftKey: `fullview-ask-comment:${s.id}` },
  );
  commentEditor.wrap.classList.add("ask-comment");

  const submit = async (ids: string[]): Promise<void> => {
    err.textContent = "";
    const comment = commentEditor.value();
    if (commentMode === "required" && !comment.text) {
      err.textContent = "This ask needs a comment with the answer.";
      return;
    }
    const res = await send<{ ok: boolean }>({
      type: "interactionCall",
      id: s.id,
      op: "answer",
      body: { optionIds: ids, ...(comment.text ? { comment } : {}) },
    });
    if (res?.ok) {
      commentEditor.clear();
      onDone();
    } else err.textContent = "Couldn't send that answer. Try again.";
  };

  const list = el("div", "ask-options");
  const answerBtn = el("button", "btn primary", "Answer") as HTMLButtonElement;
  const sync = (): void => {
    answerBtn.disabled = picked.size < min || picked.size > max;
  };

  for (const opt of ask.options) {
    const btn = el(
      "button",
      `ask-option${opt.recommended ? " recommended" : ""}`,
    ) as HTMLButtonElement;
    const labelRow = el("span", "ask-label-row");
    labelRow.appendChild(el("span", "ask-label", opt.label));
    if (opt.recommended) labelRow.appendChild(el("span", "ask-reco", "recommended"));
    btn.appendChild(labelRow);
    if (opt.description) btn.appendChild(el("span", "ask-desc", opt.description));
    btn.addEventListener("click", () => {
      if (immediate) {
        void submit([opt.id]);
        return;
      }
      if (picked.has(opt.id)) {
        picked.delete(opt.id);
        btn.classList.remove("picked");
      } else if (max <= 1) {
        // staged single-choice: picking swaps the selection
        picked.clear();
        for (const other of list.querySelectorAll(".picked")) other.classList.remove("picked");
        picked.add(opt.id);
        btn.classList.add("picked");
      } else if (picked.size < max) {
        picked.add(opt.id);
        btn.classList.add("picked");
      }
      sync();
    });
    list.appendChild(btn);
  }
  wrap.appendChild(list);

  if (commentMode !== "off") wrap.appendChild(commentEditor.wrap);
  if (!immediate) {
    sync();
    answerBtn.addEventListener("click", () => void submit([...picked]));
    wrap.appendChild(answerBtn);
  }
  wrap.appendChild(err);
  return wrap;
}

/* ── reply + resolve action row ───────────────────────────────────── */

function actions(s: Snapshot, onDone: () => void): HTMLElement {
  const wrap = el("section", "actions");

  const composer = el("div", "composer");
  // The rich editor brings mention + emoji parity with the overlay composer;
  // Enter sends (isTrusted-gated inside token-input), Shift+Enter is a newline.
  // Anchors are off — there is no live page to pick on here.
  const editor: TokenInput = tokenInput(editorApp, "Reply… @mention to notify", {
    multiline: true,
    noAnchors: true,
    onSend: () => void sendReply(),
    draftKey: `fullview-reply:${s.id}`,
  });
  replyEditorRef = editor;
  const err = el("div", "act-err");
  // A pending reply-to pins the quoted original above the editor (F18); the ×
  // drops the targeting without touching the typed draft.
  const replyingToMsgId = replyQuote(`fullview-reply:${s.id}`, s.thread);
  if (replyingToMsgId !== null) {
    composer.appendChild(
      quoteChipEl(s, replyingToMsgId, () => {
        setReplyQuote(`fullview-reply:${s.id}`, null);
        repaintIntent();
      }),
    );
  }

  const sendReply = async (): Promise<void> => {
    const body: RawRichText = editor.value();
    if (!body.text) return;
    err.textContent = "";
    (replyBtn as HTMLButtonElement).disabled = true;
    const replyTo = replyQuote(`fullview-reply:${s.id}`);
    const payload = { body, ...(replyTo !== null ? { replyTo: { msgId: replyTo } } : {}) };
    // A retry of an unconfirmed send reuses its id: the server answers it once (M-1).
    const place = `fullview-reply:${s.id}`;
    const clientId = clientIdFor(place, payload);
    const res = await send<{ ok: boolean }>({
      type: "interactionCall",
      id: s.id,
      op: "reply",
      body: { ...payload, clientId },
    });
    if (res?.ok) {
      confirmSend(place, clientId);
      if (replyQuote(place) === replyTo) setReplyQuote(place, null);
      if (sameRevision(editor.value(), body)) editor.clear();
      onDone();
    } else {
      (replyBtn as HTMLButtonElement).disabled = false;
      err.textContent = "Couldn't send that reply. Try again.";
    }
  };

  const btnRow = el("div", "btn-row");
  const replyBtn = el("button", "btn", "Reply");
  replyBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void sendReply();
  });
  btnRow.appendChild(replyBtn);

  if (isLive(s.state)) {
    const resolveBtn = el("button", "btn ghost", "Resolve");
    resolveBtn.addEventListener("click", async () => {
      (resolveBtn as HTMLButtonElement).disabled = true;
      err.textContent = "";
      const res = await send<{ ok: boolean }>({
        type: "interactionCall",
        id: s.id,
        op: "resolve",
        body: {},
      });
      if (res?.ok) onDone();
      else {
        (resolveBtn as HTMLButtonElement).disabled = false;
        err.textContent = "Couldn't resolve that. Try again.";
      }
    });
    btnRow.appendChild(resolveBtn);
  } else if (s.state === "resolved") {
    // Resolution is not a one-way door (F26) — same authority as resolve.
    const reopenBtn = el("button", "btn ghost", "Reopen");
    reopenBtn.addEventListener("click", async () => {
      (reopenBtn as HTMLButtonElement).disabled = true;
      err.textContent = "";
      const res = await send<{ ok: boolean }>({
        type: "interactionCall",
        id: s.id,
        op: "reopen",
        body: {},
      });
      if (res?.ok) onDone();
      else {
        (reopenBtn as HTMLButtonElement).disabled = false;
        err.textContent = "Couldn't reopen that. Try again.";
      }
    });
    btnRow.appendChild(reopenBtn);
  }

  composer.append(editor.wrap, btnRow, err);
  wrap.appendChild(composer);
  return wrap;
}

/* ── page frame + states ──────────────────────────────────────────── */

function brand(): HTMLElement {
  const bar = el("header", "brand");
  bar.appendChild(markEl());
  bar.appendChild(el("span", "wordmark", "Onlay"));
  return bar;
}

function emptyState(): void {
  revokeAllPartUrls();
  root.replaceChildren();
  root.appendChild(brand());
  const col = el("main", "column");
  const empty = el("div", "empty");
  empty.appendChild(
    el("div", "empty-lead", "This interaction isn't yours to see, or it no longer exists."),
  );
  col.appendChild(empty);
  root.appendChild(col);
}

function render(s: Snapshot, set: VariantSetSummary | null): void {
  // F-051, ported (F22): the wholesale rebuild below momentarily collapses the
  // document and the browser clamps the window scroll to the top — a reaction
  // or a posted reply teleported the reader. Keep their place; a reader near
  // the bottom follows new content instead. The restore runs sync AND on the
  // next frame (async image decodes can re-clamp a tall page once).
  const keepY = window.scrollY;
  const doc = document.documentElement;
  // First paint: no place to keep (and the short loading shell would misread
  // as "near bottom" and yank a fresh open to the end).
  const firstPaint = lastRendered === null;
  const nearBottom = !firstPaint && window.innerHeight + window.scrollY >= doc.scrollHeight - 64;
  lastRendered = { s, set };
  // Reconcile intent against the truth about to paint: a message deleted
  // remotely (or a terminal transition) invalidates an edit in progress —
  // clear it AND its keyed draft rather than stranding either.
  if (editingMsgId !== null) {
    const target = s.thread.find((m) => m.msgId === editingMsgId);
    if (!target || target.deleted || !canFollowThrough(s.state)) {
      clearDraft(`fullview-edit:${s.id}:${editingMsgId}`);
      editingMsgId = null;
    }
  }
  if (!canFollowThrough(s.state)) setReplyQuote(`fullview-reply:${s.id}`, null);
  pruneSupersededUrls(s);
  root.replaceChildren();
  root.appendChild(brand());
  const col = el("main", "column");
  const card = el("article", "card");
  card.appendChild(header(s));
  card.appendChild(contextBlock(s));
  const brief = editBrief(s);
  if (brief) card.appendChild(brief);
  const question = askBrief(s);
  if (question) card.appendChild(question);
  const variantSetId = changeOf(s)?.variantSetId;
  if (variantSetId) card.appendChild(variantsSection(variantSetId, set, s, () => void load()));
  // The captured look is CONTEXT, not exhibit — it leads the conversation, the
  // same order as the PWA hero card and the change view's capture stage. On an
  // ask the whole question card reads top-down: question → look → options.
  const looks = looksSection(s, () => void load());
  if (looks) card.appendChild(looks);
  if (s.kind === "ask") card.appendChild(askControl(s, () => void load()));
  card.appendChild(threadSection(s));
  const attachments = attachmentsSection(s);
  if (attachments) card.appendChild(attachments);
  card.appendChild(actions(s, () => void load()));
  col.appendChild(card);
  root.appendChild(col);
  if (!firstPaint) {
    const restore = (): void => {
      window.scrollTo(0, nearBottom ? doc.scrollHeight : keepY);
    };
    restore();
    requestAnimationFrame(restore);
  }
}

/**
 * `<person>|<server origin>` this page last read as (null signed out), or
 * undefined before its first status.
 */
let accountKey: string | null | undefined;

/**
 * The account changed under an open page (3-M2): nothing of the thread the
 * last one was shown stays, its reply editor and intent included.
 */
function forgetView(): void {
  clearRefreshTimer();
  lastPaintKey = "";
  lastRendered = null;
  editingMsgId = null;
  replyEditorRef = null;
  selfId = null;
  attention = null;
  revokeAllPartUrls();
  root.replaceChildren();
}

/** Reads the people and the account; true when the account is not the one the page last read as. */
async function loadDirectory(): Promise<boolean> {
  const [res, status] = await Promise.all([
    send<{ ok: boolean; people?: PersonSummary[] }>({ type: "getDirectory" }),
    send<{ person?: PersonSummary | null; serverOrigin?: string }>({ type: "getStatus" }),
  ]);
  directory.clear();
  for (const p of res?.people ?? []) directory.set(p.id, p);
  const next = status?.person ? `${status.person.id}|${status.serverOrigin ?? ""}` : null;
  const changed = accountKey !== undefined && accountKey !== next;
  accountKey = next;
  // This page's drafts belong to the signed-in account on its server (2-M1).
  setDraftScope(next);
  if (changed) forgetView();
  if (status?.person) {
    directory.set(status.person.id, status.person);
    selfId = status.person.id;
  }
  return changed;
}

function idFromLocation(): string {
  try {
    return new URL(location.href).searchParams.get("id") ?? "";
  } catch {
    return "";
  }
}

// Snapshot-pull refresh (no websockets): the page re-fetches when it regains
// focus/visibility, and on a modest interval while the interaction is still live
// OR the variant set is still forming — so a newly-committed attachment (or any
// server-side change, e.g. the commit broadcast) lands in an ALREADY-OPEN view
// without a re-open. The timer stops once the interaction resolves and no set is
// pending, keeping a settled page quiet.
const REFRESH_MS = 5000;
/** Storage keys whose change means the signed-in account or its server may have changed. */
const ACCOUNT_CHANGE_KEYS = ["accountGeneration", "person", "token", "serverOrigin"];
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
// The last painted truth. A quiet poll whose snapshot is byte-identical skips
// render() entirely — the DOM (open composers, scroll, images) stays untouched,
// which is what keeps the 5s live poll invisible instead of a flicker.
let lastPaintKey = "";
// Per-message intent (F18, the on-page panel's grammar). Lives OUTSIDE the
// snapshot so the quiet-poll skip never tears it down; `repaintIntent()`
// re-renders the last truth when only intent changed — no refetch. The
// reply-to is kept with the reply's draft (`replyQuote`), through a reload (S-1).
let editingMsgId: string | null = null;
let replyEditorRef: TokenInput | null = null;
let lastRendered: { s: Snapshot; set: VariantSetSummary | null } | null = null;

function repaintIntent(): void {
  if (lastRendered) render(lastRendered.s, lastRendered.set);
}

function clearRefreshTimer(): void {
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function scheduleRefresh(live: boolean, setStatus: string | undefined): void {
  clearRefreshTimer();
  if (live || (setStatus && setStatus !== "resolved")) {
    refreshTimer = setTimeout(() => void load({ quiet: true }), REFRESH_MS);
  }
}

async function load(opts: { quiet?: boolean } = {}): Promise<void> {
  const id = idFromLocation();
  if (!id) {
    emptyState();
    return;
  }
  const [res, changed, att] = await Promise.all([
    send<{ ok: boolean; interaction?: Snapshot }>({ type: "getInteraction", id }),
    loadDirectory(),
    send<{ personId?: string | null; attention?: Parameters<typeof indexAttention>[0] }>({
      type: "getAttention",
    }),
  ]);
  // Another account now: read the thread again as it, from nothing (3-M2).
  if (changed) return load();
  // The service worker's last Inbox read, for the header's chip; kept when a read misses.
  if (att && att.personId !== selfId) attention = null;
  else if (att?.attention) attention = indexAttention(att.attention);
  if (!res?.ok || !res.interaction) {
    // A transient miss on a background refresh must not blow away a live view.
    if (opts.quiet) return;
    clearRefreshTimer();
    emptyState();
    return;
  }
  const variantSetId = changeOf(res.interaction)?.variantSetId;
  let set: VariantSetSummary | null = null;
  if (variantSetId) {
    const sres = await send<{ ok: boolean; set?: VariantSetSummary }>({
      type: "getVariantSet",
      id: variantSetId,
    });
    set = sres?.ok && sres.set ? sres.set : null;
  }
  const paintKey = JSON.stringify([res.interaction, set]);
  if (!(opts.quiet && paintKey === lastPaintKey && !partFetchMissed)) {
    lastPaintKey = paintKey;
    partFetchMissed = false; // this render retries whatever missed
    render(res.interaction, set);
  } else {
    // Only the Inbox may have moved: the chip changes in place, nothing else is rebuilt.
    root.querySelector(".head .chips .chip.state")?.replaceWith(headerStateChip(res.interaction));
  }
  scheduleRefresh(isLive(res.interaction.state), set?.status);
}

// Startup, gated on the real mount point. interaction.html always carries a
// #root; a test that imports this module for its pure builders (attachmentsSection)
// mounts happy-dom WITHOUT one, so the auto-pull never fires under test.
function boot(): void {
  // Regaining focus/visibility pulls fresh truth — cheap and obviously correct.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void load({ quiet: true });
  });
  window.addEventListener("focus", () => void load({ quiet: true }));
  // A sign-in, sign-out or server change moves the account generation: follow it (3-M2).
  chrome.storage?.onChanged?.addListener((changes, area) => {
    // The service worker read the Inbox anew: the header's chip follows it.
    if (area === "session" && "attention" in changes) void load({ quiet: true });
    if (area !== "local") return;
    if (ACCOUNT_CHANGE_KEYS.some((k) => k in changes)) void load({ quiet: true });
  });

  // Theme (Appearance pref): commit this page via [data-theme]; system = OS.
  void getPrefs().then(
    (p) => applyPageTheme(p.theme),
    () => {},
  );
  onPrefsChanged((p) => applyPageTheme(p.theme));

  // Unsent drafts kept across reloads come back before the thread renders (D-1).
  void restoreDrafts().then(() => load());
}

if (root) boot();

export { attachmentsSection, stagePristine, variantStage };
