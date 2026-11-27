/**
 * The writing tools (spec §7, §9): `take`, `release`, `reply`,
 * `post_variants` and `set_edit_state`. Each calls the space as the person's
 * agent; the space marks every write `agent: true` and renews the hold. The
 * endpoint charges each call to the person's shared write bucket first.
 */
import {
  LIMITS,
  type PostVariantsToolInputSchema,
  type RefusedStep,
  type ReleaseToolInputSchema,
  type ReplyToolInputSchema,
  type SetEditStateToolInputSchema,
  STEP_REFUSAL_REASONS,
  type TakeToolInputSchema,
} from "@onlay/protocol";
import type * as z from "zod/mini";
import { sha256Hex } from "../../directory/crypto";
import { loadItem, namesIn, splitRef } from "../item";
import {
  clock,
  dc,
  foreign,
  kindLabel,
  plural,
  ToolError,
  type ToolResult,
  textResult,
  who,
} from "../result";
import { type AgentSpaces, errorCode, errorReason, type Json, NOT_FOUND_SENTENCE } from "../space";
import { stepList } from "../words";

/** The sentence for an item another person's agent holds, with the hold's end when known. */
async function heldBy(spaces: AgentSpaces, ref: string): Promise<ToolError> {
  let until: number | undefined;
  try {
    until = (await loadItem(spaces, ref)).interaction.agentWork?.leaseUntil;
  } catch {
    // The hold's end is a courtesy; the refusal stands without it.
  }
  return new ToolError(
    `This item is held by another agent${until ? ` until ${clock(until, Date.now())}` : ""}. Try another item or wait.`,
  );
}

/**
 * A refusal from the space as one sentence that says what to do next. Known
 * reasons get their own sentence; anything else is fixed prose and the error
 * code, never the space's own text.
 */
async function refused(
  spaces: AgentSpaces,
  ref: string,
  status: number,
  body: Json,
  sentences: Record<string, string> = {},
): Promise<ToolError> {
  if (status === 404) return new ToolError(NOT_FOUND_SENTENCE);
  const reason = errorReason(body) ?? "";
  const known = sentences[reason];
  if (known !== undefined) return new ToolError(known);
  // Another person's agent holds an unexpired lease (a competing write is refused while it does).
  if (reason === "held") return heldBy(spaces, ref);
  if (reason === "guest") {
    return new ToolError(
      "Your person is a guest on this thread, so their agent can only read and reply here.",
    );
  }
  if (reason === "agent" || status === 403) {
    return new ToolError(
      "An agent can't do that here. Agents reply, post variants, move an Edit to working or implemented, take and release.",
    );
  }
  if (status === 429) return new ToolError("Too many calls. Wait a minute, then try again.");
  return new ToolError(
    `onlay refused that (${errorCode(status, body)}). Read the item again before retrying.`,
  );
}

/* ── take · release ───────────────────────────────────────────────── */

export async function take(
  spaces: AgentSpaces,
  input: z.infer<typeof TakeToolInputSchema>,
): Promise<ToolResult> {
  const { spaceId, id } = splitRef(input.ref);
  const res = await spaces.call(spaceId, "POST", `/interaction/${id}/agent/take`, {
    ...(input.onBehalf ? { onBehalf: true } : {}),
  });
  if (res.status !== 200) {
    if (errorReason(res.body) === "not-yours") {
      const item = await loadItem(spaces, input.ref);
      const nameOf = await namesIn(spaces, spaceId);
      const asker = item.interaction.agentWork?.requestedBy;
      throw new ToolError(
        `This item was handed to ${asker ? `the agent of ${who(nameOf(asker))}` : "a teammate's agent"}. Take it only if your person asked you to, and then pass onBehalf: true.`,
      );
    }
    throw await refused(spaces, input.ref, res.status, res.body, {
      closed: "This item is closed. Call inbox for open items.",
      "not-pending":
        "Nothing on this item is waiting for an agent. Call inbox for items that are pending.",
    });
  }
  const until = res.body.agentWork?.leaseUntil;
  return textResult(
    `You hold ${input.ref}${typeof until === "number" ? ` until ${clock(until, Date.now())}` : ""}; each write you make extends the hold. Next: read it, then answer with reply, post_variants or set_edit_state. Release it if you stop without answering.`,
  );
}

