/**
 * Edge API bodies (spec §5) and the edge → space control routes (§5.1).
 *
 * Request schemas validate what a client sends; response schemas pin what
 * the server answers so the extension, the web app and the tests agree on
 * one shape. Errors are always `ApiErrorSchema` (caller.ts).
 */
import * as z from "zod/mini";
import { CallerAccessSchema } from "./caller";
import { AgentWorkStatusSchema, InteractionKindSchema } from "./interaction";
import { LIMITS } from "./limits";
import { AttentionRowSchema } from "./outbound";
import { bounded, count } from "./schema-helpers";
import {
  EmailSchema,
  MemberRoleSchema,
  PersonIdSchema,
  PersonSchema,
  PersonSummarySchema,
  RefSchema,
  SpaceIdSchema,
  SpaceSummarySchema,
  WorkspaceNameSchema,
} from "./space";

/** A person's display name, as they set it. */
const DisplayNameSchema = z
  .string()
  .check(z.trim(), z.minLength(1), z.maxLength(LIMITS.MAX_ACTOR_NAME));

/* ── health ───────────────────────────────────────────────────────── */

export const HealthzResponseSchema = z.object({
  ok: z.boolean(),
  sha: bounded(LIMITS.MAX_TAG),
  protocol: count(),
  /** The newest extension version on /download (absent when none is published). */
  extension: z.optional(bounded(LIMITS.MAX_TAG)),
});
export type HealthzResponse = z.infer<typeof HealthzResponseSchema>;

/* ── me ───────────────────────────────────────────────────────────── */

