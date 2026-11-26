/// <reference types="chrome" />
// The extension settings page (ADR-0019 §4). Keyboard shortcuts are the real
// section — edited here, persisted via the prefs module. Account READS the
// service worker's account truth (`getStatus`) and never duplicates it: who
// you are, your spaces, sign out, and a link to the web app's settings, where
// the account itself is managed (spec §10). Built entirely with
// createElement (no innerHTML), same grammar as the popup/overlay.

import { HOSTED_COPY } from "./hosted-copy";
import {
  type AccountTruth,
  accountModel,
  buildShortcutRows,
  CAPTURE_GRANT_ORIGINS,
  captureFidelityModel,
  fieldVerdict,
  normalizeChord,
  type ShortcutRow,
  themeChoices,
  zoomFromPct,
  zoomModel,
} from "./options-model";
import { paintPicture } from "./picture-face";
import {
  applyPageTheme,
  type CommandId,
  getPrefs,
  KEYBOARD_DEFAULTS,
  onPrefsChanged,
  patchPrefs,
  THEME_DEFAULT,
  type Theme,
  UI_ZOOM_DEFAULT,
} from "./prefs";
import { signedOutNote } from "./signed-out-note";
import { MARK_SVG } from "./ui/tokens";

const root = document.getElementById("root") as HTMLElement;

/** The brand mark, parsed from the static token string (no markup injection). */
function markEl(): HTMLElement {
  const wrap = el("div", "mark");
  try {
    const doc = new DOMParser().parseFromString(MARK_SVG, "image/svg+xml");
    const node = doc.documentElement;
    if (node && node.nodeName.toLowerCase() === "svg") {
      wrap.appendChild(document.importNode(node, true));
    }
  } catch {
    /* wordmark stands alone */
  }
  return wrap;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
// ── state ──
let keyboard: Record<CommandId, string> = { ...KEYBOARD_DEFAULTS };
let uiZoom: number = UI_ZOOM_DEFAULT;
let themePref: Theme = THEME_DEFAULT;
/** The one row currently in edit mode (its in-progress text survives re-renders). */
let editing: { id: CommandId; value: string } | null = null;
let confirmingReset = false;
/** Avatar upload: the last painted truth (re-render source) + ephemeral status. */

// ── page skeleton ──
const shell = el("div", "shell");

const masthead = el("header", "masthead");
masthead.appendChild(markEl());
const mastGrow = el("div");
const mastTitle = el("div", "title");
mastTitle.appendChild(el("span", undefined, "Onlay"));
mastTitle.appendChild(el("span", "sep", "·"));
mastTitle.appendChild(el("span", "page-name", "settings"));
mastGrow.appendChild(mastTitle);
mastGrow.appendChild(
  el("div", "sub", "Client preferences — stored in this browser, synced nowhere."),
);
masthead.appendChild(mastGrow);
shell.appendChild(masthead);

const layout = el("div", "layout");
const side = el("nav", "side");
side.appendChild(el("div", "micro", "Sections"));
for (const [href, label] of [
  ["#account", "Account"],
  ["#keyboard", "Keyboard"],
  ["#capture", "Capture"],
  ["#appearance", "Appearance"],
] as const) {
  const a = el("a", undefined, label) as HTMLAnchorElement;
  a.href = href;
  side.appendChild(a);
}
layout.appendChild(side);

const content = el("div");
layout.appendChild(content);
shell.appendChild(layout);

function section(id: string, title: string, lead: string): { sec: HTMLElement; card: HTMLElement } {
  const sec = el("section");
  sec.id = id;
  sec.appendChild(el("h2", undefined, title));
  sec.appendChild(el("p", "lead", lead));
  const card = el("div", "card");
  sec.appendChild(card);
  content.appendChild(sec);
  return { sec, card };
}

const accountCard = section(
  "account",
  HOSTED_COPY.accountTitle,
  "Who you're signed in as, and the spaces you work in.",
).card;

const keyboardCard = section(
  "keyboard",
  "Keyboard shortcuts",
  "Chords are 1–2 keys and fire only when you're not typing. Click a shortcut to change it.",
).card;
const keyboardBody = el("div");
const keyboardFoot = el("div", "kfoot");
keyboardCard.append(keyboardBody, keyboardFoot);

const captureCard = section(
  "capture",
  "Capture fidelity",
  "Whether Onlay may read the pages you work on to reconstruct their look.",
).card;

const appearanceCard = section("appearance", "Appearance", "How the overlay looks on pages.").card;
const appearanceBody = el("div");
appearanceCard.appendChild(appearanceBody);

shell.appendChild(
  el(
    "div",
    "pagefoot",
    "Preferences live in chrome.storage.local — deleting the extension deletes them.",
  ),
);
root.appendChild(shell);

// ── keyboard section ──

function paintNote(note: HTMLElement, error: string | null, warning: string | null): void {
  if (error) {
    note.className = "note error";
    note.textContent = error;
    note.style.display = "";
  } else if (warning) {
    note.className = "note warn";
    note.textContent = warning;
    note.style.display = "";
  } else {
    note.style.display = "none";
    note.textContent = "";
  }
}

function keycaps(parts: string[]): HTMLElement[] {
  return parts.map((k) => el("span", "key", k));
}

function chipButton(row: ShortcutRow): HTMLElement {
  const chip = el("button", "chip") as HTMLButtonElement;
  chip.append(...keycaps(row.keycaps));
  chip.title = "Click to change";
  chip.addEventListener("click", () => {
    editing = { id: row.id, value: row.value };
    confirmingReset = false;
    renderKeyboard();
  });
  return chip;
}

function fixedChip(row: ShortcutRow): HTMLElement {
  const chip = el("span", "chip fixed");
  chip.append(...keycaps(row.keycaps));
  const tag = el("span", "tag", "fixed");
  tag.title = "Fixed this release — the always-available opener.";
  chip.appendChild(tag);
  return chip;
}

function editor(row: ShortcutRow, note: HTMLElement): HTMLElement {
  const input = el("input", "chord-input") as HTMLInputElement;
  input.value = editing?.value ?? row.value;
  input.maxLength = 2;
  input.spellcheck = false;
  input.setAttribute("aria-label", `Shortcut for ${row.label}`);

  const paint = (): void => {
    const v = fieldVerdict(keyboard, row.id, normalizeChord(input.value));
    input.classList.toggle("bad", !v.canSave);
    input.classList.toggle("warned", v.canSave && v.warning !== null);
    paintNote(note, v.error, v.warning);
  };
  input.addEventListener("input", () => {
    if (editing) editing.value = input.value;
    paint();
  });
  const commit = (): void => {
    const value = normalizeChord(input.value);
    const v = fieldVerdict(keyboard, row.id, value);
    if (!v.canSave) {
      // Invalid/duplicate/empty blocks saving THIS field — the error stays
      // visible until the human fixes it or Escapes back to the saved chord.
      paint();
      return;
    }
    editing = null;
    if (value !== keyboard[row.id]) {
      keyboard = { ...keyboard, [row.id]: value };
      void patchPrefs({ keyboard });
    }
    renderKeyboard();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      editing = null;
      renderKeyboard();
    }
  });
  input.addEventListener("blur", commit);
  paint();
  return input;
}

