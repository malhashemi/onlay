// Happy-path unit tests for the full-page interaction view's pure view-model
// helpers (ui-spec §4). Rendering is exercised e2e; these lock the facts the
// page draws from server truth.

import { describe, expect, test } from "bun:test";
import {
  type ActorSummary,
  type CaptureRef,
  type RawInteractionSnapshot,
  RESIDUE_CLASSES,
} from "@onlay/protocol";
import {
  age,
  anchorIsCapturable,
  anchorLabel,
  askIsOpen,
  attachmentCaptures,
  becauseLabel,
  captureResidueLine,
  chipState,
  collectResidue,
  decodeBase64,
  editContextCapture,
  fallbackActor,
  hostOf,
  humanBytes,
  indexAttention,
  initialsOf,
  isImageMime,
  isLive,
  lookStagePart,
  lookThumbPart,
  matchesQuery,
  needsReader,
  pathLabel,
  RESIDUE_RANK,
  residueCopy,
  resolveActor,
  selectedOptionIds,
  snapshotLooks,
  snapshotSummary,
  snapshotTs,
  waitsOnSelf,
} from "./interaction-view";
import type { RenderResidue } from "./portable-renderer";

const HUMAN: ActorSummary = {
  id: "odile",
  name: "Odile Varga",
  kind: "human",
  tint: "#fb7185",
  initials: "OV",
};

const askSnapshot = (over: Partial<RawInteractionSnapshot> = {}): RawInteractionSnapshot => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "ask",
  anchor: { level: "unanchored" },
  authorId: "planner-agent",
  participants: ["planner-agent", "odile"],
  waitingOn: ["odile"],
  state: "open",
  thread: [],
  ask: {
    question: "Ship it?",
    context: "the release is staged",
    waitingOn: ["odile"],
    selection: { min: 1, max: 1, submit: "immediate" },
    options: [
      { id: "yes", label: "Ship" },
      { id: "no", label: "Hold" },
    ],
    answers: [],
  },
  createdAt: Date.now(),
  ...over,
});

describe("initialsOf", () => {
  test("first letters of up to two words, uppercased", () => {
    expect(initialsOf("Odile Varga")).toBe("OV");
    expect(initialsOf("planner-agent")).toBe("PA");
    expect(initialsOf("")).toBe("?");
  });
});

describe("resolveActor / fallbackActor", () => {
  test("directory hit returns the known summary", () => {
    const dir = new Map([[HUMAN.id, HUMAN]]);
    expect(resolveActor(dir, "odile")).toBe(HUMAN);
  });
  test("miss synthesizes a fallback, guessing species from the id", () => {
    const dir = new Map<string, ActorSummary>();
    const a = resolveActor(dir, "planner-agent");
    expect(a.kind).toBe("agent");
    expect(fallbackActor("someone").kind).toBe("human");
  });
});

describe("age", () => {
  test("coarse buckets", () => {
    const now = 10_000_000_000;
    expect(age(now, now)).toBe("now");
    expect(age(now - 5 * 60_000, now)).toBe("5m");
    expect(age(now - 3 * 3_600_000, now)).toBe("3h");
    expect(age(now - 2 * 86_400_000, now)).toBe("2d");
  });
});

describe("hostOf", () => {
  test("host of a url, null when page-less", () => {
    expect(hostOf("https://example.com/docs/x")).toBe("example.com");
    expect(hostOf(undefined)).toBeNull();
  });
});

describe("anchorLabel", () => {
  test("unanchored / page / selection / block", () => {
    expect(anchorLabel({ level: "unanchored" })).toBe("unanchored");
    expect(anchorLabel({ level: "page" })).toBe("page-level");
    expect(anchorLabel({ level: "selection", selector: "p", text: "hello there" })).toBe(
      "“hello there”",
    );
    expect(anchorLabel({ level: "element", selector: "div > p", blockId: "b7" })).toBe("§b7");
  });
});

