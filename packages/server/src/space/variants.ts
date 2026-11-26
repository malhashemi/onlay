import {
  addMessage,
  admitCreate,
  admitMutation,
  agentSetEditState,
  answerAgentWork,
  attachVariantSet,
  createInteraction,
  createVariantSet,
  discardSet,
  type InteractionCreateInput,
  type InteractionState,
  type MutationKind,
  matchesUrlPrefix,
  pickEdit,
  pickVariant,
  reopenSet,
  revisionByClientId,
  setChangeState,
  setWaitingOn,
  submitVariants,
  tuneVariant,
  type Variant,
  type VariantSetState,
  variantSetRoot,
} from "@onlay/kernel";
import {
  type Anchor,
  type Caller,
  type ElementContext,
  LIMITS,
  type MutationProgram,
  maxOpsFor,
  programBytes,
  type VariantIntent,
  type VariantPickRequest,
  type VariantRoot,
} from "@onlay/protocol";
import { canSee, fanOutVariantState, ownerOf, type Runtime } from "./runtime";
import {
  afterMutation,
  commit,
  commitSet,
  conflict,
  createdWithNonce,
  forbidden,
  heldRefusal,
  isMember,
  NOT_FOUND,
  type Outcome,
  ownsSourceOf,
  refuse,
  requestAgentOp,
  spaceFull,
  storedHostUrl,
  transact,
} from "./service";

/**
 * Variant sets (spec §8). A set is the method of an Edit; several sets may be
 * live on one page and nothing here looks across them. A set's root is one
 * block or the whole page. Picking keeps: on a page whose source is known the
 * Edit goes to an agent to implement, otherwise its picked program stays
 * applied (`kept`). Agents append or revise variants through their person.
 */

/**
 * The set and its owning Edit, when the caller may see the Edit and make this
 * mutation on it; a `frameUrl` (WebSocket frames) must sit under the set's
 * bound URL.
 */
export function admitSet(
  rt: Runtime,
  caller: Caller,
  kind: MutationKind | "read",
  setId: string,
  frameUrl?: string,
): Outcome<{ set: VariantSetState; owner: InteractionState }> {
  const set = rt.variantSets.get(setId);
  const owner = set ? ownerOf(rt, set) : undefined;
  if (!set || !owner || !canSee(caller.access, owner.id)) return NOT_FOUND;
  if (kind !== "read") {
    const a = admitMutation({ class: caller.class, access: caller.access }, kind, owner.id);
    if (!a.ok) return a.code === "not_found" ? NOT_FOUND : forbidden(a.reason);
  }
  if (frameUrl !== undefined && !matchesUrlPrefix(frameUrl, set.expectUrlPrefix)) {
    return conflict("url-mismatch", "This page isn't the one the variants were made on.");
  }
  return { ok: true, set, owner };
}

/* ── creation ─────────────────────────────────────────────────────── */

export interface CreateSetInput {
  frameUrl: string;
  /** The page the person shares, when the block is inside a frame of it (display only). */
  hostUrl?: string;
  root: VariantRoot;
  command: string;
  count: number;
  intent?: VariantIntent;
  provenance?: string;
  /** A single hand-made variant (the in-place text edit): no agent is asked. */
  manual?: MutationProgram;
  /** The client's correlation id: a repeat of the same create answers with the first set. */
  nonce?: string;
}

function anchorOfRoot(root: VariantRoot): Anchor {
  if (root.kind === "page") return { level: "page" };
  return {
    level: "element",
    selector: root.element.selector,
    // The block's text, so the extension can tell this block from another
    // that later answers to the same selector.
    ...(root.element.textSnippet.length > 0
      ? { snippet: root.element.textSnippet.slice(0, LIMITS.MAX_SNIPPET) }
      : {}),
    ...(root.element.sourcePointer !== undefined
      ? { sourcePointer: root.element.sourcePointer }
      : {}),
  };
}