export async function release(
  spaces: AgentSpaces,
  input: z.infer<typeof ReleaseToolInputSchema>,
): Promise<ToolResult> {
  const { spaceId, id } = splitRef(input.ref);
  const res = await spaces.call(spaceId, "POST", `/interaction/${id}/agent/release`);
  if (res.status !== 200) {
    throw await refused(spaces, input.ref, res.status, res.body, {
      "not-holder": "You don't hold this item, so there is nothing to release.",
    });
  }
  return textResult(`Released ${input.ref}; it is pending for an agent again.`);
}

/* ── reply ────────────────────────────────────────────────────────── */

export async function reply(
  spaces: AgentSpaces,
  input: z.infer<typeof ReplyToolInputSchema>,
): Promise<ToolResult> {
  const { spaceId, id } = splitRef(input.ref);
  // `@name` stays plain text: an agent's reply never mentions anyone.
  // A repeat with the same clientId answers with the first message (M-1).
  const res = await spaces.call(spaceId, "POST", `/interaction/${id}/reply`, {
    body: { text: input.text },
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
  });
  if (res.status !== 200) {
    throw await refused(spaces, input.ref, res.status, res.body, {
      closed: "This item is closed, so it takes no replies. Call inbox for open items.",
      cap: "This thread is full, so it takes no more replies.",
    });
  }
  const msgId =
    typeof res.body.msgId === "string" && /^m\d{1,9}$/.test(res.body.msgId)
      ? ` (message ${res.body.msgId})`
      : "";
  return textResult(
    `Replied on ${input.ref}${msgId}, marked as written by the agent of ${who(spaces.agent.person.name)}.`,
  );
}

/* ── post_variants ────────────────────────────────────────────────── */

interface ProgramCheck {
  ok: boolean;
  opIndex?: number;
  reason?: string;
  /** Every step the shared rule refuses on any page, with its closed-set reason. */
  steps?: RefusedStep[];
}

const KNOWN_REASONS: ReadonlySet<string> = new Set(STEP_REFUSAL_REASONS);

/** The steps a check names, kept only when every one is an index and a known reason. */
function knownSteps(check: ProgramCheck): RefusedStep[] | null {
  const steps = check.steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const ok = steps.every(
    (r) => Number.isInteger(r?.index) && r.index >= 0 && KNOWN_REASONS.has(String(r?.reason)),
  );
  return ok ? steps : null;
}

/** One variant's verdict; the label is the caller's own input, echoed framed. */
function checkLine(label: string, index: number, check: ProgramCheck | undefined): string {
  const name = `Variant ${index + 1} ${foreign(label, LIMITS.MAX_VARIANT_LABEL)}`;
  if (!check || check.ok) return `${name}: ok.`;
  // The shared rule's refusals, said in onlay's own words (steps count from 0).
  const steps = knownSteps(check);
  if (steps) return `${name}: refused, ${stepList(steps)} (steps count from 0).`;
  const op =
    typeof check.opIndex === "number" ? `op ${check.opIndex} (counting from 0)` : "the program";
  return `${name}: refused, ${op}: ${foreign(check.reason ?? "not allowed", MAX_REASON_CHARS)}.`;
}

/** A refusal reason can name sizes and selectors; this much of it is shown. */
const MAX_REASON_CHARS = 300;

/** Whether the space refused some variants one by one (programs, sizes). */
function perVariantRefusal(body: Json): ProgramCheck[] | undefined {
  const results = body?.results;
  if (!Array.isArray(results)) return undefined;
  return (results as ProgramCheck[]).some((r) => r && r.ok === false) ? results : undefined;
}

