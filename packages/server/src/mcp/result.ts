/**
 * Tool results (spec §9): one `text` block written for an agent to read, an
 * `image` block beside it for `look`, and failures as `isError: true` with one
 * plain sentence that says what to do next.
 *
 * Foreign values (anything a page produced, anything another person or their
 * agent wrote, anything echoed back from the caller's input) enter a result
 * only through `foreign` (inline, in a sentence) or `untrustedBlock` (a block
 * of lines). The server's own sentences never interpolate one bare.
 */
import {
  declassify,
  LIMITS,
  MCP_MAX_RESULT_CHARS,
  type UntrustedText,
  untrusted,
} from "@onlay/protocol";
import { fitFramed, untrustedInline } from "../space/render";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: true;
}

/** A tool failure the agent can act on; its message is the whole result. */
export class ToolError extends Error {}

/**
 * The text within the result budget, cut only between whole lines and whole
 * blocks (a backstop: each tool budgets its own parts first).
 */
const capped = (text: string): string => fitFramed(text, MCP_MAX_RESULT_CHARS);

export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text: capped(text) }],
});

export const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text", text: capped(text) }],
  isError: true,
});

/**
 * THE way a foreign value enters a sentence: declassified, its framing
 * delimiters neutralised, between the inline brackets.
 */
export function foreign(value: string, max: number): string {
  return untrustedInline(value, max);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shape each kind of id has when onlay minted it. */
const ID_SHAPES = {
  capture: UUID,
  set: UUID,
  variant: UUID,
  message: /^m\d{1,9}$/,
} as const;

/**
 * An id in a sentence: bare when it has the shape onlay mints for its kind,
 * framed otherwise (it came from capture metadata or another caller).
 */
export function shownId(kind: keyof typeof ID_SHAPES, value: string): string {
  return ID_SHAPES[kind].test(value) ? value : foreign(value, LIMITS.MAX_VARIANT_SET_ID);
}

/** A person's name, framed. */
export const who = (name: string): string => foreign(name, LIMITS.MAX_ACTOR_NAME);

/**
 * declassify a stored plain string: control characters out, length capped.
 * Only for the body of an `untrustedBlock`, never for a sentence.
 */
export function dc(value: string, max: number = LIMITS.MAX_TEXT_SNIPPET): string {
  return declassify(untrusted(value) as UntrustedText, max);
}

/** `14:32 UTC`, or with the date when it is not today. */
export function clock(ts: number, now: number): string {
  const iso = new Date(ts).toISOString();
  const sameDay = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  return sameDay ? `${iso.slice(11, 16)} UTC` : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function age(ts: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ts) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

const KIND_LABEL: Record<string, string> = {
  comment: "Comment",
  change: "Edit",
  ask: "Ask",
};

export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? "item";

/** `1 item`, `3 items`. */
export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;