function rowEl(row: ShortcutRow): HTMLElement {
  const wrap = el("div", "krow");
  const main = el("div", "main");
  const info = el("div", "info");
  info.appendChild(el("div", "label", row.label));
  info.appendChild(el("div", "desc", row.description));
  main.appendChild(info);

  const note = el("div", "note");
  if (row.fixed) main.appendChild(fixedChip(row));
  else if (editing?.id === row.id) main.appendChild(editor(row, note));
  else {
    main.appendChild(chipButton(row));
    paintNote(note, row.error, row.warning);
  }
  wrap.appendChild(main);
  wrap.appendChild(note);
  return wrap;
}

function renderReset(): void {
  keyboardFoot.replaceChildren();
  if (confirmingReset) {
    keyboardFoot.appendChild(el("span", "confirm-q grow", "Reset all shortcuts to defaults?"));
    const yes = el("button", "btn-danger", "Reset");
    yes.addEventListener("click", () => {
      confirmingReset = false;
      editing = null;
      keyboard = { ...KEYBOARD_DEFAULTS };
      void patchPrefs({ keyboard });
      renderKeyboard();
    });
    const no = el("button", "btn-ghost", "Cancel");
    no.addEventListener("click", () => {
      confirmingReset = false;
      renderReset();
    });
    keyboardFoot.append(yes, no);
    return;
  }
  keyboardFoot.appendChild(
    el("span", "grow", "Changes apply on open pages within a moment — no reload needed."),
  );
  const reset = el("button", "btn-ghost", "Reset to defaults");
  reset.addEventListener("click", () => {
    confirmingReset = true;
    renderReset();
  });
  keyboardFoot.appendChild(reset);
}