describe("ask + state helpers", () => {
  test("askIsOpen only for open asks", () => {
    expect(askIsOpen(askSnapshot())).toBe(true);
    expect(askIsOpen(askSnapshot({ state: "answered" }))).toBe(false);
    expect(askIsOpen(askSnapshot({ kind: "comment" }))).toBe(false);
  });
  test("isLive counts live states, not terminal", () => {
    expect(isLive("open")).toBe(true);
    expect(isLive("verifying")).toBe(true);
    expect(isLive("resolved")).toBe(false);
    expect(isLive("dropped")).toBe(false);
  });
  test("waitsOnSelf checks the paired actor", () => {
    expect(waitsOnSelf(askSnapshot(), "odile")).toBe(true);
    expect(waitsOnSelf(askSnapshot(), "other")).toBe(false);
    expect(waitsOnSelf(askSnapshot(), null)).toBe(false);
  });
  test("needsReader follows the server's attention where it lists the thread", () => {
    // An agent-answered Comment waits on nobody, yet the server says it needs you.
    const answered = askSnapshot({ kind: "comment", waitingOn: [] });
    const needs = indexAttention({
      needsYou: [{ interactionId: answered.id, because: "agent-answered" }],
      waiting: [],
    });
    expect(needsReader(answered, "odile", needs)).toBe(true);
    expect(needs.get(answered.id)?.because).toBe("agent-answered");
    // Listed as waiting: waiting, whatever waitingOn says.
    const waits = indexAttention({ needsYou: [], waiting: [{ interactionId: answered.id }] });
    expect(needsReader(askSnapshot(), "odile", waits)).toBe(false);
    // Not listed yet (or no lists at all): waitingOn decides.
    const other = indexAttention({ needsYou: [], waiting: [] });
    expect(needsReader(askSnapshot(), "odile", other)).toBe(true);
    expect(needsReader(answered, "odile", other)).toBe(false);
    expect(needsReader(askSnapshot(), "odile", null)).toBe(true);
    expect(needsReader(askSnapshot(), null, null)).toBe(false);
  });
  test("indexAttention: a thread in both lists needs you", () => {
    const row = { interactionId: "t1" };
    expect(indexAttention({ needsYou: [row], waiting: [row] }).get("t1")).toBe(row);
    expect(indexAttention(null).size).toBe(0);
  });
  test("chipState maps state + waiting into the shared vocabulary", () => {
    expect(chipState("open", true)).toBe("needs-you");
    expect(chipState("open", false)).toBe("waiting");
    expect(chipState("resolved", true)).toBe("resolved");
    expect(chipState("dropped", true)).toBe("resolved");
  });
  test("selectedOptionIds unions the answers", () => {
    const answered = askSnapshot({
      state: "resolved",
      ask: {
        ...(askSnapshot().ask as NonNullable<ReturnType<typeof askSnapshot>["ask"]>),
        answers: [{ actorId: "odile", optionIds: ["yes"], ts: 1 }],
      },
    });
    expect(selectedOptionIds(answered)).toEqual(["yes"]);
    expect(selectedOptionIds(askSnapshot())).toEqual([]);
  });
});

/* ── attachment view-model helpers ──────────────────────────────────── */

const captureRef = (over: Partial<CaptureRef> = {}): CaptureRef => ({
  captureId: "cap00001",
  interactionId: "11111111-1111-4111-8111-111111111111",
  kind: "attachment",
  lineageId: "cap00001",
  revision: 1,
  capturedAt: Date.now(),
  capturedBy: "odile",
  capturedFrom: "cli",
  format: "image/png",
  totalBytes: 2048,
  parts: [{ name: "file", role: "file", mime: "image/png", byteLen: 2048 }],
  caption: "look here",
  ...over,
});

