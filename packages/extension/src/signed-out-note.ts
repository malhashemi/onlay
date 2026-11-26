// What the popup and the options page say after the extension's own Sign
// out: the browser may still be signed in to the web app, with a link to the
// web app's account settings, where signing out there switches accounts.
import { HOSTED_COPY } from "./hosted-copy";

export function signedOutNote(doc: Document, cls: string, serverOrigin: string): HTMLElement {
  const note = doc.createElement("div");
  note.className = cls;
  note.append(`${HOSTED_COPY.extensionSignedOut} ${HOSTED_COPY.extensionSwitchLead}`);
  if (/^https?:\/\//.test(serverOrigin)) {
    const link = doc.createElement("a");
    link.href = `${serverOrigin}/app/#/settings/account`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = HOSTED_COPY.extensionSwitchLink;
    note.append(link);
  } else {
    note.append(HOSTED_COPY.extensionSwitchLink);
  }
  note.append(HOSTED_COPY.extensionSwitchTail);
  return note;
}
