// This content script's request ids for message sends (M-1): see
// `@onlay/render/send-ids`. One map per tab, so a retry here reuses the id
// this tab sent; another tab's sends never touch it. The unconfirmed ones are
// kept with the drafts (2-D1): a draft restored after a reload, sent again
// with the same text, reuses the id the lost send carried.
import { createSendIds } from "@onlay/render/send-ids";
import { draftSendStore } from "./drafts";
import { uuid4 } from "./uuid";

export const { clientIdFor, confirmSend } = createSendIds(uuid4, Date.now, draftSendStore);