describe("attachment helpers", () => {
  test("attachmentCaptures keeps only the attachment role", () => {
    const s = askSnapshot({
      captures: [
        captureRef({ captureId: "a" }),
        captureRef({ captureId: "b", kind: "snapshot" }),
        captureRef({ captureId: "c", kind: "edit-context" }),
      ],
    });
    expect(attachmentCaptures(s).map((c) => c.captureId)).toEqual(["a"]);
    expect(attachmentCaptures(askSnapshot())).toEqual([]);
  });

  test("editContextCapture returns the newest-revision edit-context ref", () => {
    const s = askSnapshot({
      captures: [
        captureRef({ captureId: "e1", kind: "edit-context", revision: 1 }),
        captureRef({ captureId: "e3", kind: "edit-context", revision: 3 }),
        captureRef({ captureId: "e2", kind: "edit-context", revision: 2 }),
        captureRef({ captureId: "a", kind: "attachment" }),
      ],
    });
    expect(editContextCapture(s)?.captureId).toBe("e3");
  });

  test("editContextCapture selects the NEWEST by capturedAt across lineages, not raw revision (GPT-4)", () => {
    // Two edit-context lineages on ONE interaction: an OLD lineage at a HIGH
    // revision (a target captured 10 times long ago) and a NEW lineage (a re-pick
    // → different targetKey) at revision 1 but captured later. Raw-revision
    // ordering would seat the stale rev-10 over the fresh rev-1 — the wrong
    // original beside current variants. capturedAt is the honest total order.
    const s = askSnapshot({
      captures: [
        captureRef({
          captureId: "old",
          kind: "edit-context",
          lineageId: "edit:aaa",
          revision: 10,
          capturedAt: 1000,
        }),
        captureRef({
          captureId: "new",
          kind: "edit-context",
          lineageId: "edit:bbb",
          revision: 1,
          capturedAt: 2000,
        }),
      ],
    });
    expect(editContextCapture(s)?.captureId).toBe("new");
    // Within one lineage capturedAt still rises with revision, and equal
    // capturedAt (same-ms) falls back to the higher revision.
    const tie = askSnapshot({
      captures: [
        captureRef({
          captureId: "r1",
          kind: "edit-context",
          lineageId: "edit:x",
          revision: 1,
          capturedAt: 5,
        }),
        captureRef({
          captureId: "r2",
          kind: "edit-context",
          lineageId: "edit:x",
          revision: 2,
          capturedAt: 5,
        }),
      ],
    });
    expect(editContextCapture(tie)?.captureId).toBe("r2");
  });

  test("editContextCapture is null when only attachments/snapshots present", () => {
    const s = askSnapshot({
      captures: [
        captureRef({ captureId: "a", kind: "attachment" }),
        captureRef({ captureId: "s", kind: "snapshot", revision: 9 }),
      ],
    });
    expect(editContextCapture(s)).toBeNull();
    expect(editContextCapture(askSnapshot())).toBeNull();
  });

  test("snapshotLooks returns snapshot-kind only, newest-revision first", () => {
    const s = askSnapshot({
      captures: [
        captureRef({ captureId: "s1", kind: "snapshot", revision: 1 }),
        captureRef({ captureId: "s3", kind: "snapshot", revision: 3 }),
        captureRef({ captureId: "s2", kind: "snapshot", revision: 2 }),
        captureRef({ captureId: "e", kind: "edit-context", revision: 9 }),
        captureRef({ captureId: "a", kind: "attachment" }),
      ],
    });
    expect(snapshotLooks(s).map((c) => c.captureId)).toEqual(["s3", "s2", "s1"]);
    // §4a: the newest captured look for a referenced interaction is the request seam.
    expect(snapshotLooks(s)[0]?.captureId).toBe("s3");
  });

  test("snapshotLooks is empty when the place has no captured look (never a dead reference)", () => {
    const none = askSnapshot({
      captures: [
        captureRef({ captureId: "a", kind: "attachment" }),
        captureRef({ captureId: "e", kind: "edit-context" }),
      ],
    });
    expect(snapshotLooks(none)).toEqual([]);
    // §4a empty state: the reveal admits it (undefined) and offers the request path.
    expect(snapshotLooks(none)[0]).toBeUndefined();
    expect(snapshotLooks(askSnapshot())).toEqual([]);
  });

  test("lookThumbPart prefers the thumbnail, falls back to the witness, else null", () => {
    const withThumb = captureRef({
      kind: "snapshot",
      parts: [
        { name: "document", role: "document", mime: "application/gzip", byteLen: 10 },
        { name: "witness", role: "witness", mime: "image/webp", byteLen: 20 },
        { name: "thumbnail", role: "thumbnail", mime: "image/webp", byteLen: 5 },
      ],
    });
    expect(lookThumbPart(withThumb)).toBe("thumbnail");
    const witnessOnly = captureRef({
      kind: "snapshot",
      parts: [
        { name: "document", role: "document", mime: "application/gzip", byteLen: 10 },
        { name: "witness", role: "witness", mime: "image/webp", byteLen: 20 },
      ],
    });
    expect(lookThumbPart(witnessOnly)).toBe("witness");
    const bare = captureRef({
      kind: "snapshot",
      parts: [{ name: "document", role: "document", mime: "application/gzip", byteLen: 10 }],
    });
    expect(lookThumbPart(bare)).toBeNull();
  });

  test("lookStagePart prefers the FULL-SIZE witness, falls back to the thumbnail, else null", () => {
    // The stage/reveal must show the witness at native size — never the 320px
    // thumbnail upscaled (Stage 2 §4/§4a). Inverse preference of lookThumbPart.
    const withBoth = captureRef({
      kind: "snapshot",
      parts: [
        { name: "document", role: "document", mime: "application/gzip", byteLen: 10 },
        { name: "witness", role: "witness", mime: "image/webp", byteLen: 20 },
        { name: "thumbnail", role: "thumbnail", mime: "image/webp", byteLen: 5 },
      ],
    });
    // Both present → the stage takes the witness where the strip takes the thumbnail.
    expect(lookStagePart(withBoth)).toBe("witness");
    expect(lookThumbPart(withBoth)).toBe("thumbnail");
    const thumbOnly = captureRef({
      kind: "snapshot",
      parts: [
        { name: "document", role: "document", mime: "application/gzip", byteLen: 10 },
        { name: "thumbnail", role: "thumbnail", mime: "image/webp", byteLen: 5 },
      ],
    });
    expect(lookStagePart(thumbOnly)).toBe("thumbnail");
    const bareStage = captureRef({
      kind: "snapshot",
      parts: [{ name: "document", role: "document", mime: "application/gzip", byteLen: 10 }],
    });
    expect(lookStagePart(bareStage)).toBeNull();
  });

  test("isImageMime accepts raster image/* (SVG is refused server-side)", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("image/webp")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
    expect(isImageMime("text/plain")).toBe(false);
  });

  test("humanBytes reads as B / KB / MB", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("decodeBase64 round-trips bytes", () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const b64 = btoa(String.fromCharCode(...bytes));
    expect([...decodeBase64(b64)]).toEqual([...bytes]);
  });
});