/** Creates the Edit and the set that is its method, independent of every other set. */
export function createSetOp(
  rt: Runtime,
  caller: Caller,
  input: CreateSetInput,
): Outcome<{ set: VariantSetState; owner: InteractionState }> {
  const anchor = anchorOfRoot(input.root);
  const a = admitCreate({ class: caller.class, access: caller.access }, "change", anchor);
  if (!a.ok) return forbidden(a.reason);
  if (input.frameUrl.length === 0) return conflict("url-mismatch", "This needs the page's URL.");
  // A repeat of a create that already landed (its first push was lost).
  const repeat = createdWithNonce(rt, caller, input.nonce);
  if (repeat) {
    const set = repeat.change?.variantSetId
      ? rt.variantSets.get(repeat.change.variantSetId)
      : undefined;
    return set && canSee(caller.access, repeat.id) ? { ok: true, set, owner: repeat } : NOT_FOUND;
  }
  const full = spaceFull(rt);
  if (full) return full;
  const host = input.hostUrl === undefined ? {} : storedHostUrl(input.hostUrl);
  if (host === null)
    return refuse("invalid", "host-url", "The shared page's address isn't a web address.");
  if (input.manual !== undefined) {
    const tooLarge = programTooLarge(input.manual);
    if (tooLarge) return tooLarge;
  }
  const now = rt.clock.now();
  const changeId = rt.uuid();
  const setId = rt.uuid();
  const create: InteractionCreateInput = {
    id: changeId,
    kind: "change",
    url: input.frameUrl,
    expectUrlPrefix: input.frameUrl,
    ...host,
    anchor,
    authorId: caller.personId,
    member: isMember(caller),
    ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    change: {
      intent: input.command,
      method: "variant-set",
      ownsSource: ownsSourceOf(anchor, input.provenance),
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    },
    ...(input.manual !== undefined ? { requestAgent: false } : {}),
  };
  const created = createInteraction(create, now);
  if (!created.ok) return refuse("invalid", created.reason, "The Edit is incomplete.");
  const element: ElementContext | undefined =
    input.root.kind === "block" ? input.root.element : undefined;
  const setInput = {
    setId,
    expectUrlPrefix: input.frameUrl,
    command: input.command,
    count: input.manual === undefined ? input.count : 1,
    root: input.root,
    ...(element ? { element } : {}),
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    changeInteractionId: changeId,
  };
  const { set, state } = transact(rt, () => {
    commit(rt, { k: "int-create", ts: now, ...create }, created.state);
    let state = commit(
      rt,
      { k: "int-attach-set", ts: now, id: changeId, setId },
      attachVariantSet(created.state, setId),
    );
    let set = commitSet(
      rt,
      { k: "variant-set-create", ts: now, ...setInput },
      createVariantSet(setInput, now),
    );
    if (input.manual !== undefined) {
      const variant: Variant = {
        variantId: rt.uuid(),
        label: "Manual text edit",
        program: input.manual,
        version: 1,
        by: caller.personId,
      };
      const submitted = submitVariants(set, [variant], now);
      if (submitted.ok) {
        set = commitSet(
          rt,
          { k: "variant-generated", ts: now, setId, variants: [variant] },
          submitted.state,
        );
        state = handToRequester(rt, state);
      }
    }
    return { set, state };
  });
  afterMutation(rt, undefined, state);
  return { ok: true, set, owner: state };
}

/** The pick is the requester's: point the Edit's wait at them. */
function handToRequester(rt: Runtime, s: InteractionState): InteractionState {
  const waited = setWaitingOn(s, [s.authorId]);
  if (waited === s) return s;
  return commit(
    rt,
    { k: "int-waiting", ts: rt.clock.now(), id: s.id, actorIds: waited.waitingOn },
    waited,
  );
}

/* ── human judgment: pick · discard · steer · tune ───────────────── */

