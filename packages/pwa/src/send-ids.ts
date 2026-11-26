// This tab's request ids for message sends (M-1): see `@onlay/render/send-ids`.
import { createSendIds } from "@onlay/render/send-ids";

export const { clientIdFor, confirmSend } = createSendIds(() => crypto.randomUUID());