/* ── the shared honesty meter (extension + PWA read this ONE model) ─────── */

const emptyRender = (over: Partial<RenderResidue> = {}): RenderResidue => ({
  strippedPlaceholders: 0,
  strippedUrls: 0,
  authorRulesMissing: false,
  applied: 0,
  misses: 0,
  rejected: 0,
  ...over,
});

describe("residue meter model (FB-3/GPT-5 — one source, both surfaces)", () => {
  test("collectResidue unions capture-time enum with a synthesized render strip, ranked", () => {
    const entries = collectResidue(
      [{ class: "unfetchable-asset" }, { class: "canvas-video-content" }],
      emptyRender({ strippedUrls: 3 }),
    );
    // canvas outranks a lost asset (headline first); the render strip does NOT add
    // a second unfetchable-asset entry (already present).
    expect(entries.map((e) => e.class)).toEqual(["canvas-video-content", "unfetchable-asset"]);
  });

  test("collectResidue synthesizes ONE unfetchable-asset when a render strip has no capture-time twin", () => {
    const entries = collectResidue([], emptyRender({ strippedPlaceholders: 2 }));
    expect(entries).toEqual([{ class: "unfetchable-asset" }]);
    // A clean capture with a clean frame surfaces nothing.
    expect(collectResidue(undefined, emptyRender())).toEqual([]);
    expect(collectResidue([], null)).toEqual([]);
  });

  test("collectResidue dedups capture entries by class+origin", () => {
    const entries = collectResidue(
      [
        { class: "declined-grant", origin: "https://a.example" },
        { class: "declined-grant", origin: "https://a.example" },
        { class: "declined-grant", origin: "https://b.example" },
      ],
      null,
    );
    expect(entries).toHaveLength(2);
  });

  test("residueCopy speaks the render-spec §2.3 register (never 'exact'); origin interpolates", () => {
    expect(residueCopy({ class: "declined-grant", origin: "https://cdn.example" })).toContain(
      "https://cdn.example",
    );
    expect(residueCopy({ class: "canvas-video-content" })).toContain("screenshot");
    for (const c of ["closed-shadow-root", "quiescence-timeout", "oversize-truncation"]) {
      expect(residueCopy({ class: c }).toLowerCase()).not.toContain("exact");
    }
  });

  test("captureResidueLine returns the single most-severe line, or null when clean", () => {
    const dirty = captureRef({
      kind: "snapshot",
      residue: [{ class: "oversize-truncation" }, { class: "closed-shadow-root" }],
    });
    expect(captureResidueLine(dirty)).toBe(residueCopy({ class: "closed-shadow-root" }));
    expect(captureResidueLine(captureRef({ kind: "snapshot" }))).toBeNull();
  });
});

describe("anchorIsCapturable (GPT-3 — the one fresh-look/snapshot rule)", () => {
  test("element and selection are capturable; page and unanchored are not", () => {
    expect(anchorIsCapturable({ level: "element", selector: "#x" })).toBe(true);
    expect(anchorIsCapturable({ level: "selection", selector: "#x", text: "hi" })).toBe(true);
    expect(anchorIsCapturable({ level: "page" })).toBe(false);
    expect(anchorIsCapturable({ level: "unanchored" })).toBe(false);
  });
});

