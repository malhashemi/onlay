// A capture is bound to what it was started for, to the end (R2-C2): the same
// document, the same page key (the exact URL the server binds, fragment
// included), the same signed-in account, plus whatever the caller adds (the
// Edit is still this person's, the block is still connected). The check runs
// before the DOM walk, before every pixel grab and before upload; once it
// fails the capture is abandoned without a word.
import { pageKey } from "../page-url";

export interface BindingSource {
  /** The page URL right now. */
  frameUrl(): string;
  /** `<person>|<server origin>`, or null when signed out. */
  account(): string | null;
}

/** Freeze what this capture is for; the returned check says whether it still holds. */
export function bindCapture(src: BindingSource, also: () => boolean = () => true): () => boolean {
  const doc = typeof document === "undefined" ? null : document;
  const page = pageKey(src.frameUrl());
  const account = src.account();
  return () =>
    page !== null &&
    account !== null &&
    (typeof document === "undefined" ? null : document) === doc &&
    pageKey(src.frameUrl()) === page &&
    src.account() === account &&
    also();
}
