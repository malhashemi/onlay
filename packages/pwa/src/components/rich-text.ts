// Mention display — the web app's twin of the extension's token-text
// re-segmentation (tokens are data). Walk `tokens[]` in order, advancing past
// each token's text (the shared convention, @onlay/render/mentions: a person
// is `@<display name>` or a bare `@<person id>`, the agent `@agent`): that run
// becomes a pill. EVERYTHING else — bare @names that routed nothing (visual
// truth: no token, no pill), anchor tokens (no page to point at here), and
// all body text — stays plain text nodes, and each fenced block is a code
// block (no pill is made of code). createTextNode/el only, never innerHTML
// (bodies are untrusted).
import { parseFences, type RawRichText } from "@onlay/protocol";
import { placeOutsideFences, renderFencedBody } from "@onlay/render/code-block";
import { mentionSpellings, personMentionText } from "@onlay/render/mentions";
import { el } from "../dom";
import { webCodeBlock } from "./code-block";

/**
 * `nameOf` gives a person's name, or undefined while the web app can't
 * resolve them; `aliasOf` their alias when this reader is given it (a member).
 */
export function renderRichText(
  body: RawRichText,
  nameOf: (personId: string) => string | undefined,
  aliasOf: (personId: string) => string | undefined = () => undefined,
): DocumentFragment {
  const blocks = parseFences(body.text);
  // Anchors read as their text here.
  const tokens = (body.tokens ?? []).filter((tok) => tok.t !== "anchor");
  const placed = placeOutsideFences(body.text, tokens, blocks, (tok) =>
    mentionSpellings(tok, nameOf, aliasOf),
  );
  return renderFencedBody(
    document,
    body.text,
    blocks,
    placed,
    ({ tok }, run) => {
      const name = tok.t === "actor" ? (nameOf(tok.actorId) ?? "") : "";
      // A bare `@<person id>`, or the alias a person was shown by when the
      // message was written, pills as the person's current name.
      const older =
        tok.t === "actor" && (run === `@${tok.actorId}` || run === `@${aliasOf(tok.actorId)}`);
      const pill = el("span", "mention-pill", older ? personMentionText(name) : run);
      pill.title = tok.t === "agent" ? "Handed to an agent" : name;
      return pill;
    },
    (b) => webCodeBlock(b.code, { lang: b.lang, label: b.lang }),
  );
}

/**
 * Plain text that may hold fenced blocks (an Edit's intent): exactly as
 * before when it has none, else a `div` with a code block for each.
 */
export function fencedText(tag: "p" | "div", cls: string, text: string): HTMLElement {
  if (parseFences(text).length === 0) return el(tag, cls, text);
  const node = el("div", cls);
  node.append(renderRichText({ text }, () => undefined));
  return node;
}
