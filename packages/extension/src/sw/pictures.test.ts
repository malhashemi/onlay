// The service worker's picture handler: only Onlay's picture paths are
// fetched, only PNG, JPEG and WebP bytes are handed on, a cached picture
// belongs to the account that fetched it, and a space's picture is answered
// only while the space is the person's, cached or not.
import { describe, expect, test } from "bun:test";
import { createPictures } from "./pictures";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const PATH = `/s/${SPACE}/people/p_bbbbbbbbbbbbbbbbbbbb/picture/cccccccccccccccc`;

function png(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, 64);
  new DataView(b.buffer).setUint32(20, 64);
  return b;
}

function harness(answer: () => Response | null) {
  const asked: string[] = [];
  let generation = 1;
  let rev = 0;
  let now = 0;
  let onRead: () => void = () => {};
  const spaces = new Set([SPACE]);
  const pictures = createPictures({
    get: async (path) => {
      asked.push(path);
      const res = answer();
      onRead();
      return res;
    },
    scope: async (spaceId) => `${generation}|${spaceId ?? "me"}:${rev}`,
    hasSpace: (spaceId) => spaces.has(spaceId),
    now: () => now,
  });
  return {
    pictures,
    asked,
    spaces,
    nextAccount: () => {
      generation += 1;
    },
    accessChanged: () => {
      rev += 1;
    },
    whileReading: (fn: () => void) => {
      onRead = fn;
    },
    later: (ms: number) => {
      now += ms;
    },
  };
}

describe("pictures in the service worker", () => {
  test("a picture path is fetched once and handed on as checked base64", async () => {
    const h = harness(() => new Response(png()));
    const first = await h.pictures.get(PATH);
    expect(first).toMatchObject({ ok: true, type: "image/png", scope: `1|${SPACE}:0` });
    expect(await h.pictures.get(PATH)).toEqual(first);
    expect(h.asked).toEqual([PATH]);
    // Another account asks again.
    h.nextAccount();
    await h.pictures.get(PATH);
    expect(h.asked).toHaveLength(2);
  });

  test("anything but a picture path is never fetched", async () => {
    const h = harness(() => new Response(png()));
    for (const url of [
      "https://workoscdn.com/images/v1/x",
      "/api/me",
      "/s/s_aaaaaaaaaaaaaaaaaaaa/interaction",
      `${PATH}/../../x`,
      "//evil.test/x",
      42,
      undefined,
    ]) {
      expect(await h.pictures.get(url)).toEqual({ ok: false });
    }
    expect(h.asked).toHaveLength(0);
  });

  test("bytes that are not a PNG, JPEG or WebP are refused, whatever the header says", async () => {
    const svg = new TextEncoder().encode("<svg><script>1</script></svg>");
    const h = harness(() => new Response(svg, { headers: { "Content-Type": "image/png" } }));
    expect(await h.pictures.get(PATH)).toEqual({ ok: false });
  });

  test("a refusal is remembered for a minute, then asked again", async () => {
    let status = 404;
    const h = harness(() =>
      status === 404 ? new Response("no", { status }) : new Response(png()),
    );
    expect(await h.pictures.get(PATH)).toEqual({ ok: false });
    await h.pictures.get(PATH);
    expect(h.asked).toHaveLength(1);
    status = 200;
    h.later(61_000);
    expect((await h.pictures.get(PATH)).ok).toBe(true);
    expect(h.asked).toHaveLength(2);
  });

  test("no connection is no picture", async () => {
    const h = harness(() => null);
    expect(await h.pictures.get(PATH)).toEqual({ ok: false });
  });

  test("an access change while the body was read: not answered from it, not kept", async () => {
    const h = harness(() => new Response(png()));
    h.whileReading(() => h.accessChanged());
    expect(await h.pictures.get(PATH)).toEqual({ ok: false });
    h.whileReading(() => {});
    expect((await h.pictures.get(PATH)).ok).toBe(true);
    expect(h.asked).toHaveLength(2);
  });

  test("a new access revision or account asks again; clear drops everything", async () => {
    const h = harness(() => new Response(png()));
    await h.pictures.get(PATH);
    h.accessChanged();
    await h.pictures.get(PATH);
    expect(h.asked).toHaveLength(2);
    h.pictures.clear();
    await h.pictures.get(PATH);
    expect(h.asked).toHaveLength(3);
  });

  test("a cached picture is refused once its space is no longer the person's", async () => {
    const h = harness(() => new Response(png()));
    expect((await h.pictures.get(PATH)).ok).toBe(true);
    h.spaces.delete(SPACE);
    expect(await h.pictures.get(PATH)).toEqual({ ok: false });
    expect(h.asked).toHaveLength(1);
    // One's own picture has no space to lose.
    const own = "/api/me/picture/cccccccccccccccc";
    expect((await h.pictures.get(own)).ok).toBe(true);
  });

  test("a space that left the list takes its pictures with it", async () => {
    const h = harness(() => new Response(png()));
    await h.pictures.get(PATH);
    h.spaces.delete(SPACE);
    h.pictures.retain(h.spaces);
    // Back in the list (joined again): fetched anew, never served from before.
    h.spaces.add(SPACE);
    expect((await h.pictures.get(PATH)).ok).toBe(true);
    expect(h.asked).toHaveLength(2);
  });

  test("a space that left the list while its picture was read: refused, not kept", async () => {
    const h = harness(() => new Response(png()));
    h.whileReading(() => h.spaces.delete(SPACE));
    expect(await h.pictures.get(PATH)).toEqual({ ok: false });
    h.whileReading(() => {});
    h.spaces.add(SPACE);
    expect((await h.pictures.get(PATH)).ok).toBe(true);
    expect(h.asked).toHaveLength(2);
  });

  test("a document holding the picture under the current scope gets no bytes; under another, it does", async () => {
    const h = harness(() => new Response(png()));
    const first = await h.pictures.get(PATH);
    if (!first.ok || !("b64" in first)) throw new Error("expected bytes");
    expect(await h.pictures.get(PATH, first.scope)).toEqual({
      ok: true,
      scope: first.scope,
      held: true,
    });
    h.accessChanged();
    expect(await h.pictures.get(PATH, first.scope)).toMatchObject({
      ok: true,
      scope: `1|${SPACE}:1`,
      type: "image/png",
    });
    // A space no longer theirs is refused, whatever the document holds.
    h.spaces.delete(SPACE);
    expect(await h.pictures.get(PATH, `1|${SPACE}:1`)).toEqual({ ok: false });
  });

  test("a body over the cap is refused, declared or streamed", async () => {
    const big = new Uint8Array(70_000);
    big.set(png());
    const declared = harness(() => new Response(big));
    expect(await declared.pictures.get(PATH)).toEqual({ ok: false });
    const streamed = harness(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(16_384));
            },
          }),
        ),
    );
    expect(await streamed.pictures.get(PATH)).toEqual({ ok: false });
  });
});
