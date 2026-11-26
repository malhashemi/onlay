import { describe, expect, test } from "bun:test";
import * as z from "zod/mini";
import {
  isPersonId,
  isSpaceId,
  makePersonId,
  makeRef,
  makeSpaceId,
  normalizeEmail,
  PersonSchema,
  PersonSummarySchema,
  parseRef,
  RefSchema,
  SpaceSummarySchema,
  validateWorkspaceName,
  WorkspaceNameSchema,
} from "./space";

/** A deterministic byte source: 0, 1, 2, … */
const counting = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);
const IID = "6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

describe("ids", () => {
  test("person and space ids are a prefix plus 20 lowercase base32 chars", () => {
    const p = makePersonId(counting);
    const s = makeSpaceId(counting);
    expect(p).toBe("p_abcdefghijklmnopqrst");
    expect(s).toBe("s_abcdefghijklmnopqrst");
    expect(isPersonId(p)).toBe(true);
    expect(isSpaceId(s)).toBe(true);
  });

  test("every byte maps into the alphabet", () => {
    const id = makePersonId((n) => new Uint8Array(n).fill(255));
    expect(id).toBe(`p_${"7".repeat(20)}`);
    expect(isPersonId(id)).toBe(true);
  });

  test("a short byte source is refused", () => {
    expect(() => makeSpaceId(() => new Uint8Array(3))).toThrow();
  });

  test("wrong prefixes, cases and lengths are not ids", () => {
    expect(isPersonId("s_abcdefghijklmnopqrst")).toBe(false);
    expect(isSpaceId("s_ABCDEFGHIJKLMNOPQRST")).toBe(false);
    expect(isSpaceId("s_abcdefghijklmnopqrs")).toBe(false);
    expect(isSpaceId("s_abcdefghijklmnopqrs1")).toBe(false); // 1 is not base32
  });
});

describe("refs", () => {
  const space = makeSpaceId(counting);

  test("make and parse round-trip", () => {
    const ref = makeRef(space, IID);
    expect(ref).toBe(`${space}/${IID}`);
    expect(parseRef(ref)).toEqual({ spaceId: space, interactionId: IID });
    expect(z.safeParse(RefSchema, ref).success).toBe(true);
  });

  test("malformed refs parse to null and fail the schema", () => {
    for (const bad of [
      IID,
      `${space}/`,
      `${space}/not-a-uuid`,
      `s_short/${IID}`,
      `${space}/${IID}/x`,
    ]) {
      expect(parseRef(bad)).toBeNull();
      expect(z.safeParse(RefSchema, bad).success).toBe(false);
    }
  });
});

describe("people and spaces", () => {
  const person = {
    id: makePersonId(counting),
    email: "ada@example.com",
    name: "Ada Lovelace",
    initials: "AL",
    tint: "#7c3aed",
  };

  test("a person parses; the summary carries no email", () => {
    expect(z.safeParse(PersonSchema, person).success).toBe(true);
    const summary = z.parse(PersonSummarySchema, person);
    expect("email" in summary).toBe(false);
  });

  test("a person needs a valid email and person id", () => {
    expect(z.safeParse(PersonSchema, { ...person, email: "nope" }).success).toBe(false);
    expect(z.safeParse(PersonSchema, { ...person, id: "ada" }).success).toBe(false);
  });

  test("emails normalize by trimming and lower-casing", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  test("space summaries carry kind and role", () => {
    const space = { id: makeSpaceId(counting), kind: "workspace", name: "acme", role: "guest" };
    expect(z.safeParse(SpaceSummarySchema, space).success).toBe(true);
    expect(z.safeParse(SpaceSummarySchema, { ...space, role: "owner" }).success).toBe(false);
  });
});

describe("workspace names", () => {
  test("accepts lowercase letters, digits and inner hyphens up to 63 chars", () => {
    for (const ok of ["acme", "a", "team-42", "9lives", "x".repeat(63)]) {
      expect(validateWorkspaceName(ok)).toEqual({ ok: true });
      expect(z.safeParse(WorkspaceNameSchema, ok).success).toBe(true);
    }
  });

  test("refuses empty and over-long names", () => {
    expect(validateWorkspaceName("")).toMatchObject({ ok: false, reason: "length" });
    expect(validateWorkspaceName("x".repeat(64))).toMatchObject({ ok: false, reason: "length" });
  });

  test("refuses a leading hyphen, uppercase and other characters", () => {
    for (const bad of ["-acme", "Acme", "acme_co", "acme co", "acmé"]) {
      expect(validateWorkspaceName(bad)).toMatchObject({ ok: false, reason: "charset" });
      expect(z.safeParse(WorkspaceNameSchema, bad).success).toBe(false);
    }
  });

  test("refuses the reserved names", () => {
    for (const reserved of ["api", "app", "auth", "s", "mcp", "personal"]) {
      expect(validateWorkspaceName(reserved)).toEqual({
        ok: false,
        reason: "reserved",
        message: `The name ${reserved} is reserved.`,
      });
      expect(z.safeParse(WorkspaceNameSchema, reserved).success).toBe(false);
    }
  });
});
