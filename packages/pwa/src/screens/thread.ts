// #/t/<spaceId>/<interactionId> — a thread: rendered ENTIRELY from server
// truth, evidence first: the anchored look — the REAL captured screenshot —
// leads the screen as a kind-tinted hero card. An Edit with variants gets the
// compare card as its hero while the decision is open; after a pick, the kept
// look (the picked variant's captured witness) stays visible with who kept
// it — without the extension, a kept edit IS its look. Messages an agent
// wrote wear their person's avatar and name with an "agent" tag. Members also
// get Share (add an email, list, remove, copy the link) and Copy for agent;
// a guest sees reply, react, attach and pick only. A missing and an
// unreadable thread render the ONE generic "This isn't here." screen.

import type {
  CaptureRef,
  KeptEdit,
  RawInteractionSnapshot,
  RawThreadMsg,
  ShareListResponse,
} from "@onlay/protocol";
import { makeRef, previewFirstLine } from "@onlay/protocol";
import {
  changedSinceCopied,
  interactionUpdatedAt,
  itemCopyText,
  markCopied,
  threadLink,
} from "@onlay/render/copy-for-agent";
import { searchEmojis } from "@onlay/render/emoji";
import {
  age,
  anchorIsCapturable,
  anchorLabel,
  askIsOpen,
  attachmentCaptures,
  canFollowThrough,
  captureResidueLine,
  chipState,
  hostOf,
  humanBytes,
  isImageMime,
  isLive,
  lookStagePart,
  selectedOptionIds,
  shownUrl,
  snapshotLooks,
  variantLooks,
  waitsOnSelf,
} from "@onlay/render/interaction-view";
import { sameRevision } from "@onlay/render/mentions";
import { applyLocalReaction, REACTIONS } from "@onlay/render/reactions";
import type { Fail, VariantSetSummary } from "../api";
import * as api from "../api";
import { uploadAttachment } from "../attach";
import { errorState, header, notHere, screenBody } from "../chrome";
import { avatar } from "../components/avatar";
import { offlineBanner } from "../components/banner";
import { kindChip, stakesDot, stateChip } from "../components/chip";
import { type CompareCard, compareCard } from "../components/compare-card";
import { type Composer, composer, serializeWire, wireForEditing } from "../components/composer";
import { fencedText, renderRichText } from "../components/rich-text";
import { failureToast, toast } from "../components/toast";
import {
  type AppCtx,
  aliasFor,
  knownNameFor,
  personFor,
  roleIn,
  type Screen,
  selfId,
  spaceOf,
} from "../context";
import { button, clear, copyText, el } from "../dom";
import { closeLightbox, openLightbox, updateLightbox } from "../lightbox";
import { mentionCtx } from "../mention-ctx";
import { cachedPartUrl, partUrlKey, urlPool } from "../object-urls";
import { clientIdFor, confirmSend } from "../send-ids";
import {
  AGENT_WORK_LABEL,
  type Capabilities,
  capabilitiesFor,
  draftKey,
  hashFor,
  kindLabel,
  webUrl,
} from "../view-model";

/** The hero caption's micro-label (uppercased by CSS): what this interaction
 *  is doing to the anchored place, in the kind lexicon. */
const HERO_LABEL: Record<string, string> = {
  comment: "Commenting on",
  ask: "Asking about",
  change: "Editing",
};

/** localStorage, when the browser lets us have it. */
function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The share list's failure, and its way back. */
const SHARES_COPY = {
  loadFailed: "Couldn't load who has access.",
  retry: "Retry",
} as const;

/** A picked variant whose Edit is no longer kept: shown as history. */
const KEPT_COPY = {
  picked: "Picked",
  noLookForVersion: "No captured look for the version that was kept.",
} as const;

