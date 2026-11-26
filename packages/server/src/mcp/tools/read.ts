/**
 * The reading tools (spec §9): `read` (one item in full), `read_markup` (a
 * slice of its captured HTML, or the elements a selector matches) and `look`
 * (one captured image).
 */
import {
  type CaptureRef,
  captureImageMimeOf,
  LIMITS,
  type LookToolInputSchema,
  MCP_MARKUP_EXCERPT_CHARS,
  MCP_MAX_MARKUP_SLICE,
  MCP_MAX_RESULT_CHARS,
  MCP_THREAD_BUDGET_CHARS,
  type RawInteractionSnapshot,
  type RawThreadMsg,
  type ReadMarkupToolInputSchema,
  type ReadToolInputSchema,
} from "@onlay/protocol";
import type * as z from "zod/mini";
import { anchorLine, renderThread, untrustedBlock } from "../../space/render";
import { type Item, loadItem, namesIn } from "../item";
import { MAX_SELECTOR_MATCHES, selectElements } from "../markup";
import {
  bytes,
  clock,
  dc,
  foreign,
  kindLabel,
  plural,
  shownId,
  ToolError,
  type ToolResult,
  textResult,
  who,
} from "../result";
import type { AgentSpaces, Json } from "../space";

/** `look` refuses images larger than this. */
const MAX_LOOK_BYTES = 5 * 1024 * 1024;
/** `read` lists at most this many captures, newest first. */
const MAX_LISTED_CAPTURES = 12;
/** Residue origins shown per capture, and the characters of each. */
const MAX_LISTED_ORIGINS = 3;
const LISTED_ORIGIN_CHARS = 100;
/** The thread never gets less than this, whatever the rest of `read` took. */
const MIN_THREAD_BUDGET = 2_000;

/* ── captured markup ──────────────────────────────────────────────── */

interface Markup {
  slot: "block" | "page";
  content: string;
  /** The capture itself was cut short in the browser. */
  truncated: boolean;
}

/** The captured block (block anchors) or page (page Edits) HTML; null when none was captured. */
async function markupOf(spaces: AgentSpaces, item: Item): Promise<Markup | null> {
  const level = item.interaction.anchor.level;
  const slot = level === "element" ? "block" : level === "page" ? "page" : null;
  if (slot === null) return null;
  const path = slot === "block" ? "anchor-content" : "page-content";
  const res = await spaces.call(item.spaceId, "GET", `/interaction/${item.id}/${path}`);
  if (res.status !== 200 || typeof res.body.content !== "string") return null;
  return { slot, content: res.body.content, truncated: res.body.truncated === true };
}

function markupHeader(m: Markup): string {
  const what = m.slot === "block" ? "the block" : "the page";
  const cut = m.truncated ? " (the capture itself was cut short in the browser)" : "";
  return `Captured markup of ${what}: ${m.content.length.toLocaleString("en-US")} characters${cut}.`;
}

/* ── the thread, within a budget ──────────────────────────────────── */

/** A message id as the server mints it (`m12`) reads as prose; anything else is framed. */
function msgRef(msgId: string): string {
  const shown = shownId("message", msgId);
  return shown === msgId ? `"${msgId}"` : shown;
}

interface ThreadWindow {
  text: string;
  shown: number;
}

/**
 * The newest messages whose rendering fits `budget`, oldest of them first.
 * The newest message is shown even when it alone is larger.
 */
function newestThatFit(
  msgs: RawThreadMsg[],
  render: (msgs: RawThreadMsg[]) => string,
  budget: number,
): ThreadWindow {
  let window: ThreadWindow = { text: "", shown: 0 };
  for (let start = msgs.length - 1; start >= 0; start--) {
    const text = render(msgs.slice(start));
    if (text.length > budget && window.shown > 0) break;
    window = { text, shown: msgs.length - start };
    if (text.length > budget) break;
  }
  return window;
}

/**
 * The thread section: `msgs` is the whole thread, or the part before
 * `before`. Says how many earlier messages were left out and how to get them.
 */
