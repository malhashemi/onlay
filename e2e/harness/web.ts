// Driving the web app (`/app/`) as a person does: settings screens, the
// Inbox, a thread.
import { expect, type Locator, type Page } from "@playwright/test";

/** A unique, valid workspace name. */
export function workspaceName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** Settings → Spaces → New workspace. Lands on the new workspace's screen. */
export async function createWorkspace(page: Page, origin: string, name: string): Promise<void> {
  await page.goto(`${origin}/app/#/settings/spaces`);
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator(".app-title")).toHaveText(name);
}

/** On a workspace screen: Invite by email, and wait for what the admin is told. */
export async function invite(page: Page, email: string): Promise<void> {
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText(email).first()).toBeVisible();
}

/** The Inbox row for a thread whose text contains `text`. */
export function inboxRow(page: Page, text: string): Locator {
  return page.locator(".screen.inbox .inbox-content [aria-label]").filter({ hasText: text });
}

/** Replies in an open web app thread. */
export async function replyInThread(page: Page, text: string): Promise<void> {
  await page.locator(".reply-composer textarea").fill(text);
  await page.locator(".reply-composer").getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".thread .msg").filter({ hasText: text })).toBeVisible();
}
