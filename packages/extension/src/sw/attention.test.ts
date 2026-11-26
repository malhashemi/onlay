// The kept Inbox is the account's that read it: answered only under the
// person it was read for, never once the account moved on (a sign-out,
// another person, another server), and a read that finished after the move
// is not kept at all.
import { describe, expect, test } from "bun:test";
import { attentionAnswer, INBOX_KEY, INBOX_OWNER_KEY, inboxOwner, keptLists } from "./attention";

const ADA_LISTS = {
  needsYou: [{ interactionId: "t-ada", text: "Ada's thread", ts: 1 }],
  waiting: [{ interactionId: "t-ada-2", text: "Ada's other", ts: 2 }],
  recent: [],
};

function kept(generation: number, personId: string) {
  return { [INBOX_KEY]: ADA_LISTS, [INBOX_OWNER_KEY]: { generation, personId } };
}

describe("the kept Inbox and whose it is", () => {
  test("answered under the person it was read for, ids alone", () => {
    expect(attentionAnswer(kept(3, "ada"), 3)).toEqual({
      personId: "ada",
      attention: {
        needsYou: [{ interactionId: "t-ada" }],
        waiting: [{ interactionId: "t-ada-2" }],
      },
    });
  });

  test("once the account moved on, nothing of it is answered, under any name", () => {
    // Bea signed in after Ada's Inbox was kept: generation 3 → 4.
    expect(attentionAnswer(kept(3, "ada"), 4)).toEqual({ personId: null, attention: null });
    expect(keptLists(kept(3, "ada"), 4)).toBeNull();
  });

  test("lists with no owner (an older worker's copy) are nobody's", () => {
    expect(attentionAnswer({ [INBOX_KEY]: ADA_LISTS }, 3).attention).toBeNull();
    expect(attentionAnswer({}, 3).attention).toBeNull();
  });

  test("a read that finishes after the account moved on is not kept", () => {
    expect(inboxOwner({ generation: 3, personId: "ada" }, 4)).toBeNull();
    expect(inboxOwner({ generation: 3, personId: null }, 3)).toBeNull();
    expect(inboxOwner({ generation: 3, personId: "ada" }, 3)).toEqual({
      generation: 3,
      personId: "ada",
    });
  });
});
