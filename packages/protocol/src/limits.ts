/**
 * Protocol-wide hard limits. Every inbound frame is gated by these BEFORE it
 * reaches any handler — schema + size limits are the threat-model floor:
 * page-derived text is attacker-controlled input.
 */
export const PROTOCOL_VERSION = 2;

/**
 * The oldest client protocol the hosted service still serves (spec §5). A
 * client below it gets `upgrade_required` over HTTP and close code
 * `CLOSE_UPGRADE_REQUIRED` on a socket. Starts equal to `PROTOCOL_VERSION`.
 */
export const MIN_CLIENT_PROTOCOL = 2;

/**
 * The default server port for the out-of-band server↔extension contract: a
 * browser extension cannot read `.onlay/`, so the loopback connection starts
 * here — unless the user sets a custom port in the extension options page
 * (Connection → Local server port), which the service worker honours for the
 * zero-config auto-pair path.
 */
export const DEFAULT_SERVER_PORT = 8123;

export const LIMITS = {
  /**
   * Cheap pre-parse DoS guard, measured in UTF-16 code units (`string.length`)
   * so it works identically in the extension service worker and the server
   * without an encode pass. Anything larger is rejected before JSON.parse.
   */
  MAX_FRAME_CHARS: 16_384,

  /**
   * Server→extension frames get a larger budget: state snapshots can carry
   * whole thread snapshots, and the sender is the trusted local server (the
   * gate already authenticated the socket) — the inbound DoS posture does
   * not apply. The server still truncates oldest threads to stay under this.
   */
  MAX_OUTBOUND_FRAME_CHARS: 1_048_576,

  MAX_URL: 2_048,
  MAX_SELECTOR: 1_024,
  /** Frames an anchor's `framePath` may cross, from the owning document down (A-3). */
  MAX_FRAME_PATH: 4,
  MAX_TAG: 64,
  MAX_ID: 256,
  MAX_CLASSES: 32,
  MAX_CLASS_LEN: 128,
  MAX_TEXT_SNIPPET: 200,
  MAX_COMMAND_TEXT: 4_096,
  MAX_COLOR: 32,

  /** Per-session outbound (agent→browser) queue caps; overflow drops oldest. */
  MAX_QUEUE_FRAMES: 256,
  MAX_QUEUE_BYTES: 524_288,

  // ---- shared interaction text ----
  MAX_TITLE: 200,
  MAX_COMMENT_TEXT: 4_096,
  MAX_ANCHOR_ID: 128,
  /** Block-level preview text (blocks are bigger than single elements). */
  MAX_SNIPPET: 512,
  /** Per-state-snapshot interaction count growth guard. */
  MAX_INTERACTIONS_PER_STATE: 500,

  // ---- view mode ----
  MAX_VARIANT_SET_ID: 64,
  MAX_VARIANTS_PER_SET: 20, // set-wide cap (maker-raised from the ticket's 4 once streaming/append landed; the cycle row paginates, it no longer bounds the set)
  MAX_VARIANT_LABEL: 120,
  MAX_MUTATION_OPS: 64, // ops per variant program
  MAX_STYLE_PROPS: 32, // props per setStyle op
  MAX_CSS_PROP: 64,
  MAX_CSS_VALUE: 512, // holds gradients/urls
  MAX_ATTR_VALUE: 2_048,
  MAX_MUTATION_TEXT: 4_096, // setText replacement
  MAX_FRAGMENT_CHARS: 32_768, // insertFragment HTML; fits MAX_OUTBOUND_FRAME_CHARS with headroom
  MAX_COMMAND_INTENT: 4_096, // the human's free-text command
  MAX_ELEMENT_MARKUP: 8_192, // trimmed markup snippet at pick
  MAX_SOURCE_POINTER: 512, // data-onlay-source "file:line:column"

  // ---- anchor content (ADR-0017: the captured element travels) ----
  /** Sidecar cap on the sanitized outerHTML captured at element-anchor time
   *  (HTTP-uploaded, NEVER a WS frame — inbound frames cap at 16 KiB). */
  MAX_ANCHOR_CONTENT: 131_072, // 128 KiB
  /** Bound on the structure-preserving markdown excerpt rendered into wakes. */
  MAX_ANCHOR_EXCERPT: 2_048,
  /** Document provenance attr: `origin@sha;branch;dirty` (dev-only stamp). */
  MAX_PROVENANCE: 256,

  // ---- captures ----
  MAX_CAPTURE_ID: 64,
  MAX_CAPTURE_PART_NAME: 64,
  MAX_CAPTURE_MIME: 128,
  MAX_CAPTURE_FORMAT: 64,
  MAX_CAPTURE_CAPTION: 2_048,
  MAX_CAPTURE_META: 8_192,
  /** Residue summary bounds (capture spec §6/§1.8) — mirrored extension-side. */
  MAX_RESIDUE_ENTRIES: 12,
  MAX_RESIDUE_ORIGINS: 8,
  MAX_RESIDUE_DETAIL: 64,
  MAX_RESIDUE_ORIGIN: 256, // a `scheme://host:port` origin string bound
  /** Signed document-space CSS-px coordinate bound (rects/viewport, §1.6). */
  MAX_CAPTURE_COORD: 33_554_432, // 2^25 — the browser element-size ceiling
  MAX_CAPTURE_PART_BYTES: 5_242_880,
  MAX_CAPTURE_TOTAL_BYTES: 8_388_608,
  MAX_CAPTURE_PARTS: 16,
  MAX_CAPTURE_REVISIONS: 10,
  MAX_CAPTURES_PER_INTERACTION: 50,
  MAX_CAPTURE_IMAGE_PIXELS: 40_000_000,
  MAX_CAPTURE_QUOTA_ACTOR_BYTES: 268_435_456,
  MAX_CAPTURE_QUOTA_GLOBAL_BYTES: 2_147_483_648,
  MAX_PENDING_CAPTURES_PER_ACTOR: 4,
  STAGING_TTL_MS: 600_000,
  CAPTURE_UPLOAD_TIMEOUT_MS: 30_000,

  // ---- actors & pairing ----
  MAX_ACTOR_ID: 64, // slug [a-z0-9-]
  MAX_ACTOR_NAME: 80,
  MAX_INITIALS: 4,
  MAX_AVATAR_DATA: 96_000,
  /** A stored picture (a provider's copy or an upload), in bytes. */
  MAX_PICTURE_BYTES: 65_536,
  /** A person's alias: their email's local part (an email's local part is at most 64). */
  MAX_ALIAS: 64,
  MAX_INVITE_CODE: 32, // e.g. HUM-XXXX-XXXX
  MAX_CLIENT_LABEL: 120,

  // ---- interactions (comment · ask · change) ----
  MAX_QUESTION: 500, // the ask's one-line question
  MAX_ASK_CONTEXT: 32_000, // required markdown context
  MAX_ASK_OPTIONS: 12,
  MAX_OPTION_ID: 64,
  MAX_OPTION_LABEL: 120,
  MAX_OPTION_DESC: 500,
  /** Typed @actor/#anchor tokens riding one thread message. */
  MAX_TOKENS_PER_MSG: 32,
  MAX_EMOJI: 8, // one emoji reaction key (grapheme clusters are wide)
  /** Per-interaction thread growth guard. */
  MAX_THREAD_MSGS: 500,
  /** Prior thread messages included with an agent wake for orientation. */
  MAX_AGENT_THREAD_CONTEXT: 10,
  MAX_ANCHOR_LABEL: 200, // human-readable label on a # anchor token
  /** Attention popover row caps per section (needs-you / waiting / recent). */
  MAX_ATTENTION_ROWS: 50,
  /** How long a resolved interaction stays surfaced as "recently resolved". */
  RECENT_RESOLVED_MS: 172_800_000,

  // ---- hosted service (spec §4–§9) ----
  /** Ops per mutation program whose root is the whole page (block roots keep MAX_MUTATION_OPS). */
  MAX_MUTATION_OPS_PAGE: 256,
  /** Sanitized `document.body` snapshot uploaded at page-edit creation. */
  MAX_PAGE_CONTENT: 1_048_576,
  /** Sockets (one per space) a single extension client keeps open. */
  MAX_SPACES_PER_CLIENT: 12,
  MAX_SHARES_PER_INTERACTION: 50,
  /**
   * Spaces one person may be in. Creating a workspace and an invitation
   * turning into membership count their member spaces (the personal space
   * included): past it, creating is `conflict`/`space-limit` and an
   * invitation waits. A share that would make them a guest counts member and
   * guest spaces together and is refused the same way.
   */
  MAX_SPACES_PER_PERSON: 50,
  MAX_EMAIL: 254,
  MAX_WORKSPACE_NAME: 63,
  /** Capture blobs are stored as rows of at most this many bytes. */
  MAX_BLOB_CHUNK: 1_048_576,
  /** How long an agent's `take` holds an item; every agent write by the holder renews it. */
  AGENT_LEASE_MS: 600_000,
  /** Upper bound on `/interaction/:id/wait` and the MCP `wait` tool. */
  MAX_WAIT_SECONDS: 25,
  /**
   * The serialized JSON of one mutation program (block or page root), in
   * UTF-8 bytes: what one variant, one hand-made batch or one manual edit
   * may carry. Measured with `programBytes`.
   */
  MAX_PROGRAM_BYTES: 262_144,
  /** Every program of one variant set together, in the same measure. */
  MAX_SET_PROGRAM_BYTES: 1_048_576,
  /** Live (unresolved) interactions one space holds; creating more is `conflict`/`space-full`. */
  MAX_LIVE_INTERACTIONS: 5_000,
} as const;
