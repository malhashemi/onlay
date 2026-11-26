// The composer's space choice (spec §10): which space a new Comment or Edit
// goes to. Defaults to the last space used; choosing one remembers it (the
// command bar's space chip and every composer share that choice). With a
// single space there is nothing to choose and nothing is shown. Guest spaces
// never appear: a guest can't create.
//
// One field names the chosen space; it opens a menu with a search over the
// person's spaces (`@onlay/render/space-select`, the web app's too), so 50
// spaces are as easy to choose from as 3. The menu reads the person's spaces
// as they are each time it opens; a membership or account change closes an
// open one (content.ts), and a send checks the chosen space is still theirs
// (`usable`) right before it goes.
import {
  closeDetachedSpaceMenus,
  closeOpenSpaceMenus,
  placeOpenSpaceMenus,
  spaceSelect,
} from "@onlay/render/space-select";
import type { App } from "./app";
import { scaled } from "./dom";
import { isTrustedEvent } from "./trusted";
import { onRouted } from "./typing-router";

/** The picker's words (a copy pass reads them here). */
export const SPACE_PICKER_COPY = {
  label: "Space",
  search: "Search spaces…",
  searchLabel: "Search spaces",
  list: "Spaces",
  empty: "No matching spaces.",
  personal: "Just you",
  /** Beside a composer whose chosen space the person lost: nothing was sent, the text stays. */
  lost: "You're no longer a member of that space. Choose another space, then send again.",
} as const;

export interface SpacePicker {
  /** The labeled field, or null when there's at most one space to post in. */
  element: HTMLElement | null;
  /** The chosen space, or null when the person has none to post in. */
  value(): string | null;
  /** The chosen space is still one the person may post in: checked right before a send. */
  usable(): boolean;
  /** Close its menu (its composer or tray is going away). */
  close(): void;
}

/** Close an open space menu (the Escape ladder's first rung, a card that starts to move, a membership change). */
export function closeAnySpaceMenu(): boolean {
  return closeOpenSpaceMenus();
}

/** A composer or tray took its content down: a menu left open under it goes too. */
export function dropDetachedSpaceMenus(): void {
  closeDetachedSpaceMenus();
}

/** The card holding a space field has finished moving: its open menu follows. */
export function placeAnySpaceMenu(): void {
  placeOpenSpaceMenus();
}

export function spacePicker(app: App, onChange?: (spaceId: string) => void): SpacePicker {
  let chosen = app.currentSpaceId();
  const usable = (): boolean => chosen !== null && app.composeSpaces().some((s) => s.id === chosen);
  if (app.composeSpaces().length < 2 || chosen === null)
    return { element: null, value: () => chosen, usable, close: () => {} };

  const select = spaceSelect({
    doc: document,
    // Read as they are now each time the menu opens: a space lost since is not offered.
    spaces: () =>
      app.composeSpaces().map((s) => ({
        id: s.id,
        name: s.name,
        ...(s.kind === "personal" ? { note: SPACE_PICKER_COPY.personal } : {}),
      })),
    value: chosen,
    copy: SPACE_PICKER_COPY,
    classes: { wrap: "field", label: "micro" },
    trusted: isTrustedEvent,
    // Keys typed in the overlay reach it only through the typing router.
    listen: (target, type, fn) => onRouted(target, type, fn),
    metrics: () => ({ margin: scaled(8), gap: scaled(4), minWidth: scaled(220) }),
    onChange: (id) => {
      chosen = id;
      app.setCurrentSpace(id);
      onChange?.(id);
    },
  });
  return {
    element: select.element,
    value: () => chosen,
    usable,
    close: () => select.close(false),
  };
}
