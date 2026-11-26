/**
 * Admission — who may create and mutate what in a space (spec §7), as pure
 * functions over the caller's client class and access. The space runs these
 * before any reducer; URL binding and author-only rules (edit/delete own) stay
 * where they are and apply on top.
 *
 *   caller                 creates                         mutates
 *   member · full          anchored Comment, Edit, Ask     every human mutation (on a matching URL)
 *   member · interaction   unanchored Comment              reply, edit/delete own, react, resolve,
 *                                                          reopen, attach, pick, discard (+ answer,
 *                                                          fresh-look: kept from the local web app)
 *   guest  · any class     nothing                         shared interactions only: reply,
 *                                                          edit/delete own, react, attach, pick
 *   agent                  nothing                         reply, post variants, Edit state, take,
 *                                                          release; a guest's agent only replies,
 *                                                          and only where its person is shared
 *
 * Out-of-scope reads as missing (`not_found`); an in-scope action the caller
 * may not take is `forbidden`.
 */
import type { Anchor, CallerAccess, ClientClass, InteractionKind } from "@onlay/protocol";

export interface AdmissionCaller {
  class: ClientClass;
  access: CallerAccess;
}

/** Mutations people make (from the extension or the web app). */
export const HUMAN_MUTATIONS = [
  "reply",
  "edit-own",
  "delete-own",
  "react",
  "resolve",
  "reopen",
  "attach",
  "pick",
  "discard",
  "answer",
  "anchor",
  "reanchor",
  "anchor-lost",
  "batch",
  "steer",
  "tune",
  "fresh-look",
  /** Drop an Edit, or any other human Edit state change. */
  "set-state",
] as const;

/** Mutations agents make through MCP. `agent-state` is `working` or `implemented` only. */
export const AGENT_MUTATIONS = [
  "reply",
  "post-variants",
  "agent-state",
  "take",
  "release",
] as const;

export type MutationKind = (typeof HUMAN_MUTATIONS)[number] | (typeof AGENT_MUTATIONS)[number];

const INTERACTION_CLIENT_MUTATIONS: ReadonlySet<MutationKind> = new Set<MutationKind>([
  "reply",
  "edit-own",
  "delete-own",
  "react",
  "resolve",
  "reopen",
  "attach",
  "pick",
  "discard",
  "answer",
  "fresh-look",
]);

const GUEST_MUTATIONS: ReadonlySet<MutationKind> = new Set<MutationKind>([
  "reply",
  "edit-own",
  "delete-own",
  "react",
  "attach",
  "pick",
]);

const AGENT_MUTATION_SET: ReadonlySet<MutationKind> = new Set<MutationKind>(AGENT_MUTATIONS);
const HUMAN_MUTATION_SET: ReadonlySet<MutationKind> = new Set<MutationKind>(HUMAN_MUTATIONS);
const GUEST_AGENT_MUTATIONS: ReadonlySet<MutationKind> = new Set<MutationKind>(["reply"]);

export type AdmissionRefusal =
  | "not-shared"
  | "guest"
  | "agent"
  | "needs-anchor"
  | "needs-page"
  | "edit-needs-page"
  | "not-allowed";

export type Admission =
  | { ok: true }
  | { ok: false; code: "not_found" | "forbidden"; reason: AdmissionRefusal };

const OK: Admission = { ok: true };
const forbidden = (reason: AdmissionRefusal): Admission => ({
  ok: false,
  code: "forbidden",
  reason,
});

/** May this access see this interaction at all? Members see the whole space. */
export function canSeeInteraction(access: CallerAccess, interactionId: string): boolean {
  return access.kind === "member" || access.interactionIds.includes(interactionId);
}

/** May this caller open an interaction of this kind at this anchor? */
export function admitCreate(
  caller: AdmissionCaller,
  kind: InteractionKind,
  anchor: Anchor,
): Admission {
  if (caller.class === "agent") return forbidden("agent");
  if (caller.access.kind === "guest") return forbidden("guest");
  if (caller.class === "interaction") {
    if (kind === "change") return forbidden("edit-needs-page");
    if (kind !== "comment") return forbidden("not-allowed");
    return anchor.level === "unanchored" ? OK : forbidden("needs-page");
  }
  // full: holding the page, a person anchors (block or page).
  return anchor.level === "unanchored" ? forbidden("needs-anchor") : OK;
}

/** May this caller make this mutation on this interaction? */
export function admitMutation(
  caller: AdmissionCaller,
  kind: MutationKind,
  interactionId: string,
): Admission {
  if (!canSeeInteraction(caller.access, interactionId)) {
    return { ok: false, code: "not_found", reason: "not-shared" };
  }
  if (caller.class === "agent") {
    const allowed = caller.access.kind === "guest" ? GUEST_AGENT_MUTATIONS : AGENT_MUTATION_SET;
    return allowed.has(kind) ? OK : forbidden("agent");
  }
  if (!HUMAN_MUTATION_SET.has(kind)) return forbidden("not-allowed");
  if (caller.access.kind === "guest") {
    return GUEST_MUTATIONS.has(kind) ? OK : forbidden("guest");
  }
  if (caller.class === "interaction") {
    return INTERACTION_CLIENT_MUTATIONS.has(kind) ? OK : forbidden("needs-page");
  }
  return OK;
}
