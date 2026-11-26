// The floating card's rules: inside the viewport with a margin, the editor
// capped by the viewport and by the room the card's controls leave, growth
// upward once the bottom edge is reached, and moves by drag or arrow key.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  attachMover,
  type CardLayoutInput,
  EDITOR_VIEWPORT_SHARE,
  editorMaxHeight,
  layoutCard,
  nudge,
} from "./floating-card";

const base = (over: Partial<CardLayoutInput> = {}): CardLayoutInput => ({
  view: { w: 1280, h: 800 },
  margin: 8,
  want: { x: 400, y: 200 },
  width: 320,
  chrome: 200,
  editor: { content: 54, min: 54, cap: 320 },
  ...over,
});

describe("layoutCard", () => {
  test("a card that fits sits where it wants", () => {
    const l = layoutCard(base());
    expect(l).toMatchObject({ left: 400, top: 200, width: 320, height: 254 });
    expect(l.maxHeight).toBe(784);
  });

  test("near the bottom edge it grows upward: the bottom holds, the top rises", () => {
    const want = { x: 400, y: 600 };
    const short = layoutCard(base({ want, editor: { content: 54, min: 54, cap: 320 } }));
    expect(short.top).toBe(600 - 62); // 600 + 254 would cross 792: lifted to fit
    expect(short.top + short.height).toBe(792);
    const taller = layoutCard(base({ want, editor: { content: 154, min: 54, cap: 320 } }));
    expect(taller.top + taller.height).toBe(792);
    expect(taller.top).toBe(short.top - 100);
  });

  test("growth stops at the editor's maximum; past it the editor scrolls and the card is still", () => {
    const want = { x: 400, y: 600 };
    const atCap = layoutCard(base({ want, editor: { content: 320, min: 54, cap: 320 } }));
    const beyond = layoutCard(base({ want, editor: { content: 5000, min: 54, cap: 320 } }));
    expect(atCap.editorMax).toBe(320);
    expect(beyond).toEqual(atCap);
  });

  test("away from the edge, text that shrinks lets the card settle back to where it wants", () => {
    const want = { x: 400, y: 300 };
    const grown = layoutCard(base({ want, editor: { content: 320, min: 54, cap: 320 } }));
    expect(grown.top).toBe(800 - 8 - 520);
    const shrunk = layoutCard(base({ want, editor: { content: 54, min: 54, cap: 320 } }));
    expect(shrunk.top).toBe(300);
  });

  test("the editor's maximum comes from the viewport's height", () => {
    const l = layoutCard(
      base({ view: { w: 1280, h: 500 }, editor: { content: 9999, min: 54, cap: 320 } }),
    );
    expect(l.editorMax).toBe(Math.floor(500 * EDITOR_VIEWPORT_SHARE));
  });

  test("on a small window the controls stay on screen: the editor gives way first", () => {
    const l = layoutCard(
      base({ view: { w: 360, h: 340 }, chrome: 230, editor: { content: 9999, min: 54, cap: 320 } }),
    );
    expect(l.editorMax).toBe(340 - 16 - 230);
    expect(l.top).toBe(8);
    expect(l.top + l.height).toBeLessThanOrEqual(340 - 8);
  });

  test("a window too small even for the controls cuts the card to the viewport (it scrolls inside)", () => {
    const l = layoutCard(base({ view: { w: 300, h: 200 }, chrome: 260 }));
    expect(l.editorMax).toBe(54);
    expect(l.height).toBe(184);
    expect(l.top).toBe(8);
    expect(l.width).toBe(284);
    expect(l.left).toBe(8);
  });

  test("near every edge it is clamped inside with the margin", () => {
    const at = (x: number, y: number) => layoutCard(base({ want: { x, y } }));
    expect(at(-50, -50)).toMatchObject({ left: 8, top: 8 });
    expect(at(5000, 100)).toMatchObject({ left: 1280 - 8 - 320, top: 100 });
    expect(at(100, 5000).top).toBe(800 - 8 - 254);
    expect(at(5000, 5000)).toMatchObject({ left: 952, top: 538 });
  });

  test("a card without an editor (the Edit's confirmation) is placed by its own height", () => {
    const { editor: _none, ...bare } = base({ chrome: 120, want: { x: 0, y: 790 } });
    const l = layoutCard(bare);
    expect(l.editorMax).toBe(0);
    expect(l).toMatchObject({ height: 120, top: 800 - 8 - 120, left: 8 });
  });

  test("a resize re-clamps a card from the same wish (the bigger window gives it back)", () => {
    const want = { x: 900, y: 500 };
    const small = layoutCard(base({ want, view: { w: 800, h: 600 } }));
    expect(small).toMatchObject({ left: 800 - 8 - 320, top: 600 - 8 - 254 });
    expect(layoutCard(base({ want }))).toMatchObject({ left: 900, top: 500 });
  });
});

