// Share one thread with someone outside its space (spec §5, §10). Members
// only: add an email, see who it's shared with, remove one, and copy the
// thread's web link. The list lives on the server
// (`/api/spaces/:sid/interactions/:iid/shares`, proxied by the service
// worker); this view holds only what it last fetched.
import type { Share } from "@onlay/protocol";
import type { App } from "./app";
import { el } from "./dom";
import { onRouted } from "./typing-router";

export interface ShareDeps {
  /** One shares call through the service worker. */
  call(msg: {
    op: "list" | "add" | "remove";
    spaceId: string;
    id: string;
    email?: string;
  }): Promise<{ ok: boolean; shares?: Share[]; message?: string }>;
  copy(text: string): Promise<boolean>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function chromeShareDeps(): ShareDeps {
  return {
    call: (msg) => {
      try {
        return chrome.runtime.sendMessage({ type: "shares", ...msg }).then(
          (r: { ok: boolean; shares?: Share[]; message?: string } | undefined) =>
            r ?? { ok: false },
          () => ({ ok: false }),
        );
      } catch {
        return Promise.resolve({ ok: false });
      }
    },
    copy: (text) =>
      navigator.clipboard.writeText(text).then(
        () => true,
        () => false,
      ),
  };
}

/** The last list fetched per thread, so a re-render paints at once. */
const cache = new Map<string, Share[]>();
/** What is typed in a thread's share field and not yet shared, by space and thread. */
const typed = new Map<string, string>();
/** The thread whose share field has the caret, kept across a rebuild of the field. */
let typingIn: string | null = null;
/** Each thread's share field as last built: a share that lands after a rebuild clears that one. */
const fields = new Map<string, HTMLInputElement>();

export function shareSection(
  app: App,
  spaceId: string,
  interactionId: string,
  deps: ShareDeps,
): HTMLElement {
  const wrap = el("div", "field share-section");
  const head = el("div", "row-wrap");
  head.append(el("span", "micro", "Shared with"));
  const copy = el("button", "btn ghost sm", "Copy link") as HTMLButtonElement;
  copy.type = "button";
  head.append(copy);
  const list = el("div", "pick-menu");
  const addRow = el("div", "row");
  const input = document.createElement("input");
  input.className = "input";
  input.type = "email";
  input.placeholder = "name@example.com";
  input.setAttribute("aria-label", "Email to share this thread with");
  const add = el("button", "btn sm", "Share") as HTMLButtonElement;
  add.type = "button";
  addRow.append(input, add);
  const status = el("div", "dim");
  wrap.append(head, list, addRow, status);

  const key = `${spaceId}/${interactionId}`;
  // The panel and the modal build this afresh on every render (a state frame,
  // a picture arriving): what is typed, and the caret's being here, outlive it.
  input.value = typed.get(key) ?? "";
  fields.set(key, input);
  // Routed: while the overlay has focus the typing router stops `input` at the
  // window and delivers it only to routed listeners (typing-router.ts).
  onRouted<InputEvent>(input, "input", () => {
    if (input.value === "") typed.delete(key);
    else typed.set(key, input.value);
  });
  input.addEventListener("focus", () => {
    typingIn = key;
  });
  input.addEventListener("blur", () => {
    // A rebuild takes the field out of the page; only a blur that leaves it there is the person's.
    if (input.isConnected && typingIn === key) typingIn = null;
  });
  if (typingIn === key)
    queueMicrotask(() => {
      if (input.isConnected) input.focus();
    });
  const paint = (shares: Share[] | undefined): void => {
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!shares) {
      list.appendChild(el("div", "dim", "Loading…"));
      return;
    }
    if (shares.length === 0) list.appendChild(el("div", "dim", "Only people in this space."));
    for (const sh of shares) {
      const item = el("div", "pick-item");
      item.append(el("span", undefined, sh.email));
      const rm = el("button", "btn ghost tiny", "Remove") as HTMLButtonElement;
      rm.type = "button";
      rm.style.marginLeft = "auto";
      rm.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        rm.disabled = true;
        void deps.call({ op: "remove", spaceId, id: interactionId, email: sh.email }).then((r) => {
          if (!r.ok) {
            rm.disabled = false;
            status.textContent = r.message ?? "Couldn't remove access. Try again.";
            return;
          }
          void load();
        });
      });
      item.append(rm);
      list.appendChild(item);
    }
  };

  async function load(): Promise<void> {
    const r = await deps.call({ op: "list", spaceId, id: interactionId });
    if (r.ok && r.shares) cache.set(key, r.shares);
    else status.textContent = r.message ?? "Couldn't load who has access.";
    // A failed read is not an empty list: the "only people in this space" line
    // waits for a list the server actually returned.
    const known = cache.get(key);
    if (known) paint(known);
    else while (list.firstChild) list.removeChild(list.firstChild);
  }

  async function submit(): Promise<void> {
    const email = input.value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      status.textContent = "Enter an email address.";
      return;
    }
    add.disabled = true;
    status.textContent = "";
    const r = await deps.call({ op: "add", spaceId, id: interactionId, email });
    add.disabled = false;
    if (!r.ok) {
      status.textContent = r.message ?? "Couldn't share this thread. Try again.";
      return;
    }
    // Only what was sent goes: an address typed while the request was out stays.
    const sent = (v: string | undefined): boolean => (v ?? "").trim().toLowerCase() === email;
    const live = fields.get(key) ?? input;
    if (sent(live.value)) live.value = "";
    if (sent(typed.get(key))) typed.delete(key);
    status.textContent = `Shared with ${email}. They'll see this thread when they sign in.`;
    void load();
  }

  add.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void submit();
  });
  onRouted<KeyboardEvent>(input, "keydown", (e) => {
    e.stopPropagation(); // the page never hears what's typed here (F-056)
    if (e.key === "Enter" && e.isTrusted) {
      e.preventDefault();
      void submit();
    }
  });
  copy.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    void deps.copy(app.threadLink(spaceId, interactionId)).then((ok) => {
      status.textContent = ok ? "Link copied." : "Couldn't copy the link. Try again.";
    });
  });

  paint(cache.get(key));
  void load();
  return wrap;
}