/**
 * Pick is keep (spec §8): the set's outcome becomes `picked`; on an owned page
 * the Edit goes to `working` with agent work pending, otherwise to `kept`. The
 * pick names the variant the person previewed and the version they saw; an
 * unknown variant, another version, or an `index` hint that disagrees is
 * refused (`variant-changed`) and changes nothing, for every caller.
 */
export function pickOp(
  rt: Runtime,
  caller: Caller,
  setId: string,
  pick: VariantPickRequest,
  frameUrl?: string,
): Outcome<{ set: VariantSetState; owner: InteractionState }> {
  const g = admitSet(rt, caller, "pick", setId, frameUrl);
  if (!g.ok) return g;
  const { set, owner } = g;
  if (set.status !== "previewing") {
    return conflict(set.status === "resolved" ? "resolved" : "picked");
  }
  const changed = () =>
    conflict(
      "variant-changed",
      "This variant changed or is gone since you previewed it. Look again, then pick.",
    );
  if (pick.index !== undefined && set.variants[pick.index]?.variantId !== pick.variantId) {
    return changed();
  }
  const now = rt.clock.now();
  const picked = pickVariant(set, pick, now);
  if (!picked.ok) return picked.reason === "variant-changed" ? changed() : conflict("picked");
  // A guest never requests agent work: on an owned page their pick is the author's to hand on.
  const requestedBy = isMember(caller) ? caller.personId : owner.authorId;
  const kept = pickEdit(owner, caller.personId, now, requestedBy);
  if (!kept.changed) return conflict(kept.reason);
  const { next, state } = transact(rt, () => ({
    next: commitSet(
      rt,
      {
        k: "variant-picked",
        ts: now,
        setId,
        variantId: pick.variantId,
        version: pick.version,
        ...(picked.state.activeIndex !== undefined ? { index: picked.state.activeIndex } : {}),
      },
      picked.state,
    ),
    state: commit(
      rt,
      {
        k: "int-pick",
        ts: now,
        id: owner.id,
        actorId: caller.personId,
        ...(requestedBy !== caller.personId ? { requestedBy } : {}),
      },
      kept.state,
    ),
  }));
  fanOutVariantState(rt, next);
  afterMutation(rt, owner, state);
  return { ok: true, set: next, owner: state };
}

/** Discard an unpicked set and drop its Edit. A set behind a kept pick is not discarded. */
export function discardOp(
  rt: Runtime,
  caller: Caller,
  setId: string,
  frameUrl?: string,
): Outcome<{ set: VariantSetState; owner: InteractionState }> {
  const g = admitSet(rt, caller, "discard", setId, frameUrl);
  if (!g.ok) return g;
  const { set, owner } = g;
  if (set.pickedVariantId !== undefined) return conflict("picked");
  const now = rt.clock.now();
  const r = discardSet(set, now);
  if (!r.ok) return conflict(set.status === "resolved" ? "resolved" : "picked");
  const dropped = setChangeState(owner, "dropped", now);
  const { next, state } = transact(rt, () => ({
    next: commitSet(rt, { k: "variant-discarded", ts: now, setId }, r.state),
    state: dropped.changed
      ? commit(rt, { k: "int-state", ts: now, id: owner.id, state: "dropped" }, dropped.state)
      : owner,
  }));
  fanOutVariantState(rt, next);
  afterMutation(rt, owner, state);
  return { ok: true, set: next, owner: state };
}

/**
 * A steer or tune journals the instruction on the owning Edit as a
 * system-marked message from the person, and asks for an agent (spec §7.1).
 */
