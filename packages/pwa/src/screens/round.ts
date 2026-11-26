// #/round/<spaceId>?url=<page> — the round: every item pending for agents on
// one page in one space (`GET /s/<id>/agent-work?url=`), yours apart from
// your teammates', each row opening its thread. Copy for agent puts the round
// pointer of spec §9 on the clipboard — no thread content, so the agent reads
// current state itself.
import type { AgentWorkItem, AgentWorkListing } from "@onlay/protocol";
import { parseRef } from "@onlay/protocol";
import { markCopied, roundCopyText } from "@onlay/render/copy-for-agent";
import { age, hostOf } from "@onlay/render/interaction-view";
import * as api from "../api";
import { emptyState, errorState, header, notHere, screenBody } from "../chrome";
import { avatar } from "../components/avatar";
import { offlineBanner } from "../components/banner";
import { kindChip } from "../components/chip";
import { toast } from "../components/toast";
import { type AppCtx, roleIn, type Screen, spaceOf } from "../context";
import { add, button, clear, copyText, el } from "../dom";
import { AGENT_WORK_LABEL, capabilitiesFor, hashFor, kindLabel, webUrl } from "../view-model";

export function roundScreen(ctx: AppCtx, spaceId: string, url: string): Screen {
  const node = el("div", "screen round");
  node.append(header("For an agent", { back: "#/inbox", onNav: (h) => ctx.router.go(h) }));
  const body = screenBody();
  node.append(body);
  let lastPaint = "";

  async function load(): Promise<boolean> {
    if (!capabilitiesFor(roleIn(ctx, spaceId)).copyForAgent) {
      clear(body);
      body.append(notHere(() => ctx.router.go("#/inbox")));
      return true;
    }
    const res = await api.agentWork(ctx.client, spaceId, url);
    const key = res.ok ? JSON.stringify([res.data, res.fromCache]) : "";
    if (res.ok && key === lastPaint) return !res.fromCache;
    lastPaint = key;
    clear(body);
    if (!res.ok) {
      if (res.verdict === "hidden") body.append(notHere(() => ctx.router.go("#/inbox")));
      else if (res.verdict === "offline") body.append(offlineBanner());
      else body.append(errorState("Couldn't reach the server.", () => void load()));
      return false;
    }
    if (res.fromCache) body.append(offlineBanner(res.syncedAt));
    render(res.data);
    return !res.fromCache;
  }

  function render(listing: AgentWorkListing): void {
    const spaceName = spaceOf(ctx, spaceId)?.name ?? "";
    const all = [...listing.yours, ...listing.teammates];

    const head = el("section", "settings-section");
    head.append(el("h2", "section-head", spaceName));
    // The router only routes web URLs; checked again before any href exists.
    const safe = webUrl(url);
    const where = el("p", "settings-note");
    where.append(document.createTextNode(url));
    if (safe) {
      const link = el("a", "hero-link", hostOf(safe) ?? safe) as HTMLAnchorElement;
      link.href = safe;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.append(" ↗");
      where.append(document.createTextNode(" · "), link);
    }
    head.append(where);
    const copy = button("btn btn-primary", "Copy for agent", () => {
      const text = roundCopyText({
        origin: ctx.origin,
        spaceId,
        spaceName,
        url,
        count: all.length,
      });
      void copyText(text).then((ok) => {
        if (!ok) {
          toast("Couldn't copy. Your browser blocked the clipboard.");
          return;
        }
        try {
          markCopied(
            window.localStorage,
            ctx.me.person.id,
            all.map((i) => i.ref),
            Date.now(),
          );
        } catch {
          // storage may be denied — the marker is a convenience
        }
        toast("Copied. Paste it into your agent's session.");
      });
    });
    copy.disabled = all.length === 0;
    head.append(copy);
    body.append(head);

    if (all.length === 0) {
      body.append(emptyState("Nothing here is waiting for an agent."));
      return;
    }
    section("from you", listing.yours);
    section("from teammates", listing.teammates);
  }

  function section(title: string, items: AgentWorkItem[]): void {
    if (items.length === 0) return;
    const sec = el("section", "inbox-section");
    sec.append(el("h2", "section-head", title));
    for (const item of items) sec.append(itemRow(item));
    body.append(sec);
  }

  function itemRow(item: AgentWorkItem): HTMLElement {
    const ref = parseRef(item.ref);
    const row = button("attention-row", "", () => {
      if (ref)
        ctx.router.go(hashFor({ name: "thread", spaceId: ref.spaceId, id: ref.interactionId }));
    });
    row.textContent = "";
    row.setAttribute("data-kind", item.kind === "change" ? "edit" : item.kind);
    row.setAttribute("aria-label", `${kindLabel(item.kind)}: ${item.summary}`);
    const main = el("div", "row-main");
    main.append(el("p", "row-title", item.summary || kindLabel(item.kind)));
    main.append(
      el("p", "row-meta", `requested by ${item.requestedBy.name} · ${age(item.requestedAt)} ago`),
    );
    const right = el("div", "row-right");
    const work = el("span", "state-chip agent-work", AGENT_WORK_LABEL[item.status]);
    work.setAttribute("data-state", "waiting");
    right.append(work);
    add(
      row,
      kindChip(item.kind, kindLabel(item.kind)),
      avatar(item.requestedBy, "sm"),
      main,
      right,
    );
    return row;
  }

  void load();
  return { node, refresh: () => load() };
}