function threadSection(
  msgs: RawThreadMsg[],
  render: (msgs: RawThreadMsg[]) => string,
  budget: number,
  before?: string,
): string {
  const what = before ? `Thread before ${msgRef(before)}` : "Thread";
  if (msgs.length === 0) {
    return before ? `${what}: no earlier messages.` : "Thread: no messages.";
  }
  const window = newestThatFit(msgs, render, budget);
  const left = msgs.length - window.shown;
  const first = msgs[left];
  if (left === 0 || first === undefined) {
    return `${what} (${plural(msgs.length, "message")}, oldest first):\n${window.text}`;
  }
  return [
    `${what} (${plural(msgs.length, "message")}; the newest ${window.shown} shown, oldest first).`,
    `${plural(left, "earlier message")} left out: call read with before ${msgRef(first.msgId)} to see them.`,
    window.text,
  ].join("\n");
}

/* ── read ─────────────────────────────────────────────────────────── */

function agentWorkLine(
  s: RawInteractionSnapshot,
  selfId: string,
  nameOf: (id: string) => string,
  now: number,
): string {
  const w = s.agentWork;
  if (!w) return "For an agent: no.";
  const asker = w.requestedBy === selfId ? "your person" : who(nameOf(w.requestedBy));
  const asked = `asked by ${asker} at ${clock(w.requestedAt, now)}`;
  if (w.status === "taken") {
    const holder = w.takenBy === selfId ? "you" : `the agent of ${who(nameOf(w.takenBy ?? ""))}`;
    const until = w.leaseUntil ? ` until ${clock(w.leaseUntil, now)}` : "";
    return `For an agent: taken by ${holder}${until}; ${asked}.`;
  }
  if (w.status === "answered") return `For an agent: answered; ${asked}.`;
  const whose = w.requestedBy === selfId ? "yours" : "a teammate's (take it only if asked)";
  return `For an agent: pending, ${whose}; ${asked}.`;
}

function editLines(s: RawInteractionSnapshot, hasSet: boolean): string[] {
  const change = s.change;
  if (!change) return [];
  const owns = change.ownsSource === true;
  const method = dc(change.method ?? "direct", LIMITS.MAX_TAG);
  let source: string;
  if (!owns) {
    source = hasSet
      ? "Source: unknown. Answer with variants (post_variants); never change source for this Edit, and don't set its state."
      : "Source: unknown, and there is no variant set, so you can't post variants. Reply that you can't change this page's source, and offer variants if the person asks for them from the page.";
  } else if (s.state === "working") {
    source =
      "Source: known, and the Edit is already working. If you have that source, implement it there, then set_edit_state implemented (skip working).";
  } else {
    source =
      "Source: known (the anchor points into source, or the page carries a provenance stamp). If you have that source, implement the picked variant there, then set_edit_state implemented.";
  }
  return [
    `Method: ${method}.`,
    source,
    untrustedBlock("intent", dc(change.intent, LIMITS.MAX_COMMAND_INTENT)),
  ];
}

function variantLines(
  item: Item,
  set: Json | undefined,
  nameOf: (id: string) => string,
  now: number,
): string[] {
  const setId = item.interaction.change?.variantSetId;
  const lines: string[] = [];
  if (setId && set) {
    const root = set.root?.kind === "page" ? "the whole page" : "the block";
    const variants = (set.variants ?? []) as Json[];
    const rows = variants.map((v, i) => {
      const picked = set.pickedVariantId === v.variantId ? " · picked" : "";
      // `by` (the writer's person id) when the space records it; the agent mark either way.
      const writer =
        typeof v.by === "string" && v.by.length > 0
          ? dc(nameOf(v.by), LIMITS.MAX_ACTOR_NAME)
          : undefined;
      const by = writer
        ? ` · by ${writer}${v.agent ? "'s agent" : ""}`
        : v.agent
          ? " · by an agent"
          : "";
      return `${i + 1}. ${dc(String(v.variantId), LIMITS.MAX_VARIANT_SET_ID)} · "${dc(String(v.label), LIMITS.MAX_VARIANT_LABEL)}" · version ${Number(v.version)} · ${plural((v.program ?? []).length, "op")}${by}${picked}`;
    });
    lines.push(
      `Variants (set ${shownId("set", setId)}, ${dc(String(set.status), LIMITS.MAX_TAG)}, root ${root}): ${variants.length === 0 ? "none yet." : ""}`,
    );
    if (rows.length > 0) lines.push(untrustedBlock("variants", rows.join("\n")));
  } else if (setId) {
    lines.push("Variants: onlay couldn't read this Edit's variant set.");
  } else if (item.interaction.kind === "change") {
    lines.push("Variants: this Edit has no variant set.");
  }
  const kept = item.kept;
  if (kept) {
    const root = kept.root?.kind === "page" ? "the whole page" : "the block";
    lines.push(
      `Kept: ${plural((kept.program ?? []).length, "op")} on ${root}, kept by ${who(nameOf(String(kept.by)))} at ${clock(Number(kept.at), now)}, shown on the live page as a preview.`,
    );
  }
  return lines;
}

