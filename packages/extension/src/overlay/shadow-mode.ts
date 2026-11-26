// The overlay's shadow root is CLOSED: the host page can never reach the
// private chrome inside it (thread text, Inbox rows, people, share emails,
// space names), and the content script keeps the only reference. The one
// exception is the e2e harness, which builds with `ONLAY_SHADOW_MODE=open`
// because Playwright cannot pierce a closed root. The build bakes the value
// in as a literal; nothing at runtime can change it.
declare const __ONLAY_SHADOW_MODE__: string | undefined;

export const SHADOW_MODE: ShadowRootMode =
  typeof __ONLAY_SHADOW_MODE__ === "string" && __ONLAY_SHADOW_MODE__ === "open" ? "open" : "closed";
