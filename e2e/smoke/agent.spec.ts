// Journey 4: an agent acting as its person. Ada writes @agent on a thread;
// her agent, through MCP, finds it under "yours" in `inbox`, takes it, reads
// it and replies; the reply shows in the thread on the page with Ada's name
// and the "agent" tag, and the thread reads as answered. Its fenced block
// shows as a colored code block that copies, beside the page and in the web
// app.
import { expect, test } from "../harness/fixtures";
import {
  commentOnBlock,
  expectConnected,
  pins,
  threadMessages,
  threadView,
} from "../harness/overlay";
import { inboxRow } from "../harness/web";

const CODE = '{\n  "headline": "Pricing for small teams"\n}';

test("an agent takes an @agent thread through MCP and its reply shows agent-marked", async ({
  article,
  origin,
  pages,
  extensionPerson,
  mcp,
}) => {
  const ada = await extensionPerson("ada");
  for (const at of [pages.base, origin])
    await ada.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: at });
  const page = await ada.newPage();
  await page.goto(article);
  await expectConnected(page);
  await commentOnBlock(page, "#headline", null, [{ mention: "agent" }, " tighten this headline"]);
  await pins(page).click();
  const thread = threadView(page);
  await expect(thread).toContainText("for agent");

  const agent = mcp(ada.person);
  expect((await agent.initialize()).serverInfo.name).toBe("onlay");
  const inbox = await agent.call("inbox", { url: article });
  expect(inbox.isError).toBe(false);
  expect(inbox.text).toContain("Yours, handed to an agent by your person (1,");
  expect(inbox.text).toContain("tighten this headline");
  const ref = /^- (s_[a-z0-9]+\/\S+) · /m.exec(inbox.text)?.[1];
  expect(ref, inbox.text).toBeTruthy();

  const take = await agent.call("take", { ref });
  expect(take.isError, take.text).toBe(false);
  await expect(thread).toContainText("taken");

  const read = await agent.call("read", { ref });
  expect(read.isError, read.text).toBe(false);
  expect(read.text).toContain("tighten this headline");
  expect(read.text).toContain(article);

  const reply = await agent.call("reply", {
    ref,
    text: `Suggested: Pricing for small teams.\n\`\`\`json\n${CODE}\n\`\`\``,
  });
  expect(reply.isError, reply.text).toBe(false);

  // On the page: Ada's name, the agent tag, and the thread answered.
  const answer = threadMessages(page).filter({ hasText: "Suggested: Pricing for small teams." });
  await expect(answer).toBeVisible();
  await expect(answer.locator(".msg-author")).toHaveText("ada");
  await expect(answer.locator(".agent-tag")).toHaveText("agent");
  await expect(thread).toContainText("answered");

  // The fenced block: a code block, colored by the service worker, that copies.
  const block = answer.locator(".code-block");
  await expect(block.locator(".code-lang")).toHaveText("json");
  await expect(block.locator(".code-text")).toHaveText(CODE);
  await expect(block.locator(".code-text span.code-k-keyword").first()).toBeVisible();
  await block.getByRole("button", { name: "Copy code" }).click();
  await expect(block.getByRole("status")).toHaveText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);

  // The same in the web app, colored by its own lazily loaded highlighter.
  const web = await ada.newPage();
  await web.goto(`${origin}/app/`);
  await inboxRow(web, "tighten this headline").click();
  const webBlock = web.locator(".thread .msg .code-block");
  await expect(webBlock.locator(".code-text")).toHaveText(CODE);
  await expect(webBlock.locator(".code-text span.code-k-keyword").first()).toBeVisible();
  await webBlock.getByRole("button", { name: "Copy code" }).click();
  await expect(webBlock.getByRole("status")).toHaveText("Copied.");
  expect(await web.evaluate(() => navigator.clipboard.readText())).toBe(CODE);

  // The popup's row says the same, and the answer waits on Ada.
  const popup = await ada.popup();
  await expect(popup.locator(".row").filter({ hasText: "tighten this headline" })).toContainText(
    "answered",
  );
  await expect.poll(() => ada.badge()).toBe("1");
});