/** `300,000 bytes, at most 262,144` from a size refusal's numbers, when it carries them. */
function sizeNote(body: Json): string {
  const pick = (...keys: string[]): number | undefined => {
    for (const where of [body?.error, body]) {
      for (const key of keys) {
        const v = where?.[key];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
    }
    return undefined;
  };
  const measured = pick("measured", "size", "bytes", "actual");
  const allowed = pick("allowed", "max", "limit");
  if (measured === undefined || allowed === undefined) return "";
  return ` (${measured.toLocaleString("en-US")} bytes, at most ${allowed.toLocaleString("en-US")})`;
}

/**
 * The variant ids a post with `clientId` gives its variants: the same for a
 * repeat of that post by the same person on the same set, so the set (which
 * refuses a duplicate variant id) can never hold the post twice. Shaped as a
 * UUID, like the ids the space makes.
 */
async function variantIdsFor(
  personId: string,
  setId: string,
  clientId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = await sha256Hex(`onlay-variant\n${personId}\n${setId}\n${clientId}\n${i}`);
    const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
    ids.push(
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
    );
  }
  return ids;
}

/** Said after every post: the space can't see the person's page. */
const NOT_PROOF =
  "Posting doesn't prove a variant applies on the person's page: a step whose target isn't there is skipped, and read shows how each variant applied once the person previews it.";

const NO_SET =
  "This Edit has no variant set, and an agent can't make one. If onlay knows its source and you have it, implement the change and use set_edit_state; otherwise reply that you can't change this page's source, and offer variants if the person asks for them from the page.";

export async function postVariants(
  spaces: AgentSpaces,
  input: z.infer<typeof PostVariantsToolInputSchema>,
): Promise<ToolResult> {
  const item = await loadItem(spaces, input.ref);
  const s = item.interaction;
  if (s.kind !== "change") {
    throw new ToolError(
      `post_variants works only on an Edit, and this is a ${kindLabel(s.kind)}. Answer it with reply.`,
    );
  }
  const setId = s.change?.variantSetId;
  if (!setId) throw new ToolError(NO_SET);
  const refusals = {
    "wrong-status":
      "This variant set is closed, so it takes no variants. Read the item to see its state.",
    count: `A set holds at most ${LIMITS.MAX_VARIANTS_PER_SET} variants. Post fewer, or revise one with reviseVariantId.`,
  };
  /** A refusal of the whole call: per variant when the space says which, else one sentence. */
  const refusal = async (
    status: number,
    body: Json,
    lines: (checks: ProgramCheck[]) => string,
    extra: Record<string, string> = {},
  ): Promise<ToolError> => {
    const checks = perVariantRefusal(body);
    if (checks) return new ToolError(lines(checks));
    const reason = errorReason(body) ?? "";
    if (status === 400 && /size|large|bytes/.test(reason)) {
      return new ToolError(
        `The variants are too large together${sizeNote(body)}. Nothing was stored; post fewer or smaller programs.`,
      );
    }
    return refused(spaces, input.ref, status, body, { ...refusals, ...extra });
  };

  if (input.reviseVariantId !== undefined) {
    const [only] = input.variants;
    if (only === undefined || input.variants.length !== 1) {
      throw new ToolError("Pass exactly one variant when you revise one with reviseVariantId.");
    }
    const set = (await spaces.read(item.spaceId, `/variant-set/${setId}`)).set as Json;
    const variants = (set?.variants ?? []) as Json[];
    const index = variants.findIndex((v) => v.variantId === input.reviseVariantId);
    if (index < 0) {
      throw new ToolError(
        `This Edit has no variant ${foreign(input.reviseVariantId, LIMITS.MAX_VARIANT_SET_ID)}. Call read to list its variants.`,
      );
    }
    // With a clientId the space applies this revision at most once (2-S1).
    const res = await spaces.call(item.spaceId, "POST", `/variant-set/${setId}/variants/${index}`, {
      program: only.program,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    });
    if (res.status !== 200) {
      const single = res.body?.result as ProgramCheck | undefined;
      const body = single && single.ok === false ? { ...res.body, results: [single] } : res.body;
      throw await refusal(
        res.status,
        body,
        (checks) =>
          `${checkLine(only.label, 0, checks[0])} Nothing was stored; fix that and revise again.`,
        { stale: refusals["wrong-status"] },
      );
    }
    // The space's own account of what the revision made: for a repeat, the
    // first revision's variant, version and op count, not this call's.
    const count = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
    const at = count(res.body.index, index);
    const ops = count(res.body.ops, only.program.length);
    const version = Number(res.body.version);
    return textResult(
      `Revised variant ${at + 1} of ${input.ref} to version ${Number.isFinite(version) ? version : "?"} (${plural(ops, "op")}; its label stays ${foreign(String(variants[at]?.label ?? ""), LIMITS.MAX_VARIANT_LABEL)}). ${NOT_PROOF} The person previews it; call wait to hear back.`,
    );
  }
  const ids =
    input.clientId !== undefined
      ? await variantIdsFor(spaces.agent.person.id, setId, input.clientId, input.variants.length)
      : undefined;
  const posted = (total: number, checks: ProgramCheck[]): ToolResult => {
    const lines = input.variants.map((v, i) => checkLine(v.label, i, checks[i]));
    return textResult(
      `Posted ${plural(input.variants.length, "variant")} to ${input.ref}; the set now has ${total}.\n${lines.join("\n")}\n${NOT_PROOF}\nThe person previews and picks; call wait to hear back, and say what you posted with reply.`,
    );
  };
  /** The set's variant ids now. */
  const heldIds = async (): Promise<Set<unknown>> => {
    const set = (await spaces.read(item.spaceId, `/variant-set/${setId}`)).set as Json;
    return new Set(((set?.variants ?? []) as Json[]).map((v) => v.variantId));
  };
  if (ids !== undefined) {
    // A repeat of a post that went through: the first answer, nothing new.
    const held = await heldIds();
    if (ids.every((variantId) => held.has(variantId))) return posted(held.size, []);
    if (ids.some((variantId) => held.has(variantId))) {
      throw new ToolError(
        "Some variants for this clientId are already in the set; nothing was stored. Call read to see the set, then post what is missing with a new clientId.",
      );
    }
  }
  const res = await spaces.call(item.spaceId, "POST", `/variant-set/${setId}/variants`, {
    variants: input.variants.map((v, i) => ({
      ...(ids?.[i] !== undefined ? { variantId: ids[i] } : {}),
      label: v.label,
      program: v.program,
    })),
  });
  if (res.status !== 200) {
    if (ids !== undefined && errorReason(res.body) === "duplicate-id") {
      // The same post landed in between (two tries at once): the first answer.
      const held = await heldIds();
      if (ids.every((variantId) => held.has(variantId))) return posted(held.size, []);
    }
    throw await refusal(
      res.status,
      res.body,
      (checks) =>
        `${input.variants.map((v, i) => checkLine(v.label, i, checks[i])).join("\n")}\nNothing was stored. Fix the refused variants and post all of them again.`,
    );
  }
  const checks = (res.body.results ?? []) as ProgramCheck[];
  return posted(((res.body.set?.variants ?? []) as unknown[]).length, checks);
}