export function threadScreen(ctx: AppCtx, spaceId: string, id: string): Screen {
  const node = el("div", "screen detail");
  const me = selfId(ctx);
  const mentions = mentionCtx(ctx, spaceId);
  const who = (pid: string) => personFor(ctx, spaceId, pid);
  const caps = (): Capabilities => capabilitiesFor(roleIn(ctx, spaceId));
  let kept: KeptEdit | null = null;
  // The picked variant behind a kept look: read once per set after the
  // compare card hands the hero back.
  let keptSet: { setId: string; set: VariantSetSummary | null } | null = null;
  let shares: ShareListResponse | null = null;
  /** The last share-list read failed: say so with Retry, never "not shared". */
  let sharesFailed = false;
  const urls = urlPool();
  let offline = false;
  let lastPaint = ""; // stable JSON of the last painted result — the skip-repaint key
  // A part fetch that missed poisons the skip: the guard must repaint (and so
  // refetch) or one transient failure would pin a blank image forever.
  let partMissed = false;
  // Per-message intent (F18, the on-page panel's grammar): replying-to pins a
  // quote chip above the composer; editing swaps the message body for an inline
  // editor. Both live OUTSIDE the snapshot so a live re-pull of unchanged truth
  // (skip-repaint) never tears them down, and `repaint()` re-renders the LAST
  // snapshot when only intent changed — no refetch, no flicker.
  let replyingTo: string | null = null;
  let editingMsg: string | null = null;
  let editDraft = ""; // survives a truth-driven re-render mid-edit
  let lastSnap: RawInteractionSnapshot | null = null;
  let lastSynced = 0;
  let composerRef: Composer | null = null;
  // The hero's look-history place (F29: history scrubs IN PLACE, no separate
  // screen). Anchored by captureId, not index: a viewer scrubbed back keeps
  // the look they're on when a fresh snapshot lands; a viewer on "latest"
  // (anchor null) follows the new latest — the looks screen's old contract.
  let lookAnchor: string | null = null;
  // The compare card (F33): a change with a linked variant set gets the
  // informed-decision surface AS its card, right here — no separate screen.
  // Created once and re-appended across repaints so its stage, hold state and
  // open comment composer survive truth-driven rebuilds; `onGone` (no set /
  // unlinked / unreadable) falls back to the plain hero permanently for this
  // mount.
  let compareEmbed: CompareCard | null = null;
  let compareGone = false;
  let compareForSet: string | null = null;
  let disposed = false;

  function compareEmbedFor(s: RawInteractionSnapshot): CompareCard | null {
    const can = caps();
    if (disposed || s.kind !== "change" || !s.change?.variantSetId) return null;
    const setId = s.change.variantSetId;
    // Gone is PER SET: a reopened change linking a fresh set gets a fresh card.
    if (setId !== compareForSet) {
      compareEmbed?.dispose();
      compareEmbed = null;
      compareGone = false;
      compareForSet = setId;
    }
    if (compareGone) return null;
    if (!compareEmbed) {
      compareEmbed = compareCard(ctx, spaceId, id, {
        onGone: () => {
          compareGone = true;
          compareEmbed?.dispose();
          compareEmbed = null;
          void loadKeptSet(s, true).then(repaint);
        },
        canDiscard: can.discard,
        ...(can.freshLook && anchorIsCapturable(s.anchor)
          ? { onFreshLook: () => void doResnap() }
          : {}),
      });
    }
    return compareEmbed;
  }

  /** Keep the reader's place across a wholesale rebuild (F-051, ported —
   *  F22): the cleared body momentarily collapses the document and the
   *  browser clamps the window scroll to the top. A reader near the bottom
   *  follows new content (their own just-sent reply) instead. */
  function keepScroll(firstPaint: boolean, rebuild: () => void): void {
    const keepY = window.scrollY;
    const doc = document.documentElement;
    const nearBottom = !firstPaint && window.innerHeight + window.scrollY >= doc.scrollHeight - 64;
    rebuild();
    if (firstPaint) return;
    const restore = (): void => {
      window.scrollTo(0, nearBottom ? doc.scrollHeight : keepY);
    };
    restore();
    window.requestAnimationFrame(restore);
  }

  function repaint(): void {
    if (!lastSnap) return;
    // The composer dies with the DOM below — persist its in-flight draft first
    // (the 300ms debounce may not have fired) so the rebuilt composer restores
    // the text instead of losing the last-typed words.
    composerRef?.flush();
    keepScroll(false, () => {
      clear(body);
      urls.release();
      if (offline) body.append(offlineBanner(lastSynced));
      render(lastSnap as RawInteractionSnapshot);
    });
  }

  const backHeader = header("", {
    back: "#/inbox",
    onNav: (h) => ctx.router.go(h),
  });
  node.append(backHeader);
  const body = screenBody();
  node.append(body);

  /** The set behind a picked Edit, for its kept look. */
  /**
   * The set behind a picked Edit. Re-read after a pick (`force`), or when the
   * thread's kept entry names a pick the cached set doesn't show.
   */
  async function loadKeptSet(s: RawInteractionSnapshot, force = false): Promise<void> {
    const setId = s.change?.variantSetId;
    if (!setId) return;
    const cached = keptSet?.setId === setId ? keptSet.set : null;
    const stale =
      cached !== null &&
      kept !== null &&
      kept.variantId !== undefined &&
      cached.pickedVariantId !== kept.variantId;
    if (keptSet?.setId === setId && !force && !stale) return;
    keptSet = { setId, set: null };
    const res = await api.variantSet(ctx.client, spaceId, setId);
    if (res.ok && keptSet?.setId === setId) keptSet = { setId, set: res.data.set };
  }

  async function loadShares(): Promise<boolean> {
    if (!caps().share) return true;
    const res = await api.shares(ctx.client, spaceId, id);
    if (!res.ok) {
      sharesFailed = true;
      return false;
    }
    sharesFailed = false;
    shares = res.data;
    return !res.fromCache;
  }

  async function load(): Promise<boolean> {
    const [res] = await Promise.all([
      api.interaction(ctx.client, spaceId, id),
      ctx.loadPeople(spaceId),
      loadShares(),
    ]);
    if (res.ok && compareGone) await loadKeptSet(res.data.interaction);
    // A response landing after route disposal must not render into the detached
    // body — that render would mint a compare card whose global keydown handler
    // no dispose owns (codex-f33-3, the ghost-`d`-discards-an-invisible-set bug).
    if (disposed) return false;
    // The F24 round contract: true only when live server truth was reached
    // (a cache fallback or an error keeps the fallback interval armed).
    const live = res.ok && !res.fromCache;
    // Identical truth → leave the DOM alone. The 30s/focus refresh repainting
    // an unchanged snapshot is pure flicker (images re-wire, scroll nudges);
    // any real change (a reply, a state move, cache↔live) changes the key.
    // `syncedAt` is a fresh Date.now() on every LIVE fetch — keying on the
    // whole result would defeat the guard — so it counts only when it renders
    // (the offline banner). Guarded to ok-results so error-screen Retry re-runs.
    const paintKey = res.ok
      ? JSON.stringify([
          res.data,
          res.fromCache,
          res.fromCache ? res.syncedAt : 0,
          shares,
          sharesFailed,
          keptSet,
          ctx.me.spaces,
          [...(ctx.people.get(spaceId)?.values() ?? [])],
        ])
      : "";
    if (res.ok && paintKey === lastPaint && !partMissed) return live;
    const firstPaint = lastPaint === "";
    lastPaint = paintKey;
    partMissed = false; // this render retries whatever missed
    if (!res.ok) {
      clear(body);
      urls.release();
      // "This isn't here" is reserved for not_found (missing or unreadable —
      // the same answer). An operational failure gets a calm cause + Retry,
      // never the same screen. Offline shows its own banner.
      if (res.verdict === "hidden") {
        body.append(notHere(() => ctx.router.go("#/inbox")));
      } else if (res.verdict === "offline") {
        body.append(offlineBanner());
      } else {
        body.append(errorState("Couldn't reach the server.", () => void load()));
      }
      return false;
    }
    // The old render's blob URLs die with its nodes — the 30s refresh (and
    // every post-mutation reload) must not accumulate hero/attachment URLs
    // for the screen's lifetime. keepScroll (F22) holds the reader's place
    // across the rebuild — a posted reply must not teleport them to the top.
    keepScroll(firstPaint, () => {
      clear(body);
      urls.release();
      offline = res.fromCache;
      lastSynced = res.syncedAt ?? 0;
      if (offline) body.append(offlineBanner(res.syncedAt));
      lastSnap = res.data.interaction;
      kept = res.data.kept ?? null;
      render(res.data.interaction);
    });
    return live;
  }

  function render(s: RawInteractionSnapshot): void {
    // Reconcile intent against the truth about to paint: a message deleted
    // remotely (or a thread gone terminal) invalidates an edit in progress —
    // clear it rather than stranding an editor on a tombstone.
    if (editingMsg !== null) {
      const target = s.thread.find((m) => m.msgId === editingMsg);
      if (!target || target.deleted || !canFollowThrough(s.state)) {
        editingMsg = null;
        editDraft = "";
      }
    }
    if (replyingTo !== null && !canFollowThrough(s.state)) replyingTo = null;

    const can = caps();
    const author = who(s.authorId);
    const waits = waitsOnSelf(s, me);
    const anchored = s.anchor.level !== "unanchored";

    // ── header row (B.1): chips + subtle age, Resolve as a quiet pill ──
    const head = el("section", "detail-head");
    const chips = el("div", "detail-chips");
    chips.append(kindChip(s.kind, kindLabel(s.kind)));
    chips.append(stateChip(chipState(s.state, waits)));
    const dot = stakesDot(s.ask?.stakes);
    if (dot) chips.append(dot);
    if (s.agentWork) {
      const work = el("span", "state-chip agent-work", AGENT_WORK_LABEL[s.agentWork.status]);
      work.setAttribute("data-state", "waiting");
      chips.append(work);
    }
    chips.append(el("span", "detail-age", age(s.createdAt)));
    // A guest neither resolves nor reopens.
    if (can.resolve && isLive(s.state)) {
      const resolveBtn = button("resolve-pill", "Resolve", () => void doResolve());
      disableOffline(resolveBtn);
      chips.append(resolveBtn);
    } else if (can.resolve && s.state === "resolved") {
      // Resolution is not a one-way door (F26) — same authority as resolve.
      const reopenBtn = button("resolve-pill", "Reopen", () => void doReopen());
      disableOffline(reopenBtn);
      chips.append(reopenBtn);
    }
    head.append(chips);

    const whoLine = el("div", "who-line");
    whoLine.append(avatar(author, "sm"), el("span", "who-name", author.name));
    const space = spaceOf(ctx, spaceId);
    if (space && ctx.me.spaces.length > 1) whoLine.append(el("span", "detail-age", space.name));
    if (s.waitingOn.length > 0) {
      whoLine.append(el("span", "who-arrow", "→"));
      for (const wid of s.waitingOn) whoLine.append(avatar(who(wid), "sm"));
    }
    head.append(whoLine);
    if (can.copyForAgent) head.append(agentRow(s));
    body.append(head);

    // ── the hero (B.2): the anchored look, front and center. An unanchored
    // interaction gets NO hero card — no fake evidence — its question leads.
    // A change with a linked variant set gets the COMPARE CARD as its hero
    // (F33): the decision surface lives where the change lives. ──
    const embed = compareEmbedFor(s);
    if (embed) {
      body.append(embed.node);
    } else if (anchored) {
      body.append(heroCard(s));
    } else if (s.kind === "ask" && s.ask) {
      body.append(el("div", "ask-question", s.ask.question));
      if (s.ask.context) body.append(el("p", "ask-context", s.ask.context));
    } else if (s.kind === "change" && s.change) {
      body.append(fencedText("div", "ask-question", s.change.intent));
    }

    // ── after a pick, the kept look stays (spec §8, without the extension) ──
    if (!embed) {
      const keptCard = keptLookCard(s);
      if (keptCard) body.append(keptCard);
    }

    // ── an existing Ask can still be answered (Ask is hidden from creation) ──
    if (can.answer && askIsOpen(s) && s.ask) askControl(s);

    // ── the thread ──
    const thread = el("section", "thread");
    for (const m of s.thread) thread.append(threadMsg(s, m));
    body.append(thread);

    // ── reply composer (B.6): one card owning send + attach ──
    // The thread outlives the resolution (the panel's rule) — follow-up
    // replies stay open until dropped/superseded; only Resolve keys on live.
    if (can.reply && canFollowThrough(s.state)) replyComposer(s);

    // ── evidence: attachment cards, view only — attaching moved into the
    // composer toolbar (the one shared three-phase upload path) ──
    const attachments = attachmentCaptures(s);
    if (attachments.length > 0) {
      const sec = el("section", "attachments");
      sec.append(el("h2", "section-head", "Evidence"));
      for (const cap of attachments) sec.append(attachmentCard(s.id, cap));
      body.append(sec);
    }

    // ── share: members hand this one thread to an outside email ──
    if (can.share) body.append(shareSection());
  }

  /** Copy for agent (spec §9), the "changed since copied" marker, and the
   *  way to the page's whole round. */
  function agentRow(s: RawInteractionSnapshot): HTMLElement {
    const row = el("div", "hero-actions agent-row");
    const ref = makeRef(spaceId, s.id);
    const kv = local();
    const copy = button("btn btn-secondary btn-sm", "Copy for agent", () => {
      const text = itemCopyText({
        origin: ctx.origin,
        spaceId,
        spaceName: spaceOf(ctx, spaceId)?.name ?? "",
        interactionId: s.id,
        kind: s.kind,
        ...(s.url ? { url: s.url } : {}),
      });
      void copyText(text).then((ok) => {
        if (!ok) {
          toast("Couldn't copy. Your browser blocked the clipboard.");
          return;
        }
        if (kv) markCopied(kv, me, [ref], Date.now());
        toast("Copied. Paste it into your agent's session.");
        repaint();
      });
    });
    row.append(copy);
    if (kv && changedSinceCopied(kv, me, ref, interactionUpdatedAt(s))) {
      row.append(el("span", "msg-edited", "changed since copied"));
    }
    if (s.url) {
      const round = button("btn btn-ghost btn-sm", "All for an agent on this page", () =>
        ctx.router.go(hashFor({ name: "round", spaceId, url: s.url as string })),
      );
      row.append(round);
    }
    return row;
  }

  /** The kept look: the picked variant's captured witness, with who kept it. */
  function keptLookCard(s: RawInteractionSnapshot): HTMLElement | null {
    if (s.kind !== "change") return null;
    const set = keptSet?.set;
    const setId = s.change?.variantSetId;
    if (!set || !setId || set.outcome === "discarded") return null;
    // The pick the thread's kept entry pins wins (its id and the version that
    // was picked), so a later revision never shows under "Kept".
    const pinned = kept && kept.interactionId === s.id ? kept : null;
    const picked =
      (pinned?.variantId !== undefined
        ? set.variants.find((v) => v.variantId === pinned.variantId)
        : undefined) ??
      set.variants.find((v) => v.variantId === set.pickedVariantId) ??
      (set.outcome === "picked" && set.activeIndex !== undefined
        ? set.variants[set.activeIndex]
        : undefined);
    if (!picked) return null;
    // "Kept" only while the thread read carries this Edit's kept entry; a pick
    // whose Edit moved on (implemented, resolved) is history.
    const stillKept = kept !== null && kept.interactionId === s.id;
    const card = el("section", "hero-card kept-look");
    card.setAttribute("data-kind", "edit");
    card.append(el("span", "hero-label", stillKept ? "Kept" : KEPT_COPY.picked));
    const version = pinned?.variantId === picked.variantId ? pinned.version : undefined;
    const pinnedVersion = version ?? picked.version;
    const found = variantLooks(s, setId, [
      pinnedVersion !== undefined
        ? { variantId: picked.variantId, version: pinnedVersion }
        : { variantId: picked.variantId },
    ]).get(picked.variantId);
    // Only the pinned version's own look stands for the kept one; an older
    // version's look is never shown in its place (R3-C12).
    const look = found && !found.stale ? found : undefined;
    const part = look ? lookStagePart(look.ref) : null;
    if (look && part) {
      const mime =
        look.ref.parts.find((p) => p.name === part || p.role === part)?.mime ?? "image/webp";
      const img = el("img", "hero-img") as HTMLImageElement;
      img.alt = "kept look";
      void api
        .part(ctx.client, spaceId, id, look.ref.captureId, part, { persist: false })
        .then((bytes) => {
          if (!bytes) {
            partMissed = true;
            return;
          }
          img.src = cachedPartUrl(partUrlKey(id, look.ref, part), bytes, mime);
        });
      const shot = el("div", "hero-shot");
      shot.append(img);
      card.append(shot);
    } else if (found) {
      card.append(el("p", "settings-note", KEPT_COPY.noLookForVersion));
    } else {
      card.append(el("p", "settings-note", "No captured look for this variant yet."));
    }
    const line: string[] = [picked.label || "Picked variant"];
    if (stillKept && kept) {
      line.push(`kept by ${who(kept.by).name}`, `${age(kept.at)} ago`);
    }
    card.append(el("p", "hero-source", line.join(" · ")));
    return card;
  }

  /** Share: add an email, list who it's shared with, remove, copy the link. */
  function shareSection(): HTMLElement {
    const sec = el("section", "settings-section share-section");
    sec.append(el("h2", "section-head", "Share"));
    const spaceName = spaceOf(ctx, spaceId)?.name ?? "this space";
    sec.append(
      el(
        "p",
        "settings-note",
        `Share this thread with someone outside ${spaceName}. They sign in with that email and see only this thread.`,
      ),
    );
    const list = el("div", "settings-list");
    for (const sh of shares ?? []) {
      const row = el("div", "settings-row");
      row.append(el("span", "settings-row-main", sh.email));
      const remove = button("btn btn-ghost btn-sm", "Remove", () => {
        remove.disabled = true;
        void api.removeShare(ctx.client, spaceId, id, sh.email).then(async (res) => {
          if (!res.ok) {
            remove.disabled = false;
            toast(failureToast(res));
            return;
          }
          toast(`${sh.email} no longer has access.`);
          await loadShares();
          repaint();
        });
      });
      remove.setAttribute("aria-label", `Stop sharing with ${sh.email}`);
      disableOffline(remove);
      row.append(remove);
      list.append(row);
    }
    if (sharesFailed) {
      // A failed read is not an empty list: the thread may well have guests.
      const failed = el("div", "identity-row");
      failed.append(el("p", "settings-note", SHARES_COPY.loadFailed));
      failed.append(
        button("btn btn-ghost btn-sm", SHARES_COPY.retry, () => {
          void loadShares().then(() => repaint());
        }),
      );
      list.append(failed);
    } else if (shares !== null && shares.length === 0) {
      list.append(el("p", "settings-note", "Only people in this space."));
    }
    sec.append(list);

    const addRow = el("div", "identity-row");
    const email = el("input", "field name-field") as HTMLInputElement;
    email.type = "email";
    email.placeholder = "name@example.com";
    email.autocomplete = "off";
    email.setAttribute("aria-label", "Email to share this thread with");
    const add = button("btn btn-secondary", "Share", () => void doShare());
    disableOffline(add);
    email.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.isTrusted) void doShare();
    });
    addRow.append(email, add);
    sec.append(addRow);
    const linkBtn = button("btn btn-ghost btn-sm", "Copy link", () => {
      void copyText(threadLink(ctx.origin, spaceId, id)).then((ok) =>
        toast(ok ? "Link copied." : "Couldn't copy. Your browser blocked the clipboard."),
      );
    });
    sec.append(linkBtn);

    async function doShare(): Promise<void> {
      const value = email.value.trim();
      if (!value || add.disabled) return;
      add.disabled = true;
      const res = await api.addShare(ctx.client, spaceId, id, value);
      add.disabled = false;
      if (!res.ok) {
        toast(failureToast(res));
        return;
      }
      toast(`Shared with ${value}.`);
      await loadShares();
      repaint();
    }
    return sec;
  }

  /** The anchored-look hero card (B.2): the captured look as an inline image
   *  — tap opens it FULLSCREEN with zoom (F29), the revision history scrubs
   *  right here on the card, no separate screen; the quote stands in until a
   *  look exists — the card never fakes evidence. Ask/change context rides
   *  the same card. */
  function heroCard(s: RawInteractionSnapshot): HTMLElement {
    const card = el("section", "hero-card");
    card.setAttribute("data-kind", s.kind === "change" ? "edit" : s.kind);
    const looks = snapshotLooks(s); // newest first
    // captureId anchoring: scrubbed-back keeps its look across refreshes,
    // "latest" (anchor null) follows a landing resnap.
    const anchored = lookAnchor === null ? -1 : looks.findIndex((l) => l.captureId === lookAnchor);
    const cursor = anchored >= 0 ? anchored : 0;
    if (anchored < 0) lookAnchor = null;
    const look = looks[cursor];
    const part = look ? lookStagePart(look) : null;

    card.append(el("span", "hero-label", HERO_LABEL[s.kind] ?? "Commenting on"));

    // Live truth reaches an OPEN viewer too — a fresh look landing under an
    // open lightbox joins its scrubber instead of going stale (no-op closed).
    updateLightbox(looks);

    if (look) {
      const shot = el("button", "hero-shot") as HTMLButtonElement;
      shot.type = "button";
      shot.setAttribute("aria-label", "View full screen");
      shot.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        openLightbox({
          looks,
          index: cursor,
          fetchPart: (ref, name) => api.part(ctx.client, spaceId, id, ref.captureId, name),
          partUrl: (ref, name, bytes, m) => cachedPartUrl(partUrlKey(id, ref, name), bytes, m),
        });
      });
      if (part) {
        // Exactly the old Looks fetch: part NAME string → bytes → object URL;
        // the mime resolved from the manifest (name-or-role), webp fallback —
        // never guessed. The witness is a still raster: an <img>.
        const mime =
          look.parts.find((p) => p.name === part || p.role === part)?.mime ?? "image/webp";
        const img = el("img", "hero-img") as HTMLImageElement;
        img.alt = "captured look";
        // Cache-stable URL (object-urls.ts): the same look across refreshes gets
        // the same blob: URL, so a repaint never visibly reloads the screenshot.
        void api.part(ctx.client, spaceId, id, look.captureId, part).then((bytes) => {
          if (!bytes) {
            partMissed = true;
            return;
          }
          img.src = cachedPartUrl(partUrlKey(id, look, part), bytes, mime);
        });
        shot.append(img);
      } else {
        // A rasterless revision (document-only — legal) still opens: the
        // viewer renders its reconstruction; the tile says so honestly.
        shot.classList.add("rasterless"); // no raster → no white canvas
        shot.append(el("span", "hero-recon-tile", "reconstruction only — tap to view"));
      }
      card.append(shot);
      // The revision scrub, in place (F29) — only when there is history.
      if (looks.length > 1) {
        const scrub = el("div", "look-scrub");
        const moveTo = (i: number): void => {
          const next = looks[Math.max(0, Math.min(looks.length - 1, i))];
          lookAnchor = next && next !== looks[0] ? next.captureId : null;
          repaint();
        };
        const older = button("icon-btn", "‹", () => moveTo(cursor + 1));
        older.setAttribute("aria-label", "Older look");
        older.disabled = cursor >= looks.length - 1;
        const newer = button("icon-btn", "›", () => moveTo(cursor - 1));
        newer.setAttribute("aria-label", "Newer look");
        newer.disabled = cursor <= 0;
        scrub.append(
          older,
          el("span", "look-age", cursor === 0 ? "latest" : `${cursor} back`),
          newer,
        );
        card.append(scrub);
      }
      // The honesty meter rides the hero now: a look captured with residue
      // names it here too, never a silently-plausible witness.
      const residueLine = captureResidueLine(look);
      if (residueLine) card.append(el("p", "cap-residue", residueLine));
    } else {
      // No captured look yet — the anchor's quote is the hero.
      card.append(el("blockquote", "hero-quote", anchorLabel(s.anchor)));
    }

    // The source line, with the host as a real link to the original page (opens
    // a new tab — reading an interaction never navigates the app away), the
    // parity the extension's modal/full-page "open page ↗" gives every artifact.
    const parts: (string | HTMLElement)[] = [];
    if (look) parts.push(anchorLabel(s.anchor));
    const host = hostOf(shownUrl(s));
    const pageUrl = webUrl(shownUrl(s));
    if (pageUrl && host) {
      const link = el("a", "hero-link", host) as HTMLAnchorElement;
      link.href = pageUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.append(" ↗");
      parts.push(link);
    } else if (host) {
      parts.push(host);
    }
    if (look) parts.push(`captured ${age(look.capturedAt)} ago`);
    if (parts.length > 0) {
      const source = el("p", "hero-source");
      parts.forEach((p, i) => {
        if (i > 0) source.append(document.createTextNode(" · "));
        source.append(typeof p === "string" ? document.createTextNode(p) : p);
      });
      card.append(source);
    }

    if (s.kind === "ask" && s.ask) {
      card.append(el("p", "hero-question", s.ask.question));
      if (s.ask.context) card.append(el("p", "hero-context", s.ask.context));
    } else if (s.kind === "change" && s.change) {
      card.append(fencedText("p", "hero-question", s.change.intent));
    }

    const actions = el("div", "hero-actions");
    // Only offer a fresh look where a Full client could actually re-capture it
    // (element/selection) — the same rule the extension duty surface mirrors and
    // the server enforces. Offering it on a page-level/unanchored place would
    // request a duty no capture surface can ever discharge (GPT-3).
    if (caps().freshLook && anchorIsCapturable(s.anchor)) {
      const fresh = button("btn btn-ghost", "⟳ Fresh look", () => void doResnap());
      disableOffline(fresh);
      actions.append(fresh);
    }
    if (actions.childElementCount > 0) card.append(actions);
    return card;
  }

  function threadMsg(s: RawInteractionSnapshot, m: RawThreadMsg): HTMLElement {
    const row = el("article", m.system ? "msg system" : "msg");
    if (m.deleted) {
      row.append(el("p", "msg-deleted", "message removed"));
      return row;
    }
    const can = caps();
    const a = who(m.authorId);
    if (!m.system) row.append(avatar(a, "sm"));
    const col = el("div", "msg-col");
    const meta = el("div", "msg-meta");
    // An agent acts as its person: their face and name, plus an "agent" tag.
    if (!m.system) meta.append(el("span", "msg-author", a.name));
    if (m.agent) meta.append(el("span", "msg-edited msg-agent", "agent"));
    meta.append(el("span", "msg-age", age(m.ts)));
    if (m.editedAt !== undefined) meta.append(el("span", "msg-edited", "edited"));
    col.append(meta);

    // A reply shows what it answers (ADR-0018 §1) — the on-page panel's quote.
    if (m.replyTo) col.append(quoteOf(s, m.replyTo.msgId));

    if (editingMsg === m.msgId) {
      col.append(editBox(s, m));
      row.append(col);
      return row;
    }

    const bodyEl = el("div", "msg-body");
    bodyEl.append(
      renderRichText(
        m.body,
        (pid) => knownNameFor(ctx, spaceId, pid),
        (pid) => aliasFor(ctx, spaceId, pid),
      ),
    );
    col.append(bodyEl);

    const bar = el("div", "reaction-bar");
    paintReactions(s, m, bar);
    col.append(bar);

    // Quiet per-message affordances (the panel's grammar): reply on every
    // message while the thread is live; edit/delete only on your own (and an
    // agent's message, though written as you, is the agent's to revise).
    if (!m.system && can.reply && canFollowThrough(s.state)) {
      const acts = el("div", "msg-acts");
      const replyAct = button("msg-act", "reply", () => {
        replyingTo = m.msgId;
        repaint();
        composerRef?.focus();
      });
      disableOffline(replyAct);
      acts.append(replyAct);
      if (can.editOwn && m.authorId === me && !m.agent) {
        const editAct = button("msg-act", "edit", () => {
          editingMsg = m.msgId;
          editDraft = wireForEditing(m.body, mentions.directory.values());
          repaint();
        });
        disableOffline(editAct);
        // Two-tap confirm, not a modal — the panel's pattern.
        const del = button("msg-act danger", "delete", () => {
          if (del.textContent === "delete") {
            del.textContent = "confirm?";
            setTimeout(() => {
              del.textContent = "delete";
            }, 2500);
            return;
          }
          del.disabled = true; // the confirm tap fires exactly one delete
          void api.deleteMsg(ctx.client, spaceId, id, m.msgId).then((res) => {
            if (!guard(res)) {
              del.disabled = false;
              return;
            }
            void load();
          });
        });
        disableOffline(del);
        acts.append(editAct, del);
      }
      col.append(acts);
    }
    row.append(col);
    return row;
  }

  /** The quoted original above a reply — a tombstoned original says so. */
  function quoteOf(s: RawInteractionSnapshot, msgId: string): HTMLElement {
    const target = s.thread.find((t) => t.msgId === msgId);
    if (!target || target.deleted || target.system) {
      return el("div", "quote-chip missing", "original message removed");
    }
    const author = who(target.authorId);
    const chip = el("div", "quote-chip");
    chip.append(
      avatar(author, "sm"),
      el("span", "quote-text", `${author.name}: ${previewFirstLine(target.body.text)}`),
    );
    return chip;
  }

  /** Inline editor for an own message: plain field + Save/Cancel. Mentions
   *  survive the round-trip the composer's way — recognition at serialization
   *  (`serializeWire` re-resolves the `@<handle>` runs the space knows). */
  function editBox(_s: RawInteractionSnapshot, m: RawThreadMsg): HTMLElement {
    const wrap = el("div", "edit-box");
    const ta = el("textarea", "field") as HTMLTextAreaElement;
    ta.value = editDraft;
    ta.rows = 2;
    ta.setAttribute("aria-label", "Edit message");
    ta.addEventListener("input", () => {
      editDraft = ta.value;
    });
    const rowEl = el("div", "edit-actions");
    const save = button("btn btn-primary btn-sm", "Save", () => {
      const next = serializeWire(ta.value, (h) => mentions.directory.get(h));
      if (!next.text) return;
      save.disabled = true; // one save per intent — Enter-mash sends one edit
      void api.editMsg(ctx.client, spaceId, id, m.msgId, next).then((res) => {
        if (!guard(res)) {
          save.disabled = false;
          return;
        }
        editingMsg = null;
        editDraft = "";
        void load();
      });
    });
    disableOffline(save);
    const cancel = button("btn btn-secondary btn-sm", "Cancel", () => {
      editingMsg = null;
      editDraft = "";
      repaint();
    });
    rowEl.append(save, cancel);
    wrap.append(ta, rowEl);
    // The editor owns focus once mounted (repaint() is synchronous — the node
    // is in the DOM by the next microtask).
    queueMicrotask(() => ta.focus());
    return wrap;
  }

  /** Repaint one message's reaction row in place: count pills for what the
   *  server (or our optimistic copy) holds, then the visible quick-react set
   *  (B.5) + a ＋ that searches the full emoji table. */
  function paintReactions(s: RawInteractionSnapshot, m: RawThreadMsg, bar: HTMLElement): void {
    clear(bar);
    const current = m.reactions ?? {};
    const can = caps();
    for (const [emoji, people] of Object.entries(current)) {
      const on = people.includes(me);
      const b = button(`reaction ${on ? "on" : ""}`, `${emoji} ${people.length}`, () => {
        void doReact(s, m, bar, emoji, !on);
      });
      b.disabled = !can.react;
      disableOffline(b);
      bar.append(b);
    }
    if (can.react && !m.system && canFollowThrough(s.state)) {
      // The quick-react row stays visible (never a lone "+") but quiet —
      // desaturated until touched, so five glyphs don't shout under every
      // message. An emoji already reacted with shows as its count pill instead.
      for (const glyph of REACTIONS) {
        if (current[glyph]) continue;
        const b = button("reaction reaction-quick", glyph, () => {
          void doReact(s, m, bar, glyph, true);
        });
        b.setAttribute("aria-label", `React with ${glyph}`);
        disableOffline(b);
        bar.append(b);
      }
      const more = button("reaction reaction-quick reaction-more", "＋", () =>
        toggleReactPicker(s, m, bar),
      );
      more.setAttribute("aria-label", "React with any emoji");
      disableOffline(more);
      bar.append(more);
    }
  }

  /** An inline emoji search under the message — any emoji is a valid reaction
   *  (existing `api.react` wire). In flow, like the composer popover: never
   *  clipped, never covering the keyboard's target. */
  function toggleReactPicker(s: RawInteractionSnapshot, m: RawThreadMsg, bar: HTMLElement): void {
    const col = bar.parentElement;
    if (!col) return;
    const open = col.querySelector(".react-picker");
    if (open) {
      open.remove();
      return;
    }
    const pick = el("div", "composer-popover react-picker");
    const search = el("input", "field popover-search") as HTMLInputElement;
    search.type = "search";
    search.placeholder = "Search emoji…";
    search.setAttribute("aria-label", "Search emoji");
    const results = el("div", "popover-results");
    const choose = (glyph: string): void => {
      pick.remove();
      const on = !(m.reactions?.[glyph] ?? []).includes(me);
      void doReact(s, m, bar, glyph, on);
    };
    const renderResults = (): void => {
      clear(results);
      const matches = searchEmojis(search.value.trim().toLowerCase(), 12);
      if (matches.length === 0) {
        // Under the 2-char search gate, offer the shared quick-react set.
        const quick = el("div", "emoji-quick");
        for (const glyph of REACTIONS) {
          const b = button("pick-row emoji-quick-btn", "", () => choose(glyph));
          b.append(el("span", "emoji-glyph", glyph));
          quick.append(b);
        }
        results.append(quick);
        return;
      }
      for (const match of matches) {
        const b = button("pick-row", "", () => choose(match.glyph));
        b.append(
          el("span", "emoji-glyph", match.glyph),
          el("span", "pick-hint", `:${match.name}:`),
        );
        results.append(b);
      }
    };
    search.addEventListener("input", renderResults);
    renderResults();
    pick.append(search, results);
    bar.after(pick);
    search.focus();
  }

  function askControl(s: RawInteractionSnapshot): void {
    if (!s.ask) return;
    const already = new Set(selectedOptionIds(s));
    const control = el("section", "ask-control");
    control.append(el("h2", "ask-control-head", "Your answer"));
    const chosen = new Set<string>(already);
    const max = s.ask.selection?.max ?? 1;
    const single = max === 1;
    const opts = el("div", "ask-options");
    for (const opt of s.ask.options ?? []) {
      const b = el("button", "ask-option") as HTMLButtonElement;
      b.type = "button";
      b.textContent = opt.label;
      if (chosen.has(opt.id)) b.classList.add("chosen");
      b.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        if (single) {
          chosen.clear();
          for (const c of opts.children) c.classList.remove("chosen");
        }
        if (chosen.has(opt.id)) {
          chosen.delete(opt.id);
          b.classList.remove("chosen");
        } else {
          chosen.add(opt.id);
          b.classList.add("chosen");
        }
      });
      opts.append(b);
    }
    control.append(opts);
    const submit = button("btn btn-primary", "Answer", () => void doAnswer([...chosen]));
    disableOffline(submit);
    control.append(submit);
    body.append(control);
  }

  function replyComposer(s: RawInteractionSnapshot): void {
    const key = draftKey("reply", id);
    const wrap = el("section", "reply-composer");
    const note = el("p", "composer-note");
    const c = composer(mentions, {
      placeholder: caps().mentionAgent ? "Reply… @agent hands it to an agent" : "Reply…",
      draftKey: key,
      onDraftRestored: () => {
        note.textContent = "Your draft is still here.";
      },
      // Enter sends; Shift+Enter is a newline (the `c` binding is initialized
      // by the time a keystroke fires this).
      onSubmit: () => void doReply(c),
    });
    composerRef = c;
    for (const control of c.controls) disableOffline(control);
    // A pending reply-to pins the quoted original above the field, with an ×
    // to dismiss the targeting without losing the typed draft (ADR-0018 §1).
    if (replyingTo !== null) {
      const chip = quoteOf(s, replyingTo);
      chip.classList.add("pending");
      const x = button("icon-btn quote-cancel", "×", () => {
        replyingTo = null;
        repaint();
      });
      x.setAttribute("aria-label", "Cancel the reply target");
      chip.append(x);
      wrap.append(chip);
    }
    // Attach lives in the composer toolbar, after emoji/@ — the same
    // three-phase upload path, beside the words it evidences.
    if (caps().attach) c.tools.append(attachTool(note));
    const send = button("btn btn-primary", "Send", () => void doReply(c));
    disableOffline(send, "Reconnect to send.");
    c.actions.append(send);
    wrap.append(c.node, note);
    body.append(wrap);
  }

  /* ── mutations ─────────────────────────────────────────────────────── */

  function guard(res: { ok: true } | Fail): boolean {
    if (res.ok) return true;
    toast(failureToast(res));
    return false;
  }

  let replying = false;
  async function doReply(c: Composer): Promise<void> {
    // The composer's value() carries the routing tokens — a mention and
    // `@agent` route exactly like the extension's.
    if (replying) return; // Enter + the Send button share one in-flight guard
    const msg = c.value();
    if (!msg.text) return;
    replying = true;
    try {
      const target = replyingTo;
      // A retry of an unconfirmed send reuses its id: the server answers it once (M-1).
      const place = `reply:${spaceId}:${id}`;
      const clientId = clientIdFor(place, { msg, target });
      const res = await api.reply(
        ctx.client,
        spaceId,
        id,
        msg,
        target ? { msgId: target } : undefined,
        clientId,
      );
      if (!guard(res)) return;
      confirmSend(place, clientId);
      replyingTo = null;
      // Only the revision that was sent goes; anything typed since stays.
      if (sameRevision(c.value(), msg)) c.clear();
      toast("Reply sent.");
      await load();
    } finally {
      replying = false;
    }
  }

  async function doReact(
    s: RawInteractionSnapshot,
    m: RawThreadMsg,
    bar: HTMLElement,
    emoji: string,
    on: boolean,
  ): Promise<void> {
    // The one sanctioned optimism: reactions are micro-signals, never state.
    // Paint the local copy immediately; a refused send reverts it. Server
    // truth reconciles on the next refresh.
    const undo = applyLocalReaction(m, emoji, me, on);
    paintReactions(s, m, bar);
    const res = await api.react(ctx.client, spaceId, id, m.msgId, emoji, on);
    if (!guard(res)) {
      undo();
      paintReactions(s, m, bar);
    }
  }

  async function doAnswer(optionIds: string[]): Promise<void> {
    if (optionIds.length === 0) {
      toast("Pick an answer first.");
      return;
    }
    const res = await api.answer(ctx.client, spaceId, id, optionIds);
    if (!guard(res)) return;
    toast("Answered.");
    await load();
  }

  async function doResolve(): Promise<void> {
    const res = await api.resolve(ctx.client, spaceId, id);
    if (!guard(res)) return;
    toast("Resolved.");
    await load();
  }

  async function doReopen(): Promise<void> {
    const res = await api.reopen(ctx.client, spaceId, id);
    if (!guard(res)) return;
    toast("Reopened.");
    await load();
  }

  async function doResnap(): Promise<void> {
    const res = await api.resnap(ctx.client, spaceId, id);
    if (!guard(res)) return;
    toast("Fresh look requested.");
    await load();
  }

  /** The composer-toolbar attach control: a quiet 📎 beside emoji/@, driving
   *  the SAME upload path the compose screen speaks, on the EXISTING thread. */
  function attachTool(note: HTMLElement): HTMLElement {
    const holder = el("span", "attach-tool");
    const fileInput = el("input", "attach-input") as HTMLInputElement;
    fileInput.type = "file";
    const btn = button("icon-btn tool-btn", "📎", () => fileInput.click());
    btn.setAttribute("aria-label", "Attach evidence");
    disableOffline(btn, "Reconnect to attach.");
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      btn.disabled = true;
      note.textContent = "Uploading…";
      void file.arrayBuffer().then(async (buf) => {
        const ok = await uploadAttachment(ctx.client, spaceId, id, {
          file,
          bytes: new Uint8Array(buf),
        });
        fileInput.value = "";
        if (ok) {
          toast("Evidence attached.");
          await load();
        } else {
          btn.disabled = false;
          note.textContent = "Couldn't upload the attachment.";
        }
      });
    });
    holder.append(btn, fileInput);
    return holder;
  }

  function attachmentCard(interactionId: string, cap: CaptureRef): HTMLElement {
    const card = el("div", "attachment-card");
    const primary = cap.parts[0];
    const meta = el("p", "attachment-meta", `${cap.format} · ${humanBytes(cap.totalBytes)}`);
    if (cap.caption) card.append(el("p", "attachment-caption", cap.caption));
    if (primary && isImageMime(primary.mime)) {
      const img = el("img", "attachment-img") as HTMLImageElement;
      img.alt = cap.caption ?? "attachment";
      img.loading = "lazy";
      void api
        .part(ctx.client, spaceId, interactionId, cap.captureId, primary.name)
        .then((bytes) => {
          if (!bytes) {
            partMissed = true;
            return;
          }
          // Cache-stable: an unchanged attachment never re-decodes on refresh.
          img.src = cachedPartUrl(
            partUrlKey(interactionId, cap, primary.name),
            bytes,
            primary.mime,
          );
        });
      card.append(img);
    } else if (primary) {
      const dl = button("btn btn-secondary", "Open attachment", () => {
        void api
          .part(ctx.client, spaceId, interactionId, cap.captureId, primary.name)
          .then((bytes) => {
            if (!bytes) return;
            const url = urls.claim(bytes, primary.mime);
            if (url) window.open(url, "_blank", "noopener");
          });
      });
      card.append(dl);
    }
    card.append(meta);
    return card;
  }

  function disableOffline(node: HTMLButtonElement | HTMLTextAreaElement, title?: string): void {
    if (offline) {
      node.disabled = true;
      if (title) node.title = title;
    }
  }

  void load();

  return {
    node,
    // Both truths tick together: the thread AND the compare card's set read —
    // live only when every read that ran was live.
    refresh: async () => {
      const live = await load();
      const embedLive = compareEmbed ? await compareEmbed.refresh() : true;
      return live && embedLive;
    },
    dispose: () => {
      disposed = true;
      closeLightbox(); // a route change under an open viewer must not strand it
      compareEmbed?.dispose();
      urls.dispose();
    },
  };
}