function instructOp(
  rt: Runtime,
  caller: Caller,
  kind: "steer" | "tune",
  setId: string,
  text: string,
  frameUrl: string | undefined,
  check: (set: VariantSetState) => Outcome<Record<never, never>>,
): Outcome<{ set: VariantSetState; owner: InteractionState }> {
  const g = admitSet(rt, caller, kind, setId, frameUrl);
  if (!g.ok) return g;
  const c = check(g.set);
  if (!c.ok) return c;
  const now = rt.clock.now();
  const r = addMessage(
    g.owner,
    {
      authorId: caller.personId,
      body: { text: text.slice(0, LIMITS.MAX_COMMENT_TEXT) },
      system: true,
    },
    LIMITS.MAX_THREAD_MSGS,
    now,
  );
  const state = transact(rt, () => {
    let state = g.owner;
    if (r.added) state = commit(rt, { k: "int-msg", ts: now, id: state.id, msg: r.msg }, r.state);
    return requestAgentOp(rt, caller, state);
  });
  afterMutation(rt, g.owner, state);
  return { ok: true, set: g.set, owner: state };
}

export function steerOp(
  rt: Runtime,
  caller: Caller,
  setId: string,
  instruction: string,
  frameUrl?: string,
): Outcome<{ set: VariantSetState; owner: InteractionState }> {
  const r = instructOp(rt, caller, "steer", setId, `Steer: ${instruction}`, frameUrl, (set) =>
    set.status === "resolved" ? conflict("resolved") : { ok: true },
  );
  if (r.ok) {
    const now = rt.clock.now();
    commitSet(rt, { k: "variant-steered", ts: now, setId, instruction }, r.set);
  }
  return r;
}

export function tuneOp(
  rt: Runtime,
  caller: Caller,
  setId: string,
  index: number,
  instruction: string,
  frameUrl?: string,
): Outcome<{ set: VariantSetState; owner: InteractionState }> {
  const label = rt.variantSets.get(setId)?.variants[index]?.label ?? `variant ${index + 1}`;
  return instructOp(
    rt,
    caller,
    "tune",
    setId,
    `Tune “${label}”: ${instruction}`,
    frameUrl,
    (set) => {
      if (set.status !== "previewing")
        return conflict(set.status === "resolved" ? "resolved" : "picked");
      if (!set.variants[index]) return conflict("stale");
      return { ok: true };
    },
  );
}

/* ── agents: append · revise ──────────────────────────────────────── */

export interface ProgramCheck {
  ok: boolean;
  /** The refused op's index, when one is refused. */
  opIndex?: number;
  reason?: string;
  /** A program refused for its size: its measured bytes and the most allowed. */
  measured?: number;
  allowed?: number;
}

const sizeText = (n: number) => n.toLocaleString("en-US");

/** A program over `MAX_PROGRAM_BYTES`, as a check result; null when it fits. */
function programSize(program: MutationProgram): ProgramCheck | null {
  const bytes = programBytes(program);
  if (bytes <= LIMITS.MAX_PROGRAM_BYTES) return null;
  return {
    ok: false,
    reason: `program-too-large (${bytes} bytes, max ${LIMITS.MAX_PROGRAM_BYTES})`,
    measured: bytes,
    allowed: LIMITS.MAX_PROGRAM_BYTES,
  };
}

/** The refusal for one program over `MAX_PROGRAM_BYTES` (a manual edit, a batch). */
function programTooLarge(program: MutationProgram) {
  const size = programSize(program);
  if (!size || size.measured === undefined) return null;
  return {
    ...refuse(
      "invalid",
      "program-too-large",
      `The program is ${sizeText(size.measured)} bytes; at most ${sizeText(LIMITS.MAX_PROGRAM_BYTES)} are allowed. Shrink it, then send it again.`,
    ),
    extra: { measured: size.measured, allowed: LIMITS.MAX_PROGRAM_BYTES },
  };
}

/** The refusal when a set's programs together pass `MAX_SET_PROGRAM_BYTES`. */
function setTooLarge(bytes: number) {
  return {
    ...refuse(
      "invalid",
      "set-too-large",
      `The set's programs would come to ${sizeText(bytes)} bytes together; a set holds at most ${sizeText(LIMITS.MAX_SET_PROGRAM_BYTES)}. Send smaller programs or fewer variants.`,
    ),
    extra: { measured: bytes, allowed: LIMITS.MAX_SET_PROGRAM_BYTES },
  };
}

