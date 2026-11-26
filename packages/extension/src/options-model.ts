// Pure view models for the options page (ADR-0019 §4) — everything the page
// renders is computed here so it tests without a DOM. options.ts only paints.
import type { Person, SpaceSummary } from "@onlay/protocol";
import { HOSTED_COPY } from "./hosted-copy";
import {
  COMMAND_IDS,
  COMMAND_META,
  type CommandId,
  KEYBOARD_DEFAULTS,
  type KeyboardIssue,
  type Theme,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  validateKeyboard,
} from "./prefs";

// ── keyboard section ──

export interface ShortcutRow {
  id: CommandId;
  label: string;
  description: string;
  /** The raw stored chord (what an editor input should contain). */
  value: string;
  /** Keycap segments for display: "ctrl+." → ["Ctrl", "."], "cc" → ["c","c"]. */
  keycaps: string[];
  /** commandBar is fixed-format this pass — rendered read-only. */
  fixed: boolean;
  /** Hard failure (duplicate/empty/invalid) — blocks saving this field. */
  error: string | null;
  /** Advisory (vimium) — shown amber, saves anyway. */
  warning: string | null;
  isDefault: boolean;
}

/** Validation-to-UI mapping: first hard error and first warning per command. */
export function issueMaps(issues: KeyboardIssue[]): {
  errors: Map<CommandId, string>;
  warnings: Map<CommandId, string>;
} {
  const errors = new Map<CommandId, string>();
  const warnings = new Map<CommandId, string>();
  for (const issue of issues) {
    const bucket = issue.kind === "vimium" ? warnings : errors;
    if (!bucket.has(issue.id)) bucket.set(issue.id, issue.message);
  }
  return { errors, warnings };
}

/** Keycap segments for a chord chip: accels split on "+", chords per key. */
export function chordKeycaps(value: string): string[] {
  if (value === "") return [];
  if (value.includes("+")) {
    return value.split("+").map((part) => {
      if (part.toLowerCase() === "ctrl") return "Ctrl";
      return part;
    });
  }
  return value.split("");
}

export function buildShortcutRows(keyboard: Record<CommandId, string>): ShortcutRow[] {
  const { errors, warnings } = issueMaps(validateKeyboard(keyboard).issues);
  return COMMAND_IDS.map((id) => {
    const value = keyboard[id] ?? "";
    return {
      id,
      label: COMMAND_META[id].label,
      description: COMMAND_META[id].description,
      value,
      keycaps: chordKeycaps(value),
      fixed: id === "commandBar",
      error: errors.get(id) ?? null,
      warning: warnings.get(id) ?? null,
      isDefault: value === KEYBOARD_DEFAULTS[id],
    };
  });
}

/**
 * Gate for saving ONE edited field: the candidate map is the saved map with
 * that field replaced. A hard error on the edited command blocks its save;
 * errors elsewhere (pre-existing) never hold this field hostage.
 */
export function fieldVerdict(
  keyboard: Record<CommandId, string>,
  id: CommandId,
  nextValue: string,
): { canSave: boolean; error: string | null; warning: string | null } {
  const candidate = { ...keyboard, [id]: nextValue };
  const { errors, warnings } = issueMaps(validateKeyboard(candidate).issues);
  const error = errors.get(id) ?? null;
  return { canSave: error === null, error, warning: warnings.get(id) ?? null };
}

/** Normalize what the human typed into a chord: trimmed, lowercased. */
export function normalizeChord(input: string): string {
  return input.trim().toLowerCase();
}

// ── appearance section ──

export interface ThemeChoice {
  value: Theme;
  label: string;
  on: boolean;
}

/** Theme choices for the Appearance seg — System (the default) leads. */
export function themeChoices(current: Theme): ThemeChoice[] {
  return (
    [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ] as const
  ).map((c) => ({ ...c, on: c.value === current }));
}

/** Zoom slider granularity, in the stored factor (0.05 = 5% notches). */
const ZOOM_STEP = 0.05;

