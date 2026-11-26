// The popup (ADR-0006, spec §10): signed out → one "Sign in" action;
// signed in → the person's Inbox merged across their spaces (`/api/inbox`
// through the service worker). Rows are NAVIGATION ONLY — clicking deep-links
// to the anchor; no answering, no threads here. Built entirely with
// createElement (no innerHTML), same grammar as the overlay.

import type { InboxRow, Person, PersonSummary, SpaceSummary } from "@onlay/protocol";
import { shownUrl } from "@onlay/render/interaction-view";
import { HOSTED_COPY } from "./hosted-copy";
import { CAPTURE_GRANT_ORIGINS, captureFidelityModel } from "./options-model";
import { AGENT_WORK_LABEL, KINDS } from "./overlay/kinds";
import { paintPicture } from "./picture-face";
import { applyPageTheme, getPrefs, onPrefsChanged } from "./prefs";
import { signedOutNote } from "./signed-out-note";
import { resolveOrigin, resolveSiteOrigin, SERVER_ORIGIN_KEY } from "./sw/server";
import { newerPublished } from "./version";

const SVG_NS = "http://www.w3.org/2000/svg";

interface InboxLists {
  needsYou: InboxRow[];
  waiting: InboxRow[];
  recent: InboxRow[];
}
interface StatusReply {
  signedIn: boolean;
  connected: boolean;
  person: Person | null;
  spaces: SpaceSummary[];
  upgradeRequired: boolean;
  serverOrigin?: string;
}

const root = document.getElementById("root") as HTMLElement;
const directory = new Map<string, PersonSummary>();
let status: StatusReply | null = null;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function svg(paths: string[]): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    s.appendChild(p);
  }
  return s;
}

function personOf(id: string): PersonSummary {
  const found = directory.get(id);
  if (found) return found;
  return { id, name: "Someone", tint: "#4b5563", initials: "?" };
}
function avatarEl(person: PersonSummary): HTMLElement {
  const node = el("span", "avatar round");
  node.style.background = person.tint || "#4b5563";
  node.title = person.name;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", person.name);
  node.textContent = (person.initials || person.name.slice(0, 2)).toUpperCase();
  paintPicture(node, person.avatarUrl);
  return node;
}
function age(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}
function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 24);
  }
}
function pageLabel(url: string | undefined): string {
  if (!url) return "unanchored";
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg || u.hostname;
  } catch {
    return url.slice(0, 24);
  }
}
/** Honest place words: unanchored rows have no page; anchor-lost names its host. */
function placeLabel(item: LiveRow): string {
  if (item.unanchored || !item.url) return "unanchored";
  if (item.anchorLost) return `anchor lost · ${hostOf(shownUrl(item))}`;
  return pageLabel(shownUrl(item));
}

function send<T>(msg: Record<string, unknown>): Promise<T | undefined> {
  return chrome.runtime.sendMessage(msg).then(
    (r: T) => r,
    () => undefined,
  );
}

/** An Inbox row carrying whether it waits on this person. */
type LiveRow = InboxRow & { needs: boolean; resolved?: boolean };

function stateChip(item: LiveRow): HTMLElement {
  if (item.resolved) return el("span", "chip chip-resolved", "resolved");
  if (item.needs) return el("span", "chip chip-needs", "needs you");
  return el("span", "chip chip-waiting", "waiting");
}

function spaceName(id: string): string {
  return status?.spaces.find((s) => s.id === id)?.name ?? "";
}