const setBytes = (variants: { program: MutationProgram }[]): number =>
  variants.reduce((n, v) => n + programBytes(v.program), 0);

/** Targets that resolve to the page root itself (trimmed, any case). */
const PAGE_ROOT_TARGETS = new Set([":scope", "body", "html", ":root"]);

/**
 * What can be known about a selector without the page: not empty, no control
 * characters, brackets, parentheses and quotes balanced. Null when it passes;
 * the preview engine still checks what only the live page can tell.
 */
function selectorProblem(selector: string): string | null {
  const t = selector.trim();
  if (t.length === 0) return "empty selector";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u001f\u007f]/.test(t)) return "control characters in the selector";
  const closers: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[") closers.push("]");
    else if (c === "(") closers.push(")");
    else if (c === "]" || c === ")") {
      if (closers.pop() !== c) return "unbalanced brackets, parentheses or quotes in the selector";
    }
  }
  if (quote !== null || closers.length > 0) {
    return "unbalanced brackets, parentheses or quotes in the selector";
  }
  return null;
}

/**
 * Checks a program against its root (spec §8) before it is stored: the op
 * budget, its size, every target selector (`selectorProblem`), and for a page
 * root no `setText` or `replace` insert aimed at the root itself (`:scope`,
 * `body`, `html` or `:root`). A refusal names the op's index.
 */
export function checkProgram(root: VariantRoot | null, program: MutationProgram): ProgramCheck {
  const max = maxOpsFor(root ?? "block");
  if (program.length > max) return { ok: false, reason: `too-many-ops (max ${max})` };
  const size = programSize(program);
  if (size) return size;
  for (let i = 0; i < program.length; i++) {
    const op = program[i];
    if (op === undefined) continue;
    const problem = selectorProblem(op.target);
    if (problem) return { ok: false, opIndex: i, reason: problem };
    if (root?.kind !== "page" || !PAGE_ROOT_TARGETS.has(op.target.trim().toLowerCase())) continue;
    if (op.op === "setText") return { ok: false, opIndex: i, reason: "setText on the page root" };
    if (op.op === "insertFragment" && op.position === "replace")
      return { ok: false, opIndex: i, reason: "replace insert on the page root" };
  }
  return { ok: true };
}

export interface VariantInput {
  variantId?: string | undefined;
  label: string;
  program: MutationProgram;
}

/** The agent's write answers the Edit's agent work; the Edit works and waits on its requester. */
function agentWrote(rt: Runtime, caller: Caller, owner: InteractionState): InteractionState {
  const now = rt.clock.now();
  let state = owner;
  const moved = agentSetEditState(state, "working", caller.personId, now);
  if (moved.changed) {
    state = commit(
      rt,
      {
        k: "int-state",
        ts: now,
        id: state.id,
        state: "working",
        agent: true,
        actorId: caller.personId,
      },
      moved.state,
    );
  } else {
    const answered = answerAgentWork(state, caller.personId, now);
    if (answered.state !== state) {
      state = commit(
        rt,
        { k: "int-agent-answer", ts: now, id: state.id, actorId: caller.personId },
        answered.state,
      );
    }
  }
  return handToRequester(rt, state);
}

/**
 * A compact event on the owning Edit for every variant write, so a `wait` on
 * the Edit wakes even when nothing else about it changed.
 */
function variantsWritten(
  rt: Runtime,
  caller: Caller,
  owner: InteractionState,
  setId: string,
): InteractionState {
  return commit(
    rt,
    { k: "int-variants", ts: rt.clock.now(), id: owner.id, setId, actorId: caller.personId },
    owner,
  );
}

/**
 * A picked set behind a kept Edit takes new variants again (spec §8): the
 * reopened state, uncommitted, and its journal entry when it reopened.
 */
