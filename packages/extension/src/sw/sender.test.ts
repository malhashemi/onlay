// The service worker's last check before an upload (R3-C4).
import { expect, test } from "bun:test";
import { senderMayUpload } from "./sender";

const PAGE = "https://acme.test/orders/1#a";

function ports(gen = 3, tabUrl: string | null = PAGE) {
  return {
    generation: () => gen,
    tab: async () => (tabUrl === null ? null : { url: tabUrl }),
  };
}

const sender = (over: Record<string, unknown> = {}) =>
  ({
    tab: { id: 7 },
    frameId: 0,
    url: PAGE,
    documentLifecycle: "active",
    ...over,
  }) as unknown as chrome.runtime.MessageSender;

const msg = (over: Record<string, unknown> = {}) => ({ pageUrl: PAGE, generation: 3, ...over });

test("a live tab's document on the page it claims, under the current generation, may upload", async () => {
  expect(await senderMayUpload(msg(), sender(), ports())).toBe(true);
});

test("anything else uploads nothing", async () => {
  // not from a tab
  expect(await senderMayUpload(msg(), sender({ tab: undefined }), ports())).toBe(false);
  // a document going away (back/forward cache, prerender)
  expect(await senderMayUpload(msg(), sender({ documentLifecycle: "cached" }), ports())).toBe(
    false,
  );
  // the frame is on another page than the message claims
  expect(await senderMayUpload(msg(), sender({ url: "https://acme.test/orders/2" }), ports())).toBe(
    false,
  );
  // composed under another account generation
  expect(await senderMayUpload(msg({ generation: 2 }), sender(), ports())).toBe(false);
  expect(await senderMayUpload(msg({ generation: null }), sender(), ports())).toBe(false);
  // the tab is gone, or the top frame's tab has moved to another page
  expect(await senderMayUpload(msg(), sender(), ports(3, null))).toBe(false);
  expect(await senderMayUpload(msg(), sender(), ports(3, "https://acme.test/other"))).toBe(false);
});

test("a subframe is checked against its own URL, not the tab's", async () => {
  const frame = "https://embed.test/widget";
  expect(
    await senderMayUpload(
      msg({ pageUrl: frame }),
      sender({ frameId: 3, url: frame }),
      ports(3, "https://acme.test/host"),
    ),
  ).toBe(true);
});
