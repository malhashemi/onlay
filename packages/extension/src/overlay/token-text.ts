// TokenText — the DISPLAY twin of token-input.ts.
// One renderer for message bodies: given RichText (text + tokens[]), each
// token's wire text renders as a styled chip — a mentioned person in their
// tint, @agent in the primary hue (one round pill for both), #anchors as mono
// reference chips that click through to their spot on the page. Tokens are
// DATA: segmentation consumes tokens[] in order by wire-text occurrence; a
// message with no tokens renders as plain text.
import { parseFences, type RawRichText } from "@onlay/protocol";
import { placeOutsideFences, renderFencedBody } from "@onlay/render/code-block";
import { mentionSpellings, personMentionText } from "@onlay/render/mentions";
import { overlayCodeBlock } from "./code-blocks";
import { el } from "./dom";
import { AGENT_WIRE, knownAlias, knownName, type PersonView } from "./people";
import type { AnchorToken } from "./token-input";
import { isTrustedEvent } from "./trusted";

/** The slice of App a body renderer reads. */
export interface TokenTextApp {
  person(id: string, spaceId?: string): PersonView;
}

export interface TokenTextDeps {
  /** Clicking an anchor chip reveals/flashes its spot (content.ts wires this). */
  onAnchorClick?(token: AnchorToken): void;
  /** The thread's own space: who people are (and their aliases) as that space says. */
  spaceId?: string | undefined;
}

function personChip(
  app: TokenTextApp,
  actorId: string,
  wire: string,
  spaceId: string | undefined,
): HTMLElement {
  const person = app.person(actorId, spaceId);
  // A bare `@<person id>`, or the alias they were shown by when the message
  // was written, reads as the person's name now.
  const older =
    wire === `@${actorId}` || (person.alias !== undefined && wire === `@${person.alias}`);
  const chip = el("span", "token-pill token-actor", older ? personMentionText(person.name) : wire);
  // the pill's color is the INDIVIDUAL — the mentioned person's tint
  if (person.tint) chip.style.setProperty("--pill", person.tint);
  chip.title = person.name;
  return chip;
}

function agentChip(): HTMLElement {
  const chip = el("span", "token-pill token-actor", AGENT_WIRE);
  chip.title = "Handed to an agent";
  return chip;
}

function anchorChip(token: AnchorToken, deps: TokenTextDeps): HTMLElement {
  const chip = el("span", "token-pill token-anchor", `#${token.label}`);
  chip.title = `anchor — ${token.label}`;
  const onClick = deps.onAnchorClick;
  if (onClick) {
    chip.classList.add("clickable");
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!isTrustedEvent(e)) return;
      onClick(token);
    });
  }
  return chip;
}

/**
 * Render rich text into a DocumentFragment: plain text nodes with token
 * chips where each token's wire text (`@Name` / `@agent` / `#label`) occurs,
 * and a code block for each fenced block (no chip is made of code). A token
 * whose wire text is absent from the text is skipped (defensive — the
 * composer always writes both sides).
 */
export function renderRichText(
  app: TokenTextApp,
  body: RawRichText,
  deps: TokenTextDeps = {},
): DocumentFragment {
  const doc = document;
  const blocks = parseFences(body.text);
  const who = (id: string) => app.person(id, deps.spaceId);
  const placed = placeOutsideFences(body.text, body.tokens ?? [], blocks, (tok) =>
    mentionSpellings(
      tok,
      (id) => knownName(who, id),
      (id) => knownAlias(who, id),
    ),
  );
  return renderFencedBody(
    doc,
    body.text,
    blocks,
    placed,
    ({ tok }, wire) =>
      tok.t === "agent"
        ? agentChip()
        : tok.t === "actor"
          ? personChip(app, tok.actorId, wire, deps.spaceId)
          : anchorChip(tok, deps),
    (b) => overlayCodeBlock(doc, b),
  );
}
