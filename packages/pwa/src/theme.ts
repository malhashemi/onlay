// Light / dark / system, on the same `[data-theme]` contract the extension
// pages use (design-language §4): `theme.ts` stamps `data-theme` on <html> or
// clears it for System (then the OS `prefers-color-scheme` wins via the media
// block in tokens.css). The choice is a device preference, not participant data,
// so it lives in localStorage — never in the per-client IDB partition.
export type Theme = "light" | "dark" | "system";

const KEY = "onlay-pwa-theme";

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // localStorage may be denied — default to System.
  }
  return "system";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // best-effort persistence
  }
}

/** Apply the stored preference at boot. */
export function initTheme(): void {
  applyTheme(getTheme());
}