export interface ZoomModel {
  /** Slider geometry in integer percent — travels cleanly through <input>. */
  pct: number;
  minPct: number;
  maxPct: number;
  stepPct: number;
  label: string;
  isDefault: boolean;
}

export function zoomModel(uiZoom: number): ZoomModel {
  const pct = Math.round(uiZoom * 100);
  return {
    pct,
    minPct: Math.round(UI_ZOOM_MIN * 100),
    maxPct: Math.round(UI_ZOOM_MAX * 100),
    stepPct: Math.round(ZOOM_STEP * 100),
    label: `${pct}%`,
    isDefault: pct === Math.round(UI_ZOOM_DEFAULT * 100),
  };
}

/** Slider percent back to the stored factor, clamped to the prefs bounds. */
export function zoomFromPct(pct: number): number {
  if (!Number.isFinite(pct)) return UI_ZOOM_DEFAULT;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, pct / 100));
}

// ── capture fidelity section (the grant ceremony, ADR-0022 §7 / D6) ──

/**
 * The single broad optional grant the ceremony requests. `<all_urls>` (not the
 * broad http+https host pair) because `captureVisibleTab` — the witness raster —
 * requires literally `<all_urls>`/`activeTab` (PINNED, BLOCKER-1). One grant
 * covers the witness AND subsumes http+https for the harvest fetch leg.
 */
export const CAPTURE_GRANT_ORIGINS = ["<all_urls>"] as const;

export interface CaptureFidelityModel {
  granted: boolean;
  title: string;
  lead: string;
  toggleLabel: string;
  /** Honest second-person state line; changes with the grant. */
  detail: string;
  /** Compact on/off word for the toggle badge. */
  statusLabel: string;
}

/**
 * Pure copy model for the "Capture fidelity" ceremony (quiet, honest,
 * second-person — never "exact"). The page/popup only paint from this; the
 * actual `chrome.permissions.request({ origins: ["<all_urls>"] })` gesture is
 * wired in options.ts/popup.ts, which own the browser side.
 */
export function captureFidelityModel(granted: boolean): CaptureFidelityModel {
  return {
    granted,
    title: "Capture fidelity",
    lead: "Onlay reconstructs the block you're editing so you can compare variants anywhere. To match fonts, colors, and images from the sites you work on, Onlay needs permission to read those pages.",
    toggleLabel: "Let Onlay capture the pages you work on",
    detail: granted
      ? "On — Onlay reads the pages you work on to capture their fonts, colors, and images. You can turn this off any time."
      : "Off — captures still work, but may be missing some styles from the sites you visit. Turn this on to include them.",
    statusLabel: granted ? "on" : "off",
  };
}

// ── account section (reads the service worker's account truth) ──

/** What `getStatus` answers that the Account section paints. */
export interface AccountTruth {
  signedIn: boolean;
  person: Person | null;
  spaces: SpaceSummary[];
  serverOrigin: string;
}

export interface AccountModel {
  signedIn: boolean;
  name: string;
  email: string;
  initials: string;
  tint: string;
  /** Their picture (Onlay's own copy); absent: their initials. */
  avatarUrl?: string | undefined;
  /** Each space and the person's role in it, in `/api/me` order. */
  spaces: Array<{ name: string; role: string }>;
  /** The web app's settings: account, spaces, workspaces, agent setup. */
  settingsUrl: string;
}

export function accountModel(truth: AccountTruth): AccountModel {
  const p = truth.signedIn ? truth.person : null;
  return {
    signedIn: p !== null,
    name: p?.name ?? "",
    email: p?.email ?? "",
    initials: p ? (p.initials || p.name.slice(0, 2)).toUpperCase() : "",
    tint: p?.tint ?? "#4b5563",
    ...(p?.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
    spaces: p
      ? truth.spaces.map((s) => ({
          name: s.name,
          role:
            s.role === "guest"
              ? HOSTED_COPY.guestRole
              : s.kind === "personal"
                ? "personal"
                : s.role,
        }))
      : [],
    settingsUrl: `${truth.serverOrigin}/app/#/settings`,
  };
}
