// #/inbox — the home: attention merged across every space the person sees, in
// three sections (needs you / waiting / recent), server truth re-pulled live.
// With more than one space, a chip row filters to one space and each row
// names its space. Rows carry their agent work: for agent, taken, answered.
//
// Search: the bar under the header searches every interaction the person may
// see in each space, through the ONE shared matcher the extension uses (text ·
// person · anchor · state · page), needs-you first, then newest. `/` focuses
// the bar; Esc clears, then blurs; arrows walk the rows.

import type { InboxResponse, InboxRow } from "@onlay/protocol";
import { becauseLabel, chipState, hostOf, shownUrl } from "@onlay/render/interaction-view";
import * as api from "../api";
import { emptyState, errorState, header, screenBody } from "../chrome";
import { avatar } from "../components/avatar";
import { extensionHintBanner, insecureBanner, offlineBanner } from "../components/banner";
import { kindChip, stateChip } from "../components/chip";
import { gearGlyph, searchGlyph } from "../components/glyphs";
import { type AppCtx, personFor, type Screen, siteOrigin } from "../context";
import { add, button, clear, el } from "../dom";
import { dismissHint, shouldShowExtensionHint } from "../extension-hint";
import {
  AGENT_WORK_LABEL,
  filterInbox,
  filterSearchRows,
  hashFor,
  INBOX_SECTIONS,
  kindLabel,
  needsYouCopy,
  rowLocation,
  rowSpaceName,
  rowText,
  SECTION_META,
  searchRowOf,
  showsSpaces,
  validFilter,
} from "../view-model";

/** The insecure-context banner shows once per session, not on every re-pull. */
let insecureShown = false;
/** The space filter survives navigating into a thread and back. */
let spaceFilter: string | null = null;