/* ── set_edit_state ───────────────────────────────────────────────── */

export async function setEditState(
  spaces: AgentSpaces,
  input: z.infer<typeof SetEditStateToolInputSchema>,
): Promise<ToolResult> {
  const { spaceId, id } = splitRef(input.ref);
  const res = await spaces.call(spaceId, "POST", `/interaction/${id}/state`, {
    state: input.state,
  });
  if (res.status !== 200) {
    if (errorReason(res.body) === "backward") {
      let current = "";
      try {
        current = dc((await loadItem(spaces, input.ref)).interaction.state, LIMITS.MAX_TAG);
      } catch {
        // Without the current state the sentence still says what to do.
      }
      throw new ToolError(
        current === "working" && input.state === "working"
          ? "This Edit is already working; skip that, implement it, then set_edit_state implemented."
          : `This Edit can't move to ${input.state}${current ? ` from ${current}` : " from where it is"}. Read it to see its state.`,
      );
    }
    throw await refused(spaces, input.ref, res.status, res.body, {
      "not-change": "Only an Edit has these states; answer this item with reply.",
      closed: "This Edit is closed. Call inbox for open items.",
      "no-source":
        "onlay doesn't know this Edit's source, so an agent can't set its state. Answer with variants (post_variants) if it has a variant set; otherwise reply that you can't change this page's source.",
    });
  }
  const now = dc(String(res.body.state ?? input.state), LIMITS.MAX_TAG);
  if (input.state === "implemented") {
    return textResult(
      `Marked ${input.ref} implemented; it is now ${now}, waiting for the person who asked to verify it. Say what you changed with reply.`,
    );
  }
  return textResult(`${input.ref} is now ${now}. Set it to implemented when the change is done.`);
}