function reopenedIfPicked(
  rt: Runtime,
  set: VariantSetState,
): { open: VariantSetState; reopened: boolean } {
  if (set.status !== "implementing" || set.outcome !== "picked") {
    return { open: set, reopened: false };
  }
  const r = reopenSet(set, rt.clock.now());
  return r.ok ? { open: r.state, reopened: true } : { open: set, reopened: false };
}

type SubmitOutcome = Outcome<{
  set: VariantSetState;
  owner: InteractionState;
  results: ProgramCheck[];
}>;

/**
 * An agent appends variants. The reopen (a kept Edit's set) and the
 * submission are computed and validated first and committed together with
 * the Edit's move, so a refused submission changes nothing.
 */
export function submitOp(
  rt: Runtime,
  caller: Caller,
  setId: string,
  variants: VariantInput[],
): SubmitOutcome {
  const g = admitSet(rt, caller, "post-variants", setId);
  if (!g.ok) return g;
  const held = heldRefusal(rt, caller, g.owner);
  if (held) return held;
  if (variants.length < 1) return refuse("invalid", "schema-invalid", "Send at least one variant.");
  const root = variantSetRoot(g.set);
  const results = variants.map((v) => checkProgram(root, v.program));
  if (results.some((r) => !r.ok)) {
    const sized = results.find((r) => r.measured !== undefined);
    return {
      ...refuse(
        "invalid",
        sized ? "program-too-large" : "program-invalid",
        sized?.measured !== undefined
          ? `A variant's program is ${sizeText(sized.measured)} bytes; at most ${sizeText(LIMITS.MAX_PROGRAM_BYTES)} are allowed. Shrink it, then send it again.`
          : "A variant's program can't apply at this root.",
      ),
      results,
    } as SubmitOutcome;
  }
  const total = setBytes(g.set.variants) + setBytes(variants);
  if (total > LIMITS.MAX_SET_PROGRAM_BYTES)
    return { ...setTooLarge(total), results } as SubmitOutcome;
  const now = rt.clock.now();
  const fresh: Variant[] = variants.map((v) => ({
    variantId: v.variantId ?? rt.uuid(),
    label: v.label.slice(0, LIMITS.MAX_VARIANT_LABEL),
    program: v.program,
    version: 1,
    agent: true,
    // The person the agent acts as wrote it.
    by: caller.personId,
  }));
  const { open, reopened } = reopenedIfPicked(rt, g.set);
  const r = submitVariants(open, fresh, now);
  if (!r.ok)
    return r.reason === "count"
      ? refuse("invalid", "count", "Too many variants.")
      : conflict(r.reason);
  const { set, state } = transact(rt, () => {
    if (reopened) commitSet(rt, { k: "variant-reopened", ts: now, setId }, open);
    return {
      set: commitSet(rt, { k: "variant-generated", ts: now, setId, variants: fresh }, r.state),
      state: variantsWritten(rt, caller, agentWrote(rt, caller, g.owner), setId),
    };
  });
  fanOutVariantState(rt, set);
  afterMutation(rt, g.owner, state);
  return { ok: true, set, owner: state, results };
}

type ReviseOutcome = Outcome<{
  set: VariantSetState;
  owner: InteractionState;
  result: ProgramCheck;
  /**
   * What this revision made: the variant, its index, the version and the
   * program's op count. For a repeat, the first revision's, as recorded.
   */
  made?: { variantId: string; index: number; version: number; ops: number };
  repeat?: true;
}>;

/**
 * An agent revises one variant: a new version, agent-marked; validated before
 * anything commits. With a `clientId` it is applied at most once (2-S1, 3-S1):
 * a repeat by the same person on the same set answers with what the first
 * made, as recorded, never with the repeat's own arguments, and changes
 * nothing, whatever happened to the set since.
 */