function rowEl(item: LiveRow): HTMLElement {
  const spec = KINDS[item.kind] ?? KINDS.comment;
  const urlless = item.unanchored === true || !item.url;
  const btn = el("button", "row");
  (btn as HTMLButtonElement).type = "button";
  const glyph = el("span", `glyph ${spec.cls.replace("k-", "")}`);
  glyph.appendChild(svg(spec.glyph.paths));
  btn.appendChild(glyph);

  const body = el("div", "body");
  const top = el("div", "top");
  top.appendChild(el("span", "text", item.text || spec.label));
  top.appendChild(stateChip(item));
  top.appendChild(el("span", "age", age(item.ts)));
  body.appendChild(top);

  const meta = el("div", "meta");
  const author = personOf(item.fromActorId);
  meta.appendChild(avatarEl(author));
  meta.appendChild(el("span", "actor", author.name));
  if ((status?.spaces.length ?? 0) > 1)
    meta.appendChild(el("span", "place", spaceName(item.spaceId)));
  meta.appendChild(el("span", "place", placeLabel(item)));
  if (item.agentWork) meta.appendChild(el("span", "wait", AGENT_WORK_LABEL[item.agentWork]));
  body.appendChild(meta);
  btn.appendChild(body);

  btn.addEventListener("click", () => {
    // URL-bound rows keep the deep-link; url-less rows open the full-page view.
    if (urlless) void send({ type: "openFullView", spaceId: item.spaceId, id: item.interactionId });
    else void send({ type: "openRow", url: shownUrl(item), interactionId: item.interactionId });
    window.close();
  });
  return btn;
}

// ── capture fidelity toggle (mirrors the options ceremony, ADR-0022 §7/D6) ──
// The popup is itself an extension-action invocation, so `chrome.permissions.
// request` here carries a valid user gesture — a user can grant without opening
// options. Enabling requests the one broad `<all_urls>` grant.

let captureGranted = false;
let captureBusy = false;
/** A disable that couldn't stick: Chrome grants site access at the BROWSER
 *  level (chrome://extensions → Site access), which `permissions.remove` can't
 *  revoke — say so instead of a toggle that silently snaps back (F35). */
let captureLocked = false;

async function refreshCaptureGrant(): Promise<void> {
  try {
    captureGranted = await chrome.permissions.contains({ origins: [...CAPTURE_GRANT_ORIGINS] });
  } catch {
    captureGranted = false;
  }
}

async function toggleCaptureGrant(): Promise<void> {
  if (captureBusy) return;
  captureBusy = true;
  const wantedOff = captureGranted;
  paintCapture();
  try {
    if (captureGranted) {
      await chrome.permissions.remove({ origins: [...CAPTURE_GRANT_ORIGINS] });
    } else {
      await chrome.permissions.request({ origins: [...CAPTURE_GRANT_ORIGINS] });
    }
  } catch {
    // denied/failed → prior state stands; captures degrade to metered residue.
  } finally {
    // The BROWSER is the truth — never the request/remove return values.
    await refreshCaptureGrant();
    captureLocked = wantedOff && captureGranted;
    captureBusy = false;
    paintCapture();
  }
}

let captureSlot: HTMLElement | null = null;
function paintCapture(): void {
  if (!captureSlot) return;
  const m = captureFidelityModel(captureGranted);
  captureSlot.replaceChildren();
  const info = el("div", "cap-info");
  info.appendChild(el("span", "cap-label", "Capture fidelity"));
  info.appendChild(
    el(
      "span",
      "cap-detail",
      captureGranted
        ? "Reading the pages you work on."
        : "Off — captures have no screenshot and may miss styles.",
    ),
  );
  captureSlot.appendChild(info);
  const btn = el("button", `switch${captureGranted ? " on" : ""}`) as HTMLButtonElement;
  btn.type = "button";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", captureGranted ? "true" : "false");
  btn.setAttribute("aria-label", m.toggleLabel);
  btn.disabled = captureBusy;
  btn.appendChild(el("span", "switch-track"));
  btn.appendChild(el("span", "switch-thumb"));
  btn.addEventListener("click", () => void toggleCaptureGrant());
  captureSlot.appendChild(btn);
  if (captureLocked) {
    captureSlot.appendChild(
      el(
        "div",
        "cap-locked",
        "Chrome grants this at the browser level — change it under chrome://extensions → Onlay → Site access.",
      ),
    );
  }
}

// ── the update note: an unpacked install never updates itself ──
// Once per popup open, the server's /healthz names the extension it
// publishes; a release build behind it shows one quiet line with the way to
// /install. Nothing else nags.

