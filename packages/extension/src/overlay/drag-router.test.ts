// Drag isolation: a card's drag (press, moves, release) is taken at the
// window before a page listener there sees it, and delivered to the mover
// once; a press the mover does not take goes on to the page as before.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { attachMover } from "@onlay/render/floating-card";
import { Window } from "happy-dom";
import { installDragIsolation, routeDrag } from "./drag-router";

let win: Window | null = null;

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

function mount() {
  const W = win as Window;
  const doc = W.document as unknown as Document;
  const host = doc.createElement("div");
  doc.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const head = doc.createElement("div");
  const grip = doc.createElement("button");
  const close = doc.createElement("button");
  const chip = doc.createElement("span");
  head.append(grip, chip, close);
  root.appendChild(head);
  let clock = 1_000;
  installDragIsolation(
    W as unknown as globalThis.Window,
    () => ({ host, root }),
    () => clock,
  );
  const pageSaw: string[] = [];
  for (const type of ["pointerdown", "pointermove", "pointerup"]) {
    W.addEventListener(type, () => pageSaw.push(type), { capture: true });
  }
  let pos = { x: 100, y: 100 };
  const moves: Array<{ x: number; y: number }> = [];
  attachMover({
    handle: head,
    grip,
    position: () => pos,
    moveTo: (p) => {
      moves.push(p);
      pos = p;
    },
    step: () => 16,
    trusted: () => true,
    pointer: routeDrag,
  });
  let under: Element = chip;
  (root as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => under;
  // As the browser makes them: trusted (a page's own made-up events never touch a drag).
  const ptr = (type: string, target: Element, x: number, y: number) => {
    const e = new W.PointerEvent(type, {
      bubbles: true,
      composed: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
    }) as unknown as Event;
    Object.defineProperty(e, "isTrusted", { value: true });
    target.dispatchEvent(e);
  };
  return {
    head,
    chip,
    close,
    moves,
    pageSaw,
    ptr,
    pointAt: (e: Element) => {
      under = e;
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

test("the page's window listeners never see a card's drag, and the mover hears each event once", () => {
  const s = mount();
  s.ptr("pointerdown", s.chip, 10, 10);
  s.ptr("pointermove", s.head, 40, 70);
  s.ptr("pointerup", s.head, 40, 70);
  expect(s.moves).toEqual([{ x: 130, y: 160 }]);
  expect(s.pageSaw).toEqual([]);
  // once the drag's trailing events are in, a move over the card is the page's again
  s.tick(600);
  s.ptr("pointermove", s.head, 50, 50);
  expect(s.pageSaw).toEqual(["pointermove"]);
  expect(s.moves).toEqual([{ x: 130, y: 160 }]);
});

test("a press the mover does not take (a header button) goes on as before", () => {
  const s = mount();
  s.pointAt(s.close);
  s.ptr("pointerdown", s.close, 10, 10);
  expect(s.pageSaw).toEqual(["pointerdown"]);
  s.ptr("pointermove", s.head, 40, 40);
  expect(s.moves).toEqual([]);
});