export function inboxScreen(ctx: AppCtx): Screen {
  const node = el("div", "screen inbox");
  const newBtn = button("btn btn-primary header-ask", "Comment", () => ctx.router.go("#/compose"));
  newBtn.setAttribute("aria-label", "New comment");
  const settingsBtn = button("icon-btn", "", () => ctx.router.go("#/settings"));
  settingsBtn.append(gearGlyph());
  settingsBtn.setAttribute("aria-label", "Settings");
  node.append(header("Inbox", { actions: [newBtn, settingsBtn] }));

  const body = screenBody();
  node.append(body);

  // The search bar is PERSISTENT chrome — it never lives inside the repainted
  // results, so a live tick mid-typing can never steal the caret.
  const searchWrap = el("div", "inbox-search");
  const searchRow = el("div", "search-field");
  searchRow.append(searchGlyph());
  const input = document.createElement("input");
  input.type = "search";
  input.className = "search-input";
  input.placeholder = "Search your threads…";
  input.setAttribute("aria-label", "Search your threads");
  searchRow.append(input);
  const clearBtn = button("search-clear", "×", () => {
    setQuery("");
    input.focus();
  });
  clearBtn.setAttribute("aria-label", "Clear search");
  clearBtn.style.display = "none";
  searchRow.append(clearBtn);
  searchWrap.append(searchRow);

  // The space filter: built per paint of the space list, toggled in place.
  const spacesRow = el("div", "search-kinds space-filter");
  spacesRow.setAttribute("role", "group");
  spacesRow.setAttribute("aria-label", "Show one space");
  searchWrap.append(spacesRow);
  body.append(searchWrap);

  const content = el("div", "inbox-content");
  body.append(content);

  // No extension answered on this desktop Chromium browser: one quiet line
  // above the Inbox, until dismissed here (S-3).
  void shouldShowExtensionHint(ctx.me.extensionIds).then((show) => {
    if (show)
      body.insertBefore(extensionHintBanner(`${siteOrigin(ctx)}/install`, dismissHint), searchWrap);
  });

  let query = "";
  let inbox: InboxResponse | null = null;
  let lastPaint = "";
  let spacesKey = "";

  interface ArchiveState {
    rows: InboxRow[] | null;
    live: boolean;
    loading: boolean;
  }
  let archive: ArchiveState = { rows: null, live: false, loading: false };
  let archiveInflight: Promise<boolean> | null = null;

  /** The search corpus: every space's interactions, merged. One in flight. */
  function loadArchive(): Promise<boolean> {
    if (archiveInflight) return archiveInflight;
    archive = { ...archive, loading: true };
    const spaces = ctx.me.spaces;
    archiveInflight = Promise.all(spaces.map((s) => api.interactions(ctx.client, s.id))).then(
      (results) => {
        archiveInflight = null;
        const rows: InboxRow[] = [];
        let live = true;
        results.forEach((res, i) => {
          const space = spaces[i];
          if (!res.ok || !space) {
            live = false;
            return;
          }
          if (res.fromCache) live = false;
          for (const snap of res.data.interactions) rows.push(searchRowOf(space.id, snap));
        });
        archive = { rows, live, loading: false };
        paint();
        return live;
      },
    );
    return archiveInflight;
  }

  const searching = (): boolean => query.trim() !== "";

  function paintSpaces(): void {
    const spaces = ctx.me.spaces;
    spaceFilter = validFilter(spaceFilter, spaces);
    const key = JSON.stringify([spaces.map((s) => [s.id, s.name]), spaceFilter, searching()]);
    if (key === spacesKey) return;
    spacesKey = key;
    clear(spacesRow);
    spacesRow.style.display = showsSpaces(spaces) && !searching() ? "flex" : "none";
    const chip = (label: string, id: string | null): void => {
      const on = spaceFilter === id;
      const b = button(`search-kind${on ? " on" : ""}`, label, () => {
        spaceFilter = id;
        lastPaint = "";
        paint();
      });
      b.setAttribute("aria-pressed", String(on));
      spacesRow.append(b);
    };
    chip("All spaces", null);
    for (const s of spaces) chip(s.name, s.id);
  }

  function setQuery(q: string): void {
    query = q;
    input.value = q;
    onModeChange();
  }

  function onModeChange(): void {
    if (searching() && archive.rows === null && !archive.loading) void loadArchive();
    paint();
  }

  /** Repaint results, keeping the focused row focused across a live tick. */
  function paint(): void {
    paintSpaces();
    clearBtn.style.display = searching() ? "block" : "none";
    const rows = searching() && archive.rows ? results() : null;
    const key = JSON.stringify([
      query,
      rows,
      archive.loading,
      archive.live,
      spaceFilter,
      searching() ? null : inbox,
    ]);
    if (key === lastPaint) return;
    lastPaint = key;
    const focused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute("data-id")
        : null;
    clear(content);
    if (searching()) {
      if (archive.rows === null) {
        content.append(
          el(
            "p",
            "search-note",
            archive.loading ? "Searching…" : "Search couldn't reach the server.",
          ),
        );
        return;
      }
      if (!archive.live && !archive.loading) content.append(offlineBanner());
      const found = rows ?? [];
      if (found.length === 0) {
        content.append(emptyState("Nothing matches."));
        return;
      }
      const section = el("section", "inbox-section");
      const needs = needsIds();
      for (const r of found) {
        section.append(inboxRow(ctx, r, { place: true, needs: needs.has(r.interactionId) }));
      }
      content.append(section);
    } else if (inbox) {
      renderInbox(content, inbox);
    }
    if (focused) {
      const back = content.querySelector(`[data-id="${focused}"]`);
      if (back instanceof HTMLElement) back.focus();
    }
  }

  /** Server truth for "needs you" — the Inbox's needs-you set. */
  function needsIds(): ReadonlySet<string> {
    return new Set((inbox?.needsYou ?? []).map((r) => r.interactionId));
  }

  function results(): InboxRow[] {
    if (!archive.rows) return [];
    return filterSearchRows(archive.rows, query, needsIds(), (id) => nameAnywhere(ctx, id));
  }

  async function load(): Promise<boolean> {
    const inboxP = api.inbox(ctx.client);
    const archiveP = searching() ? loadArchive() : null;
    const res = await inboxP;
    const archiveLive = archiveP === null ? true : await archiveP;
    if (ctx.store.isOnlineOnly() && !insecureShown) {
      insecureShown = true;
      body.insertBefore(insecureBanner(), searchWrap);
    }
    if (!res.ok) {
      clear(content);
      lastPaint = "";
      if (res.verdict === "offline") content.append(offlineBanner());
      else content.append(errorState("Couldn't reach the server.", () => void load()));
      return false;
    }
    inbox = res.data;
    // Names for the rows: each space's people, re-pulled alongside.
    const spaceIds = new Set(
      [...res.data.needsYou, ...res.data.waiting, ...res.data.recent].map((r) => r.spaceId),
    );
    await Promise.all([...spaceIds].map((id) => ctx.loadPeople(id)));
    lastPaint = "";
    paint();
    if (res.fromCache && !searching()) content.prepend(offlineBanner(res.syncedAt));
    return !res.fromCache && archiveLive && !(searching() && !archive.live);
  }

  function renderInbox(into: HTMLElement, all: InboxResponse): void {
    const sections = filterInbox(all, spaceFilter);
    const total = sections.needsYou.length + sections.waiting.length + sections.recent.length;
    if (total === 0) {
      into.append(emptyState("You're all caught up."));
      return;
    }
    if (sections.needsYou.length > 0) {
      const n = spaceFilter === null ? all.needsYouCount : sections.needsYou.length;
      into.append(el("p", "inbox-count", needsYouCopy(n)));
    }
    for (const key of INBOX_SECTIONS) {
      const rows = sections[key];
      if (rows.length === 0) continue;
      const section = el("section", "inbox-section");
      section.append(el("h2", "section-head", SECTION_META[key].title));
      for (const r of rows) section.append(inboxRow(ctx, r, { needs: key === "needsYou" }));
      into.append(section);
    }
  }

  /* ── keyboard: `/` focuses, Esc clears then blurs, arrows walk rows ── */

  input.addEventListener("input", () => {
    query = input.value;
    onModeChange();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (searching()) setQuery("");
      else input.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      rowButtons()[0]?.focus();
    }
  });

  function rowButtons(): HTMLElement[] {
    return [...content.querySelectorAll(".attention-row")].filter(
      (n): n is HTMLElement => n instanceof HTMLElement,
    );
  }

  content.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = rowButtons();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && at === 0) input.focus();
    else rows[Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1))]?.focus();
  });

  const onGlobalKey = (e: KeyboardEvent): void => {
    if (!e.isTrusted || e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    )
      return;
    e.preventDefault();
    input.focus();
  };
  window.addEventListener("keydown", onGlobalKey);

  paintSpaces();
  void load();

  return {
    node,
    refresh: () => load(),
    dispose: () => window.removeEventListener("keydown", onGlobalKey),
  };
}