interface UpdateNote {
  installUrl: string;
}
const updateCheck: Promise<UpdateNote | null> = (async () => {
  try {
    const stored = await chrome.storage.local.get(SERVER_ORIGIN_KEY);
    const origin = resolveOrigin(stored[SERVER_ORIGIN_KEY]);
    const res = await fetch(`${origin}/healthz`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { extension?: unknown } | null;
    const newer = newerPublished(chrome.runtime.getManifest(), body?.extension);
    return newer ? { installUrl: `${resolveSiteOrigin(stored[SERVER_ORIGIN_KEY])}/install` } : null;
  } catch {
    return null;
  }
})();

function updateSlot(): HTMLElement {
  const slot = el("div", "update-note");
  void updateCheck.then((note) => {
    if (!note) return;
    slot.append(`${HOSTED_COPY.updateAvailable} `);
    const link = el("a", undefined, HOSTED_COPY.updateLink) as HTMLAnchorElement;
    link.href = note.installUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    slot.append(link);
  });
  return slot;
}

const STAKES_RANK: Record<string, number> = { dangerous: 0, careful: 1, routine: 2 };

/** Order inside a section: needs-you first (stakes, then oldest), then waiting (newest). */
function orderRows(rows: LiveRow[]): LiveRow[] {
  return [...rows].sort((a, b) => {
    if (a.needs !== b.needs) return a.needs ? -1 : 1;
    if (a.needs) {
      const s =
        (STAKES_RANK[a.stakes ?? "routine"] ?? 2) - (STAKES_RANK[b.stakes ?? "routine"] ?? 2);
      if (s !== 0) return s;
      return a.ts - b.ts;
    }
    return b.ts - a.ts;
  });
}

function section(title: string, items: LiveRow[], recent = false): HTMLElement | null {
  if (items.length === 0) return null; // omit empty sections
  const wrap = el("div");
  const head = el("div", "micro", `${title} `);
  head.appendChild(el("span", "count", String(items.length)));
  wrap.appendChild(head);
  const rows = el("div", recent ? "rows recent" : "rows");
  for (const it of items) rows.appendChild(rowEl(it));
  wrap.appendChild(rows);
  return wrap;
}

function renderInbox(person: Person | null, lists: InboxLists | null): void {
  root.replaceChildren();
  const head = el("div", "head");
  if (person) head.appendChild(avatarEl(person));
  const grow = el("div", "grow");
  grow.appendChild(el("div", "title", "Inbox"));
  grow.appendChild(el("div", "name", person ? person.name : "Onlay"));
  head.appendChild(grow);
  const connected = status?.connected === true;
  const conn = el("div", `conn${connected ? " on" : ""}`);
  conn.appendChild(el("span", "dot"));
  conn.appendChild(el("span", undefined, connected ? "connected" : "offline"));
  head.appendChild(conn);
  root.appendChild(head);

  const sections: HTMLElement[] = [];
  if (lists) {
    // Merge needs-you + waiting into live rows, then split by anchoring the same
    // way the command bar does: unanchored/anchor-lost, then url-bound elsewhere.
    const live: LiveRow[] = [
      ...lists.needsYou.map((r) => ({ ...r, needs: true })),
      ...lists.waiting.map((r) => ({ ...r, needs: false })),
    ];
    const unanchored = live.filter((r) => r.unanchored === true || r.anchorLost === true || !r.url);
    const elsewhere = live.filter(
      (r) => r.url !== undefined && r.unanchored !== true && r.anchorLost !== true,
    );
    const recent: LiveRow[] = lists.recent
      .slice(0, 5)
      .map((r) => ({ ...r, needs: false, resolved: true }));
    const s1 = section("Unanchored", orderRows(unanchored));
    const s2 = section("Elsewhere", orderRows(elsewhere));
    const s3 = section("Recent", recent, true);
    for (const s of [s1, s2, s3]) if (s) sections.push(s);
  }
  if (sections.length === 0) {
    root.appendChild(el("div", "empty", HOSTED_COPY.popupInboxEmpty));
  } else {
    for (const s of sections) root.appendChild(s);
  }

  captureSlot = el("div", "cap-toggle");
  root.appendChild(captureSlot);
  paintCapture();
  void refreshCaptureGrant().then(paintCapture);

  const footer = el("div", "footer");
  footer.appendChild(el("span", undefined, "Open a row to answer or reply."));
  const out = el("button", undefined, HOSTED_COPY.signOut) as HTMLButtonElement;
  out.addEventListener("click", async () => {
    out.disabled = true;
    out.textContent = HOSTED_COPY.signingOut;
    await send({ type: "signOut" });
    justSignedOut = true;
    void load();
  });
  footer.appendChild(out);
  root.appendChild(updateSlot());
  root.appendChild(footer);
}

/** Set by this popup's own Sign out: the signed-out screen says what it did and didn't end. */
let justSignedOut = false;

/** Signed out: what Onlay is, and the one way in. */
function renderSignedOut(): void {
  root.replaceChildren();
  const head = el("div", "head");
  const grow = el("div", "grow");
  grow.appendChild(el("div", "title", HOSTED_COPY.signedOutTitle));
  head.appendChild(grow);
  root.appendChild(head);
  const panel = el("div", "pair");
  panel.appendChild(el("div", "lead", HOSTED_COPY.signedOutBody));
  if (justSignedOut) panel.appendChild(signedOutNote(document, "lead", status?.serverOrigin ?? ""));
  const note = el("div", "err");
  const btn = el("button", "btn", HOSTED_COPY.signIn) as HTMLButtonElement;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const r = await send<{ ok: boolean }>({ type: "signIn" });
    if (r?.ok) note.textContent = HOSTED_COPY.signInOpened;
    else {
      btn.disabled = false;
      note.textContent = HOSTED_COPY.signInFailed;
    }
  });
  panel.append(btn, note);
  root.appendChild(panel);
  root.appendChild(updateSlot());
}