export const MeResponseSchema = z.object({
  person: PersonSchema,
  spaces: z.array(SpaceSummarySchema),
  canCreateWorkspace: z.boolean(),
  superAdmin: z.boolean(),
  /**
   * The extension ids allowed to sign in here: the web app asks each whether
   * it is installed (S-3). Absent from an older server.
   */
  extensionIds: z.optional(z.array(bounded(LIMITS.MAX_TAG)).check(z.maxLength(8))),
  /**
   * The public site's origin (the welcome page, `/install`, `/privacy`): the
   * service's own origin when one origin serves everything. Absent from an
   * older server.
   */
  siteOrigin: z.optional(bounded(LIMITS.MAX_URL)),
  /**
   * AuthKit's logout endpoint (origin and path): the only address the web app
   * follows from a sign-out's answer. Absent from an older server.
   */
  signOutEndpoint: z.optional(bounded(LIMITS.MAX_URL)),
  /** Where the person's name and picture come from (Settings → Account). Absent from an older server. */
  profile: z.optional(
    z.object({
      /** The person set their name here; no sign-in renames them. */
      nameSet: z.boolean(),
      /** Not set here, and their name is their email's local part (no provider name yet). */
      nameFromEmail: z.optional(z.boolean()),
      /** Which picture shows: the sign-in provider's, their own upload, or their initials. */
      picture: z.enum(["provider", "own", "none"]),
      /** Onlay holds a copy of the sign-in provider's picture. */
      providerPicture: z.boolean(),
    }),
  ),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type MeProfile = NonNullable<MeResponse["profile"]>;

/**
 * `PATCH /api/me`: a name the person sets (kept over every sign-in's), and/or
 * which picture shows: `provider` (the sign-in provider's, when there is
 * one) or `none` (initials). An upload is `PUT /api/me/picture`.
 */
export const MePatchRequestSchema = z
  .object({
    name: z.optional(DisplayNameSchema),
    picture: z.optional(z.enum(["provider", "none"])),
  })
  .check(z.refine((body) => body.name !== undefined || body.picture !== undefined));
export type MePatchRequest = z.infer<typeof MePatchRequestSchema>;

/** Account deletion: the person types their own email to confirm. */
export const MeDeleteRequestSchema = z.object({ confirm: bounded(LIMITS.MAX_EMAIL) });
export type MeDeleteRequest = z.infer<typeof MeDeleteRequestSchema>;

/* ── inbox and origins ────────────────────────────────────────────── */

/** Today's attention row, plus the space it lives in. */
export const InboxRowSchema = z.extend(AttentionRowSchema, { spaceId: SpaceIdSchema });
export type InboxRow = z.infer<typeof InboxRowSchema>;

/** Attention merged across the caller's spaces. */
export const InboxResponseSchema = z.object({
  needsYou: z.array(InboxRowSchema),
  waiting: z.array(InboxRowSchema),
  recent: z.array(InboxRowSchema),
  /** The full needs-you count (rows are capped); the badge reads this. */
  needsYouCount: count(),
});
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

/** Per space, the origins with live anchored interactions the caller may see. */
export const OriginsResponseSchema = z.object({
  spaces: z.record(SpaceIdSchema, z.array(bounded(LIMITS.MAX_RESIDUE_ORIGIN))),
});
export type OriginsResponse = z.infer<typeof OriginsResponseSchema>;

/* ── workspaces ───────────────────────────────────────────────────── */

export const WorkspaceCreateRequestSchema = z.object({ name: WorkspaceNameSchema });
export type WorkspaceCreateRequest = z.infer<typeof WorkspaceCreateRequestSchema>;

export const WorkspaceCreateResponseSchema = z.object({ space: SpaceSummarySchema });
export type WorkspaceCreateResponse = z.infer<typeof WorkspaceCreateResponseSchema>;

export const WorkspaceMemberSchema = z.object({ person: PersonSchema, role: MemberRoleSchema });
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

/**
 * Why an invitation still waits although its email has an account: the
 * person is already a member of `LIMITS.MAX_SPACES_PER_PERSON` spaces. It turns into
 * membership at a later sign-in when there is room.
 */
export const INVITATION_WAITING_SPACE_LIMIT = "space-limit";

export const InvitationSchema = z.object({
  email: EmailSchema,
  invitedBy: PersonSummarySchema,
  createdAt: z.number(),
  /** Set while the invitation waits on the space limit; any other tag is shown as nothing. */
  waiting: z.optional(bounded(LIMITS.MAX_TAG)),
});
export type Invitation = z.infer<typeof InvitationSchema>;

export const WorkspaceResponseSchema = z.object({
  space: SpaceSummarySchema,
  members: z.array(WorkspaceMemberSchema),
  /** Present for admins only. */
  invitations: z.optional(z.array(InvitationSchema)),
});
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;

export const WorkspacePatchRequestSchema = z.object({ name: WorkspaceNameSchema });
export type WorkspacePatchRequest = z.infer<typeof WorkspacePatchRequestSchema>;

/** Workspace deletion: the admin types the workspace's name to confirm. */
export const WorkspaceDeleteRequestSchema = z.object({
  confirm: bounded(LIMITS.MAX_WORKSPACE_NAME),
});
export type WorkspaceDeleteRequest = z.infer<typeof WorkspaceDeleteRequestSchema>;

export const InvitationCreateRequestSchema = z.object({ email: EmailSchema });
export type InvitationCreateRequest = z.infer<typeof InvitationCreateRequestSchema>;

/** `joined`: the email belonged to a person, who is now a member. Otherwise an invitation waits. */
export const InvitationCreateResponseSchema = z.object({
  joined: z.boolean(),
  /** Not joined although the email has an account: why it waits (`space-limit`). */
  waiting: z.optional(bounded(LIMITS.MAX_TAG)),
});
export type InvitationCreateResponse = z.infer<typeof InvitationCreateResponseSchema>;

export const MemberPatchRequestSchema = z.object({ role: MemberRoleSchema });
export type MemberPatchRequest = z.infer<typeof MemberPatchRequestSchema>;

/* ── deployment administration ────────────────────────────────────── */

/** Who may create workspaces; missing in storage reads as `listed`. */
export const WORKSPACE_CREATION_POLICIES = ["super_admins", "listed", "anyone"] as const;
export const WorkspaceCreationPolicySchema = z.enum(WORKSPACE_CREATION_POLICIES);
export type WorkspaceCreationPolicy = (typeof WORKSPACE_CREATION_POLICIES)[number];

/** A `listed` entry: one email, or every email at a domain. */
export const CREATOR_KINDS = ["email", "domain"] as const;
export const WorkspaceCreatorSchema = z.object({
  entry: bounded(LIMITS.MAX_EMAIL),
  kind: z.enum(CREATOR_KINDS),
});
export type WorkspaceCreator = z.infer<typeof WorkspaceCreatorSchema>;

export const AdminSettingsResponseSchema = z.object({
  workspaceCreation: WorkspaceCreationPolicySchema,
  creators: z.array(WorkspaceCreatorSchema),
  superAdmins: z.array(PersonSchema),
});
export type AdminSettingsResponse = z.infer<typeof AdminSettingsResponseSchema>;

export const AdminSettingsPutRequestSchema = z.object({
  workspaceCreation: WorkspaceCreationPolicySchema,
  creators: z.array(WorkspaceCreatorSchema).check(z.maxLength(LIMITS.MAX_ATTENTION_ROWS * 10)),
});
export type AdminSettingsPutRequest = z.infer<typeof AdminSettingsPutRequestSchema>;

export const SuperAdminCreateRequestSchema = z.object({ email: EmailSchema });
export type SuperAdminCreateRequest = z.infer<typeof SuperAdminCreateRequestSchema>;

/* ── shares ───────────────────────────────────────────────────────── */

export const ShareSchema = z.object({
  email: EmailSchema,
  sharedBy: PersonSummarySchema,
  createdAt: z.number(),
});
export type Share = z.infer<typeof ShareSchema>;

export const ShareListResponseSchema = z
  .array(ShareSchema)
  .check(z.maxLength(LIMITS.MAX_SHARES_PER_INTERACTION));
export type ShareListResponse = z.infer<typeof ShareListResponseSchema>;

export const ShareCreateRequestSchema = z.object({ email: EmailSchema });
export type ShareCreateRequest = z.infer<typeof ShareCreateRequestSchema>;

/* ── sign-in ──────────────────────────────────────────────────────── */

/** `GET /auth/extension` query: the extension id, its PKCE challenge, and a nonce. */
export const ExtensionAuthQuerySchema = z.object({
  ext: bounded(LIMITS.MAX_TAG),
  challenge: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
  state: bounded(LIMITS.MAX_ID),
});
export type ExtensionAuthQuery = z.infer<typeof ExtensionAuthQuerySchema>;

export const ExtensionTokenRequestSchema = z.object({
  code: bounded(LIMITS.MAX_ID),
  verifier: z.string().check(z.regex(/^[A-Za-z0-9_-]{43,128}$/)),
});
export type ExtensionTokenRequest = z.infer<typeof ExtensionTokenRequestSchema>;

export const ExtensionTokenResponseSchema = z.object({
  token: bounded(LIMITS.MAX_ID),
  person: PersonSchema,
});
export type ExtensionTokenResponse = z.infer<typeof ExtensionTokenResponseSchema>;

/**
 * `POST /auth/logout` and `/auth/logout-everywhere` from a web session that
 * came from AuthKit (200; otherwise 204 and no body): where the browser goes
 * next to end its AuthKit session too, AuthKit's logout, which then returns
 * to the public site.
 */
export const SignOutResponseSchema = z.object({
  signOutUrl: z.url({ protocol: /^https?$/ }),
});
export type SignOutResponse = z.infer<typeof SignOutResponseSchema>;

/** `POST /auth/dev/session`, only when `DEV_AUTH` is "1". */
export const DevSessionRequestSchema = z.object({
  email: EmailSchema,
  name: z.optional(DisplayNameSchema),
});
export type DevSessionRequest = z.infer<typeof DevSessionRequestSchema>;

/** `token` is an extension-class client token for the same person. */
export const DevSessionResponseSchema = ExtensionTokenResponseSchema;
export type DevSessionResponse = ExtensionTokenResponse;

/* ── space routes ─────────────────────────────────────────────────── */

/** One pending item for agents, as a listing or the MCP `inbox` shows it. */
export const AgentWorkItemSchema = z.object({
  ref: RefSchema,
  kind: InteractionKindSchema,
  /** One line: the Edit's intent, or the comment's first words. */
  summary: bounded(LIMITS.MAX_ANCHOR_LABEL),
  /** The page; absent for an unanchored interaction. */
  url: z.optional(bounded(LIMITS.MAX_URL)),
  spaceId: SpaceIdSchema,
  spaceName: bounded(LIMITS.MAX_ACTOR_NAME),
  requestedBy: PersonSummarySchema,
  requestedAt: z.number(),
  status: AgentWorkStatusSchema,
});
export type AgentWorkItem = z.infer<typeof AgentWorkItemSchema>;

/** `GET /agent-work`: pending items, the caller's own requests apart from teammates'. */
export const AgentWorkListingSchema = z.object({
  yours: z.array(AgentWorkItemSchema),
  teammates: z.array(AgentWorkItemSchema),
});
export type AgentWorkListing = z.infer<typeof AgentWorkListingSchema>;

/** `GET /agent-work` query: narrow to one page, one origin, or one repo (`anchor.provenance`). */
export const AgentWorkQuerySchema = z.object({
  url: z.optional(bounded(LIMITS.MAX_URL)),
  origin: z.optional(bounded(LIMITS.MAX_RESIDUE_ORIGIN)),
  repo: z.optional(bounded(LIMITS.MAX_PROVENANCE)),
});
export type AgentWorkQuery = z.infer<typeof AgentWorkQuerySchema>;

/** `GET /interaction/:id/wait` query. */
export const WaitQuerySchema = z.object({
  since: count(),
  timeout: z.number().check(z.gte(0), z.lte(LIMITS.MAX_WAIT_SECONDS)),
});
export type WaitQuery = z.infer<typeof WaitQuerySchema>;

/* ── edge → space control routes (§5.1) ───────────────────────────── */

/**
 * One person as a space shows them. `guest` marks a non-member who holds a
 * share in the space right now.
 */
export const InternalPersonSchema = z.extend(PersonSummarySchema, {
  member: z.boolean(),
  guest: z.optional(z.boolean()),
});
export type InternalPerson = z.infer<typeof InternalPersonSchema>;

/**
 * `POST /internal/person`: one person's display data in the space, upserted,
 * or `removed` (left, removed or deleted: kept only for names in past
 * messages). Per person, so revocation never waits for a whole roster.
 */
export const InternalPersonRequestSchema = z.union([
  z.object({ person: InternalPersonSchema }),
  z.object({ personId: PersonIdSchema, removed: z.literal(true) }),
]);
export type InternalPersonRequest = z.infer<typeof InternalPersonRequestSchema>;

/** Re-scope that person's sockets, or close them when `access` is null. */
export const InternalAccessChangedRequestSchema = z.object({
  personId: PersonIdSchema,
  access: z.nullable(CallerAccessSchema),
});
export type InternalAccessChangedRequest = z.infer<typeof InternalAccessChangedRequestSchema>;

/**
 * Credentials signed out: close that person's sockets opened with them and
 * delete their push subscriptions. No `credentialIds` = every credential of
 * the person (sign out everywhere, account deletion).
 */
export const InternalCredentialRevokedRequestSchema = z.object({
  personId: PersonIdSchema,
  credentialIds: z.optional(z.array(bounded(LIMITS.MAX_ID)).check(z.maxLength(256))),
  /**
   * Sign out everywhere (and an email or subject change, account deletion):
   * the person's new credential generation. Every credential stamped below it
   * is refused from now on; one issued after the change carries it and is not,
   * however late the notice arrives.
   */
  minGeneration: z.optional(z.number().check(z.int(), z.gte(0))),
});
export type InternalCredentialRevokedRequest = z.infer<
  typeof InternalCredentialRevokedRequestSchema
>;

/**
 * `GET /interaction/:id?peek=1`: a read that never pays the "shared with you"
 * debt (automatic recoveries use it; only a person opening the thread reads
 * without it).
 */
export const PEEK_PARAM = "peek";