function captureLine(c: CaptureRef, now: number): string {
  const dims = c.width && c.height ? ` · ${c.width}×${c.height}` : "";
  const residue = c.residue ?? [];
  let originsLeft = MAX_LISTED_ORIGINS;
  const missing = residue.map((r) => {
    if (!r.origin || originsLeft <= 0) return r.class;
    originsLeft--;
    return `${r.class} (${foreign(r.origin, LISTED_ORIGIN_CHARS)})`;
  });
  const variant = c.variantId
    ? ` · of variant ${shownId("variant", c.variantId)} v${Number(c.variantVersion ?? 0) || "?"}`
    : "";
  return `- ${shownId("capture", c.captureId)} · ${c.kind} · revision ${c.revision} · ${bytes(c.totalBytes)}${dims}${variant} · ${clock(c.capturedAt, now)}${missing.length > 0 ? ` · missing from the look: ${missing.join(", ")}` : ""}`;
}

function capturesSection(captures: CaptureRef[], now: number): string {
  if (captures.length === 0) return "Captures: none.";
  const newest = [...captures]
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, MAX_LISTED_CAPTURES);
  const older =
    captures.length > newest.length
      ? `\n${plural(captures.length - newest.length, "older capture")} not listed.`
      : "";
  return `Captures (${captures.length}, newest first; see one with look):\n${newest.map((c) => captureLine(c, now)).join("\n")}${older}`;
}

async function variantSetOf(spaces: AgentSpaces, item: Item): Promise<Json | undefined> {
  const setId = item.interaction.change?.variantSetId;
  if (!setId) return undefined;
  const res = await spaces.call(item.spaceId, "GET", `/variant-set/${setId}`);
  return res.status === 200 ? (res.body.set as Json) : undefined;
}

