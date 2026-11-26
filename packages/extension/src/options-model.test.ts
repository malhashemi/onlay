// Options-page view models: shortcut row building, validation-to-UI mapping,
// the single-field save gate, and the account read model.
import { describe, expect, test } from "bun:test";
import {
  accountModel,
  buildShortcutRows,
  CAPTURE_GRANT_ORIGINS,
  captureFidelityModel,
  chordKeycaps,
  fieldVerdict,
  issueMaps,
  normalizeChord,
  themeChoices,
  zoomFromPct,
  zoomModel,
} from "./options-model";
import {
  COMMAND_IDS,
  KEYBOARD_DEFAULTS,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  validateKeyboard,
} from "./prefs";

describe("buildShortcutRows", () => {
  test("defaults: one row per command in display order, commandBar fixed, all clean", () => {
    const rows = buildShortcutRows(KEYBOARD_DEFAULTS);
    expect(rows.map((r) => r.id)).toEqual([...COMMAND_IDS]);
    for (const row of rows) {
      expect(row.error).toBeNull();
      expect(row.warning).toBeNull();
      expect(row.isDefault).toBe(true);
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
    }
    const bar = rows[0];
    expect(bar).toBeDefined();
    if (!bar) throw new Error("missing command bar row");
    expect(bar.fixed).toBe(true);
    expect(bar.keycaps).toEqual(["Ctrl", "."]);
    expect(rows.filter((r) => r.fixed)).toHaveLength(1);
  });

  test("lexicon guard (ADR-0019 §5): copy says Block/Edit, never element/Change", () => {
    for (const row of buildShortcutRows(KEYBOARD_DEFAULTS)) {
      const copy = `${row.label} ${row.description}`;
      expect(copy).not.toMatch(/element/i);
      expect(copy).not.toMatch(/\bChange\b/);
    }
  });

  test("a duplicate marks both rows with errors; vimium marks a warning only", () => {
    const rows = buildShortcutRows({ ...KEYBOARD_DEFAULTS, switchSpace: "cc", inbox: "ga" });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("switchSpace")?.error).toContain("Comment on block");
    expect(byId.get("commentBlock")?.error).toContain("Switch space");
    expect(byId.get("inbox")?.error).toBeNull();
    expect(byId.get("inbox")?.warning).toContain("Vimium");
    expect(byId.get("inbox")?.isDefault).toBe(false);
  });
});

describe("issueMaps", () => {
  test("splits hard errors from vimium warnings, first message per command wins", () => {
    const { issues } = validateKeyboard({ ...KEYBOARD_DEFAULTS, inbox: "ff", settings: "" });
    const { errors, warnings } = issueMaps(issues);
    expect(errors.get("settings")).toBeTruthy();
    expect(errors.has("inbox")).toBe(false);
    expect(warnings.get("inbox")).toBeTruthy();
  });
});

describe("fieldVerdict", () => {
  test("a hard error on the edited field blocks its save", () => {
    expect(fieldVerdict(KEYBOARD_DEFAULTS, "inbox", "cc").canSave).toBe(false);
    expect(fieldVerdict(KEYBOARD_DEFAULTS, "inbox", "").canSave).toBe(false);
    expect(fieldVerdict(KEYBOARD_DEFAULTS, "inbox", "q!").canSave).toBe(false);
  });

  test("vimium is advisory — saves with a warning", () => {
    const v = fieldVerdict(KEYBOARD_DEFAULTS, "inbox", "ga");
    expect(v.canSave).toBe(true);
    expect(v.warning).toContain("Vimium");
  });

  test("a pre-existing error elsewhere never holds this field hostage", () => {
    const broken = { ...KEYBOARD_DEFAULTS, switchSpace: "" };
    const v = fieldVerdict(broken, "inbox", "zz");
    expect(v.canSave).toBe(true);
    expect(v.error).toBeNull();
  });
});

describe("chord display", () => {
  test("keycaps", () => {
    expect(chordKeycaps("ctrl+.")).toEqual(["Ctrl", "."]);
    expect(chordKeycaps("cc")).toEqual(["c", "c"]);
    expect(chordKeycaps("q")).toEqual(["q"]);
    expect(chordKeycaps("")).toEqual([]);
  });
  test("normalizeChord trims and lowercases what the human typed", () => {
    expect(normalizeChord(" CC ")).toBe("cc");
  });
});

