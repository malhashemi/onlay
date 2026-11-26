import { describe, expect, test } from "bun:test";
import {
  createSendIds,
  type SendAttempt,
  type SendAttemptStore,
  UNCONFIRMED_TTL_MS,
} from "./send-ids";

describe("request ids for sends (M-1, 2-M3)", () => {
  function ids() {
    let n = 0;
    let t = 0;
    const s = createSendIds(
      () => `id-${++n}`,
      () => t,
    );
    return { s, advance: (ms: number) => (t += ms) };
  }

  test("each unconfirmed payload from a place keeps its own id", () => {
    const { s } = ids();
    const a = s.clientIdFor("create:T", { text: "a" });
    const b = s.clientIdFor("create:T", { text: "b" });
    expect(b).not.toBe(a);
    expect(s.clientIdFor("create:T", { text: "a" })).toBe(a);
    expect(s.clientIdFor("create:T", { text: "b" })).toBe(b);
  });

  test("a confirmed send's next identical payload is a new send", () => {
    const { s } = ids();
    const a = s.clientIdFor("p", { text: "a" });
    s.confirmSend("p", a);
    expect(s.clientIdFor("p", { text: "a" })).not.toBe(a);
  });

  test("an unconfirmed attempt is kept for 10 minutes, then forgotten", () => {
    const { s, advance } = ids();
    const a = s.clientIdFor("p", { text: "a" });
    advance(UNCONFIRMED_TTL_MS - 1);
    expect(s.clientIdFor("p", { text: "a" })).toBe(a);
    advance(1);
    expect(s.clientIdFor("p", { text: "a" })).not.toBe(a);
  });
});

describe("no count evicts an unconfirmed attempt early (3-M4)", () => {
  test("many other sends from one place in ten minutes leave the first one's id alone", () => {
    let n = 0;
    const s = createSendIds(() => `id-${++n}`);
    const first = s.clientIdFor("create:T", { text: "first" });
    for (let i = 0; i < 100; i++) s.clientIdFor("create:T", { text: `other ${i}` });
    expect(s.clientIdFor("create:T", { text: "first" })).toBe(first);
  });

  test("attempts kept in a store outlive the client: a retry from a new one reuses the id (2-D1)", () => {
    const kept = new Map<string, SendAttempt[]>();
    const store: SendAttemptStore = {
      get: (p) => kept.get(p),
      set: (p, a) => {
        if (a.length > 0) kept.set(p, a);
        else kept.delete(p);
      },
    };
    const before = createSendIds(
      () => "before",
      () => 0,
      store,
    );
    const id = before.clientIdFor("reply:c1", { text: "a" });
    // A page reload: a new client over the same kept attempts.
    const after = createSendIds(
      () => "after",
      () => 1000,
      store,
    );
    expect(after.clientIdFor("reply:c1", { text: "a" })).toBe(id);
    after.confirmSend("reply:c1", id);
    expect(kept.has("reply:c1")).toBe(false);
    // Past the 10 minutes the kept attempt is dropped from the store too.
    before.clientIdFor("p", { text: "b" });
    const late = createSendIds(
      () => "late",
      () => UNCONFIRMED_TTL_MS + 1,
      store,
    );
    expect(late.clientIdFor("p", { text: "b" })).toBe("late");
  });
});