function renderKeyboard(): void {
  const rows = buildShortcutRows(keyboard);
  keyboardBody.replaceChildren(...rows.map(rowEl));
  renderReset();
  if (editing) {
    const input = keyboardBody.querySelector(".chord-input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }
}

// ── appearance: theme + overlay zoom ──

function commitTheme(t: Theme): void {
  if (t === themePref) return;
  themePref = t;
  applyPageTheme(t); // this page flips immediately, not on the storage echo
  void patchPrefs({ theme: t });
  renderAppearance();
}

function themeRow(): HTMLElement {
  const row = el("div", "krow");
  const main = el("div", "main");
  const info = el("div", "info");
  info.appendChild(el("div", "label", "Theme"));
  info.appendChild(
    el("div", "desc", "System follows your OS; Light and Dark commit the overlay and these pages."),
  );
  main.appendChild(info);
  const seg = el("div", "themeseg");
  for (const c of themeChoices(themePref)) {
    const b = el("button", `themebtn${c.on ? " on" : ""}`, c.label) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => commitTheme(c.value));
    seg.appendChild(b);
  }
  main.appendChild(seg);
  row.appendChild(main);
  return row;
}

function commitZoom(z: number): void {
  if (z === uiZoom) return;
  uiZoom = z;
  void patchPrefs({ uiZoom: z });
  renderAppearance();
}

function zoomRow(): HTMLElement {
  const m = zoomModel(uiZoom);
  const row = el("div", "krow");
  const main = el("div", "main");
  const info = el("div", "info");
  info.appendChild(el("div", "label", "Overlay zoom"));
  info.appendChild(
    el("div", "desc", "Scales the command bar, panels, and pins on every page — applies live."),
  );
  main.appendChild(info);

  const ctl = el("div", "zoomctl");
  const slider = el("input") as HTMLInputElement;
  slider.type = "range";
  slider.min = String(m.minPct);
  slider.max = String(m.maxPct);
  slider.step = String(m.stepPct);
  slider.value = String(m.pct);
  slider.setAttribute("aria-label", "Overlay zoom");
  const readout = el("span", "zoom-val", m.label);
  slider.addEventListener("input", () => {
    readout.textContent = `${slider.value}%`;
  });
  // Persist on release, not per notch — every write repaints open overlays.
  slider.addEventListener("change", () => commitZoom(zoomFromPct(Number(slider.value))));
  ctl.append(slider, readout);
  main.appendChild(ctl);

  if (!m.isDefault) {
    const reset = el("button", "btn-ghost", "Reset") as HTMLButtonElement;
    reset.addEventListener("click", () => commitZoom(UI_ZOOM_DEFAULT));
    main.appendChild(reset);
  }
  row.appendChild(main);
  return row;
}

function renderAppearance(): void {
  appearanceBody.replaceChildren(themeRow(), zoomRow());
}

// ── capture fidelity: the grant ceremony (ADR-0022 §7 / D6) ──
//
// An extension-page gesture is the ONLY place `chrome.permissions.request` can
// prompt (a content-script overlay click cannot confer a host grant). Enabling
// requests the one broad `<all_urls>` grant that both the harvest fetch and the
// witness raster need; disabling removes it. The overlay never prompts — its
// residue meter links here.

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
  renderCapture();
}

async function setCaptureGrant(next: boolean): Promise<void> {
  captureBusy = true;
  renderCapture();
  try {
    if (next) {
      await chrome.permissions.request({ origins: [...CAPTURE_GRANT_ORIGINS] });
    } else {
      await chrome.permissions.remove({ origins: [...CAPTURE_GRANT_ORIGINS] });
    }
  } catch {
    // A denied/failed request leaves the prior state — metered residue, never a throw.
  } finally {
    // The BROWSER is the truth — never the request/remove return values.
    try {
      captureGranted = await chrome.permissions.contains({ origins: [...CAPTURE_GRANT_ORIGINS] });
    } catch {
      captureGranted = false;
    }
    captureLocked = !next && captureGranted;
    captureBusy = false;
    renderCapture();
  }
}

function captureToggle(granted: boolean, label: string): HTMLElement {
  const btn = el("button", `switch${granted ? " on" : ""}`) as HTMLButtonElement;
  btn.type = "button";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", granted ? "true" : "false");
  btn.setAttribute("aria-label", label);
  btn.disabled = captureBusy;
  btn.appendChild(el("span", "switch-track", ""));
  btn.appendChild(el("span", "switch-thumb", ""));
  btn.addEventListener("click", () => void setCaptureGrant(!granted));
  return btn;
}

function renderCapture(): void {
  const m = captureFidelityModel(captureGranted);
  captureCard.replaceChildren();
  captureCard.appendChild(el("p", "lead", m.lead));

  const row = el("div", "krow");
  const main = el("div", "main");
  const info = el("div", "info");
  info.appendChild(el("div", "label", m.toggleLabel));
  info.appendChild(el("div", "desc", m.detail));
  main.appendChild(info);
  main.appendChild(captureToggle(m.granted, m.toggleLabel));
  row.appendChild(main);
  captureCard.appendChild(row);

  if (captureBusy) {
    captureCard.appendChild(el("div", "hint", "Waiting for the browser's permission prompt…"));
  }
  if (captureLocked) {
    captureCard.appendChild(
      el(
        "div",
        "hint",
        "Chrome grants this at the browser level — change it under chrome://extensions → Onlay → Site access.",
      ),
    );
  }
}