/** A person's name from whichever space's people know them. */
function nameAnywhere(ctx: AppCtx, id: string): string {
  if (id === ctx.me.person.id) return ctx.me.person.name;
  for (const people of ctx.people.values()) {
    const p = people.get(id);
    if (p) return p.name;
  }
  return "";
}

/** One row, the Inbox grammar: kind, author, text, where it lives (and in
 *  which space, when there are several), its agent work, its state. */
function inboxRow(
  ctx: AppCtx,
  row: InboxRow,
  opts: { place?: boolean; needs: boolean },
): HTMLElement {
  const from = personFor(ctx, row.spaceId, row.fromActorId);
  const node = button("attention-row", "", () =>
    ctx.router.go(hashFor({ name: "thread", spaceId: row.spaceId, id: row.interactionId })),
  );
  node.textContent = "";
  node.setAttribute("aria-label", `${kindLabel(row.kind)}: ${rowText(row)}`);
  node.setAttribute("data-id", row.interactionId);
  node.setAttribute("data-kind", row.kind === "change" ? "edit" : row.kind);

  const chip = kindChip(row.kind, kindLabel(row.kind));
  const main = el("div", "row-main");
  main.append(el("p", "row-title", rowText(row)));
  const meta = [rowLocation(row)];
  const host = opts.place ? hostOf(shownUrl(row)) : null;
  if (host) meta.push(host);
  const space = rowSpaceName(row, ctx.me.spaces);
  if (space) meta.push(space);
  main.append(el("p", "row-meta", meta.join(" · ")));

  const right = el("div", "row-right");
  const reason = becauseLabel(row.because);
  if (reason) right.append(el("span", "state-chip because", reason));
  if (row.agentWork) {
    const work = el("span", "state-chip agent-work", AGENT_WORK_LABEL[row.agentWork]);
    work.setAttribute("data-state", "waiting");
    right.append(work);
  }
  right.append(stateChip(chipState(row.state, opts.needs)));

  add(node, chip, avatar(from, "sm"), main, right);
  return node;
}