export function reviseOp(
  rt: Runtime,
  caller: Caller,
  setId: string,
  index: number,
  program: MutationProgram,
  clientId?: string,
): ReviseOutcome {
  const g = admitSet(rt, caller, "post-variants", setId);
  if (!g.ok) return g;
  const first =
    clientId !== undefined ? revisionByClientId(g.set, caller.personId, clientId) : undefined;
  if (first) {
    return {
      ok: true,
      set: g.set,
      owner: g.owner,
      result: { ok: true },
      made: {
        variantId: first.variantId,
        index: first.index,
        version: first.version,
        ops: first.ops,
      },
      repeat: true,
    };
  }
  const held = heldRefusal(rt, caller, g.owner);
  if (held) return held;
  const result = checkProgram(variantSetRoot(g.set), program);
  if (!result.ok) {
    return {
      ...(result.measured !== undefined
        ? refuse(
            "invalid",
            "program-too-large",
            `The program is ${sizeText(result.measured)} bytes; at most ${sizeText(LIMITS.MAX_PROGRAM_BYTES)} are allowed. Shrink it, then send it again.`,
          )
        : refuse("invalid", "program-invalid", "The program can't apply at this root.")),
      result,
    } as ReviseOutcome;
  }
  const replaced = g.set.variants[index];
  if (replaced) {
    const total = setBytes(g.set.variants) - programBytes(replaced.program) + programBytes(program);
    if (total > LIMITS.MAX_SET_PROGRAM_BYTES)
      return { ...setTooLarge(total), result } as ReviseOutcome;
  }
  const now = rt.clock.now();
  const { open, reopened } = reopenedIfPicked(rt, g.set);
  const r = tuneVariant(open, index, program, now, true, caller.personId, clientId);
  if (!r.ok) return conflict(open.variants[index] ? "wrong-status" : "stale");
  const { set, state } = transact(rt, () => {
    if (reopened) commitSet(rt, { k: "variant-reopened", ts: now, setId }, open);
    return {
      set: commitSet(
        rt,
        {
          k: "variant-tuned",
          ts: now,
          setId,
          index,
          program,
          agent: true,
          by: caller.personId,
          ...(clientId !== undefined ? { clientId } : {}),
        },
        r.state,
      ),
      state: variantsWritten(rt, caller, agentWrote(rt, caller, g.owner), setId),
    };
  });
  fanOutVariantState(rt, set);
  afterMutation(rt, g.owner, state);
  const made = set.variants[index];
  return {
    ok: true,
    set,
    owner: state,
    result,
    ...(made
      ? {
          made: {
            variantId: made.variantId,
            index,
            version: made.version,
            ops: program.length,
          },
        }
      : {}),
  };
}

/* ── reads ────────────────────────────────────────────────────────── */

/** The whole set for a reader: request, root, element context and every variant. */
export function summarizeSet(set: VariantSetState) {
  const root = variantSetRoot(set);
  return {
    setId: set.setId,
    status: set.status,
    command: set.command,
    ...(set.outcome !== undefined ? { outcome: set.outcome } : {}),
    ...(set.activeIndex !== undefined ? { activeIndex: set.activeIndex } : {}),
    ...(set.pickedVariantId !== undefined ? { pickedVariantId: set.pickedVariantId } : {}),
    ...(set.pickedVersion !== undefined ? { pickedVersion: set.pickedVersion } : {}),
    ...(set.intent !== undefined ? { intent: set.intent } : {}),
    ...(set.changeInteractionId !== undefined
      ? { changeInteractionId: set.changeInteractionId }
      : {}),
    ...(root ? { root } : {}),
    ...(root?.kind === "block" ? { element: root.element } : {}),
    expectUrlPrefix: set.expectUrlPrefix,
    variants: set.variants.map((v) => ({
      variantId: v.variantId,
      label: v.label,
      program: v.program,
      version: v.version,
      ...(v.agent ? { agent: true } : {}),
      ...(v.by !== undefined ? { by: v.by } : {}),
    })),
    createdAt: set.createdAt,
    ...(set.resolvedAt !== undefined ? { resolvedAt: set.resolvedAt } : {}),
  };
}