describe("accountModel", () => {
  const person = {
    id: "p_aaaaaaaaaaaaaaaaaaaa",
    email: "ana@example.com",
    name: "Ana Lima",
    initials: "al",
    tint: "#0ea5e9",
  };
  const spaces = [
    { id: "s_aaaaaaaaaaaaaaaaaaaa", kind: "personal", name: "Ana Lima", role: "admin" },
    { id: "s_bbbbbbbbbbbbbbbbbbbb", kind: "workspace", name: "design", role: "member" },
    { id: "s_cccccccccccccccccccc", kind: "workspace", name: "client", role: "guest" },
  ] as const;

  test("signed in: who you are, your spaces and roles, the web app's settings", () => {
    const m = accountModel({
      signedIn: true,
      person,
      spaces: [...spaces],
      serverOrigin: "https://app.onlay.dev",
    });
    expect(m.signedIn).toBe(true);
    expect(m.initials).toBe("AL");
    expect(m.email).toBe("ana@example.com");
    expect(m.spaces).toEqual([
      { name: "Ana Lima", role: "personal" },
      { name: "design", role: "member" },
      { name: "client", role: "guest" },
    ]);
    expect(m.settingsUrl).toBe("https://app.onlay.dev/app/#/settings");
  });

  test("signed out shows nobody, even with a stale person", () => {
    const m = accountModel({ signedIn: false, person, spaces: [], serverOrigin: "http://x" });
    expect(m.signedIn).toBe(false);
    expect(m.name).toBe("");
    expect(m.spaces).toEqual([]);
  });
});

describe("captureFidelityModel (grant ceremony)", () => {
  test("the ceremony requests the single broad <all_urls> grant (BLOCKER-1)", () => {
    expect([...CAPTURE_GRANT_ORIGINS]).toEqual(["<all_urls>"]);
  });

  test("granted vs declined flip the state line and badge word", () => {
    const on = captureFidelityModel(true);
    const off = captureFidelityModel(false);
    expect(on.granted).toBe(true);
    expect(off.granted).toBe(false);
    expect(on.statusLabel).toBe("on");
    expect(off.statusLabel).toBe("off");
    expect(on.detail).not.toBe(off.detail);
    // The toggle label + title are the ceremony's stable copy.
    expect(on.toggleLabel).toBe("Let Onlay capture the pages you work on");
    expect(on.title).toBe("Capture fidelity");
    // Declined copy is honest: captures still work, some styles may be missing.
    expect(off.detail.toLowerCase()).toContain("still work");
  });

  test("lexicon guard: quiet + honest, never 'exact'/'element'/'Change'/'membrane'", () => {
    for (const granted of [true, false]) {
      const m = captureFidelityModel(granted);
      const copy = `${m.title} ${m.lead} ${m.toggleLabel} ${m.detail}`;
      expect(copy).not.toMatch(/\bexact\b/i);
      expect(copy).not.toMatch(/element/i);
      expect(copy).not.toMatch(/\bChange\b/);
      expect(copy).not.toMatch(/membrane/i);
    }
  });
});

describe("zoomModel / zoomFromPct (Appearance)", () => {
  test("slider geometry in integer percent, default flagged", () => {
    const m = zoomModel(UI_ZOOM_DEFAULT);
    expect(m.pct).toBe(Math.round(UI_ZOOM_DEFAULT * 100));
    expect(m.minPct).toBe(Math.round(UI_ZOOM_MIN * 100));
    expect(m.maxPct).toBe(Math.round(UI_ZOOM_MAX * 100));
    expect(m.label).toBe(`${m.pct}%`);
    expect(m.isDefault).toBe(true);
    expect(zoomModel(1.75).isDefault).toBe(false);
  });

  test("percent maps back to a bounds-clamped factor; junk falls to default", () => {
    expect(zoomFromPct(125)).toBe(1.25);
    expect(zoomFromPct(10)).toBe(UI_ZOOM_MIN);
    expect(zoomFromPct(999)).toBe(UI_ZOOM_MAX);
    expect(zoomFromPct(Number.NaN)).toBe(UI_ZOOM_DEFAULT);
  });
});

describe("themeChoices (Appearance)", () => {
  test("System leads, the current value is on", () => {
    const m = themeChoices("system");
    expect(m.map((c) => c.label)).toEqual(["System", "Light", "Dark"]);
    expect(m.map((c) => c.on)).toEqual([true, false, false]);
    expect(themeChoices("dark").find((c) => c.on)?.value).toBe("dark");
  });
});