export async function read(
  spaces: AgentSpaces,
  input: z.infer<typeof ReadToolInputSchema>,
): Promise<ToolResult> {
  const item = await loadItem(spaces, input.ref);
  const s = item.interaction;
  const now = Date.now();
  const selfId = spaces.agent.person.id;
  const nameOf = await namesIn(spaces, item.spaceId);
  const render = (msgs: RawThreadMsg[]) =>
    renderThread(msgs, { nameOf, aliasOf: nameOf.aliasOf, selfPersonId: selfId });
  const head = `${kindLabel(s.kind)} ${item.ref} · ${dc(s.state, LIMITS.MAX_TAG)} · in ${await spaces.label(item.spaceId)}`;

  if (input.before !== undefined) {
    const at = s.thread.findIndex((m) => m.msgId === input.before);
    if (at < 0) {
      throw new ToolError(
        "This thread has no message with that id. Call read without before for the newest messages.",
      );
    }
    return textResult(
      `${head}\n${threadSection(s.thread.slice(0, at), render, MCP_THREAD_BUDGET_CHARS, input.before)}`,
    );
  }

  const [set, markup] = await Promise.all([variantSetOf(spaces, item), markupOf(spaces, item)]);
  const rootSnippet =
    set?.root?.kind === "block" && typeof set.root.element?.textSnippet === "string"
      ? (set.root.element.textSnippet as string)
      : undefined;
  const before: string[] = [
    head,
    `Page: ${s.url ? foreign(s.url, LIMITS.MAX_URL) : "none (unanchored)"}`,
    // A block inside a frame: the page the person shares holds the frame (F-3).
    ...(s.url && s.hostUrl ? [`Inside a frame of: ${foreign(s.hostUrl, LIMITS.MAX_URL)}`] : []),
    `Started by ${s.authorId === selfId ? "your person" : who(nameOf(s.authorId))} at ${clock(s.createdAt, now)}.`,
    agentWorkLine(s, selfId, nameOf, now),
    untrustedBlock(
      "anchor",
      anchorLine(s.anchor, s.anchorLost, {
        ...(rootSnippet ? { snippet: rootSnippet } : {}),
        ...(s.change?.provenance ? { pageProvenance: s.change.provenance } : {}),
      }),
    ),
    ...editLines(s, set !== undefined),
  ];
  if (s.ask) {
    const options = s.ask.options
      .map((o) => `- ${dc(o.id, LIMITS.MAX_OPTION_ID)}: ${dc(o.label, LIMITS.MAX_OPTION_LABEL)}`)
      .join("\n");
    before.push(
      untrustedBlock("question", `${dc(s.ask.question, LIMITS.MAX_QUESTION)}\n${options}`),
    );
  }
  before.push(...variantLines(item, set, nameOf, now));
  before.push(capturesSection(s.captures ?? [], now));

  const after: string[] = [];
  if (markup) {
    const total = markup.content.length;
    const shown = Math.min(total, MCP_MARKUP_EXCERPT_CHARS);
    const more =
      total > shown
        ? ` Showing the first ${shown.toLocaleString("en-US")}; read_markup with offset ${shown} gets the rest, or pass a selector.`
        : "";
    after.push(
      `${markupHeader(markup)}${more}`,
      untrustedBlock(
        "captured markup",
        dc(markup.content.slice(0, shown), MCP_MARKUP_EXCERPT_CHARS),
      ),
    );
  } else {
    after.push("Captured markup: none.");
  }

  // The thread takes what the rest leaves, up to its own budget; the rest keeps its limits.
  const rest = before.join("\n").length + after.join("\n").length + 400;
  const budget = Math.min(
    MCP_THREAD_BUDGET_CHARS,
    Math.max(MIN_THREAD_BUDGET, MCP_MAX_RESULT_CHARS - rest),
  );
  return textResult([...before, threadSection(s.thread, render, budget), ...after].join("\n"));
}

/* ── read_markup ──────────────────────────────────────────────────── */

export async function readMarkup(
  spaces: AgentSpaces,
  input: z.infer<typeof ReadMarkupToolInputSchema>,
): Promise<ToolResult> {
  const item = await loadItem(spaces, input.ref);
  const markup = await markupOf(spaces, item);
  if (markup === null) {
    throw new ToolError(
      "No markup was captured for this item. Use read for the anchor and thread, or look for an image.",
    );
  }
  const limit = input.limit ?? MCP_MAX_MARKUP_SLICE;
  const total = markup.content.length;
  if (input.selector !== undefined) {
    const selector = foreign(input.selector, LIMITS.MAX_SELECTOR);
    const selection = await selectElements(markup.content, input.selector, limit);
    if (selection === null) {
      throw new ToolError(
        "That selector isn't supported here. Use a simpler one: tag, .class, #id, [attr], [attr=value], :nth-child(), :not(), descendant or > combinators.",
      );
    }
    if (selection.found === 0) {
      return textResult(
        `${markupHeader(markup)}\nNo element matches ${selector}. Read a slice without a selector to find the right one.`,
      );
    }
    const shown = selection.matches.length;
    const notes = [
      `${plural(selection.found, "element")} match ${selector}; showing ${shown}.`,
      selection.found > MAX_SELECTOR_MATCHES
        ? `At most ${MAX_SELECTOR_MATCHES} matches are returned; narrow the selector for the rest.`
        : "",
      selection.truncated
        ? `The output stops at ${limit.toLocaleString("en-US")} characters; narrow the selector or raise limit.`
        : "",
    ].filter(Boolean);
    const body = selection.matches
      .map((m, i) => `[match ${i + 1}]\n${dc(m, MCP_MAX_MARKUP_SLICE)}`)
      .join("\n");
    return textResult(
      [markupHeader(markup), ...notes, untrustedBlock("captured markup", body)].join("\n"),
    );
  }
  const offset = input.offset ?? 0;
  if (offset >= total && total > 0) {
    throw new ToolError(
      `The offset is past the end: the markup has ${total.toLocaleString("en-US")} characters. Use a smaller offset.`,
    );
  }
  const end = Math.min(total, offset + limit);
  const next = end < total ? ` Continue with offset ${end}.` : " That is the end.";
  return textResult(
    [
      `${markupHeader(markup)} Characters ${offset.toLocaleString("en-US")}–${end.toLocaleString("en-US")}.${next}`,
      untrustedBlock("captured markup", dc(markup.content.slice(offset, end), limit)),
    ].join("\n"),
  );
}

