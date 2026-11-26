import { describe, expect, test } from "bun:test";
import * as z from "zod/mini";
import { LIMITS } from "./limits";
import { parseInbound, parseOutbound } from "./parse";
import { MutationProgramSchema } from "./variant";

const PAGE = "http://127.0.0.1:8125/app";
const SET_ID = "vs-1";

const validProgram = [
  {
    op: "setStyle",
    target: ":scope",
    props: [{ prop: "color", value: "rebeccapurple" }],
  },
  {
    op: "insertFragment",
    target: ":scope",
    position: "append",
    html: "<span>More detail</span>",
  },
];

const element = {
  selector: "main > button.cta",
  tag: "button",
  classes: ["cta", "primary"],
  textSnippet: "Buy now",
  markup: '<button class="cta primary">Buy now</button>',
  sourcePointer: "src/app.tsx:12:8",
};

const validCreate = {
  v: 1,
  type: "variant-create",
  nonce: "client-nonce-1",
  frameUrl: PAGE,
  root: { kind: "block", element },
  command: "make the call to action calmer",
  count: 2,
};

describe("mutation programs", () => {
  test("accepts the fixed setStyle + insertFragment vocabulary", () => {
    const r = z.safeParse(MutationProgramSchema, validProgram);
    expect(r.success).toBe(true);
  });

  test("rejects an unknown mutation op", () => {
    const r = z.safeParse(MutationProgramSchema, [{ op: "teleport", target: ":scope" }]);
    expect(r.success).toBe(false);
  });

  test("rejects a program over MAX_MUTATION_OPS", () => {
    const program = Array.from({ length: LIMITS.MAX_MUTATION_OPS + 1 }, () => ({
      op: "setText",
      target: ":scope",
      text: "x",
    }));
    const r = z.safeParse(MutationProgramSchema, program);
    expect(r.success).toBe(false);
  });
});

describe("variant inbound frames", () => {
  test("variant-create parses through the inbound union", () => {
    const r = parseInbound(JSON.stringify(validCreate));
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "variant-create") {
      expect(r.msg.nonce).toBe("client-nonce-1");
      expect(r.msg.count).toBe(2);
    }
  });

  test("variant-create with a manual program round-trips", () => {
    const r = parseInbound(JSON.stringify({ ...validCreate, count: 1, manual: validProgram }));
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "variant-create") expect(r.msg.manual?.length).toBe(2);
  });

  test("variant-create needs a root; the element-only form is retired from the wire", () => {
    const { root: _root, ...noRoot } = validCreate;
    expect(parseInbound(JSON.stringify(noRoot)).ok).toBe(false);
    expect(parseInbound(JSON.stringify({ ...noRoot, element })).ok).toBe(false);
  });

  test("variant-create over MAX_FRAME_CHARS is rejected before schema parsing", () => {
    const raw = JSON.stringify({
      ...validCreate,
      manual: [
        {
          op: "insertFragment",
          target: ":scope",
          position: "append",
          html: "x".repeat(LIMITS.MAX_FRAME_CHARS),
        },
      ],
    });
    expect(raw.length).toBeGreaterThan(LIMITS.MAX_FRAME_CHARS);
    const r = parseInbound(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("frame-too-large");
  });

  test("post-create variant controls parse", () => {
    for (const frame of [
      { v: 1, type: "variant-cycle", setId: SET_ID, frameUrl: PAGE, index: 1 },
      { v: 1, type: "variant-pick", setId: SET_ID, frameUrl: PAGE, variantId: "v1", version: 1 },
      { v: 1, type: "variant-discard", setId: SET_ID, frameUrl: PAGE },
      {
        v: 1,
        type: "variant-tune",
        setId: SET_ID,
        frameUrl: PAGE,
        index: 0,
        instruction: "tighter",
      },
      { v: 1, type: "variant-steer", setId: SET_ID, frameUrl: PAGE, instruction: "keep it warm" },
      { v: 1, type: "variant-sync", setId: SET_ID, frameUrl: PAGE },
    ]) {
      expect(parseInbound(JSON.stringify(frame)).ok).toBe(true);
    }
  });
});

describe("variant outbound and agent events", () => {
  const variant = { variantId: "v1", label: "Calmer CTA", program: validProgram, version: 1 };

  test("variant-state parses through the outbound union", () => {
    const r = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "variant-state",
        setId: SET_ID,
        status: "previewing",
        variants: [variant],
        activeIndex: 0,
      }),
    );
    expect(r.ok).toBe(true);
  });
});
