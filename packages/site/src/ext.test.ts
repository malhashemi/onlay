// The stand-down: when the visitor's own Onlay answers the ping, the page
// simulates nothing.
import { describe, expect, test } from "bun:test";
import { EXTENSION_IDS } from "./config";
import { demoMode, extensionInstalled, type PageRuntime, pageRuntime, watchDemo } from "./ext";

/** A page runtime whose extensions answer as `answers` says (by id); the rest never answer. */
function runtime(answers: Record<string, unknown>): PageRuntime & { asked: unknown[] } {
  const rt: PageRuntime & { asked: unknown[] } = {
    asked: [],
    sendMessage(id, message, callback) {
      rt.asked.push([id, message]);
      if (id in answers) callback(answers[id]);
    },
  };
  return rt;
}

const [UNPACKED, STORE] = EXTENSION_IDS as [string, string];

describe("the ping", () => {
  test("asks each known id with the web app's own message", async () => {
    const rt = runtime({});
    await extensionInstalled(EXTENSION_IDS, rt, 5);
    expect(rt.asked).toEqual([
      [UNPACKED, { type: "onlay-ping" }],
      [STORE, { type: "onlay-ping" }],
    ]);
  });

  test("the two known builds are the downloaded one and the store's", () => {
    expect(EXTENSION_IDS).toEqual([
      "jpgekbcbbgdojakpjpefffljbmiimlbb",
      "ifolhmiajgkaecdfghbnkchpeibajnbj",
    ]);
  });

  test("either build answering counts", async () => {
    expect(await extensionInstalled(EXTENSION_IDS, runtime({ [UNPACKED]: { ok: true } }), 5)).toBe(
      true,
    );
    expect(
      await extensionInstalled(
        EXTENSION_IDS,
        runtime({ [STORE]: { ok: true, version: "0.1.58" } }),
        5,
      ),
    ).toBe(true);
  });

  test("only `{ok: true}` is an answer", async () => {
    for (const answer of [undefined, null, {}, { ok: false }, { ok: "true" }, "ok"]) {
      expect(await extensionInstalled([STORE], runtime({ [STORE]: answer }), 5)).toBe(false);
    }
  });

  test("silence times out as absent", async () => {
    expect(await extensionInstalled(EXTENSION_IDS, runtime({}), 5)).toBe(false);
  });

  test("a runtime that reports an error, or throws, is absent", async () => {
    const failing = runtime({ [STORE]: { ok: true } });
    failing.lastError = { message: "Could not establish connection." };
    expect(await extensionInstalled([STORE], failing, 5)).toBe(false);
    const throwing: PageRuntime = {
      sendMessage() {
        throw new Error("Invalid extension id");
      },
    };
    expect(await extensionInstalled([STORE], throwing, 5)).toBe(false);
  });

  test("no runtime at all answers at once: no extension may be messaged from here", async () => {
    expect(pageRuntime({})).toBeUndefined();
    expect(pageRuntime({ chrome: {} })).toBeUndefined();
    expect(pageRuntime({ chrome: { runtime: {} } })).toBeUndefined();
    const started = Date.now();
    expect(await extensionInstalled(EXTENSION_IDS, undefined)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe("what the page does", () => {
  test("the extension answers: the simulation stands down", async () => {
    expect(await demoMode(EXTENSION_IDS, runtime({ [STORE]: { ok: true } }), 5)).toBe("own");
  });

  test("nothing answers: the page simulates Onlay", async () => {
    expect(await demoMode(EXTENSION_IDS, runtime({}), 5)).toBe("sim");
    expect(await demoMode(EXTENSION_IDS, undefined)).toBe("sim");
  });
});

describe("an answer that comes late", () => {
  /** A runtime that holds each answer until the test lets it go. */
  function slow(): PageRuntime & { answer(id: string, response: unknown): void } {
    const waiting = new Map<string, (response: unknown) => void>();
    return {
      sendMessage(id, _message, callback) {
        waiting.set(id, callback);
      },
      answer(id, response) {
        waiting.get(id)?.(response);
      },
    };
  }
  const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  test("after the wait the page simulates; when the extension then answers, it must stand down", async () => {
    const rt = slow();
    const watch = watchDemo(EXTENSION_IDS, rt, 5);
    let late = false;
    void watch.late.then(() => {
      late = true;
    });
    expect(await watch.mode).toBe("sim");
    expect(watch.current()).toBe("sim");
    expect(late).toBe(false);
    rt.answer(STORE, { ok: true, version: "0.1.60" });
    await tick(1);
    expect(watch.current()).toBe("own");
    expect(late).toBe(true);
  });

  test("an answer inside the wait is not late: the page never simulated", async () => {
    const rt = slow();
    const watch = watchDemo(EXTENSION_IDS, rt, 30);
    let late = false;
    void watch.late.then(() => {
      late = true;
    });
    rt.answer(UNPACKED, { ok: true });
    expect(await watch.mode).toBe("own");
    await tick(40);
    expect(late).toBe(false);
  });

  test("a late answer that is not `{ok: true}` changes nothing", async () => {
    const rt = slow();
    const watch = watchDemo(EXTENSION_IDS, rt, 5);
    let late = false;
    void watch.late.then(() => {
      late = true;
    });
    expect(await watch.mode).toBe("sim");
    rt.answer(STORE, { ok: false });
    rt.answer(UNPACKED, undefined);
    await tick(1);
    expect(watch.current()).toBe("sim");
    expect(late).toBe(false);
  });

  test("with no runtime there is nothing to hear from, early or late", async () => {
    const watch = watchDemo(EXTENSION_IDS, undefined);
    expect(await watch.mode).toBe("sim");
    expect(watch.current()).toBe("sim");
  });
});
