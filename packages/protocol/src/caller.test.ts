import { describe, expect, test } from "bun:test";
import * as z from "zod/mini";
import {
  API_ERROR_STATUS,
  ApiErrorSchema,
  apiError,
  type Caller,
  ClientTokenSchema,
  decodeCaller,
  encodeCaller,
} from "./caller";

const member: Caller = {
  personId: "p_abcdefghijklmnopqrst",
  name: "Zoë Ångström",
  initials: "ZÅ",
  tint: "#0ea5e9",
  class: "full",
  access: { kind: "member", role: "admin" },
  credentialId: "tok_1",
};

const guest: Caller = {
  personId: "p_bbbbbbbbbbbbbbbbbbbb",
  name: "Guest 🙂",
  initials: "G",
  tint: "#f97316",
  avatarUrl: "https://example.com/a.png",
  class: "interaction",
  access: { kind: "guest", interactionIds: ["6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b"] },
  credentialId: "ses_1",
};

describe("caller header", () => {
  test("round-trips members and guests, non-ASCII names included", () => {
    for (const c of [member, guest]) {
      const header = encodeCaller(c);
      expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCaller(header)).toEqual(c);
    }
  });

  test("refuses garbage, padding, bad JSON and invalid shapes", () => {
    expect(decodeCaller("")).toBeNull();
    expect(decodeCaller("not base64!")).toBeNull();
    expect(decodeCaller(`${encodeCaller(member)}=`)).toBeNull();
    expect(decodeCaller("e30")).toBeNull(); // "{}" — valid JSON, wrong shape
    expect(decodeCaller("eyJh")).toBeNull(); // '{"a' — not JSON
    const forged = { ...member, class: "operator" };
    expect(decodeCaller(encodeCaller(forged as unknown as Caller))).toBeNull();
    const badAccess = { ...member, access: { kind: "guest", interactionIds: ["nope"] } };
    expect(decodeCaller(encodeCaller(badAccess as unknown as Caller))).toBeNull();
  });

  test("refuses an over-long header without decoding it", () => {
    expect(decodeCaller("A".repeat(70_000))).toBeNull();
  });
});

describe("errors", () => {
  test("the table maps every code to its status", () => {
    expect(API_ERROR_STATUS).toEqual({
      invalid: 400,
      sign_in_required: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      last_admin: 409,
      upgrade_required: 426,
      rate_limited: 429,
      unavailable: 503,
    });
  });

  test("apiError builds a body the schema accepts; unknown codes are refused", () => {
    expect(
      z.safeParse(ApiErrorSchema, apiError("conflict", "The name acme is taken.")).success,
    ).toBe(true);
    expect(z.safeParse(ApiErrorSchema, { error: { code: "teapot", message: "" } }).success).toBe(
      false,
    );
  });

  test("an error may carry a machine reason", () => {
    expect(apiError("conflict", "That page doesn't match.", "url-mismatch")).toEqual({
      error: { code: "conflict", message: "That page doesn't match.", reason: "url-mismatch" },
    });
    expect(apiError("not_found", "Nothing is here.")).toEqual({
      error: { code: "not_found", message: "Nothing is here." },
    });
  });
});

test("client tokens are onl_ plus 43 base64url chars", () => {
  expect(z.safeParse(ClientTokenSchema, `onl_${"a".repeat(43)}`).success).toBe(true);
  expect(z.safeParse(ClientTokenSchema, `onl_${"a".repeat(42)}`).success).toBe(false);
  expect(z.safeParse(ClientTokenSchema, `tok_${"a".repeat(43)}`).success).toBe(false);
});

describe("access epoch", () => {
  test("rides the caller header when the edge read one, and is optional", () => {
    const withEpoch: Caller = { ...member, accessEpoch: 7 };
    expect(decodeCaller(encodeCaller(withEpoch))).toEqual(withEpoch);
    expect(decodeCaller(encodeCaller(member))?.accessEpoch).toBeUndefined();
  });

  test("is a non-negative integer", () => {
    for (const accessEpoch of [-1, 1.5]) {
      expect(decodeCaller(encodeCaller({ ...member, accessEpoch }))).toBeNull();
    }
  });
});

describe("what a caller must carry (review 2, finding 13)", () => {
  test("an empty credential id or a guest with no shares is not a caller", () => {
    expect(decodeCaller(encodeCaller({ ...member, credentialId: "" }))).toBeNull();
    expect(
      decodeCaller(encodeCaller({ ...guest, access: { kind: "guest", interactionIds: [] } })),
    ).toBeNull();
    expect(decodeCaller(encodeCaller(guest))).toEqual(guest);
  });
});