// ── account (read-only truth from the service worker) ──

function drow(label: string, value: HTMLElement): HTMLElement {
  const row = el("div", "drow");
  row.appendChild(el("span", "dlabel", label));
  row.appendChild(value);
  return row;
}

/** Set by this page's own Sign out: the signed-out card says what it did and didn't end. */
let justSignedOut = false;

function renderAccount(truth: AccountTruth): void {
  const m = accountModel(truth);
  accountCard.replaceChildren();
  if (!m.signedIn) {
    accountCard.appendChild(el("div", "empty", HOSTED_COPY.accountSignedOut));
    if (justSignedOut) {
      accountCard.appendChild(signedOutNote(document, "hint", truth.serverOrigin));
    }
    const signIn = el("button", "btn-ghost", HOSTED_COPY.signIn) as HTMLButtonElement;
    const note = el("div", "hint");
    signIn.addEventListener("click", async () => {
      signIn.disabled = true;
      const r = (await chrome.runtime.sendMessage({ type: "signIn" }).catch(() => null)) as {
        ok?: boolean;
      } | null;
      note.textContent = r?.ok ? HOSTED_COPY.signInOpened : HOSTED_COPY.signInFailed;
      if (!r?.ok) signIn.disabled = false;
    });
    accountCard.append(signIn, note);
    return;
  }
  const who = el("div", "who");
  const avatar = el("span", "avatar round");
  avatar.style.background = m.tint;
  avatar.textContent = m.initials;
  avatar.setAttribute("role", "img");
  avatar.setAttribute("aria-label", m.name);
  paintPicture(avatar, m.avatarUrl);
  who.appendChild(avatar);
  const info = el("div");
  info.appendChild(el("div", "name", m.name));
  info.appendChild(el("div", "meta", m.email));
  who.appendChild(info);
  accountCard.appendChild(who);

  const list = el("span", "dvalue");
  list.textContent = m.spaces.map((sp) => `${sp.name} (${sp.role})`).join(", ");
  accountCard.appendChild(drow(HOSTED_COPY.accountSpaces, list));

  const actions = el("div", "portset");
  const link = el("a", "btn-ghost", HOSTED_COPY.accountWebSettings) as HTMLAnchorElement;
  link.href = m.settingsUrl;
  link.target = "_blank";
  link.rel = "noopener";
  const out = el("button", "btn-ghost", HOSTED_COPY.signOut) as HTMLButtonElement;
  out.addEventListener("click", async () => {
    out.disabled = true;
    out.textContent = HOSTED_COPY.signingOut;
    await chrome.runtime.sendMessage({ type: "signOut" }).catch(() => null);
    justSignedOut = true;
    void loadAccount();
  });
  actions.append(link, out);
  accountCard.appendChild(actions);
}

async function loadAccount(): Promise<void> {
  const r = (await chrome.runtime
    .sendMessage({ type: "getStatus" })
    .catch(() => null)) as Partial<AccountTruth> | null;
  renderAccount({
    signedIn: r?.signedIn === true,
    person: r?.person ?? null,
    spaces: r?.spaces ?? [],
    serverOrigin: r?.serverOrigin ?? "",
  });
}

// ── boot + live updates ──

void getPrefs().then((p) => {
  keyboard = p.keyboard;
  uiZoom = p.uiZoom;
  themePref = p.theme;
  applyPageTheme(p.theme);
  renderKeyboard();
  renderAppearance();
});
onPrefsChanged((p) => {
  // External writes (another window, the SW) land here too; the row being
  // edited keeps its in-progress text via the `editing` state.
  keyboard = p.keyboard;
  uiZoom = p.uiZoom;
  themePref = p.theme;
  applyPageTheme(p.theme);
  renderKeyboard();
  renderAppearance();
});

void loadAccount();
chrome.storage.onChanged.addListener((changes, area) => {
  // Signing in or out (here, in the popup, or a 401 anywhere) repaints Account.
  if (area === "local" && ("token" in changes || "person" in changes || "spaces" in changes))
    void loadAccount();
});

// Capture-grant truth: query once, then re-read whenever the grant flips (the
// popup mirror or the browser's own permission UI can flip it out from under us).
void refreshCaptureGrant();
chrome.permissions.onAdded.addListener(() => void refreshCaptureGrant());
chrome.permissions.onRemoved.addListener(() => void refreshCaptureGrant());

renderKeyboard();
renderCapture();
renderAppearance();