describe("the ONE search matcher (F25 — command bar and PWA parity)", () => {
  const row = {
    text: "Should the hero CTA be teal?",
    actorId: "rosalind",
    actorName: "Odile",
    context: "§hero-cta",
    state: "open",
    place: "/pricing",
  };

  test("matches case-insensitively across every field; empty query matches all", () => {
    expect(matchesQuery(row, "")).toBe(true);
    expect(matchesQuery(row, "   ")).toBe(true);
    expect(matchesQuery(row, "TEAL")).toBe(true); // text
    expect(matchesQuery(row, "rosal")).toBe(true); // actor id
    expect(matchesQuery(row, "odile")).toBe(true); // display name
    expect(matchesQuery(row, "hero-cta")).toBe(true); // context
    expect(matchesQuery(row, "open")).toBe(true); // state
    expect(matchesQuery(row, "/pricing")).toBe(true); // place
    expect(matchesQuery(row, "unrelated")).toBe(false);
  });

  test("the FULL url matches — searching by site works on non-root pages", () => {
    // place is the PATHNAME on a non-root page, so the host lives only in url.
    const anchored = {
      ...row,
      place: "/r/tools/comments/7xk2q9",
      url: "https://forum.example.com/r/tools/comments/7xk2q9",
    };
    expect(matchesQuery(anchored, "forum")).toBe(true); // host
    expect(matchesQuery(anchored, "FORUM.EXAMPLE.COM/r/tools")).toBe(true); // host+path, any case
    expect(matchesQuery(anchored, "7xk2q9")).toBe(true); // deep path segment
    expect(matchesQuery(anchored, "twitter")).toBe(false);
    expect(matchesQuery(row, "forum")).toBe(false); // unanchored: no url to match
  });

  test("pathLabel: path, root hostname, unanchored, and garbage", () => {
    expect(pathLabel("https://x.dev/docs/adr-0019")).toBe("/docs/adr-0019");
    expect(pathLabel("https://x.dev/")).toBe("x.dev");
    expect(pathLabel(undefined)).toBe("unanchored");
    expect(pathLabel("not a url")).toBe("not a url");
  });

  test("snapshotSummary: question / intent / first live words", () => {
    expect(snapshotSummary(askSnapshot())).toBe("Ship it?");
    const withThread = askSnapshot({
      kind: "comment",
      ask: undefined,
      thread: [
        { msgId: "m1", authorId: "a", body: { text: "sys" }, ts: 1, system: true },
        { msgId: "m2", authorId: "a", body: { text: "gone" }, ts: 2, deleted: true },
        { msgId: "m3", authorId: "a", body: { text: "first real words" }, ts: 3 },
      ],
    });
    expect(snapshotSummary(withThread)).toBe("first real words");
  });

  test("snapshotSummary is a preview: a fenced Ask question shows its code, no markers", () => {
    const base = askSnapshot();
    const fenced = askSnapshot({
      ask: {
        ...(base.ask as NonNullable<typeof base.ask>),
        question: "Ship this?\n```bash\nbun run deploy\n```",
      },
    });
    expect(snapshotSummary(fenced)).toBe("Ship this?\nbun run deploy");
  });

  test("snapshotTs: newest thread message, else birth", () => {
    expect(snapshotTs(askSnapshot({ createdAt: 42 }))).toBe(42);
    const t = askSnapshot({
      thread: [{ msgId: "m1", authorId: "a", body: { text: "x" }, ts: 99 }],
    });
    expect(snapshotTs(t)).toBe(99);
  });
});

describe("becauseLabel", () => {
  test("names a shared thread plainly and stays quiet for anything it does not know", () => {
    expect(becauseLabel("shared")).toBe("Shared with you");
    expect(becauseLabel("mentioned-by-a-future-server")).toBeNull();
    expect(becauseLabel(undefined)).toBeNull();
  });
});

describe("why a look kept no screenshot (L-3)", () => {
  test("each reason has its own sentence, and a dropped screenshot leads the meter", () => {
    const reasons = RESIDUE_CLASSES.filter((c) => c.startsWith("screenshot-"));
    expect(reasons).toHaveLength(8);
    const lines = reasons.map((c) => residueCopy({ class: c }));
    expect(new Set(lines).size).toBe(8);
    // A block inside a frame without an address of its own (2-A1).
    expect(residueCopy({ class: "screenshot-inner-frame" })).toBe(
      "No screenshot: this block is inside a frame that has no address of its own.",
    );
    for (const [i, c] of reasons.entries()) {
      expect(lines[i], c).toMatch(/^No screenshot: .+\.$/);
      expect(RESIDUE_RANK[c], c).toBe(6);
    }
    const shown = collectResidue(
      [{ class: "cross-origin-frame" }, { class: "screenshot-foreign-frame" }],
      null,
    );
    expect(shown[0]?.class).toBe("screenshot-foreign-frame");
  });
});
