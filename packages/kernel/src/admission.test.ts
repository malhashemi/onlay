import { describe, expect, test } from "bun:test";
import type { Anchor, CallerAccess, ClientClass } from "@onlay/protocol";
import {
  type AdmissionCaller,
  AGENT_MUTATIONS,
  admitCreate,
  admitMutation,
  canSeeInteraction,
  HUMAN_MUTATIONS,
  type MutationKind,
} from "./admission";

const SHARED = "6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER = "7f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const member: CallerAccess = { kind: "member", role: "member" };
const guest: CallerAccess = { kind: "guest", interactionIds: [SHARED] };
const page: Anchor = { level: "page" };
const block: Anchor = { level: "element", selector: "main > h1" };
const unanchored: Anchor = { level: "unanchored" };

const as = (cls: ClientClass, access: CallerAccess): AdmissionCaller => ({ class: cls, access });
const allowed = (caller: AdmissionCaller, id = SHARED): MutationKind[] =>
  [...new Set<MutationKind>([...HUMAN_MUTATIONS, ...AGENT_MUTATIONS])].filter(
    (k) => admitMutation(caller, k, id).ok,
  );

describe("creation", () => {
  test("a member on the extension anchors Comments, Edits and Asks; never unanchored", () => {
    const full = as("full", member);
    for (const kind of ["comment", "change", "ask"] as const) {
      expect(admitCreate(full, kind, block)).toEqual({ ok: true });
      expect(admitCreate(full, kind, page)).toEqual({ ok: true });
    }
    expect(admitCreate(full, "comment", unanchored)).toMatchObject({ reason: "needs-anchor" });
  });

  test("a member on the web app opens unanchored Comments only", () => {
    const web = as("interaction", member);
    expect(admitCreate(web, "comment", unanchored)).toEqual({ ok: true });
    expect(admitCreate(web, "comment", page)).toMatchObject({ reason: "needs-page" });
    expect(admitCreate(web, "change", unanchored)).toMatchObject({ reason: "edit-needs-page" });
    expect(admitCreate(web, "ask", unanchored)).toMatchObject({ reason: "not-allowed" });
  });

  test("guests and agents create nothing", () => {
    for (const cls of ["full", "interaction"] as const) {
      expect(admitCreate(as(cls, guest), "comment", page)).toMatchObject({
        code: "forbidden",
        reason: "guest",
      });
    }
    expect(admitCreate(as("agent", member), "ask", unanchored)).toMatchObject({ reason: "agent" });
  });
});

describe("mutation", () => {
  test("a member on the extension may make every human mutation, no agent one", () => {
    expect(allowed(as("full", member))).toEqual([...HUMAN_MUTATIONS]);
  });

  test("a member on the web app keeps the pageless set", () => {
    expect(allowed(as("interaction", member))).toEqual([
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
  });

  test("a guest acts only on shared interactions, and never resolves", () => {
    for (const cls of ["full", "interaction"] as const) {
      expect(allowed(as(cls, guest))).toEqual([
        "reply",
        "edit-own",
        "delete-own",
        "react",
        "attach",
        "pick",
      ]);
      expect(admitMutation(as(cls, guest), "reply", OTHER)).toEqual({
        ok: false,
        code: "not_found",
        reason: "not-shared",
      });
      expect(admitMutation(as(cls, guest), "resolve", SHARED)).toMatchObject({ code: "forbidden" });
    }
  });

  test("an agent writes as an agent; a guest's agent only replies where shared", () => {
    expect(allowed(as("agent", member))).toEqual([
      "reply",
      "post-variants",
      "agent-state",
      "take",
      "release",
    ]);
    expect(allowed(as("agent", guest))).toEqual(["reply"]);
    expect(admitMutation(as("agent", guest), "reply", OTHER)).toMatchObject({ code: "not_found" });
  });

  test("visibility: members see everything, guests their shares", () => {
    expect(canSeeInteraction(member, OTHER)).toBe(true);
    expect(canSeeInteraction(guest, SHARED)).toBe(true);
    expect(canSeeInteraction(guest, OTHER)).toBe(false);
  });
});
