import { describe, expect, test } from "bun:test";
import * as z from "zod/mini";
import { LIMITS } from "./limits";
import {
  InboxToolInputSchema,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  mcpToolList,
  PostVariantsToolInputSchema,
  ReadToolInputSchema,
  SetEditStateToolInputSchema,
  TakeToolInputSchema,
  WaitToolInputSchema,
} from "./mcp";

const REF = "s_abcdefghijklmnopqrst/6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

describe("MCP tools", () => {
  test("the table holds the ten tools, each described", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(MCP_TOOLS).toHaveLength(10);
    for (const t of MCP_TOOLS) expect(t.description.length).toBeGreaterThan(20);
  });

  test("tools/list entries carry object JSON Schemas without a dialect", () => {
    const list = mcpToolList();
    for (const entry of list) {
      expect(entry.inputSchema.type).toBe("object");
      expect(entry.inputSchema.$schema).toBeUndefined();
    }
    const take = list.find((t) => t.name === "take");
    expect(take?.inputSchema.required).toEqual(["ref"]);
    const props = take?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.ref?.pattern).toBeString();
    expect(props.ref?.description).toBeString();
    expect(props.onBehalf?.type).toBe("boolean");
    const wait = list.find((t) => t.name === "wait");
    const waitProps = wait?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(waitProps.timeoutSeconds?.maximum).toBe(LIMITS.MAX_WAIT_SECONDS);
  });

  test("inputs validate refs, states, timeouts and variant budgets", () => {
    expect(z.safeParse(TakeToolInputSchema, { ref: REF, onBehalf: true }).success).toBe(true);
    expect(z.safeParse(TakeToolInputSchema, { ref: "abc" }).success).toBe(false);
    expect(z.safeParse(SetEditStateToolInputSchema, { ref: REF, state: "working" }).success).toBe(
      true,
    );
    expect(z.safeParse(SetEditStateToolInputSchema, { ref: REF, state: "resolved" }).success).toBe(
      false,
    );
    expect(z.safeParse(WaitToolInputSchema, { ref: REF, timeoutSeconds: 26 }).success).toBe(false);
    const op = { op: "setText", target: ".title", text: "x" };
    const page = Array.from({ length: LIMITS.MAX_MUTATION_OPS_PAGE }, () => op);
    expect(
      z.safeParse(PostVariantsToolInputSchema, {
        ref: REF,
        variants: [{ label: "A", program: page }],
      }).success,
    ).toBe(true);
    expect(
      z.safeParse(PostVariantsToolInputSchema, {
        ref: REF,
        variants: [{ label: "A", program: [...page, op] }],
      }).success,
    ).toBe(false);
    expect(z.safeParse(PostVariantsToolInputSchema, { ref: REF, variants: [] }).success).toBe(
      false,
    );
  });

  test("inbox takes an optional after, a ref", () => {
    expect(z.safeParse(InboxToolInputSchema, { after: REF }).success).toBe(true);
    expect(z.safeParse(InboxToolInputSchema, { after: "m12" }).success).toBe(false);
    const inbox = mcpToolList().find((t) => t.name === "inbox");
    const props = inbox?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.after?.pattern).toBeString();
    expect(inbox?.inputSchema.required).toBeUndefined();
  });

  test("read takes an optional before, a message id", () => {
    expect(z.safeParse(ReadToolInputSchema, { ref: REF }).success).toBe(true);
    expect(z.safeParse(ReadToolInputSchema, { ref: REF, before: "m12" }).success).toBe(true);
    expect(z.safeParse(ReadToolInputSchema, { ref: REF, before: "" }).success).toBe(false);
    const read = mcpToolList().find((t) => t.name === "read");
    const props = read?.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.before?.type).toBe("string");
    expect(read?.inputSchema.required).toEqual(["ref"]);
  });
});
