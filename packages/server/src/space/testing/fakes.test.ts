import { expect, test } from "bun:test";
import { FakeSockets, ManualClock } from "./fakes";

test("the manual clock moves only when told", () => {
  const clock = new ManualClock(1_000);
  expect(clock.now()).toBe(1_000);
  clock.advance(500);
  expect(clock.now()).toBe(1_500);
});

test("fake sockets record frames, clone attachments and drop closed sockets", () => {
  const sockets = new FakeSockets<{ personId: string }>();
  const a = sockets.connect();
  const b = sockets.connect();
  const who = { personId: "p_abcdefghijklmnopqrst" };
  a.setAttachment(who);
  who.personId = "changed";
  expect(a.attachment()).toEqual({ personId: "p_abcdefghijklmnopqrst" });
  a.send(JSON.stringify({ type: "tick" }));
  expect(a.frames()).toEqual([{ type: "tick" }]);
  b.close(4403, "access revoked");
  b.send("dropped");
  expect(b.sent).toEqual([]);
  expect(sockets.all()).toEqual([a]);
});