/* ── look ─────────────────────────────────────────────────────────── */

/** The captures that carry a witness: the looks and snapshots. */
const LOOK_KINDS = new Set(["snapshot", "edit-context", "variant-look"]);

type Part = CaptureRef["parts"][number];

const witnessOf = (c: CaptureRef): Part | undefined => c.parts.find((p) => p.role === "witness");

/**
 * The image a named capture shows: its witness, or for an attachment its
 * image file. Never an asset or a thumbnail.
 */
function namedImagePart(c: CaptureRef): Part | undefined {
  const witness = witnessOf(c);
  if (witness) return witness;
  if (c.kind !== "attachment") return undefined;
  return c.parts.find((p) => p.role === "file" && p.mime.startsWith("image/"));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function look(
  spaces: AgentSpaces,
  input: z.infer<typeof LookToolInputSchema>,
): Promise<ToolResult> {
  const item = await loadItem(spaces, input.ref);
  const listed = await spaces.read(item.spaceId, `/interaction/${item.id}/captures`);
  const captures = (listed.captures ?? []) as CaptureRef[];
  let capture: CaptureRef | undefined;
  let part: Part | undefined;
  if (input.captureId !== undefined) {
    capture = captures.find((c) => c.captureId === input.captureId);
    if (!capture) {
      throw new ToolError("This item has no capture with that id. Call read to list its captures.");
    }
    part = namedImagePart(capture);
    if (!part) {
      throw new ToolError(
        "That capture holds no image to show. Call read to list captures, and pick a look, a snapshot or an image attachment.",
      );
    }
  } else {
    capture = captures
      .filter((c) => LOOK_KINDS.has(c.kind) && witnessOf(c) !== undefined)
      .sort((a, b) => b.capturedAt - a.capturedAt)[0];
    part = capture ? witnessOf(capture) : undefined;
    if (!capture || !part) {
      throw new ToolError(
        "This item has no captured look yet. Work from read and read_markup, or pass the captureId of an image attachment.",
      );
    }
  }
  if (part.byteLen > MAX_LOOK_BYTES) {
    throw new ToolError(
      `That image is ${bytes(part.byteLen)}, over the 5 MiB look limit. Pick a smaller capture from read.`,
    );
  }
  const res = await spaces.fetch(
    item.spaceId,
    "GET",
    `/interaction/${item.id}/capture/${encodeURIComponent(capture.captureId)}/part/${encodeURIComponent(part.name)}`,
  );
  if (res.status === 404) {
    await res.body?.cancel();
    throw new ToolError(
      "That image is gone, or your person can no longer open this item. Call inbox.",
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ToolError("onlay couldn't load that image. Try again, or work from read_markup.");
  }
  const data = new Uint8Array(await res.arrayBuffer());
  const mimeType = captureImageMimeOf(data);
  if (mimeType === null || data.byteLength > MAX_LOOK_BYTES) {
    throw new ToolError(
      "That capture part isn't an image onlay can show. Pick another capture from read.",
    );
  }
  const now = Date.now();
  return {
    content: [
      {
        type: "text",
        text: `Image of ${item.ref}: ${captureLine(capture, now).slice(2)} · part ${foreign(part.name, LIMITS.MAX_CAPTURE_PART_NAME)} (${mimeType}, ${bytes(data.byteLength)}).`,
      },
      { type: "image", data: base64(data), mimeType },
    ],
  };
}
