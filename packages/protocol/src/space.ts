/**
 * Spaces and people — the hosted service's identities (spec §2, §4, §6).
 *
 * A Person is someone who signed in, known by one email. Every interaction
 * lives in a Space: each person's personal space, or a shared workspace.
 * Outside its space an interaction is addressed by its ref,
 * `<spaceId>/<interactionId>`.
 *
 * Id generators take the random-bytes source as an argument so this module
 * stays pure: the server passes `crypto.getRandomValues`, tests pass a fixed
 * sequence.
 */
import * as z from "zod/mini";
import { LIMITS } from "./limits";
import { bounded } from "./schema-helpers";

/* ── ids ──────────────────────────────────────────────────────────── */

/** RFC 4648 base32, lower-cased: the alphabet of person and space ids. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const ID_BODY_LENGTH = 20;

export const PERSON_ID_PREFIX = "p_";
export const SPACE_ID_PREFIX = "s_";

const PERSON_ID_RE = /^p_[a-z2-7]{20}$/;
const SPACE_ID_RE = /^s_[a-z2-7]{20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_RE =
  /^s_[a-z2-7]{20}\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A source of `n` uniformly random bytes (e.g. `n => crypto.getRandomValues(new Uint8Array(n))`). */
export type RandomBytes = (n: number) => Uint8Array;

/** 256 is a multiple of 32, so each byte's low five bits are uniform. */
function base32Body(randomBytes: RandomBytes): string {
  const bytes = randomBytes(ID_BODY_LENGTH);
  if (bytes.length < ID_BODY_LENGTH) throw new Error("randomBytes returned too few bytes");
  let out = "";
  for (let i = 0; i < ID_BODY_LENGTH; i++) out += BASE32[(bytes[i] ?? 0) & 31];
  return out;
}

export function makePersonId(randomBytes: RandomBytes): string {
  return PERSON_ID_PREFIX + base32Body(randomBytes);
}

export function makeSpaceId(randomBytes: RandomBytes): string {
  return SPACE_ID_PREFIX + base32Body(randomBytes);
}

export function isPersonId(s: string): boolean {
  return PERSON_ID_RE.test(s);
}

export function isSpaceId(s: string): boolean {
  return SPACE_ID_RE.test(s);
}

export const PersonIdSchema = z.string().check(z.regex(PERSON_ID_RE));
export const SpaceIdSchema = z.string().check(z.regex(SPACE_ID_RE));

/* ── refs ─────────────────────────────────────────────────────────── */

/** An interaction addressed outside its space: `<spaceId>/<interactionId>`. */
export const RefSchema = z.string().check(z.regex(REF_RE));

export interface ParsedRef {
  spaceId: string;
  interactionId: string;
}

export function makeRef(spaceId: string, interactionId: string): string {
  return `${spaceId}/${interactionId}`;
}

/** The two halves of a ref, or null when either half is malformed. */
export function parseRef(ref: string): ParsedRef | null {
  const slash = ref.indexOf("/");
  if (slash < 0) return null;
  const spaceId = ref.slice(0, slash);
  const interactionId = ref.slice(slash + 1);
  if (!isSpaceId(spaceId) || !UUID_RE.test(interactionId)) return null;
  return { spaceId, interactionId };
}

/* ── people ───────────────────────────────────────────────────────── */

/** A person is their email, lower-cased and trimmed (spec §4). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const EmailSchema = z.email().check(z.maxLength(LIMITS.MAX_EMAIL));

const personSummaryShape = () => ({
  id: PersonIdSchema,
  name: bounded(LIMITS.MAX_ACTOR_NAME),
  initials: bounded(LIMITS.MAX_INITIALS),
  /** Hex color assigned at first sign-in — the person's tint everywhere. */
  tint: bounded(LIMITS.MAX_COLOR),
  /** Their picture: a service-relative path (`./picture.ts`); absent: their initials. */
  avatarUrl: z.optional(bounded(LIMITS.MAX_URL)),
  /**
   * Their alias, the local part of their email, for finding them by it. Only
   * a space's members get it, and only for fellow members (never a guest,
   * never the rest of the address).
   */
  alias: z.optional(bounded(LIMITS.MAX_ALIAS)),
});

/** The signed-in person, as they see themselves and as admins see members. */
export const PersonSchema = z.object({
  ...personSummaryShape(),
  email: EmailSchema,
});
export type Person = z.infer<typeof PersonSchema>;

/** A person as the space directory shows them: no email. */
export const PersonSummarySchema = z.object(personSummaryShape());
export type PersonSummary = z.infer<typeof PersonSummarySchema>;

/* ── spaces ───────────────────────────────────────────────────────── */

export const SPACE_KINDS = ["personal", "workspace"] as const;
export const SpaceKindSchema = z.enum(SPACE_KINDS);
export type SpaceKind = (typeof SPACE_KINDS)[number];

/** The stored roles of a workspace member. */
export const MEMBER_ROLES = ["admin", "member"] as const;
export const MemberRoleSchema = z.enum(MEMBER_ROLES);
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** A caller's standing in one space: a member role, or guest (holds a share there; never stored). */
export const SPACE_ROLES = ["admin", "member", "guest"] as const;
export const SpaceRoleSchema = z.enum(SPACE_ROLES);
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const SpaceSummarySchema = z.object({
  id: SpaceIdSchema,
  kind: SpaceKindSchema,
  name: bounded(LIMITS.MAX_ACTOR_NAME),
  role: SpaceRoleSchema,
});
export type SpaceSummary = z.infer<typeof SpaceSummarySchema>;

/* ── workspace names (spec §6) ────────────────────────────────────── */

export const RESERVED_WORKSPACE_NAMES = ["api", "app", "auth", "s", "mcp", "personal"] as const;

const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export type WorkspaceNameCheck =
  | { ok: true }
  | { ok: false; reason: "length" | "charset" | "reserved"; message: string };

/**
 * 1–63 lowercase letters, digits and hyphens, not starting with a hyphen,
 * and not reserved. Uniqueness is the directory's check, not this one's.
 */
export function validateWorkspaceName(name: string): WorkspaceNameCheck {
  if (name.length < 1 || name.length > LIMITS.MAX_WORKSPACE_NAME) {
    return { ok: false, reason: "length", message: "Use 1 to 63 characters." };
  }
  if (!WORKSPACE_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: "charset",
      message: "Use lowercase letters, digits and hyphens, and don't start with a hyphen.",
    };
  }
  if ((RESERVED_WORKSPACE_NAMES as readonly string[]).includes(name)) {
    return { ok: false, reason: "reserved", message: `The name ${name} is reserved.` };
  }
  return { ok: true };
}

export const WorkspaceNameSchema = z.string().check(
  z.minLength(1),
  z.maxLength(LIMITS.MAX_WORKSPACE_NAME),
  z.regex(WORKSPACE_NAME_RE),
  z.refine((name) => validateWorkspaceName(name).ok, { message: "reserved-workspace-name" }),
);