describe("editorMaxHeight", () => {
  test("the least of the cap, the viewport share and the room left, never under the minimum", () => {
    expect(editorMaxHeight(1000, 8, 200, 54, 320)).toBe(320);
    expect(editorMaxHeight(600, 8, 200, 54, 320)).toBe(240);
    expect(editorMaxHeight(400, 8, 260, 54, 320)).toBe(124);
    expect(editorMaxHeight(300, 8, 400, 54, 320)).toBe(54);
  });
});

describe("nudge", () => {
  test("arrows move by a step, Shift by four", () => {
    expect(nudge("ArrowLeft", false, 16)).toEqual({ x: -16, y: 0 });
    expect(nudge("ArrowRight", false, 16)).toEqual({ x: 16, y: 0 });
    expect(nudge("ArrowUp", true, 16)).toEqual({ x: 0, y: -64 });
    expect(nudge("ArrowDown", false, 16)).toEqual({ x: 0, y: 16 });
    expect(nudge("Enter", false, 16)).toBeNull();
    expect(nudge("Escape", false, 16)).toBeNull();
  });
});

describe("attachMover", () => {
  let win: Window | null = null;
  beforeEach(() => {
    win = new Window({ url: "http://127.0.0.1:8123/" });
  });
  afterEach(() => {
    win?.happyDOM.cancelAsync();
    win?.close();
    win = null;
  });

  function setup(opts: { trusted?: (e: Event) => boolean } = {}) {
    const doc = win?.document as unknown as Document;
    const head = doc.createElement("div");
    const grip = doc.createElement("button");
    const close = doc.createElement("button");
    const chip = doc.createElement("span");
    head.append(grip, chip, close);
    doc.body.append(head);
    let pos = { x: 100, y: 100 };
    const moves: Array<{ x: number; y: number }> = [];
    let starts = 0;
    const mover = attachMover({
      handle: head,
      grip,
      position: () => pos,
      moveTo: (p) => {
        moves.push(p);
        pos = p;
      },
      onStart: () => {
        starts += 1;
      },
      step: () => 16,
      trusted: opts.trusted ?? (() => true),
    });
    const W = win as Window;
    const ptr = (type: string, target: Element, x: number, y: number) =>
      target.dispatchEvent(
        new W.PointerEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          button: 0,
        }) as unknown as Event,
      );
    const key = (k: string, shift = false) =>
      grip.dispatchEvent(
        new W.KeyboardEvent("keydown", {
          key: k,
          shiftKey: shift,
          bubbles: true,
        }) as unknown as Event,
      );
    return {
      head,
      grip,
      close,
      chip,
      moves,
      ptr,
      key,
      mover,
      starts: () => starts,
      pos: () => pos,
      dragging: () => head.classList.contains("is-dragging"),
    };
  }

  test("dragging the header moves the card by the pointer's travel", () => {
    const s = setup();
    s.ptr("pointerdown", s.chip, 10, 10);
    s.ptr("pointermove", s.head, 40, 70);
    s.ptr("pointermove", s.head, 60, 20);
    s.ptr("pointerup", s.head, 60, 20);
    s.ptr("pointermove", s.head, 500, 500);
    expect(s.moves).toEqual([
      { x: 130, y: 160 },
      { x: 150, y: 110 },
    ]);
    expect(s.starts()).toBe(1);
  });

  test("a press on a header button never starts a drag; the grip does", () => {
    const s = setup();
    s.ptr("pointerdown", s.close, 10, 10);
    s.ptr("pointermove", s.head, 50, 50);
    expect(s.moves).toEqual([]);
    s.ptr("pointerdown", s.grip, 10, 10);
    s.ptr("pointermove", s.head, 20, 20);
    expect(s.moves).toEqual([{ x: 110, y: 110 }]);
  });

  test("arrow keys on the grip move it; other keys pass", () => {
    const s = setup();
    s.key("ArrowRight");
    s.key("ArrowDown", true);
    s.key("Escape");
    s.key("Tab");
    expect(s.pos()).toEqual({ x: 116, y: 164 });
  });

  test("only trusted moves and releases count, once a trusted press started the drag", () => {
    const fake = new WeakSet<Event>();
    const s = setup({ trusted: (e) => !fake.has(e) });
    const W = win as Window;
    const synth = (type: string, x: number, y: number) => {
      const e = new W.PointerEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        button: 0,
      }) as unknown as Event;
      fake.add(e);
      s.head.dispatchEvent(e);
    };
    synth("pointerdown", 10, 10);
    expect(s.dragging()).toBe(false);
    s.ptr("pointerdown", s.chip, 10, 10);
    synth("pointermove", 300, 300);
    expect(s.moves).toEqual([]);
    synth("pointerup", 300, 300);
    synth("pointercancel", 300, 300);
    expect(s.dragging()).toBe(true);
    s.ptr("pointermove", s.head, 20, 20);
    expect(s.moves).toEqual([{ x: 110, y: 110 }]);
    s.ptr("pointerup", s.head, 20, 20);
    expect(s.dragging()).toBe(false);
  });

  test("a press whose pointer cannot be captured starts no drag", () => {
    const s = setup();
    s.head.setPointerCapture = () => {
      throw new Error("NotFoundError");
    };
    s.ptr("pointerdown", s.chip, 10, 10);
    expect(s.dragging()).toBe(false);
    expect(s.starts()).toBe(0);
    s.ptr("pointermove", s.head, 50, 50);
    expect(s.moves).toEqual([]);
  });

  test("a cancel, the window losing focus or the card closing ends the drag and frees the pointer", () => {
    const released: number[] = [];
    const ends: Array<(s: ReturnType<typeof setup>) => void> = [
      (s) => s.ptr("pointercancel", s.head, 30, 30),
      () => {
        const W = win as Window;
        W.dispatchEvent(new W.Event("blur"));
      },
      (s) => s.mover.cancel(),
    ];
    for (const end of ends) {
      const s = setup();
      let held = false;
      s.head.setPointerCapture = () => {
        held = true;
      };
      s.head.hasPointerCapture = () => held;
      s.head.releasePointerCapture = (id: number) => {
        held = false;
        released.push(id);
      };
      s.ptr("pointerdown", s.chip, 10, 10);
      expect(s.dragging()).toBe(true);
      end(s);
      expect(s.dragging()).toBe(false);
      expect(held).toBe(false);
      s.ptr("pointermove", s.head, 90, 90);
      expect(s.moves).toEqual([]);
    }
    expect(released).toEqual([1, 1, 1]);
  });

  test("a blur the page made up does not end a drag; the browser's own does", () => {
    // Trusted means trusted here: the press is, a page's `blur` is not.
    const s = setup({ trusted: (e) => e.type !== "blur" || e.isTrusted === true });
    s.ptr("pointerdown", s.chip, 10, 10);
    const W = win as Window;
    W.dispatchEvent(new W.Event("blur"));
    expect(s.dragging()).toBe(true);
    const real = new W.Event("blur");
    Object.defineProperty(real, "isTrusted", { value: true });
    W.dispatchEvent(real);
    expect(s.dragging()).toBe(false);
  });
});
