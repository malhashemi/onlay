// A thread shared with someone lands in their Inbox (the end-to-end run's
// finding): through the real edge, outbox and space, the guest's /api/inbox
// lists it under needs-you because `shared`, until they open it.
import type { InboxResponse } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { call, devSignIn, personalSpaceOf } from "../support/client";

describe("a share reaches the guest's Inbox", () => {
  test("listed as shared until the guest opens it", async () => {
    const owner = await devSignIn();
    const guest = await devSignIn();
    const space = await personalSpaceOf(owner);
    const created = await call(owner, "POST", `/s/${space}/interaction`, {
      kind: "comment",
      body: { text: "have a look" },
    });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { interactionId: string }).interactionId;
    const shared = await call(owner, "POST", `/api/spaces/${space}/interactions/${id}/shares`, {
      email: guest.person.email,
    });
    expect(shared.status).toBe(201);
    const inbox = (await (await call(guest, "GET", "/api/inbox")).json()) as InboxResponse;
    expect(inbox.needsYou).toEqual([
      expect.objectContaining({ interactionId: id, spaceId: space, because: "shared" }),
    ]);
    expect((await call(guest, "GET", `/s/${space}/interaction/${id}`)).status).toBe(200);
    const after = (await (await call(guest, "GET", "/api/inbox")).json()) as InboxResponse;
    expect(after.needsYou.map((r) => r.interactionId)).not.toContain(id);
  });
});