/** The server refused this client's protocol: say so, plainly. */
function renderUpgrade(): void {
  root.replaceChildren();
  const head = el("div", "head");
  const grow = el("div", "grow");
  grow.appendChild(el("div", "title", HOSTED_COPY.upgradeTitle));
  head.appendChild(grow);
  root.appendChild(head);
  const panel = el("div", "pair");
  panel.appendChild(el("div", "lead", HOSTED_COPY.upgradeBody));
  root.appendChild(panel);
  root.appendChild(updateSlot());
}

async function loadDirectory(spaces: SpaceSummary[]): Promise<void> {
  const replies = await Promise.all(
    spaces.map((s) =>
      send<{ ok: boolean; people?: PersonSummary[] }>({ type: "getDirectory", spaceId: s.id }),
    ),
  );
  directory.clear();
  for (const r of replies) for (const p of r?.people ?? []) directory.set(p.id, p);
  if (status?.person) directory.set(status.person.id, status.person);
}

async function load(): Promise<void> {
  status = (await send<StatusReply>({ type: "getStatus" })) ?? null;
  if (status?.upgradeRequired) {
    renderUpgrade();
    return;
  }
  if (!status?.signedIn) {
    renderSignedOut();
    return;
  }
  const [inbox] = await Promise.all([
    send<{ ok: boolean; attention: InboxLists | null }>({ type: "getInbox" }),
    loadDirectory(status.spaces),
  ]);
  renderInbox(status.person, inbox?.attention ?? null);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  // A sign-in finishing in its tab, or a sign-out elsewhere, repaints the popup.
  if (areaName === "local" && (changes.token || changes.upgradeRequired || changes.spaces)) {
    void load();
    return;
  }
  if (areaName !== "session" || !changes.attention || !status?.signedIn) return;
  const lists = changes.attention.newValue as InboxLists | undefined;
  if (lists) renderInbox(status.person, lists);
});

// Theme (Appearance pref): commit this page via [data-theme]; system = OS.
void getPrefs().then(
  (p) => applyPageTheme(p.theme),
  () => {},
);
onPrefsChanged((p) => applyPageTheme(p.theme));

void load();
