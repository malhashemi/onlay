// onlay content script (ISOLATED world) — the human-facing membrane overlay.
//
// Recut for ADR-0019: ONE launcher (a small floating orb) and ONE command bar
// are the entire entry surface. The bar's registry drives commands and the
// chord dispatcher; queue inspection is a bar MODE (server attention truth
// merged with this page's snapshots); creation commands graduate into their
// own composer windows. The overlay stays a PURE VIEW of `interactions-state`
// for this frame's URL. Held invariants: no innerHTML anywhere; ISOLATED
// world only; styles via ONE constructed sheet; geometry via style
// properties; Shadow-DOM host; top-frame gating for global chrome.
//
// Hosted (spec §10): the overlay merges every space's snapshots, tags each
// with its space, and asks the service worker for each space's directory.
// Signed out, it stays quiet and says how to sign in.
//
// MUST bundle to a single classic IIFE — MV3 content scripts cannot be ESM.
import { type Anchor, type KeptEdit, KeptEditSchema, type SpaceSummary } from "@onlay/protocol";
import { createPreviewEngine } from "@onlay/render";
import { HOSTED_COPY } from "./hosted-copy";
import { onAccessChanged } from "./overlay/access-changed";
import { stepLossCounters } from "./overlay/anchor-loss";
import {
  anchorForElement,
  anchorForSelection,
  anchorLabel,
  documentProvenance,
  framePathTo,
  pinBlock,
  resolveAnchor,
} from "./overlay/anchors";
import {
  type AnchorCapture,
  type AppInternals,
  type CreateResult,
  createApp,
  LAST_SPACE_KEY,
  type InteractionSnap as Snapshot,
} from "./overlay/app";
import { createBatchTray } from "./overlay/batch";
import { captureQueueBusy, captureSnapshot, registerPreviewGuard } from "./overlay/capture";
import { bindCapture } from "./overlay/capture/binding";
import {
  listenForLocates,
  onFrameHold,
  onFrameRelease,
  onLocateUp,
  plainFramePath,
} from "./overlay/capture/frame-look";
import { installCapturePipeline } from "./overlay/capture/pipeline";
import {
  cancelVariantPasses,
  observeVariantState,
  type PassDeps,
  type PassSetInfo,
  resumeVariantPasses,
} from "./overlay/capture/variant-pass";
import { type AttentionLists, createCommandBar, type QueueRow } from "./overlay/command-bar";
import {
  COMMANDS,
  type CommandCtx,
  commandById,
  PICK_HINTS,
  type PickKind,
  REANCHOR_FRAME_GONE,
  REANCHOR_HINT,
  SANDBOXED_FRAME_HINT,
} from "./overlay/commands";
import { createComposerWindow } from "./overlay/composer-window";
import type { ComposerVia } from "./overlay/composers";
import { copiedStore, copyRound, pendingForAgent } from "./overlay/copy-agent";
import { copyElement } from "./overlay/copy-element";
import {
  applyUiZoom,
  avatar,
  el,
  installSheet,
  makeToast,
  placeBox,
  stampTheme,
} from "./overlay/dom";
import { preserveFocus, restoreDrafts, setDraftScope } from "./overlay/drafts";
import { cancelDrags, installDragIsolation } from "./overlay/drag-router";
import {
  acceptKept,
  acceptOps,
  acceptSets,
  documentsToForget,
  keptSwitchTarget,
  parseRemoteAct,
  type ReportedKept,
  type ReportedOp,
  spaceGate,
  trayAnswer,
  trayCallAllowed,
} from "./overlay/frame-edits";
import { isWebDocument } from "./overlay/frame-owner";
import { ownedFrameDocuments, reachableByOwner, rectInOwner } from "./overlay/frame-path";
import { PLACE_WAIT_MS, parsePlacement, placePoint, pointInView } from "./overlay/frame-place";
import { acceptReported } from "./overlay/frame-records";
import { dropHost, hostInPlace, type MountedHost, mountHost, publishHider } from "./overlay/host";
import { createInteractionModal, type ModalRef } from "./overlay/interaction-modal";
import { chromeShownStore, createKeptLayer } from "./overlay/kept-layer";
import { recoverKept } from "./overlay/kept-recovery";
import { KINDS } from "./overlay/kinds";
import { createLauncherOrb, createPrefsPosStore } from "./overlay/launcher";
import { ownsEditHere } from "./overlay/ownership";
import { pageKey, samePage } from "./overlay/page-url";
import type { PersonView } from "./overlay/people";
import { createPinLayer } from "./overlay/pins";
import { createRemountGate } from "./overlay/remount-gate";
import { mayFulfilFreshLook } from "./overlay/resnap-model";
import { sanitizeElement } from "./overlay/sanitize";
import { SHADOW_MODE } from "./overlay/shadow-mode";
import { createChordDispatcher } from "./overlay/shortcuts";
import { noteInteractionSpace, spaceOfInteraction, spaceOfSet } from "./overlay/space-of";
import { closeAnySpaceMenu } from "./overlay/space-picker";
import { createThreadPanel } from "./overlay/thread";
import {
  closeAnyOpenTokenMenu,
  type ElementPickRequest,
  setElementPickHandler,
} from "./overlay/token-input";
import { isTrustedEvent } from "./overlay/trusted";
import { installTypingIsolation, onWindowRouted } from "./overlay/typing-router";
import { accountGeneration, noteAccountGeneration } from "./overlay/upload-origin";
import { uuid4 } from "./overlay/uuid";
import { outcomeOf, reportVariantOutcome } from "./overlay/variant-outcome";
import {
  createVariantController,
  type RemoteAct,
  VARIANT_COPY,
  type VariantStateMessage,
} from "./overlay/variants";
import { forgetPictures } from "./picture-face";
import {
  COMMAND_IDS,
  type CommandId,
  getPrefs,
  KEYBOARD_DEFAULTS,
  onPrefsChanged,
  type Prefs,
  patchPrefs,
  THEME_DEFAULT,
  type Theme,
} from "./prefs";

declare global {
  interface Window {
    __onlayMounted?: boolean;
  }
}

(() => {
  if (window.__onlayMounted) return;
  window.__onlayMounted = true;

  // Typing isolation (typing-router.ts): registered now, at document_start,
  // before any page script, so nothing typed into the overlay reaches the page.
  let mounted: MountedHost | null = null;
  /** Takes the private UI off a host the page moved and mounts it on a fresh one. */
  let remount: () => void = () => {};
  installTypingIsolation(window, () => mounted, {
    inPlace: hostInPlace,
    misplaced: () => remount(),
  });
  // The same for a card moved by its header (drag-router.ts): the page never
  // sees the drag's pointer events.
  installDragIsolation(window, () => mounted);
  // A child frame's locate nonce for a look of its block (F-6): heard here
  // before any page script, and measured by this script only.
  listenForLocates(window, {
    send: (msg) => {
      try {
        void chrome.runtime.sendMessage(msg).catch(() => {});
      } catch {
        /* stale context: the locate times out */
      }
    },
  });

  // Unsent drafts kept across reloads come back before a composer can open (D-1).
  const draftsRestored = restoreDrafts();

  // The overlay itself mounts once the document is parsed.
  const start = (): void => {
    // Wire the real capture pipeline (harvest/witness/upload) onto captureFull so a
    // locally-picked Edit-request produces a committed edit-context capture end to
    // end (rung 1). Idempotent + fail-soft; captureFull only fires from the top
    // frame (overlay/variants.ts).
    installCapturePipeline();

    let isTopFrame = true;
    try {
      isTopFrame = window.top === window;
    } catch {
      isTopFrame = false;
    }
    // A child frame owns blocks (picks, creates, its snapshots) only when it is
    // a web page with an origin of its own (2-F4): never about:blank, srcdoc,
    // blob:, data: or an opaque-origin (sandboxed) document, whose address
    // other unrelated documents share.
    const ownsBlocks = isTopFrame || isWebDocument(window);
    // A frame without an address of its own whose owner page can reach it
    // (A-3): that page's content script picks, pins and resolves its blocks
    // through `contentDocument`, and this one stays passive. Any other frame
    // that owns no blocks (sandboxed, `data:`, another origin's) is where a
    // pick says it can't anchor. This only chooses the hint: the owner decides
    // for itself what is part of it.
    const sandboxed = !ownsBlocks && !isTopFrame && !reachableByOwner(window);

    // ── Shadow-DOM host (host.ts): closed, created and owned by this script ──
    // Closed (shadow-mode.ts): the page cannot reach in; this script keeps the
    // only reference. Nothing private goes on `host` or anywhere in the light DOM.
    let { host, root: shadow } = mountHost(document, SHADOW_MODE);
    mounted = { host, root: shadow, doc: document };
    // A capture in a same-origin parent hides this frame's overlay through this handle.
    publishHider(window);
    const sheet = installSheet(shadow);
    let currentTheme: Theme = THEME_DEFAULT;
    stampTheme(host, currentTheme);

    const hoverBox = el("div", "box");
    const selBox = el("div", "box sel");
    const toastEl = el("div", "toast");
    const toast = makeToast(toastEl);

    const app = createApp({ shadow, host, isTopFrame, toast, ownsBlocks }) as ReturnType<
      typeof createApp
    > &
      AppInternals;

    // The host stays where it was mounted (a direct light-DOM child of the
    // root element of this document). The moment the page moves it anywhere
    // else (3b-C2): focus inside the overlay is blurred, every open private
    // surface closes where it is (drafts stay in the draft store, as on any
    // close), and only then does the overlay go onto a fresh host this script
    // owns, with nothing open. Remounts run outside the observer callback and
    // are bounded: past 3 in 10 seconds the overlay stays down for this page
    // load, launcher and all, so a page that wraps every new top-level element
    // cannot make it loop.
    const remountNow = (): void => {
      const old = mounted;
      if (!old || hostInPlace(old)) return;
      (old.root.activeElement as HTMLElement | null)?.blur?.();
      // A drag in progress ends here: the launcher moves across, and its lost
      // capture may go to the document, where no handle hears it.
      cancelDrags();
      closePrivateSurfaces();
      if (!gate.allow()) {
        old.host.remove();
        mounted = null;
        dropHost();
        return;
      }
      // The launcher, pins and boxes move across; the private surfaces are
      // made afresh in their places, never carried (C-2).
      const swap = rebuildPrivateSurfaces();
      const ui = document.createDocumentFragment();
      for (const node of [...old.root.childNodes]) {
        const replacement = swap.get(node);
        if (replacement) old.root.removeChild(node);
        ui.appendChild(replacement ?? node);
      }
      old.host.remove();
      const fresh = mountHost(document, SHADOW_MODE);
      fresh.root.adoptedStyleSheets = [...old.root.adoptedStyleSheets];
      fresh.root.appendChild(ui);
      host = fresh.host;
      shadow = fresh.root;
      mounted = fresh;
      app._setRoot(shadow, host);
      stampTheme(host, currentTheme);
    };
    const gate = createRemountGate({ run: remountNow });
    remount = () => {
      if (mounted && !hostInPlace(mounted)) gate.schedule();
    };
    new MutationObserver(() => remount()).observe(document.documentElement, { childList: true });

    // ── modules ──
    /** The pages of kept Edits read by id because the frame left them out (R2-C11). */
    const keptUrls = new Map<string, string>();
    /** `<person>|<server origin>` while signed in: what kept choices and bookmarks belong to. */
    let scope: string | null = null;
    // The kept layer (spec §8): every preview on this page — kept Edits, the
    // variant sets being cycled, the witness pass — stacks through it.
    const layer = createKeptLayer({
      // Every program it applies is bound to the page key it went on (3-E2).
      createEngine: () => createPreviewEngine(document, { pageKey: () => pageKey(location.href) }),
      selfId: () => app.selfId(),
      scope: () => scope,
      pageUrl: () => location.href,
      urlOf: (id) => app.byId(id)?.url ?? keptUrls.get(id),
      stateOf: (id) => app.byId(id)?.state,
      store: chromeShownStore(),
      onChange: () => app.requestRender(),
      onDisplaced: (setId) => variants.displaced(setId),
    });
    const variants = createVariantController(app, {
      layer,
      // A set made in a child frame opens its Edit in the top frame (E-1).
      openChangeJob: (id, spaceId) => {
        if (isTopFrame) openInteraction(id);
        else {
          const sp = app.byId(id)?.spaceId ?? spaceId ?? spaceOfInteraction(id);
          if (sp) tellSw({ type: "frameOpen", interactionId: id, spaceId: sp });
        }
      },
      scope: () => scope,
      // A child frame's sets are mirrored by the top frame's panel (E-1).
      onChange: () => {
        if (!isTopFrame) scheduleFrameReport();
      },
      ...(isTopFrame
        ? {
            remote: {
              act: (documentId: string, setId: string, act: RemoteAct) =>
                frameCall(documentId, { op: "variant", setId, act }).then((r) => r.ok === true),
              reply: (documentId: string, frame: Record<string, unknown>) =>
                frameCall(documentId, { op: "send", frame }).then((r) => ({ ok: r.ok === true })),
            },
          }
        : {}),
    });
    // The capture queue owns the page while it runs: every job starts with the
    // whole layer off (an ordinary capture records the Original; a variant look
    // records only its variant), and the drain puts everything back.
    registerPreviewGuard({
      forceOriginal: () => layer.suspend(),
      suspend: () => layer.suspend(),
      settle: () => {
        layer.resume();
        variants.settle();
      },
    });
    function openInteraction(id: string): void {
      // A thread bound to a child frame opens the way its pin opens it (F-4).
      const owner = isTopFrame && !app.byId(id) ? frameOwner(id) : null;
      const spaceId = owner?.snap?.spaceId ?? spaceOfInteraction(id);
      if (owner && spaceId) {
        openFrameThread(owner.documentId, id, spaceId, owner.url);
        return;
      }
      thread.open(id);
    }

    // F30 — the automatic variant-witness pass's environment. The scheduler owns
    // its own set fetches (a broadcast frame may be truncated and carries no
    // selector); eligibility + grant live in ONE SW probe; a hidden tab parks the
    // pass and this visibilitychange listener resumes the tail.
    function variantPassDeps(): PassDeps {
      return {
        engine: layer.passEngine,
        ownsEdit: (id) => ownsEditHere(app, id),
        selfId: () => app.selfId(),
        account: () => app.account(),
        // A child frame with an address of its own takes its variants' looks (E-4).
        ownsBlocks,
        // The human's stops live in the layer; resuming it after the pass puts them back.
        restoreDisplay: () => {},
        pageUrl: () => location.href,
        log: (line) => console.debug(`[onlay] ${line}`),
        eligible: async () => {
          try {
            const r = (await chrome.runtime.sendMessage({ type: "passEligible" })) as
              | { ok: boolean; eligible?: boolean }
              | undefined;
            return r?.eligible === true;
          } catch {
            return false;
          }
        },
        // The block a set was picked on here, pinned at the pick (3-E1).
        pinOf: (setId) => variants.pinOf(setId),
        reportOutcome: (set, variant, result, steps) => {
          reportVariantOutcome(
            {
              selfId: () => app.selfId(),
              account: () => app.account(),
              ownsEdit: (id) => ownsEditHere(app, id),
              frameUrl: () => app.frameUrl(),
              send: (frame) => app.send(frame),
            },
            {
              setId: set.setId,
              spaceId: spaceOfSet(set.setId),
              changeInteractionId: set.changeInteractionId,
              variant,
            },
            outcomeOf(result, steps),
          );
        },
        fetchSet: async (setId) => {
          try {
            const spaceId = spaceOfSet(setId);
            const r = (await chrome.runtime.sendMessage({
              type: "getVariantSet",
              id: setId,
              ...(spaceId ? { spaceId } : {}),
            })) as
              | {
                  ok: boolean;
                  spaceId?: string;
                  set?: {
                    setId: string;
                    status: string;
                    changeInteractionId?: string;
                    expectUrlPrefix?: string;
                    element?: { selector?: string };
                    root?: { kind?: string };
                    variants?: Array<{ variantId: string; program: unknown; version?: number }>;
                  };
                }
              | undefined;
            const set = r?.ok ? r.set : undefined;
            if (!set?.changeInteractionId) return null;
            if (r?.spaceId) app.noteSet(set.setId, r.spaceId);
            return {
              setId: set.setId,
              changeInteractionId: set.changeInteractionId,
              status: set.status,
              ...(set.expectUrlPrefix !== undefined
                ? { expectUrlPrefix: set.expectUrlPrefix }
                : {}),
              ...(set.element?.selector !== undefined ? { selector: set.element.selector } : {}),
              ...(set.root?.kind === "page" ? { page: true } : {}),
              variants: (set.variants ?? []) as PassSetInfo["variants"],
            };
          } catch {
            return null;
          }
        },
      };
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resumeVariantPasses(variantPassDeps());
    });
    // The private surfaces (thread panel, composer window, modal, command bar)
    // are made from these deps: a remount makes fresh ones in the new host
    // rather than carrying the old nodes across (C-2).
    const threadDeps: Parameters<typeof createThreadPanel>[1] = {
      onOpened: (id) => {
        const spaceId = app.byId(id)?.spaceId ?? spaceOfInteraction(id);
        // Gone for this person (R3-C8): the panel closes with a note.
        if (spaceId) readById(spaceId, id, () => closeThreadIfGone(id));
      },
      renderVariantSet: (setId, mount) => variants.openSet(setId, mount),
      onReanchor: (id) => startReanchor(id),
      onFreshLook: (id) => startFreshLook(id),
      keptStatus: (id) =>
        layer.rows().some((r) => r.interactionId === id)
          ? { unresolved: layer.isUnresolved(id) }
          : null,
      // #anchor chips in message bodies reveal their spot: an interaction token
      // flashes its pin; a bare anchor token gets the selection ring treatment.
      onAnchorClick: (token) => {
        if (token.interactionId && app.byId(token.interactionId)) {
          pins.flash(token.interactionId);
          return;
        }
        const target = resolveAnchor(token.anchor);
        if (!target) {
          toast("anchor not on this page");
          return;
        }
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        placeBox(selBox, target);
        setTimeout(() => {
          selBox.style.display = "none";
        }, 1600);
      },
    };
    let thread = createThreadPanel(app, threadDeps);
    // One activation route per KIND, wherever it's clicked from: edits open
    // the sidecar beside the page they change (request + variants, one card);
    // asks/comments read in the centered modal.
    const pins = createPinLayer(app, (id) => {
      const s = app.byId(id);
      if (!s) return;
      // A pin in a child frame opens its thread in the top frame (F-4).
      if (!isTopFrame) {
        tellSw({ type: "frameOpen", interactionId: s.id, spaceId: s.spaceId });
        return;
      }
      if (s.kind === "change") thread.open(id);
      else modal.open({ interactionId: id, spaceId: s.spaceId, local: true });
    });
    const batch = createBatchTray(app, {
      layer,
      describe: () => {
        setMode("off");
        app.setCapture(null);
        // The tray's edits are all in one child frame's page: the Edit
        // described is for that page, bound to its address (E-3).
        const docs = [...frameOps].filter(([, f]) => f.ops.length > 0).map(([d]) => d);
        const only = batch.localOpCount() === 0 && docs.length === 1 ? docs[0] : undefined;
        if (only) pageComposerInFrame(only);
        else composerWin.open("change", { level: "page" }, null);
      },
      // The page and account the tray's first edit here was made under (2-F3).
      binding: () => ({ page: pageKey(location.href), generation: accountGeneration() }),
      onChange: () => {
        if (!isTopFrame) scheduleFrameReport();
      },
      // The edits made in each child frame's document (E-3).
      ...(isTopFrame
        ? {
            remote: {
              settle: () => settleFrameOps(),
              lists: () =>
                [...frameOps].map(([documentId, f]) => ({ documentId, host: f.host, ops: f.ops })),
              remove: (documentId: string, index: number) =>
                void trayCall(documentId, { op: "batchRemove", index }),
              send: (documentId: string, spaceId: string) =>
                trayCall(documentId, { op: "batchSend", spaceId }).then((r) =>
                  r.ok === true
                    ? { ok: true as const }
                    : {
                        ok: false as const,
                        error: typeof r.error === "string" ? r.error : "no-frame",
                        note: typeof r.note === "string" ? r.note : VARIANT_COPY.frameGone,
                      },
                ),
              dismiss: (documentId: string) => {
                frameOps.delete(documentId);
                void trayCall(documentId, { op: "batchDismiss" });
              },
            },
          }
        : {}),
    });
    const composerDeps: Parameters<typeof createComposerWindow>[1] = {
      startVariants: (target, command, count, intent, spaceId) =>
        variants.startFromChange(target, command, count, intent, spaceId),
      // Sent or abandoned, the composer takes its anchor outline with it, in
      // the frame that holds the block too.
      onClosed: () => {
        clearSelection();
        const r = remotePick;
        remotePick = null;
        if (r) void frameCall(r.documentId, { op: "clearPick", pickId: r.pickId });
      },
      // The composer follows its block as the page scrolls, inside frames too.
      blockRect: (target) => rectInOwner(target),
    };
    let composerWin = createComposerWindow(app, composerDeps);

    // ── live keyboard map (prefs truth, hot via onPrefsChanged) ──
    let keyboard: Record<CommandId, string> = { ...KEYBOARD_DEFAULTS };

    // ── connection truth for the orb (status frames + the signed-in account) ──
    let connected = false;
    let signedIn = false;
    let upgradeRequired = false;

    // ── the command bar ──
    /** The Inbox merged across spaces (`/api/inbox` through the SW; fail-soft null). */
    function fetchAttention(): Promise<AttentionLists | null> {
      try {
        return chrome.runtime.sendMessage({ type: "getInbox" }).then(
          (res: { ok?: boolean; attention?: AttentionLists | null } | undefined) => {
            const a = res?.ok ? res.attention : null;
            if (!a) return null;
            const lists = {
              needsYou: a.needsYou ?? [],
              waiting: a.waiting ?? [],
              recent: a.recent ?? [],
            };
            for (const r of [...lists.needsYou, ...lists.waiting, ...lists.recent])
              noteInteractionSpace(r.interactionId, r.spaceId);
            // The thread's header and the pins say what this Inbox says.
            app._setAttention(lists, app.selfId());
            app.requestRender();
            return lists;
          },
          () => null,
        );
      } catch {
        return Promise.resolve(null); // stale context (F-053)
      }
    }

    /**
     * The service worker's last Inbox read, which threads need the person and
     * which wait (no server call): every thread header, pin and the orb's
     * count follow it, as the Inbox does. Read at sign-in and after each
     * Inbox refresh (`attention-updated`); until it lands, waitingOn stands in.
     */
    function pullAttention(): void {
      if (!signedIn || !ownsBlocks) return;
      try {
        void chrome.runtime.sendMessage({ type: "getAttention" }).then(
          (
            res:
              | {
                  personId?: string | null;
                  attention?: Parameters<typeof app._setAttention>[0];
                }
              | undefined,
          ) => {
            if (!res?.attention) return;
            app._setAttention(res.attention, res.personId ?? null);
            app.requestRender();
          },
          () => {},
        );
      } catch {
        /* stale context (F-053) */
      }
    }

    /** An explicit open: the by-id read the server counts as this person opening it. */
    function readById(spaceId: string, id: string, onGone?: () => void): void {
      try {
        void chrome.runtime.sendMessage({ type: "getInteraction", spaceId, id }).then(
          (res: { notFound?: boolean } | undefined) => {
            if (res?.notFound === true) onGone?.();
          },
          () => {},
        );
      } catch {
        /* stale context */
      }
    }

    /** Participant-scoped by-id fetch through the SW (page-less rows), tagged with its space. */
    function fetchInteraction(
      spaceId: string,
      id: string,
    ): Promise<Snapshot | "not_found" | undefined> {
      try {
        return chrome.runtime.sendMessage({ type: "getInteraction", spaceId, id }).then(
          (res: { ok?: boolean; interaction?: unknown; notFound?: boolean } | undefined) =>
            res?.ok && res.interaction
              ? ({ ...(res.interaction as object), spaceId } as Snapshot)
              : res?.notFound === true
                ? "not_found"
                : undefined,
          () => undefined,
        );
      } catch {
        return Promise.resolve(undefined);
      }
    }

    /**
     * Routed transport (UX-3): this page + unanchored ride the WS (the
     * involvement-scoped unanchored exception admits them); rows bound to
     * OTHER urls act through the SW's participant-scoped HTTP proxy.
     */
    function sendRouted(ref: ModalRef, frame: Record<string, unknown>): Promise<{ ok: boolean }> {
      // A thread bound to a child frame's address is sent by that frame (F-2),
      // the one it was opened from (2-E4).
      const ownerDoc = ref.frameDocumentId ?? frameOwner(ref.interactionId)?.documentId;
      if (ownerDoc) {
        return frameCall(ownerDoc, {
          op: "send",
          frame: { ...frame, spaceId: ref.spaceId },
        }).then((r) => ({ ok: r.ok === true }));
      }
      const offPage = ref.url !== undefined && !ref.local;
      if (!offPage) return app.send({ ...frame, spaceId: ref.spaceId } as never);
      const type = String(frame.type ?? "");
      const op =
        type === "interaction-reply"
          ? "reply"
          : type === "interaction-edit"
            ? "edit"
            : type === "interaction-delete"
              ? "delete"
              : type === "interaction-react"
                ? "react"
                : type === "ask-answer"
                  ? "answer"
                  : type === "interaction-resolve"
                    ? "resolve"
                    : type === "interaction-reopen"
                      ? "reopen"
                      : null;
      if (!op) return Promise.resolve({ ok: false });
      const body =
        op === "reply"
          ? {
              body: frame.body,
              ...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
              ...(frame.clientId ? { clientId: frame.clientId } : {}),
            }
          : op === "edit"
            ? { msgId: frame.msgId, body: frame.body }
            : op === "delete"
              ? { msgId: frame.msgId }
              : op === "react"
                ? { msgId: frame.msgId, emoji: frame.emoji, on: frame.on }
                : op === "answer"
                  ? {
                      optionIds: frame.optionIds,
                      ...(frame.comment ? { comment: frame.comment } : {}),
                    }
                  : {};
      try {
        return chrome.runtime
          .sendMessage({
            type: "interactionCall",
            spaceId: ref.spaceId,
            id: ref.interactionId,
            op,
            body,
          })
          .then(
            (res: { ok?: boolean } | undefined) => ({ ok: res?.ok === true }),
            () => ({ ok: false }),
          );
      } catch {
        return Promise.resolve({ ok: false });
      }
    }

    function openFullView(id: string): void {
      const spaceId = app.byId(id)?.spaceId ?? spaceOfInteraction(id);
      if (!spaceId) return;
      try {
        chrome.runtime.sendMessage({ type: "openFullView", spaceId, id }).catch(() => {});
      } catch {
        toast("full view unavailable — stale extension context");
      }
    }

    const modalDeps: Parameters<typeof createInteractionModal>[1] = {
      // An off-page row's load is already the by-id read; a local one is not.
      onOpened: (ref) => {
        if (app.byId(ref.interactionId) || frameOwner(ref.interactionId))
          readById(ref.spaceId, ref.interactionId, () => {
            if (!modal.isOpen() || modal.currentId() !== ref.interactionId) return;
            modal.close();
            toast(HOSTED_COPY.threadGone);
          });
      },
      load: (ref) => {
        const local = app.byId(ref.interactionId) ?? frameOwner(ref.interactionId)?.snap;
        if (local) return Promise.resolve(local);
        return fetchInteraction(ref.spaceId, ref.interactionId).then((s) => s ?? null);
      },
      send: sendRouted,
      onAnchor: (ref) => startAnchorPlace(ref),
      // The frame the thread was opened from answers its re-anchor (3-A2).
      onReanchor: (ref) => startReanchor(ref.interactionId, ref.frameDocumentId),
      reanchorable: (id) => onThisPage(id) || onFramePage(id),
      onFullView: openFullView,
      navigate: (url) => {
        window.open(url, "_blank", "noopener");
      },
      // An Edit bound to a child frame: its set's panel drives that frame (E-1).
      // The panel drives the frame the thread was opened from, and no other (2-E4).
      renderVariantSet: (setId, mount, id, ref) => {
        const doc = ref.frameDocumentId ?? frameOwner(id)?.documentId;
        if (doc) variants.openRemoteSet(setId, mount, doc, id);
      },
    };
    let modal = createInteractionModal(app, modalDeps);

    const commandBarDeps: Parameters<typeof createCommandBar>[1] = {
      commands: COMMANDS,
      binding: (id) => keyboard[id],
      run: (id) => runCommand(id),
      fetchAttention,
      onOpened: () => pullStatus(false),
      connected: () => connected,
      offlineNote: () =>
        upgradeRequired
          ? HOSTED_COPY.upgradeBody
          : signedIn
            ? HOSTED_COPY.offlineSignedIn
            : HOSTED_COPY.offlineSignedOut,
      openInteraction,
      frameInteractions,
      navigate: (url) => {
        location.href = url;
      },
      openModal: (row: QueueRow) => {
        const owner = frameOwner(row.interactionId);
        if (owner) {
          openFrameThread(owner.documentId, row.interactionId, row.spaceId);
          return;
        }
        // Same kind law as pins: a local edit opens its sidecar on the page.
        if (row.kind === "change" && row.local) thread.open(row.interactionId);
        else modal.open(row);
      },
      openFullView,
      anchorRow: (row: QueueRow) => {
        if (row.anchorLost && row.local) startReanchor(row.interactionId);
        else startAnchorPlace(row);
      },
      onFreshLook: (id) => startFreshLook(id),
      // Every frame's kept edits, counted and switched here (E-2).
      // A frame's row carries its document: its switch acts there only (2-E4).
      keptRows: () => [
        ...layer.rows(),
        ...[...frameKept].flatMap(([documentId, k]) => k.rows.map((r) => ({ ...r, documentId }))),
      ],
      openInFrame: (id, documentId) => {
        const spaceId = spaceOfInteraction(id);
        if (spaceId) openFrameThread(documentId, id, spaceId);
      },
      setKeptOn: (id, on, documentId) => {
        // A row of a frame acts in that frame or nowhere, never here (3-E5).
        const target = keptSwitchTarget(documentId, frameKept);
        if (!target) {
          app.requestRender();
          return;
        }
        if ("here" in target) {
          layer.setOn(id, on);
          return;
        }
        const doc = target.documentId;
        const k = frameKept.get(doc);
        if (!k) return;
        // Shown at once as switched; the frame's next report says what it applied.
        frameKept.set(doc, {
          rows: k.rows.map((r) => (r.interactionId === id ? { ...r, on } : r)),
          shown: on ? k.shown : Math.max(0, k.shown - 1),
        });
        app.requestRender();
        void frameCall(doc, { op: "keptOn", interactionId: id, on });
      },
    };
    let commandBar = createCommandBar(app, commandBarDeps);

    /**
     * Make every private surface afresh (C-2) and say which new node takes the
     * place of which old one. The old ones were closed first; nothing of them
     * (text, scroll, focus) reaches the new host. What was being written comes
     * back from the draft store when the surface is next opened.
     */
    function rebuildPrivateSurfaces(): Map<Node, Node> {
      const old = [thread.element, composerWin.element, modal.element, commandBar.element];
      thread = createThreadPanel(app, threadDeps);
      composerWin = createComposerWindow(app, composerDeps);
      modal = createInteractionModal(app, modalDeps);
      commandBar = createCommandBar(app, commandBarDeps);
      modalAside = false;
      const fresh = [thread.element, composerWin.element, modal.element, commandBar.element];
      return new Map(old.map((node, i): [Node, Node] => [node, fresh[i] as Node]));
    }
    // Copy times load once; a repaint then shows "changed since copied".
    copiedStore(() => app.requestRender());

    // ── announcements: a NEW needs-you id introduces itself exactly once ──
    const announceCard = el("div", "announce-card");
    let announceRef: ModalRef | null = null;
    let announceTimer: ReturnType<typeof setTimeout> | null = null;
    announceCard.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      announceCard.style.display = "none";
      if (announceRef) modal.open(announceRef);
    });

    function showAnnounce(
      rows: Array<{
        interactionId: string;
        spaceId: string;
        kind: string;
        text: string;
        fromActorId: string;
        url?: string;
        unanchored?: boolean;
        anchorLost?: boolean;
      }>,
    ): void {
      const first = rows[0];
      if (!first) return;
      while (announceCard.firstChild) announceCard.removeChild(announceCard.firstChild);
      const actor = app.person(first.fromActorId);
      announceCard.appendChild(avatar(actor, "md"));
      const main = el("div", "announce-main");
      const kindSpec = KINDS[first.kind as keyof typeof KINDS];
      const label = kindSpec ? kindSpec.label : "Interaction";
      main.appendChild(el("div", "announce-title", `${actor.name} · ${label} needs you`));
      const meta = el("div", "announce-meta");
      if (kindSpec) {
        const chip = el("span", `chip chip-kind ${kindSpec.cls}`, kindSpec.label);
        meta.appendChild(chip);
      }
      meta.appendChild(el("span", "q-context", first.text.slice(0, 60)));
      if (rows.length > 1)
        meta.appendChild(el("span", "announce-more", `+${rows.length - 1} more in Inbox`));
      main.appendChild(meta);
      announceCard.appendChild(main);
      announceRef = {
        interactionId: first.interactionId,
        spaceId: first.spaceId,
        ...(first.url !== undefined ? { url: first.url } : {}),
        ...(first.unanchored ? { unanchored: true } : {}),
        ...(first.anchorLost ? { anchorLost: true } : {}),
      };
      announceCard.style.display = "flex";
      orb.ping();
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        announceCard.style.display = "none";
      }, 6000);
    }

    /**
     * Fires on attention snapshot changes: ids newly ENTERING the needs-you set
     * announce once (a seen-set in session storage dedups across churn and
     * tabs); reorders and refreshes never re-announce (UX-6).
     */
    async function diffAnnounce(): Promise<void> {
      if (!isTopFrame || document.visibilityState !== "visible") return;
      try {
        const got = (await chrome.storage.session.get(["attention", "announcedNeeds"])) as {
          attention?: {
            needsYou?: Array<{
              interactionId: string;
              spaceId: string;
              kind: string;
              text: string;
              fromActorId: string;
              url?: string;
              unanchored?: boolean;
              anchorLost?: boolean;
            }>;
          };
          announcedNeeds?: string[];
        };
        const needs = got.attention?.needsYou ?? [];
        const seen = new Set(got.announcedNeeds ?? []);
        const fresh = needs.filter((r) => !seen.has(r.interactionId));
        const nextSeen = needs.map((r) => r.interactionId);
        // the seen-set follows the CURRENT needs set (ids that leave and return
        // legitimately re-announce — they need you again)
        await chrome.storage.session.set({ announcedNeeds: nextSeen });
        if (
          fresh.length > 0 &&
          seen.size + nextSeen.length > 0 &&
          got.announcedNeeds !== undefined
        ) {
          showAnnounce(fresh);
        }
      } catch {
        /* stale context / no storage — announcements just stay quiet */
      }
    }

    // ── the launcher orb ──
    // Click TOGGLES the bar (the orb stacks above the backdrop, so a second
    // click closes instead of dying on the dim layer — and double-click reset
    // still reaches the orb).
    const orb = createLauncherOrb({
      onOpen: () => {
        if (commandBar.isOpen()) commandBar.close();
        else commandBar.open("inbox");
      },
      store: createPrefsPosStore(),
      onKeptNote: () => commandBar.open("kept"),
      onAgentNote: () => void copyRound(app, framePages()),
    });

    shadow.append(hoverBox, selBox, toastEl);
    if (isTopFrame) {
      shadow.append(
        thread.element,
        composerWin.element,
        pins.layer,
        pins.ring,
        variants.previewLabel,
        batch.element,
        commandBar.element,
        modal.element,
        announceCard,
        orb.element, // after the bar: the orb rides above the backdrop
      );
      void orb.restore();
      window.addEventListener("resize", () => orb.reclamp(), { passive: true });
    } else {
      // sub-frames still show pins/rings for their own elements
      shadow.append(pins.layer, pins.ring);
    }

    // ── render dispatch ──
    // A state frame tears these subtrees down and rebuilds them. Wrap the whole
    // pass so an in-progress composer (thread reply, inline edit, ask comment,
    // ask comment) keeps focus + caret across the rebuild; its text rides the
    // draft store keyed by interaction id.
    app.onRender(() => {
      preserveFocus(shadow, () => {
        pins.render();
        thread.render();
        commandBar.refresh();
        modal.refresh();
        renderBadge();
      });
    });

    // The SW's fresh attention sync lands in session storage after the bar
    // opened on the cached snapshot — relay it so an open queue never lies.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "session" && changes.attention) {
          commandBar.refreshAttention();
          void diffAnnounce();
        }
      });
    } catch {
      // stale extension context (F-053) — the refresh hint handles it
    }

    function isLive(state: string): boolean {
      return ["open", "answered", "kept", "working", "implemented", "verifying"].includes(state);
    }

    /** Needs-you count on the orb (runs on every render), by the Inbox's rule. */
    function renderBadge(): void {
      if (!isTopFrame) return;
      const n = app.selfId()
        ? [...app.interactions(), ...frameInteractions()].filter(
            (s) => isLive(s.state) && app.needsYou(s),
          ).length
        : 0;
      orb.setBadge(n);
      orb.setKeptShown(
        layer.shownCount() + [...frameKept.values()].reduce((n, k) => n + k.shown, 0),
      );
      orb.setAgentPending(pendingForAgent([...app.interactions(), ...frameInteractions()]).length);
    }

    // ── modes ──
    type Mode = "off" | "pick" | "batch" | "reanchor" | "anchorpick" | "tokenpick";
    let mode: Mode = "off";
    /** What the armed block pick feeds (comment/edit composer, or copy). */
    let pickKind: PickKind | null = null;
    let hoverEl: Element | null = null;
    let selectedEl: Element | null = null;
    // The interaction awaiting a fresh block pick (anchor-loss recovery).
    let reanchorTarget: string | null = null;
    // The child frame answering that pick, when the interaction is bound to its address (A-1).
    let remoteReanchor: { documentId: string; pickId: string } | null = null;
    // The unanchored Ask awaiting placement (the human-facing Anchor action).
    let anchorTarget: string | null = null;
    // The token editor awaiting a fresh block pick (`#` → "pick on page…").
    let tokenPick: ElementPickRequest | null = null;

    /** Enter block-pick mode to Anchor a live unanchored Ask here (ADR-0020). */
    function startAnchorPlace(ref: ModalRef): void {
      anchorTarget = ref.interactionId;
      commandBar.close();
      setMode("anchorpick");
      toast("Anchor — pick a block, or press P for the whole page (Esc cancels)");
    }

    /**
     * Bound to exactly the page of the child frame that holds it (3-A1): a
     * thread a frame took in by URL prefix is not that frame's to re-anchor.
     */
    function onFramePage(id: string): boolean {
      const o = frameOwner(id);
      return o !== null && (o.snap === undefined || samePage(o.snap.url, o.page));
    }

    /** Bound to exactly this page (3-A1): not a page this URL merely extends. */
    function onThisPage(id: string): boolean {
      const s = app.byId(id);
      return s !== undefined && samePage(s.url, location.href);
    }

    /**
     * Enter block-pick mode to re-anchor a demoted interaction (ADR-0017).
     * `documentId`: the child document the thread was opened from, which
     * alone answers the pick (3-A2).
     */
    function startReanchor(interactionId: string, documentId?: string): void {
      thread.close();
      // Bound to a child frame's address (A-1): only that frame's document
      // answers the pick, and the re-anchor is sent from there.
      const found = isTopFrame && documentId === undefined ? frameOwner(interactionId) : null;
      const owner = isTopFrame && documentId !== undefined ? { documentId } : found;
      // A thread of this page is placed again only on exactly its page (3-A1).
      if (!owner && !onThisPage(interactionId)) return;
      setMode("reanchor");
      reanchorTarget = interactionId;
      remoteReanchor = null;
      adoptFrames();
      toast(REANCHOR_HINT);
      if (!owner) return;
      const pickId = uuid4().slice(0, 32);
      remoteReanchor = { documentId: owner.documentId, pickId };
      // Ended from here (Escape, another mode) through the pick's end, like any pick.
      topPickId = pickId;
      void frameCall(owner.documentId, { op: "reanchor", interactionId, pickId }).then((r) => {
        if (r.ok === true || remoteReanchor?.pickId !== pickId) return;
        setMode("off");
        toast(REANCHOR_FRAME_GONE);
      });
    }

    // One-action fresh-look fulfillment (Stage 2 §3): resolve the anchored element
    // and capture a fresh look. The commit clears the duty server-side (§2.5) and
    // the chip vanishes on the next interactions-state frame. A lost anchor is NOT
    // silently captured at the wrong place — surface the honest Re-anchor path
    // (re-anchoring itself fires a snapshot, hook 2, which fulfills). S2-D14.
    function startFreshLook(interactionId: string): void {
      const s = app.byId(interactionId);
      // Only the requester or the author takes a fresh look of this page.
      if (!s || !mayFulfilFreshLook(s, app.selfId())) return;
      // A fresh look is of the interaction's own page, never another (R3-C4).
      if (!samePage(s.url, app.frameUrl())) {
        toast("This thread is on another page. Open that page to capture a fresh look.");
        return;
      }
      const target = resolveAnchor(s.anchor);
      if (!target) {
        toast("that block isn't on the page anymore — re-anchor it to capture a fresh look");
        startReanchor(interactionId);
        return;
      }
      toast("capturing a fresh look…");
      // Bound to this page, this account, and the right to take this look.
      void captureSnapshot(
        target,
        interactionId,
        bindCapture(app, () => {
          const now = app.byId(interactionId);
          return !!now && mayFulfilFreshLook(now, app.selfId()) && target.isConnected;
        }),
      )
        .then((outcome) => {
          // `null` — the capture never reached commit (walk failed / no pipeline);
          // the still-lit "Capture due" chip is the honest signal, so stay quiet.
          if (!outcome) return;
          if (outcome.ok) {
            // Honest even in success: a commit without a witness has no
            // screenshot — say why, and where the switch lives (F6).
            toast(
              outcome.witnessMissing
                ? "fresh look captured — no screenshot (enable Capture fidelity in the Onlay popup)"
                : "fresh look captured",
            );
          } else if (outcome.refusal === "storage-cap") {
            toast("couldn't capture a fresh look — storage cap");
          } else if (outcome.refusal === "stale-extension") {
            toast("Onlay was updated — refresh this page, then try the fresh look again", 8000);
          } else {
            toast("couldn't capture a fresh look");
          }
        })
        .catch(() => {});
    }

    /** Drop the selection outline — cancelled/finished flows restore the page. */
    function clearSelection(): void {
      selectedEl = null;
      selBox.style.display = "none";
    }

    // The modal steps ASIDE (visibility, not close) while a pick needs the
    // page under it — DOM and draft stay intact for the return trip.
    let modalAside = false;
    function stepModalAside(): void {
      if (!modal.isOpen()) return;
      modalAside = true;
      modal.element.style.visibility = "hidden";
    }
    function returnModal(): void {
      if (!modalAside) return;
      modalAside = false;
      // Inherit again, never "visible": an explicit value would show the modal
      // through a host that is hidden for a capture.
      modal.element.style.visibility = "";
    }

    /** Abort a pending token-editor block pick (mode change / Escape). */
    function cancelTokenPick(): void {
      const req = tokenPick;
      tokenPick = null;
      returnModal(); // the editor must be visible before it takes focus back
      req?.onCancel();
    }

    /** The side panel still shows `id`, which is gone for this person: close it with a note. */
    function closeThreadIfGone(id: string): void {
      if (!thread.isOpen() || thread.currentId() !== id) return;
      thread.close();
      toast(HOSTED_COPY.threadGone);
    }

    /** Close every open private surface where it is (3b-C2); drafts stay in the draft store. */
    function closePrivateSurfaces(): void {
      for (const close of [
        () => commandBar.close(),
        () => composerWin.close(),
        () => thread.close(),
        () => modal.close(),
        () => setMode("off"),
      ]) {
        try {
          close();
        } catch {
          /* a surface that fails to close must not keep the rest open */
        }
      }
    }

    function setMode(next: Mode): void {
      mode = next;
      // A block pick runs in every frame of the tab (F-1), and so does Edit
      // page mode (E-3): leaving it here ends it there.
      if (next !== "pick" && next !== "tokenpick" && next !== "batch") {
        if (isTopFrame) endTopPick();
        else if (relayPick) {
          const id = relayPick.pickId;
          relayPick = null;
          tellSw({ type: "framePickEnd", pickId: id });
        }
      }
      if (next === "off") {
        hoverEl = null;
        hoverBox.style.display = "none";
        // Leaving a mode restores the page: no stranded selection outline. The
        // one flow that keeps its highlight (block pick → composer) re-arms it
        // right after, deliberately.
        clearSelection();
      }
      if (next !== "pick") pickKind = null;
      if (next !== "batch") batch.cancelEdit();
      if (next !== "reanchor") {
        reanchorTarget = null;
        remoteReanchor = null;
      }
      if (next !== "anchorpick") anchorTarget = null;
      if (next !== "tokenpick") cancelTokenPick();
    }

    // The `#` trigger's "pick on page…" row (token-input.ts) rides the same
    // mode machinery as command/batch picks: transient block-pick mode, the
    // picked block returns to the editor as an anchor token. A pick born in
    // the modal composer steps the modal aside so the page is reachable.
    setElementPickHandler((req) => {
      cancelTokenPick();
      tokenPick = req;
      stepModalAside();
      setMode("tokenpick");
      startTopPick("token");
      toast("Pick a block — the anchor lands in your text (Esc cancels)");
    });

    // ── the command registry's machinery (ADR-0019 §3) ──
    const ctx: CommandCtx = {
      enterPick(kind) {
        commandBar.close();
        composerWin.close();
        setMode("pick");
        pickKind = kind;
        startTopPick(kind);
        toast(PICK_HINTS[kind]);
      },
      openPageComposer(kind) {
        commandBar.close();
        setMode("off");
        app.setCapture(null);
        composerWin.open(kind === "edit" ? "change" : kind, { level: "page" }, null);
      },
      openInbox() {
        setMode("off");
        commandBar.open("inbox");
      },
      openEditTray() {
        commandBar.close();
        setMode("batch");
        batch.setOpen(true);
        // Every frame of the tab is in Edit page mode with it (E-3).
        startTopPick("batch");
        toast(
          "edit mode — click selects a block (Delete removes), double-click rewrites (Esc leaves)",
        );
      },
      openSettings() {
        commandBar.close();
        try {
          chrome.runtime.sendMessage({ type: "openSettings" }).catch(() => {});
        } catch {
          /* stale context (F-053) */
        }
      },
      toggleCommandBar() {
        commandBar.toggle();
      },
      openKeptEdits() {
        setMode("off");
        commandBar.open("kept");
      },
      copyRound() {
        commandBar.close();
        void copyRound(app, framePages());
      },
      switchSpace() {
        setMode("off");
        if (app.composeSpaces().length < 2) {
          commandBar.close();
          const only = app.composeSpaces()[0];
          toast(only ? `Everything you post goes to ${only.name}.` : HOSTED_COPY.noSpace);
          return;
        }
        commandBar.open("space");
      },
      toggleTheme() {
        commandBar.close();
        // One toggle, not a three-way: flip from the EFFECTIVE look. Returning
        // to System is a Settings act.
        const dark =
          currentTheme === "system"
            ? window.matchMedia("(prefers-color-scheme: dark)").matches
            : currentTheme === "dark";
        void patchPrefs({ theme: dark ? "light" : "dark" }).then(undefined, () => {});
      },
    };

    function runCommand(id: CommandId): void {
      commandById(id).run(ctx);
    }

    function overlayContains(node: EventTarget | null | undefined): boolean {
      return node === host || (node instanceof Node && host.contains(node));
    }

    /**
     * The document an event happened in: this one, or a frame of this page
     * without an address of its own that this script took in (A-3).
     */
    function docOf(e: UIEvent): Document | null {
      const view = e.view as Window | null;
      if (!view || view === window) return document;
      const doc = view.document;
      return adopted.has(doc) ? doc : null;
    }
    /** A node of onlay's own: this overlay, or a passive frame's own host (A-3). */
    function ownNode(node: EventTarget | null | undefined, doc: Document): boolean {
      if (doc === document) return overlayContains(node);
      const n = node as Element | null;
      return n?.nodeType === 1 && n.parentElement === doc.documentElement
        ? n.hasAttribute("data-onlay-root")
        : false;
    }

    /** Listen with `fn`, and keep it: the frames of this page taken in hear it too (A-3). */
    function kept<E extends Event>(
      on: (fn: (e: E) => void) => void,
      fn: (e: E) => void,
    ): (e: E) => void {
      on(fn);
      return fn;
    }

    // hover box in block-picking modes
    function onPickMove(e: MouseEvent): void {
      // A page-made pointer move never chooses what a pick acts on.
      if (mode === "off" || !isTrustedEvent(e)) return;
      // The block of a re-anchor answered in a child frame is picked there (A-1).
      if (remoteReanchor) return;
      const doc = docOf(e);
      if (!doc) return;
      const t = doc.elementFromPoint(e.clientX, e.clientY);
      if (!t || ownNode(t, doc)) return;
      // Over a frame, the frame's own overlay (or, for a frame of this page,
      // this one through its document) shows the block under the pointer.
      if (t.localName === "iframe" || t.localName === "frame") {
        hoverEl = null;
        hoverBox.style.display = "none";
        return;
      }
      hoverEl = t;
      placeBox(hoverBox, hoverEl);
    }
    window.addEventListener("mousemove", onPickMove, { capture: true, passive: true });

    const onPickClick = kept<MouseEvent>(
      (fn) => window.addEventListener("click", fn, { capture: true }),
      (e) => {
        if (mode === "off") return;
        // Only a real user gesture drives a privileged pick (re-anchor, capture
        // upload, composer/tokenpick). Page JS can synthesize clicks — reject any
        // untrusted event in ANY active mode before it reaches those paths.
        if (!e.isTrusted) return;
        const doc = docOf(e);
        if (!doc) return;
        if (e.composedPath().some((n) => ownNode(n, doc))) return;
        // Edit mode and the Anchor of an Ask stay with this document (A-3, A-4).
        if (doc !== document && (mode === "batch" || mode === "anchorpick")) return;
        // The block is the one under THIS trusted click — never a hover the
        // page could have steered with made-up moves.
        const t = doc.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element | null);
        if (!t || ownNode(t, doc)) return;
        // A re-anchor answered by a child frame: a click here picks nothing (A-1).
        if (mode === "reanchor" && remoteReanchor) {
          e.preventDefault();
          e.stopImmediatePropagation();
          toast(REANCHOR_HINT);
          return;
        }
        // The anchor names the frames between this document and the block's.
        const path = framePathTo(t.ownerDocument);
        if (path === null) return;
        const at = (): Anchor => anchorForElement(t, path);
        // Caret clicks inside an active inline text edit pass through untouched.
        if (mode === "batch") {
          const editing = batch.editingTarget();
          if (editing && (t === editing || editing.contains(t))) return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        selectedEl = t;
        placeBox(selBox, selectedEl);
        hoverBox.style.display = "none";

        // A pick the top frame started, completed here: this frame owns the block.
        // In Edit page mode a click selects here, like in the top frame (E-3).
        if (!isTopFrame && relayPick && relayPick.kind !== "batch" && mode !== "reanchor") {
          const rp = relayPick;
          relayPick = null; // completed, not cancelled: the relay ends it everywhere
          setMode("off");
          // Where the click is in this document's viewport, for a block inside a frame too.
          const box = rectInOwner(t);
          const own = t.getBoundingClientRect();
          childPicked(rp, t, path, {
            x: e.clientX + box.left - own.left,
            y: e.clientY + box.top - own.top,
          });
          return;
        }

        if (mode === "anchorpick") {
          const target = anchorTarget;
          if (target) {
            const anchor = anchorForElement(t);
            const capture = sanitizeElement(t);
            const bound = bindCapture(app);
            // The space admits the markup from whoever anchored only once the
            // anchor has landed: upload after its receipt, never before (R3-C7).
            const landed = app.awaitReceipt("anchor", target);
            void app
              .send({ type: "interaction-anchor", interactionId: target, anchor } as never)
              .then((res: { ok: boolean }) => {
                if (!res.ok) {
                  toast("couldn't anchor — is the Ask still live?");
                  return;
                }
                void landed.then((r) => {
                  if (r.ok) app.uploadCapture(target, capture, bound);
                });
                // Record how the place looks now it lives here (Stage 2 §1.1 hook 2).
                void captureSnapshot(
                  t,
                  target,
                  bindCapture(app, () => t.isConnected),
                ).catch(() => {});
                toast("anchored — it lives here now");
              });
          }
          setMode("off");
          return;
        }
        if (mode === "reanchor") {
          // Only on exactly the thread's page (3-A1).
          const target = reanchorTarget && onThisPage(reanchorTarget) ? reanchorTarget : null;
          if (target) {
            const anchor = at();
            const capture = sanitizeElement(t);
            const bound = bindCapture(app);
            // Re-upload the captured block for the new anchor (fail-soft), only
            // once the server's receipt says the re-anchor landed: the space
            // admits that upload from whoever re-anchored (R3-C7).
            const landed = app.awaitReceipt("reanchor", target);
            void app
              .send({ type: "interaction-reanchor", interactionId: target, anchor })
              .then((res: { ok: boolean }) => {
                if (!res.ok) return;
                void landed.then((r) => {
                  if (r.ok) app.uploadCapture(target, capture, bound);
                });
              });
            // Record how the place looks at its new home (Stage 2 §1.1 hook 2).
            void captureSnapshot(
              t,
              target,
              bindCapture(app, () => t.isConnected),
            ).catch(() => {});
            toast("re-anchored");
            // A child frame's thread is the top frame's to show (A-1).
            if (isTopFrame) thread.open(target);
            else {
              const spaceId = app.byId(target)?.spaceId;
              if (spaceId) tellSw({ type: "frameOpen", interactionId: target, spaceId });
            }
          }
          setMode("off");
          return;
        }
        if (mode === "tokenpick") {
          const req = tokenPick;
          tokenPick = null; // consumed — setMode must not fire onCancel
          setMode("off");
          returnModal(); // back before onPick, so the editor can take focus
          if (req) {
            const anchor = at();
            req.onPick(anchor, anchorLabel(anchor));
          }
          return;
        }
        if (mode === "pick") {
          const kind = pickKind;
          setMode("off");
          if (kind === "copy") {
            // F-041: clipboard-only — NO interaction, NOTHING sent to SW/server.
            // copyElement invokes writeText synchronously inside this click (the
            // user gesture); an await first would forfeit transient activation.
            copyElement(t, navigator.clipboard, toast);
            return;
          }
          if (kind === null) return;
          const anchor = anchorForSelection(t.ownerDocument.defaultView ?? window, path) ?? at();
          // Capture the picked block for upload once the interaction id lands.
          const capture = anchor.level === "element" ? sanitizeElement(t) : null;
          app.setCapture(capture);
          // Stage the LIVE element for a snapshot look on create (Stage 2 §1.1 hook
          // 1): element/selection anchors only, and only Comment/Ask consume it (a
          // Change already captures edit-context, S2-D1). The receipt continuation
          // fires captureSnapshot with an `isConnected` guard for the picked node.
          app.stageSnapshotSource(
            anchor.level === "element" || anchor.level === "selection" ? t : null,
          );
          // The composer keeps its anchor highlighted while composing; the
          // outline clears with the window (onClosed), sent or abandoned.
          selectedEl = t;
          placeBox(selBox, t);
          // Where the click is in this document's viewport, for a block inside a frame too.
          const box = rectInOwner(t);
          const own = t.getBoundingClientRect();
          composerWin.open(
            kind === "edit" ? "change" : kind,
            anchor,
            t,
            {
              x: e.clientX + box.left - own.left + 8,
              y: e.clientY + box.top - own.top + 8,
            },
            undefined,
            // The agent will get a reduced copy of this block's markup: say so now.
            {
              largeBlock: capture !== null && (capture.reduced !== undefined || capture.truncated),
            },
          );
          return;
        }
        // Edit mode separates SELECTING from EDITING (editor convention): a
        // single click establishes the block selection (Delete removes it);
        // entering the text is the deliberate double-click below.
        if (mode === "batch") batch.cancelEdit();
      },
    );

    // ── frames of this page without an address of their own (A-3) ──
    // This script takes in every such frame it can reach as `contentDocument`
    // (same origin, checked here): it hears that document's pointer, keys and
    // scrolls itself, and resolves, pins and rings its blocks from here. The
    // frame's own content script stays passive.
    const adopted = new WeakSet<Document>();
    function adoptFrames(): void {
      if (!ownsBlocks) return;
      let added = false;
      for (const doc of ownedFrameDocuments(document)) {
        if (adopted.has(doc)) continue;
        const win = doc.defaultView;
        if (!win) continue;
        adopted.add(doc);
        added = true;
        win.addEventListener("mousemove", onPickMove, { capture: true, passive: true });
        win.addEventListener("click", onPickClick, { capture: true });
        win.addEventListener("keydown", onFrameKey, { capture: true });
        // Its scroll moves the ring and pins of a block inside it, and the
        // composer card beside such a block: this window hears no scroll then.
        win.addEventListener(
          "scroll",
          () => {
            reposition();
            composerWin.blockMoved();
          },
          { capture: true, passive: true },
        );
      }
      // A frame's document appeared or was replaced: its blocks may hold pins now.
      if (added) app.requestRender();
    }
    /** Keys typed in a frame of this page: the Escape ladder and the chords, as here. */
    function onFrameKey(e: KeyboardEvent): void {
      if (!isTrustedEvent(e) || !docOf(e)) return;
      escapeLadder(e);
      if (!e.defaultPrevented) chords.handleKeydown(e);
    }
    // A frame's document loads (or a new one replaces it): take it in. Load
    // events do not bubble, but a capturing listener here hears a frame's.
    window.addEventListener(
      "load",
      (e) => {
        const t = e.target as Element | null;
        if (t?.localName !== "iframe" && t?.localName !== "frame") return;
        adoptFrames();
        // Its blocks may hold pins now.
        app.requestRender();
      },
      { capture: true },
    );

    // Double-click rewrites: the deliberate step from selection into text.
    window.addEventListener(
      "dblclick",
      (e) => {
        if (mode !== "batch" || !e.isTrusted) return;
        if (e.composedPath().some((n) => overlayContains(n))) return;
        const t = document.elementFromPoint(e.clientX, e.clientY);
        if (!t || overlayContains(t)) return;
        const editing = batch.editingTarget();
        if (editing && (t === editing || editing.contains(t))) return; // word-select inside the session
        e.preventDefault();
        e.stopImmediatePropagation();
        batch.beginTextEdit(t);
      },
      { capture: true },
    );

    // P anchors to the whole page while anchor-picking (the toast offers it).
    onWindowRouted<KeyboardEvent>(
      window,
      "keydown",
      (e) => {
        if (mode !== "anchorpick" || e.key.toLowerCase() !== "p" || !isTrustedEvent(e)) return;
        const active = shadow.activeElement;
        if (active && (active as HTMLElement).isContentEditable) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const target = anchorTarget;
        setMode("off");
        if (!target) return;
        void app
          .send({
            type: "interaction-anchor",
            interactionId: target,
            anchor: { level: "page" },
          } as never)
          .then((res: { ok: boolean }) => {
            toast(res.ok ? "anchored to this page" : "couldn't anchor — is the Ask still live?");
          });
      },
      { capture: true },
    );

    // Delete removes the SELECTED block in edit mode. Typing anywhere — a page
    // text field being rewritten, an overlay editor — keeps Delete (like
    // Backspace) a normal text-editing key; only a bare selection queues a
    // removal.
    onWindowRouted<KeyboardEvent>(
      window,
      "keydown",
      (e) => {
        if (mode !== "batch") return;
        if (e.key !== "Delete" || !isTrustedEvent(e)) return;
        if (isEditableTarget(e)) return;
        if (!selectedEl) return;
        e.preventDefault();
        batch.addRemoval(selectedEl);
        selBox.style.display = "none";
        selectedEl = null;
      },
      { capture: true },
    );

    // ── the Escape ladder (ADR-0019): most-transient surface first ──
    const escapeLadder = kept<KeyboardEvent>(
      (fn) => onWindowRouted<KeyboardEvent>(window, "keydown", fn, { capture: true }),
      (e) => {
        // A page-made Escape dismisses nothing (and discards no draft).
        if (e.key !== "Escape" || !isTrustedEvent(e)) return;
        // An IME composing (in a space menu's search, an editor) takes its own
        // Escape: it cancels the composition, never a surface around it.
        if (e.isComposing || e.keyCode === 229) return;
        // Rung 0 — an open @/: trigger menu (or a composer's space menu) is the MOST transient surface of
        // all (F19): this capture listener beats the editor's own bubble-phase
        // menu-eating handler, so without this rung Escape-with-a-menu-open
        // closed the whole modal/panel around it.
        if (closeAnyOpenTokenMenu() || closeAnySpaceMenu()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (mode === "tokenpick") {
          // cancel the pick and give the editor its focus back — before any
          // panel close, or the composer the pick came from would vanish
          setMode("off");
          return;
        }
        if (commandBar.isOpen()) {
          // The palette owns the keyboard while it's up: the page must not
          // also react to this Escape (same law as Enter/arrows in the bar).
          e.preventDefault();
          e.stopPropagation();
          commandBar.escape(); // pops a mode first, closes from the root
          return;
        }
        if (modal.isOpen()) {
          // Same law as the bar — the modal's own handler only sees keys when
          // focus is INSIDE it; this rung covers Escape from anywhere.
          e.preventDefault();
          e.stopPropagation();
          modal.close();
          return;
        }
        if (thread.isOpen()) {
          thread.close();
          return;
        }
        if (composerWin.isOpen()) {
          composerWin.close();
          return;
        }
        // A composer for a frame's block, still waiting for where to open: called off.
        if (isTopFrame && cancelPlaceWait()) {
          e.preventDefault();
          return;
        }
        // The pick this frame completed may still be waiting in the top frame: it ends there.
        if (!isTopFrame && ownPick) tellSw({ type: "framePickEnd", pickId: ownPick.pickId });
        if (mode !== "off") {
          setMode("off");
          // Leaving edit mode with nothing queued: the empty tray goes too.
          if (batch.isOpen() && batch.opCount() === 0) batch.dismiss();
          return;
        }
        // Dismissal discards: unsent edits are a draft, the page comes back.
        // The tray is the top frame's: it dismisses every frame's edits (E-3).
        if (isTopFrame && batch.isOpen()) batch.dismiss();
      },
    );

    // ── keyboard entry (ADR-0019 §3): chords + the Ctrl+. accelerator ──
    function isEditableTarget(e: KeyboardEvent): boolean {
      const path = e.composedPath();
      const t = (path.length > 0 ? path[0] : e.target) as EventTarget | null;
      // By node type, not `instanceof`: an element of a frame of this page
      // (A-3) belongs to that frame's realm.
      if ((t as Node | null)?.nodeType === 1) {
        const h = t as HTMLElement;
        if (h.isContentEditable) return true;
        if (h.localName === "input" || h.localName === "textarea" || h.localName === "select")
          return true;
      }
      // The overlay's token editors live in the shadow root; page inputs on the
      // document (or the frame's, for a key typed there) — either focused means
      // the human is typing, never a chord.
      const view = e.view as Window | null;
      const frameActive = view && view !== window ? view.document.activeElement : null;
      for (const active of [shadow.activeElement, document.activeElement, frameActive]) {
        const a = active as HTMLElement | null;
        if (!a) continue;
        if (a.isContentEditable) return true;
        if (a.localName === "input" || a.localName === "textarea" || a.localName === "select")
          return true;
      }
      return false;
    }

    const chords = isTopFrame
      ? createChordDispatcher({
          fire: (action) => runCommand(action as CommandId),
          // hard guards: no chords while typing or while the bar / a composer
          // window / the thread panel (which hosts a composer when live) is up
          isBlocked: (e) =>
            commandBar.isOpen() || composerWin.isOpen() || thread.isOpen() || isEditableTarget(e),
          // Ctrl+. toggles the bar — its own input must not block the close half
          // of the toggle, but every other editable context still does.
          isAccelBlocked: (e) => !commandBar.ownsFocus() && isEditableTarget(e),
          onAccel: () => commandBar.toggle(),
        })
      : // Focus inside a child frame (F-1): the chord goes to the top frame,
        // which applies its own guards; typing in this frame's page blocks it here.
        createChordDispatcher({
          fire: (action) => tellSw({ type: "frameCommand", command: action }),
          isBlocked: (e) => isEditableTarget(e),
          isAccelBlocked: (e) => isEditableTarget(e),
          onAccel: () => tellSw({ type: "frameCommand", command: "commandBar" }),
        });
    onWindowRouted<KeyboardEvent>(window, "keydown", (e) => chords.handleKeydown(e), {
      capture: true,
    });

    /** Bind the live keyboard map (chords + accelerator + bar chips). */
    function applyKeyboard(kb: Record<CommandId, string>): void {
      keyboard = kb;
      const map: Record<string, string> = {};
      for (const id of COMMAND_IDS) {
        if (id !== "commandBar") map[id] = kb[id];
      }
      chords.setBindings(map);
      chords.setAccel(kb.commandBar);
    }

    // Prefs live in extension storage (ADR-0019 §4): read directly, re-bind hot
    // on change — no server round-trip, no polling. Keyboard is top-frame only;
    // the overlay zoom re-scales the sheet in EVERY frame (pins re-place at the
    // new pin size via reposition).
    const applyPrefs = (p: Prefs): void => {
      applyKeyboard(p.keyboard);
      applyUiZoom(sheet, p.uiZoom);
      currentTheme = p.theme;
      stampTheme(host, p.theme);
      reposition();
    };
    void getPrefs().then(applyPrefs, () => applyKeyboard(KEYBOARD_DEFAULTS));
    try {
      onPrefsChanged(applyPrefs);
    } catch {
      /* stale context (F-053) */
    }

    // keep boxes glued through scroll/resize; reposition pins
    const reposition = (): void => {
      if (selectedEl) placeBox(selBox, selectedEl);
      if (mode !== "off" && hoverEl) placeBox(hoverBox, hoverEl);
      pins.render();
    };
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    window.addEventListener("resize", reposition, { passive: true });

    // ── anchor-loss detection (ADR-0017 §4) ──
    // Each pass, count live element-anchored interactions whose anchor fails to
    // resolve while the page is visible; after a threshold of CONSECUTIVE misses
    // report the loss once. The server demotes to page-level (never drops it).
    // Every frame that owns blocks checks its own anchors (A-1): a frame holds
    // only what is bound to its own address, and resolves a block inside a
    // frame of its page through that frame's document (A-3).
    if (ownsBlocks) {
      const LOSS_PASS_MS = 2_000;
      let lossCounts = new Map<string, number>();
      /** The framed anchors (A-3) that resolved at the last pass. */
      let framedFound = "";
      setInterval(() => {
        // A document already gone (a test's teardown) has nothing to check.
        if (globalThis.document?.visibilityState !== "visible") return;
        // A capture owns the page while it runs: check again next pass.
        if (captureQueueBusy()) return;
        const present = new Set<string>();
        const lost = new Set<string>();
        const live = app
          .interactions()
          .filter((s) => !s.anchorLost && s.anchor.level === "element" && isLive(s.state))
          // Only what is bound to exactly this page (2-A4): a snapshot taken in
          // by URL prefix (a parent route's) is not this page's to call lost.
          .filter((s) => samePage(s.url, location.href));
        // Anchors are checked against the Original page: a kept edit or a preview
        // that rewrote a block's text must never demote someone's Comment there.
        const check = (): void => {
          for (const s of live) {
            present.add(s.id);
            if (!resolveAnchor(s.anchor)) lost.add(s.id);
          }
        };
        adoptFrames();
        if (live.length === 0) check();
        else layer.lifted(check);
        // A block inside a frame of this page that its page filled (or
        // emptied) since: no load event says so, so the pins follow here (A-3).
        const framed = live
          .filter((s) => s.anchor.level === "element" && s.anchor.framePath && !lost.has(s.id))
          .map((s) => s.id)
          .join(",");
        if (framed !== framedFound) {
          framedFound = framed;
          app.requestRender();
        }
        const step = stepLossCounters(lossCounts, lost, present);
        lossCounts = step.next;
        for (const id of step.fire) {
          // `framed`: this client looked inside the anchor's frames, if it has any.
          void app.send({ type: "interaction-anchor-lost", interactionId: id, framed: true });
        }
      }, LOSS_PASS_MS);
    }

    // ── URL-prefix filter for the pure view ──
    function matchesUrlPrefix(prefix: string, href: string): boolean {
      // One direction only, boundary-aware: a page at /item-evil must never
      // adopt interactions bound to /item (mirrors the kernel's URL gate).
      if (!href.startsWith(prefix)) return false;
      if (prefix.endsWith("/")) return true;
      const next = href.charAt(prefix.length);
      return next === "" || next === "/" || next === "?" || next === "#";
    }

    /** The spaces whose socket was open at the last status. */
    let openSpaces = new Set<string>();
    /** Spaces whose access just changed: their next snapshot decides what goes (R2-C10). */
    const accessCheck = new Set<string>();
    /** Each space's newest access revision this frame has been told of (3-F5). */
    const knownRev = new Map<string, number>();
    /** Each space's revision as of the snapshots this frame holds for it (3-F5). */
    const snapRev = new Map<string, number>();
    function noteRev(spaceId: string, rev: unknown): void {
      if (typeof rev !== "number" || !Number.isFinite(rev)) return;
      if (rev > (knownRev.get(spaceId) ?? 0)) knownRev.set(spaceId, rev);
    }
    /** Per space, the newest round of omitted-kept reads: an older one never lands. */
    const keptRound = new Map<string, number>();

    function applyInteractionsState(msg: {
      url: string;
      spaceId?: unknown;
      interactions: Snapshot[];
      kept?: KeptEdit[];
      keptOmitted?: string[];
    }): void {
      if (!ownsBlocks) return;
      // Every snapshot is a space's: an untagged frame has nowhere to go.
      if (typeof msg.spaceId !== "string" || !app.space(msg.spaceId)) return;
      if (!matchesUrlPrefix(msg.url, location.href)) return;
      const spaceId = msg.spaceId;
      const scoped = msg.interactions.filter(
        (s) => s.url !== undefined && matchesUrlPrefix(s.url, location.href),
      );
      const before = accessCheck.has(spaceId)
        ? new Set(
            app
              .interactions()
              .filter((s) => s.spaceId === spaceId)
              .map((s) => s.id),
          )
        : null;
      app._setInteractions(spaceId, scoped);
      // These snapshots are as of the newest access revision this frame knows (3-F5).
      snapRev.set(spaceId, knownRev.get(spaceId) ?? 0);
      if (before) {
        // Whatever this person can no longer see goes, with its sets and looks.
        accessCheck.delete(spaceId);
        const fresh = new Set(scoped.map((s) => s.id));
        const gone = new Set([...before].filter((id) => !fresh.has(id)));
        if (gone.size > 0) variants.dropForEdits(gone);
      }
      variants.snapshotsChanged();
      // The page's kept Edits ride the same snapshot; the layer shows them in
      // the document that owns this address, top or child frame (E-2).
      const entries = Array.isArray(msg.kept) ? msg.kept : [];
      layer.setKept(spaceId, entries);
      fillKeptOmitted(spaceId, entries, Array.isArray(msg.keptOmitted) ? msg.keptOmitted : []);
    }

    /**
     * Kept entries the frame dropped to fit (`keptOmitted`): read every one by
     * id, in pages, and merge them into the layer. The batch is pinned to the
     * account and its generation, the space and the page key it started under
     * (R3-C6): a newer snapshot for the space, an account change, the loss of
     * the space or another page stops it before the next read and before any
     * merge.
     */
    function fillKeptOmitted(spaceId: string, entries: KeptEdit[], omitted: string[]): void {
      const round = (keptRound.get(spaceId) ?? 0) + 1;
      keptRound.set(spaceId, round);
      if (omitted.length === 0) return;
      const pinned = { scope, generation: accountGeneration(), page: pageKey(location.href) };
      const still = (): boolean =>
        keptRound.get(spaceId) === round &&
        pinned.scope !== null &&
        scope === pinned.scope &&
        accountGeneration() === pinned.generation &&
        app.space(spaceId) !== undefined &&
        pageKey(location.href) === pinned.page;
      void recoverKept(
        omitted,
        (id) => readKept(spaceId, id),
        still,
        (found) => {
          for (const f of found) if (f.url !== null) keptUrls.set(f.kept.interactionId, f.url);
          layer.setKept(spaceId, [...entries, ...found.map((f) => f.kept)]);
        },
      );
    }

    /** Cancel kept recovery for every space `which` names (an account change, a lost space). */
    function cancelKeptRecovery(which: (spaceId: string) => boolean): void {
      for (const [id, n] of keptRound) if (which(id)) keptRound.set(id, n + 1);
    }

    async function readKept(
      spaceId: string,
      id: string,
    ): Promise<{ kept: KeptEdit; url: string | null } | null> {
      try {
        // `peek`: an automatic read never counts as the person opening a shared thread.
        const res = (await chrome.runtime.sendMessage({
          type: "getInteraction",
          spaceId,
          id,
          peek: true,
        })) as { ok?: boolean; interaction?: { url?: unknown }; kept?: unknown } | undefined;
        if (!res?.ok) return null;
        const parsed = KeptEditSchema.safeParse(res.kept);
        if (!parsed.success || parsed.data.interactionId !== id) return null;
        const url = typeof res.interaction?.url === "string" ? res.interaction.url : null;
        return { kept: parsed.data, url };
      } catch {
        return null;
      }
    }

    // ── directory + identity: each space's people, the person, their spaces ──
    function refreshDirectory(spaceId?: string): void {
      const targets = spaceId ? [spaceId] : app.spaces().map((s) => s.id);
      for (const id of targets) {
        try {
          chrome.runtime.sendMessage({ type: "getDirectory", spaceId: id }).then(
            (res: { ok?: boolean; people?: PersonView[] } | undefined) => {
              if (!res?.ok || !res.people) return;
              app._setDirectory(id, res.people);
              app.requestRender();
            },
            () => {},
          );
        } catch {
          // stale context (F-053) — app.send surfaces the refresh hint
        }
      }
    }

    interface StatusReply {
      signedIn?: boolean;
      connected?: boolean;
      person?: PersonView | null;
      spaces?: SpaceSummary[];
      upgradeRequired?: boolean;
      serverOrigin?: string;
      generation?: number;
      openSpaces?: string[];
      accessRevs?: Record<string, number>;
    }

    /** The first account truth has been adopted (nothing was open under another before it). */
    let statusApplied = false;
    /** Adopt the SW's account truth: who you are, your spaces, the last space you used. */
    async function applyStatus(res: StatusReply | undefined): Promise<void> {
      signedIn = res?.signedIn === true;
      connected = res?.connected === true;
      // A space whose socket closed: what was sent on it gets no receipt (3b-C10).
      const nowOpen = new Set(Array.isArray(res?.openSpaces) ? res.openSpaces : []);
      const closed = new Set([...openSpaces].filter((id) => !nowOpen.has(id)));
      openSpaces = nowOpen;
      if (closed.size > 0) app._connectionLost(closed);
      upgradeRequired = res?.upgradeRequired === true;
      let last: string | null = null;
      try {
        const got = (await chrome.storage.local.get(LAST_SPACE_KEY)) as Record<string, unknown>;
        const v = got[LAST_SPACE_KEY];
        last = typeof v === "string" ? v : null;
      } catch {
        /* stale context */
      }
      const before = accountGeneration();
      noteAccountGeneration(signedIn ? res?.generation : null);
      // Faces decoded under another account are not this one's.
      if (accountGeneration() !== before) forgetPictures();
      if (res?.accessRevs && typeof res.accessRevs === "object")
        for (const [sp, rev] of Object.entries(res.accessRevs)) noteRev(sp, rev);
      if (res?.serverOrigin) app._setServerOrigin(res.serverOrigin);
      app._setSelf(signedIn ? (res?.person ?? null) : null);
      const knownSpaces = new Set(app.spaces().map((s) => s.id));
      const composable = (): string =>
        app
          .composeSpaces()
          .map((s) => `${s.id}:${s.name}`)
          .join("\n");
      const composableBefore = composable();
      app._setSpaces(signedIn ? (res?.spaces ?? []) : [], last);
      // A space menu open on spaces that changed (joined, left, renamed, or
      // another account's) would offer what is not there: it closes, and
      // reads the spaces anew when opened again.
      const accountNow = signedIn && res?.person ? `${res.person.id}|${app.serverOrigin()}` : null;
      if (composable() !== composableBefore || accountNow !== scope) closeAnySpaceMenu();
      // A space learned after the first sync (made or joined a moment ago) has
      // no people yet: read them now, or nobody there can be mentioned.
      if (signedIn && hasSynced) {
        for (const s of app.spaces()) if (!knownSpaces.has(s.id)) refreshDirectory(s.id);
      }
      // One person on one server: an account change takes everything of the old
      // one off the page; a lost space takes its own work with it.
      const person = signedIn ? (res?.person ?? null) : null;
      const next = person ? `${person.id}|${app.serverOrigin()}` : null;
      const prev = scope;
      scope = next;
      // Drafts and what is open belong to that account too (2-M1): the next
      // person on this tab finds none of them.
      setDraftScope(next);
      if (prev !== next && statusApplied) closePrivateSurfaces();
      // The tray's edits, their previews and the Edit a failed send was
      // retrying into belong to that account too, in every frame (2-E2).
      if (prev !== next) {
        batch.reset();
        if (isTopFrame && frameOps.size > 0) {
          frameOps.clear();
          batch.remoteChanged();
        }
      }
      // What child frames said belonged to the old account; a lost space's goes (2-F5).
      if (isTopFrame) {
        const known = new Set(app.spaces().map((s) => s.id));
        forgetFrameSpaces((sp) => prev !== next || !known.has(sp));
        if (prev !== next) {
          cancelPlaceWait();
          remotePick = null;
        }
      }
      statusApplied = true;
      const spaceIds = app.spaces().map((s) => s.id);
      const keep = new Set(spaceIds);
      cancelKeptRecovery((id) => prev !== next || !keep.has(id));
      layer.setScope(next);
      layer.keepSpaces(spaceIds);
      variants.scopeChanged(prev, next, spaceIds);
      cancelVariantPasses((setId) => {
        const sp = spaceOfSet(setId);
        return sp !== undefined && !keep.has(sp);
      });
      if (isTopFrame) {
        orb.setConnection(
          connected && !upgradeRequired ? "connected" : signedIn ? "reconnecting" : "offline",
        );
      }
      app.requestRender();
    }

    // ── sync on mount / reconnect ──
    let hasSynced = false;
    function syncAll(): void {
      if (!signedIn || !ownsBlocks) return;
      hasSynced = true;
      app.send({ type: "interaction-sync" });
      app.send({ type: "attention-sync" });
      variants.sync();
      refreshDirectory();
    }

    // ── connection state → the orb (honest mapping, ADR-0019 §1) ──
    // `status` frames carry the socket and sign-in truth; the full account
    // (person, spaces) is re-read so a sign-in, a sign-out or a space change
    // repaints everything. Signed out reads as offline; signed in but
    // unreachable as reconnecting.
    function pullStatus(sync: boolean): void {
      try {
        chrome.runtime.sendMessage({ type: "getStatus" }).then(
          (res: StatusReply | undefined) =>
            applyStatus(res).then(() => {
              if (sync && connected) syncAll();
              pullAttention();
            }),
          () => {
            if (isTopFrame) orb.setConnection("offline");
          },
        );
      } catch {
        if (isTopFrame) orb.setConnection("offline");
      }
    }

    // ── messages from the service worker ──
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "status":
        case "space-dropped":
          pullStatus(true);
          return;
        case "directory-updated":
          if (typeof msg.spaceId === "string") refreshDirectory(msg.spaceId);
          return;
        case "access-changed": {
          if (typeof msg.spaceId !== "string") return;
          const changed = msg.spaceId;
          accessCheck.add(changed);
          if (typeof msg.rev === "number") noteRev(changed, msg.rev);
          // Faces decoded under the old access are drawn afresh.
          forgetPictures();
          // The frames re-report what this person still sees there (2-F5); a
          // pending pick is not carried across an access change either (3-F5).
          if (isTopFrame) {
            forgetFrameSpaces((sp) => sp === changed);
            cancelPlaceWait();
            remotePick = null;
          }
          onAccessChanged(changed, {
            cancelKept: (id) => cancelKeptRecovery((k) => k === id),
            openThread: () => {
              const id = thread.isOpen() ? thread.currentId() : null;
              return id ? { id, spaceId: app.byId(id)?.spaceId ?? spaceOfInteraction(id) } : null;
            },
            readById: (sp, id, gone) => readById(sp, id, gone),
            closeIfStill: (id) => closeThreadIfGone(id),
            resync: () => {
              if (!connected) return;
              void app.send({ type: "interaction-sync" });
              variants.sync();
            },
          });
          return;
        }
        case "resync":
          // A space's origins newly include this frame's origin: it may hold threads here.
          if (Array.isArray(msg.origins) && !msg.origins.includes(location.origin)) return;
          if (connected) {
            void app.send({ type: "interaction-sync" });
            variants.sync();
          }
          return;
        case "interactions-state":
          applyInteractionsState(msg);
          return;
        case "attention-tick":
          // Push-driven refresh for OFF-PAGE rows (F23): every accepted server
          // mutation repushes attention → the SW relays this tick. The modal
          // re-pulls its open off-page row; its skip-key absorbs no-ops.
          modal.remoteTick();
          return;
        case "attention-updated":
          // The service worker read the Inbox anew: headers and pins follow it.
          pullAttention();
          return;
        case "interaction-receipt":
          // A refused react must revert its optimistic paint — re-pull truth.
          if (msg.ok === false && msg.kind === "react") void app.send({ type: "interaction-sync" });
          app._onReceipt(msg);
          return;
        case "variant-state":
          if (typeof msg.spaceId === "string") app.noteSet(msg.setId, msg.spaceId);
          variants.onVariantState(msg as VariantStateMessage);
          // F30: the witness pass observes EVERY state frame — including sets
          // the UI controller doesn't own (a second edit on this page, sol-5).
          observeVariantState(msg, variantPassDeps());
          return;
        case "variant-receipt":
          variants.onVariantReceipt(msg);
          return;
        case "reveal": {
          const s = app.byId(msg.interactionId);
          if (s) {
            pins.flash(s.id);
            if (isTopFrame) openInteraction(s.id);
            else tellSw({ type: "frameOpen", interactionId: s.id, spaceId: s.spaceId });
          }
          return;
        }
        // A look of a block in some frame of this tab (F-6).
        case "frame-hold":
          if (typeof msg.holdId === "string") onFrameHold(msg.holdId);
          return;
        case "frame-release":
          if (typeof msg.holdId === "string") onFrameRelease(msg.holdId);
          return;
        case "frame-locate-up":
          if (typeof msg.nonce === "string" && typeof msg.holdId === "string")
            onLocateUp(
              window,
              msg.nonce,
              msg.holdId,
              String(msg.phase),
              msg.rect,
              msg.reveal === true,
            );
          return;
        case "pick-start":
        case "pick-end":
        case "pick-hint":
        case "frame-picked":
        case "frame-placed":
        case "frame-open":
        case "frame-report":
        case "frame-gone":
        case "frame-command":
          onFrameMessage(msg);
          return;
      }
    });
    // The service worker's "is this document still here" (2-F5).
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== "frame-ping") return false;
      sendResponse({ ok: true });
      return false;
    });
    // The top frame's calls into this child frame answer asynchronously.
    if (!isTopFrame) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type !== "frame-call" || typeof msg.call !== "object" || msg.call === null)
          return false;
        void onFrameCall(msg.call as Record<string, unknown>).then(sendResponse, () =>
          sendResponse({ ok: false }),
        );
        return true;
      });
      // This frame's own threads, for the top frame's Inbox and badge.
      app.onRender(() => scheduleFrameReport());
      setInterval(() => scheduleFrameReport(), 20_000);
      window.addEventListener("pagehide", () => {
        if (lastReport !== null) tellSw({ type: "frameGone" });
        lastReport = null;
      });
    }

    // ── frames of one tab (F-1 … F-4): the top frame holds the UI, a child
    // frame owns its blocks and everything bound to its own address. They
    // talk only through the service worker (sw/frames.ts), which names each
    // frame by what the browser reports for the sender. ──

    /** Fire-and-forget to the service worker (a stale context stays quiet). */
    function tellSw(msg: Record<string, unknown>): void {
      try {
        void chrome.runtime.sendMessage(msg).catch(() => {});
      } catch {
        /* stale context (F-053) */
      }
    }

    /** Ask a child document of this tab to act; it answers for itself. */
    function frameCall(
      documentId: string,
      call: Record<string, unknown>,
    ): Promise<Record<string, unknown> & { ok?: boolean }> {
      try {
        return chrome.runtime.sendMessage({ type: "frameCall", documentId, call }).then(
          (r: unknown) =>
            (r && typeof r === "object" ? r : { ok: false }) as Record<string, unknown> & {
              ok?: boolean;
            },
          () => ({ ok: false }),
        );
      } catch {
        return Promise.resolve({ ok: false });
      }
    }

    // ── top frame ──
    /** The child documents of this tab that reported threads, by document id. */
    /**
     * `page`: the page key the frame says it is on now (its own location,
     * which a same-document route change moves and the browser's sender URL
     * does not), for what the top frame offers to do there (3-A1).
     */
    const childFrames = new Map<string, { url: string; page?: string; interactions: Snapshot[] }>();
    /** Each child document's kept edits, as it last reported them (E-2). */
    const frameKept = new Map<string, ReportedKept>();
    /** Each child document's tray edits, with its address and host as the browser reported them (E-3). */
    const frameOps = new Map<string, { url: string; host: string; ops: ReportedOp[] }>();

    /**
     * Before the tray sends: every child document this frame knows commits a
     * text edit in progress and says what it holds (its report may be in flight).
     */
    /** A tray call to a child frame, made under this account generation and answered under it (3-E3). */
    function trayCall(
      documentId: string,
      call: Record<string, unknown>,
    ): Promise<Record<string, unknown> & { ok?: boolean }> {
      const sent = accountGeneration();
      return frameCall(documentId, { ...call, generation: sent }).then(
        (r) =>
          trayAnswer(r, sent, accountGeneration()) as Record<string, unknown> & { ok?: boolean },
      );
    }

    async function settleFrameOps(): Promise<void> {
      const docs = new Set([...childFrames.keys(), ...frameOps.keys()]);
      await Promise.all(
        [...docs].map(async (documentId) => {
          const r = await trayCall(documentId, { op: "batchCommit" });
          if (r.ok !== true) return;
          const url = frameOps.get(documentId)?.url ?? childFrames.get(documentId)?.url;
          if (!url) return;
          const ops = acceptOps(r.ops);
          if (ops.length > 0) frameOps.set(documentId, { url, host: new URL(url).hostname, ops });
          else frameOps.delete(documentId);
        }),
      );
      batch.remoteChanged();
    }

    /** The page composer for a child frame's page: the Edit is bound to its address (E-3). */
    function pageComposerInFrame(documentId: string): void {
      const f = frameOps.get(documentId);
      if (!f) return;
      const pickId = uuid4().slice(0, 32);
      void frameCall(documentId, { op: "pagePick", pickId }).then((r) => {
        if (r.ok !== true) {
          toast(VARIANT_COPY.frameGone);
          return;
        }
        lastHeard.set(documentId, Date.now());
        composeInFrame(documentId, f.url, f.host, pickId, "edit", { level: "page" });
      });
    }
    /** The block pick this frame relayed to the others, while it runs. */
    let topPickId: string | null = null;
    /** The child frame holding the block the open composer is about. */
    type RemotePick = { documentId: string; pickId: string };
    let remotePick: RemotePick | null = null;
    /** A frame's pick whose composer waits (briefly) for where to open. */
    let placeWait: {
      documentId: string;
      pickId: string;
      pick: RemotePick;
      timer: ReturnType<typeof setTimeout>;
      /** The frame answered (a point in this viewport, or none), or the wait ran out. */
      answer(at: { x: number; y: number } | null): void;
    } | null = null;
    /**
     * The one way a waiting composer is called off (Escape here or in the
     * frame, an account or access change, the frame gone, the frame's page
     * changed, a newer pick): nothing opens, and the frame drops its outline.
     * Says whether one was waiting.
     */
    function cancelPlaceWait(): boolean {
      const w = placeWait;
      if (!w) return false;
      placeWait = null;
      clearTimeout(w.timer);
      if (remotePick === w.pick) remotePick = null;
      void frameCall(w.documentId, { op: "clearPick", pickId: w.pickId });
      return true;
    }

    function frameInteractions(): Snapshot[] {
      dropStaleFrames();
      return [...childFrames.values()].flatMap((f) => f.interactions);
    }
    /** Each child frame's address and its threads, for the tab's round (A-2). */
    function framePages(): Array<{ url: string; interactions: Snapshot[] }> {
      dropStaleFrames();
      return [...childFrames.values()];
    }
    /** The pick the hint line already said "sandboxed frame" for (once per pick, A-3). */
    let hintedPick: string | null = null;
    /** Threads a child frame opened here before (or without) its report: id → that frame. */
    const openedFromFrame = new Map<string, { documentId: string; url: string; spaceId: string }>();
    /** When each child document was last heard from (a report, an open, a pick). */
    const lastHeard = new Map<string, number>();
    /** A frame silent this long is gone (2-F5, 3-F5): its content script reports every 20 s. */
    const FRAME_STALE_MS = 60_000;
    /**
     * Every record held about a child document (its snapshots, a thread opened
     * from it, a pending pick in it) goes once it has been silent too long.
     */
    function dropStaleFrames(): void {
      const docs = [
        ...childFrames.keys(),
        ...[...openedFromFrame.values()].map((o) => o.documentId),
        ...(remotePick ? [remotePick.documentId] : []),
        // Its kept edits and tray edits too (E-2, E-3).
        ...frameKept.keys(),
        ...frameOps.keys(),
      ];
      // Every document heard from, whatever it reported (3-E4).
      for (const doc of documentsToForget(lastHeard, docs, Date.now(), FRAME_STALE_MS))
        forgetFrame(doc);
    }
    /** Forget one child document: its threads, the threads opened from it, a pick in it. */
    function forgetFrame(documentId: string): void {
      lastHeard.delete(documentId);
      variants.forgetFrame(documentId);
      if (frameKept.delete(documentId)) app.requestRender();
      if (frameOps.delete(documentId)) batch.remoteChanged();
      for (const [id, o] of openedFromFrame)
        if (o.documentId === documentId) openedFromFrame.delete(id);
      if (placeWait?.documentId === documentId) cancelPlaceWait();
      if (remotePick?.documentId === documentId) remotePick = null;
      if (childFrames.delete(documentId)) app.requestRender();
    }
    /**
     * Forget what child frames said about a space (`access-changed`), or about
     * everything (an account or server change), 2-F5.
     */
    function forgetFrameSpaces(which: (spaceId: string) => boolean): void {
      // Mirrored variant panels and their pill go at once (2-E3).
      variants.forgetFrameSpaces((sp) => sp === undefined || which(sp));
      for (const [id, o] of openedFromFrame) if (which(o.spaceId)) openedFromFrame.delete(id);
      for (const [doc, k] of frameKept) {
        const rows = k.rows.filter((r) => !which(r.spaceId));
        if (rows.length === k.rows.length) continue;
        if (rows.length === 0) frameKept.delete(doc);
        // The count goes down with the rows; the frame's next report says it exactly.
        else frameKept.set(doc, { rows, shown: Math.min(k.shown, rows.length) });
      }
      for (const [doc, f] of childFrames) {
        const kept = f.interactions.filter((s) => !which(s.spaceId));
        if (kept.length === f.interactions.length) continue;
        if (kept.length === 0) childFrames.delete(doc);
        else childFrames.set(doc, { ...f, interactions: kept });
      }
      app.requestRender();
    }
    if (isTopFrame) setInterval(() => dropStaleFrames(), 10_000);
    function frameOwner(
      id: string,
    ): { documentId: string; url: string; page?: string; snap?: Snapshot } | null {
      for (const [documentId, f] of childFrames) {
        const snap = f.interactions.find((s) => s.id === id);
        if (snap) return { documentId, url: f.url, ...(f.page ? { page: f.page } : {}), snap };
      }
      return openedFromFrame.get(id) ?? null;
    }
    function startTopPick(kind: PickKind | "token" | "batch"): void {
      // Frames of this page that loaded since are taken in for the pick (A-3).
      adoptFrames();
      if (!isTopFrame) return;
      endTopPick();
      // A composer still waiting for an older pick's place is called off.
      cancelPlaceWait();
      topPickId = uuid4().slice(0, 32);
      tellSw({ type: "framePickAll", pickId: topPickId, kind });
    }
    function endTopPick(): void {
      const id = topPickId;
      topPickId = null;
      if (id) tellSw({ type: "framePickEnd", pickId: id });
    }

    /** A thread bound to a child frame: the modal here, the block flashed there (F-4). */
    function openFrameThread(documentId: string, id: string, spaceId: string, url?: string): void {
      const f = childFrames.get(documentId);
      const snap = f?.interactions.find((s) => s.id === id);
      const frameUrl = f?.url ?? url;
      if (!frameUrl) return;
      // Opened before the frame's report came in: the thread is read by id.
      if (!snap) openedFromFrame.set(id, { documentId, url: frameUrl, spaceId });
      noteInteractionSpace(id, spaceId);
      commandBar.close();
      modal.open({
        interactionId: id,
        spaceId,
        url: snap?.hostUrl ?? snap?.url ?? frameUrl,
        frameDocumentId: documentId,
      });
      void frameCall(documentId, { op: "reveal", interactionId: id });
    }

    /** The composer for a block a child frame picked: it creates through that frame. */
    function composeInFrame(
      documentId: string,
      url: string,
      host: string,
      pickId: string,
      kind: "comment" | "edit",
      anchor: Anchor,
    ): void {
      app.setCapture(null);
      app.stageSnapshotSource(null);
      composerWin.close();
      const via: ComposerVia = {
        pageUrl: url,
        host,
        create: (payload, spaceId, nonce) =>
          // A pick that expired here (its frame silent or gone, an access or
          // account change) is picked again (3-F5).
          remotePick?.pickId !== pickId || remotePick.documentId !== documentId
            ? Promise.resolve({ ok: false, reason: "no-frame" })
            : frameCall(documentId, { op: "create", pickId, payload, spaceId, nonce }).then(
                (r): CreateResult => ({
                  ok: r.ok === true,
                  ...(typeof r.interactionId === "string"
                    ? { interactionId: r.interactionId }
                    : {}),
                  ...(typeof r.reason === "string"
                    ? { reason: r.reason }
                    : typeof r.error === "string"
                      ? { reason: r.error }
                      : {}),
                }),
              ),
        // Variants of the frame's block: the set lives with the frame's address (E-1).
        startVariants: (command, count, intent, spaceId) =>
          remotePick?.pickId !== pickId || remotePick.documentId !== documentId
            ? Promise.resolve({ ok: false, reason: "no-frame" })
            : frameCall(documentId, {
                op: "variants",
                pickId,
                command,
                count,
                intent,
                spaceId,
              }).then(
                (r): CreateResult => ({
                  ok: r.ok === true,
                  ...(typeof r.interactionId === "string"
                    ? { interactionId: r.interactionId }
                    : {}),
                  ...(typeof r.reason === "string"
                    ? { reason: r.reason }
                    : typeof r.error === "string"
                      ? { reason: r.error }
                      : {}),
                }),
              ),
      };
      cancelPlaceWait(); // a newer pick replaces one still waiting
      const pick: RemotePick = { documentId, pickId };
      remotePick = pick;
      const generation = accountGeneration();
      // The card opens once: beside the click when the frame could say where
      // it is in time and it lies in this viewport, otherwise centred; and
      // only once the frame answers that its document still holds this pick
      // on the same page and account. Then it stays where it is.
      let settled = false;
      const answer = (at: { x: number; y: number } | null): void => {
        if (settled || placeWait?.pick !== pick) return;
        settled = true;
        clearTimeout(placeWait.timer);
        void frameCall(documentId, { op: "pickLive", pickId }).then((r) => {
          if (placeWait?.pick !== pick) return;
          const w = placeWait;
          placeWait = null;
          clearTimeout(w.timer);
          if (
            r.ok !== true ||
            remotePick !== pick ||
            accountGeneration() !== generation ||
            composerWin.isOpen()
          ) {
            if (remotePick === pick) remotePick = null;
            void frameCall(documentId, { op: "clearPick", pickId });
            return;
          }
          const composer = kind === "edit" ? "change" : "comment";
          const beside =
            at && pointInView(at, { width: window.innerWidth, height: window.innerHeight })
              ? { x: at.x + 8, y: at.y + 8 }
              : undefined;
          composerWin.open(composer, anchor, null, beside, via);
          // Opening closed any earlier composer, whose close forgot its pick.
          remotePick = pick;
        });
      };
      placeWait = {
        documentId,
        pickId,
        pick,
        timer: setTimeout(() => answer(null), PLACE_WAIT_MS),
        answer,
      };
    }

    function onFrameMessage(msg: Record<string, unknown>): void {
      const pickId = typeof msg.pickId === "string" ? msg.pickId : "";
      if (!isTopFrame) {
        if (msg.type === "pick-start") {
          // A frame that owns no blocks takes no part in a pick; one no owner
          // takes in says so where the pointer reaches it (A-3).
          if (!ownsBlocks) {
            if (sandboxed) sandboxPick = pickId;
            return;
          }
          // Frames of this page that loaded since are taken in for the pick.
          adoptFrames();
          // The pick starts fresh here: an older pick's outline goes.
          ownPick = null;
          clearSelection();
          relayPick = { pickId, kind: String(msg.kind) };
          setMode(msg.kind === "token" ? "tokenpick" : msg.kind === "batch" ? "batch" : "pick");
        } else if (msg.type === "pick-end") {
          if (sandboxPick === pickId) sandboxPick = null;
          if (relayPick?.pickId === pickId) {
            relayPick = null;
            setMode("off");
          }
        }
        return;
      }
      const frame = msg.frame as
        | { documentId?: unknown; url?: unknown; host?: unknown }
        | undefined;
      const documentId = typeof frame?.documentId === "string" ? frame.documentId : "";
      const frameUrl = typeof frame?.url === "string" ? frame.url : "";
      const frameHost = typeof frame?.host === "string" ? frame.host : "";
      switch (msg.type) {
        case "pick-hint":
          // The pointer reached a frame onlay can't anchor in: said once per pick.
          if (pickId !== "" && pickId === topPickId && hintedPick !== pickId) {
            hintedPick = pickId;
            toast(SANDBOXED_FRAME_HINT);
          }
          return;
        case "pick-end":
          // Cancelled in another frame (Escape there): it ends here too. A
          // completion's own pick-end is not a cancel: its frame-picked,
          // whichever comes first, completes the pick here.
          if (pickId === "" || msg.cancel !== true) return;
          if (pickId === topPickId) {
            topPickId = null;
            setMode("off");
          }
          // Escape in the frame that completed the pick, before its composer opened.
          if (placeWait?.pickId === pickId) cancelPlaceWait();
          return;
        case "frame-picked": {
          if (pickId === "" || !documentId) return;
          // A completion that came after the pick was ended: the frame drops its outline.
          if (pickId !== topPickId) {
            void frameCall(documentId, { op: "clearPick", pickId });
            return;
          }
          lastHeard.set(documentId, Date.now());
          topPickId = null; // completed there: nothing to end
          const anchor = msg.anchor as Anchor;
          if (msg.kind === "token") {
            const req = tokenPick;
            tokenPick = null; // consumed — setMode must not fire onCancel
            setMode("off");
            returnModal();
            req?.onPick(anchor, typeof msg.label === "string" ? msg.label : anchorLabel(anchor));
            return;
          }
          const kind = pickKind;
          setMode("off");
          if (kind === "comment" || kind === "edit")
            composeInFrame(documentId, frameUrl, frameHost, pickId, kind, anchor);
          return;
        }
        case "frame-placed": {
          // Where the click that picked a frame's block is in this viewport,
          // once: the waiting composer opens there, or centred.
          if (pickId === "" || !documentId) return;
          lastHeard.set(documentId, Date.now());
          const w = placeWait;
          if (!w || w.documentId !== documentId || w.pickId !== pickId) return;
          // The frame's page or account changed since the pick: it is picked again.
          if (msg.stale === true) {
            cancelPlaceWait();
            return;
          }
          const at = msg.at as { x?: unknown; y?: unknown } | undefined;
          w.answer(
            at && typeof at.x === "number" && typeof at.y === "number"
              ? { x: at.x, y: at.y }
              : null,
          );
          return;
        }
        case "frame-open": {
          if (!documentId || typeof msg.interactionId !== "string") return;
          if (typeof msg.spaceId !== "string" || !app.space(msg.spaceId)) return;
          lastHeard.set(documentId, Date.now());
          openFrameThread(documentId, msg.interactionId, msg.spaceId, frameUrl);
          return;
        }
        case "frame-report": {
          if (!documentId || !Array.isArray(msg.interactions)) return;
          // Made under another account than this frame holds now: not this person's.
          if (scope === null || msg.generation !== accountGeneration()) return;
          // A space's snapshots taken before the newest access change told
          // here are not taken (3-F5).
          const list = acceptReported<Snapshot>(
            msg.interactions,
            (msg.revs ?? {}) as Record<string, unknown>,
            (sp) => knownRev.get(sp) ?? 0,
            (sp) => app.space(sp) !== undefined,
          );
          lastHeard.set(documentId, Date.now());
          if (list.length === 0) childFrames.delete(documentId);
          else
            childFrames.set(documentId, {
              url: frameUrl,
              ...(typeof msg.page === "string" ? { page: msg.page } : {}),
              interactions: list,
            });
          // Its variant sets, as its panel here mirrors them (E-1).
          const gate = spaceGate(
            (msg.revs ?? {}) as Record<string, unknown>,
            (sp) => knownRev.get(sp) ?? 0,
            (sp) => app.space(sp) !== undefined,
          );
          // The preview pill is derived from these alone (2-E3).
          variants.mirror(documentId, acceptSets(msg.sets, gate));
          // Its kept edits, for the launcher's marker and the Kept edits list (E-2).
          const kept = acceptKept(msg.kept, gate);
          if (kept.rows.length > 0) frameKept.set(documentId, kept);
          else frameKept.delete(documentId);
          // Its tray edits, listed in the top frame's tray (E-3).
          const ops = acceptOps(msg.ops);
          if (ops.length > 0) frameOps.set(documentId, { url: frameUrl, host: frameHost, ops });
          else frameOps.delete(documentId);
          batch.remoteChanged();
          for (const s of list) noteInteractionSpace(s.id, s.spaceId);
          app.requestRender();
          const open = modal.isOpen() ? modal.currentId() : null;
          if (open && list.some((s) => s.id === open)) modal.remoteTick();
          return;
        }
        case "frame-gone":
          forgetFrame(documentId);
          return;
        case "frame-command": {
          const command = String(msg.command);
          window.focus();
          if (command === "commandBar") {
            commandBar.toggle();
            return;
          }
          if (!(COMMAND_IDS as readonly string[]).includes(command)) return;
          // The same guards as a chord typed here: not over an open bar or composer.
          if (commandBar.isOpen() || composerWin.isOpen() || thread.isOpen()) return;
          runCommand(command as CommandId);
          return;
        }
      }
    }

    // ── child frame ──
    /** The pick the top frame relayed here, while it runs. */
    let relayPick: { pickId: string; kind: string } | null = null;
    /** A pick running while this frame is one onlay can't anchor in (A-3): its hint is owed. */
    let sandboxPick: string | null = null;
    if (sandboxed) {
      const owe = (e: Event): void => {
        if (!sandboxPick || !isTrustedEvent(e)) return;
        const pickId = sandboxPick;
        sandboxPick = null; // once per pick
        tellSw({ type: "framePickHint", pickId });
      };
      window.addEventListener("mousemove", owe, { capture: true, passive: true });
      window.addEventListener("click", owe, { capture: true });
    }
    /** The block this frame picked for the top frame's open composer. */
    let ownPick: {
      pickId: string;
      anchor: Anchor;
      el: Element;
      capture: AnchorCapture | null;
      /** The page key and account generation it was picked under (2-F3). */
      page: string | null;
      generation: number | null;
      /** The block is still in the document and frames it was picked in (2-A2). */
      pin?: () => boolean;
    } | null = null;

    /** A trusted click here completed the top frame's pick (`path`: the block's frames, A-3). */
    function childPicked(
      rp: { pickId: string; kind: string },
      t: Element,
      path: string[],
      click: { x: number; y: number },
    ): void {
      if (rp.kind === "copy") {
        // Clipboard only, inside this click's gesture (F-041): nothing is sent anywhere.
        copyElement(t, navigator.clipboard, toast);
        const anchor = anchorForElement(t, path);
        tellSw({ type: "framePicked", pickId: rp.pickId, kind: "copy", anchor, label: "" });
        clearSelection();
        return;
      }
      if (rp.kind === "token") {
        const anchor = anchorForElement(t, path);
        tellSw({
          type: "framePicked",
          pickId: rp.pickId,
          kind: "token",
          anchor,
          label: anchorLabel(anchor),
        });
        clearSelection();
        return;
      }
      const anchor =
        anchorForSelection(t.ownerDocument.defaultView ?? window, path) ??
        anchorForElement(t, path);
      ownPick = {
        pickId: rp.pickId,
        anchor,
        el: t,
        capture: anchor.level === "element" ? sanitizeElement(t) : null,
        page: pageKey(location.href),
        generation: accountGeneration(),
        pin: pinBlock(t),
      };
      // The block keeps its outline while the top frame's composer is open.
      selectedEl = t;
      placeBox(selBox, t);
      tellSw({
        type: "framePicked",
        pickId: rp.pickId,
        kind: rp.kind,
        anchor,
        label: anchorLabel(anchor),
      });
      void placeForTop(rp.pickId, t, click);
    }

    /**
     * Tell the top frame, once, where the click that picked this block is in
     * the tab, so its composer opens beside it (frame-place.ts). Not placed:
     * said so, and the card opens centred. A pick whose page or account
     * changed meanwhile is said to be stale: no card opens.
     */
    async function placeForTop(
      pickId: string,
      t: Element,
      click: { x: number; y: number },
    ): Promise<void> {
      let answer: unknown;
      try {
        answer = await chrome.runtime.sendMessage({
          type: "frameLocate",
          phase: "place",
          holdId: crypto.randomUUID().replace(/-/g, ""),
          rect: { x: 0, y: 0, width: 0, height: 0 },
        });
      } catch {
        answer = null;
      }
      const pick = ownPick;
      if (pick?.pickId !== pickId) return; // the pick ended meanwhile
      if (pageKey(location.href) !== pick.page || accountGeneration() !== pick.generation) {
        tellSw({ type: "framePlaced", pickId, stale: true });
        return;
      }
      const p = parsePlacement(answer);
      // The block's frames without an address of their own must map by plain
      // offsets, as `rectInOwner` carries the click up: a rotated or scaled one places nothing.
      if (!p || !plainFramePath(t, document)) {
        tellSw({ type: "framePlaced", pickId });
        return;
      }
      tellSw({ type: "framePlaced", pickId, at: placePoint(p, click) });
    }

    const FRAME_SENDS = new Set([
      "interaction-reply",
      "interaction-edit",
      "interaction-delete",
      "interaction-react",
      "ask-answer",
      "interaction-resolve",
      "interaction-reopen",
    ]);

    /** The top frame's tray acts on this frame's own tray edits (E-3). */
    async function onTrayCall(call: Record<string, unknown>): Promise<Record<string, unknown>> {
      switch (call.op) {
        case "batchRemove": {
          const index = typeof call.index === "number" ? call.index : -1;
          return { ok: batch.removeAt(index) };
        }
        case "batchSend": {
          // This document's tray edits, as one Edit bound to its own address (E-3).
          if (typeof call.spaceId !== "string" || !app.space(call.spaceId))
            return { ok: false, error: "invalid" };
          const r = await batch.sendHere(call.spaceId);
          return { ...r };
        }
        case "batchDismiss":
          batch.dismiss();
          return { ok: true };
        default:
          batch.commitEdit();
          return { ok: true, ops: batch.listOps() };
      }
    }

    /** The top frame asks this frame to act on what is bound to this frame's address. */
    async function onFrameCall(call: Record<string, unknown>): Promise<Record<string, unknown>> {
      switch (call.op) {
        case "create": {
          const pick = ownPick;
          const payload = call.payload as Record<string, unknown> | undefined;
          if (!ownsBlocks || !pick || pick.pickId !== call.pickId || !payload)
            return { ok: false, reason: "stale-pick" };
          // The pick is for the page and account it was made under (2-F3): a
          // route change or another account since then sends nothing.
          if (pageKey(location.href) !== pick.page || accountGeneration() !== pick.generation)
            return { ok: false, reason: "page-changed" };
          const kind = payload.kind;
          const asked = payload.change as Record<string, unknown> | undefined;
          // A page Edit's provenance is this document's own stamp, never the caller's (E-3).
          const { provenance: _theirs, ...rest } = asked ?? {};
          const ownStamp = pick.anchor.level === "page" ? documentProvenance() : undefined;
          const change = asked
            ? ({ ...rest, ...(ownStamp ? { provenance: ownStamp } : {}) } as { method?: unknown })
            : undefined;
          // Comments and Direct Edits only: variants stay with the top document (F-5).
          if (kind !== "comment" && kind !== "change") return { ok: false, reason: "invalid" };
          if (kind === "change" && change?.method !== "direct")
            return { ok: false, reason: "invalid" };
          if (typeof call.spaceId !== "string" || typeof call.nonce !== "string")
            return { ok: false, reason: "invalid" };
          // The anchor and the markup are this frame's own pick, never the caller's.
          app.setCapture(pick.capture);
          app.stageSnapshotSource(pick.anchor.level === "page" ? null : pick.el, pick.pin);
          const r = await app.createInteraction(
            {
              kind,
              anchor: pick.anchor,
              // Checked by the service worker right before it sends (3-F3).
              pickGeneration: pick.generation,
              ...(payload.body !== undefined ? { body: payload.body } : {}),
              ...(change !== undefined ? { change } : {}),
            },
            call.spaceId,
            call.nonce,
          );
          return { ...r };
        }
        case "variants": {
          // Variants of the block (or page) this frame picked (E-1): the set is
          // created here, bound to this frame's address, with this frame's pick.
          const pick = ownPick;
          if (!ownsBlocks || !pick || pick.pickId !== call.pickId)
            return { ok: false, reason: "stale-pick" };
          if (pageKey(location.href) !== pick.page || accountGeneration() !== pick.generation)
            return { ok: false, reason: "page-changed" };
          // Not for a block in a frame of this page without an address of its own (A-3).
          if ("framePath" in pick.anchor && pick.anchor.framePath !== undefined)
            return { ok: false, reason: "invalid" };
          const command = typeof call.command === "string" ? call.command : "";
          const count = typeof call.count === "number" ? Math.floor(call.count) : 0;
          const intent = call.intent === "insert-after" ? "insert-after" : "change";
          if (!command || count < 1 || typeof call.spaceId !== "string")
            return { ok: false, reason: "invalid" };
          const r = await variants.startFromChange(
            pick.anchor.level === "page" ? null : pick.el,
            command,
            count,
            intent,
            call.spaceId,
            { pickGeneration: pick.generation },
          );
          return { ...r };
        }
        case "pagePick": {
          // The page composer the top frame's tray opens for this frame's page
          // (E-3): only while this document holds tray edits of its own.
          const pickId = typeof call.pickId === "string" ? call.pickId : "";
          if (!ownsBlocks || !/^[A-Za-z0-9_-]{1,64}$/.test(pickId) || batch.localOpCount() === 0)
            return { ok: false, error: "not-here" };
          ownPick = {
            pickId,
            anchor: { level: "page" },
            el: document.body,
            capture: null,
            page: pageKey(location.href),
            generation: accountGeneration(),
          };
          return { ok: true };
        }
        case "batchRemove":
        case "batchSend":
        case "batchDismiss":
        case "batchCommit":
          // Only a tray call made under the account held here now (3-E3).
          if (!trayCallAllowed(call, accountGeneration()))
            return { ok: false, error: "page-changed" };
          return { ...(await onTrayCall(call)), generation: accountGeneration() };
        case "keptOn": {
          // The top frame's Kept edits list switches one of this frame's (E-2).
          const id = typeof call.interactionId === "string" ? call.interactionId : "";
          if (!layer.rows().some((r) => r.interactionId === id) || typeof call.on !== "boolean")
            return { ok: false, error: "not-here" };
          layer.setOn(id, call.on);
          return { ok: true };
        }
        case "variant": {
          // The top frame's panel acts on one of this frame's sets (E-1).
          const act = parseRemoteAct(call.act);
          if (!act || typeof call.setId !== "string") return { ok: false, error: "invalid" };
          return { ok: variants.drive(call.setId, act) };
        }
        case "reanchor": {
          // The top frame's thread re-anchors a thread bound to this frame's
          // address (A-1): only a click in this document answers, and the
          // re-anchor is sent from here.
          const id = typeof call.interactionId === "string" ? call.interactionId : "";
          const pickId = typeof call.pickId === "string" ? call.pickId : "";
          // Only a thread bound to exactly this frame's page (3-A1).
          if (!ownsBlocks || !onThisPage(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(pickId))
            return { ok: false, error: "not-here" };
          ownPick = null;
          clearSelection();
          setMode("reanchor");
          reanchorTarget = id;
          relayPick = { pickId, kind: "reanchor" };
          adoptFrames();
          toast(REANCHOR_HINT);
          return { ok: true };
        }
        // The top frame is about to open a card for this pick: is it still the one held here?
        case "pickLive":
          return {
            ok:
              ownPick !== null &&
              ownPick.pickId === call.pickId &&
              pageKey(location.href) === ownPick.page &&
              accountGeneration() === ownPick.generation,
          };
        case "clearPick":
          if (ownPick?.pickId === call.pickId) {
            ownPick = null;
            clearSelection();
          }
          return { ok: true };
        case "send": {
          const frame = call.frame as Record<string, unknown> | undefined;
          const type = typeof frame?.type === "string" ? frame.type : "";
          const id = typeof frame?.interactionId === "string" ? frame.interactionId : "";
          // Only what this frame holds, bound to its own address.
          if (!frame || !FRAME_SENDS.has(type) || !app.byId(id))
            return { ok: false, error: "not-here" };
          const r =
            type === "interaction-reply" && typeof frame.clientId === "string"
              ? await app.sendForReceipt(frame as never, "reply", id)
              : await app.send(frame as never);
          return { ...r };
        }
        case "reveal": {
          const id = typeof call.interactionId === "string" ? call.interactionId : "";
          if (!app.byId(id)) return { ok: false };
          pins.flash(id);
          return { ok: true };
        }
        default:
          return { ok: false, error: "invalid" };
      }
    }

    /** The last report sent to the top frame; null until there is something to say. */
    let lastReport: string | null = null;
    let lastReportAt = 0;
    let reportTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleFrameReport(): void {
      if (!ownsBlocks || reportTimer !== null) return;
      reportTimer = setTimeout(() => {
        reportTimer = null;
        const list = app.interactions();
        const generation = accountGeneration();
        const revs = Object.fromEntries(snapRev);
        // Its variant sets and preview pill, for the top frame's panel (E-1).
        const { sets } = variants.mirrors();
        // Its kept edits, for the top frame's marker and Kept edits list (E-2).
        const keptRows = layer.rows();
        // Its tray edits, for the top frame's tray (E-3).
        const ops = batch.listOps();
        const edits = {
          sets,
          ...(keptRows.length > 0 ? { kept: { rows: keptRows, shown: layer.shownCount() } } : {}),
          ...(ops.length > 0 ? { ops } : {}),
        };
        const page = pageKey(location.href) ?? "";
        const key = `${generation}|${page}|${JSON.stringify(revs)}|${JSON.stringify(list)}|${JSON.stringify(edits)}`;
        // A frame with no threads and no pick says nothing until it has some;
        // an unchanged report is repeated every 20 s, or the top frame forgets
        // it (2-F5, 3-F5).
        if (
          lastReport === null &&
          list.length === 0 &&
          !ownPick &&
          sets.length === 0 &&
          keptRows.length === 0 &&
          ops.length === 0
        )
          return;
        if (key === lastReport && Date.now() - lastReportAt < 20_000) return;
        lastReport = key;
        lastReportAt = Date.now();
        tellSw({ type: "frameReport", interactions: list, generation, revs, page, ...edits });
      }, 100);
    }

    // ── single-page apps: a route change is a new page ──
    // Everything onlay applied belonged to the old URL. The layer re-checks every
    // kept program and preview against the new one (only exact matches go back
    // on), the variant panels follow, and the page re-syncs for its new URL.
    let lastPage = pageKey(location.href);
    const routeCheck = (): void => {
      let now: string | null;
      try {
        now = pageKey(location.href);
      } catch {
        return; // the page (or a test harness) took `location` away
      }
      if (now === lastPage) return;
      lastPage = now;
      layer.pageChanged();
      variants.pageChanged();
      if (connected) syncAll();
    };
    window.addEventListener("popstate", routeCheck);
    window.addEventListener("hashchange", routeCheck);
    try {
      (window as unknown as { navigation?: EventTarget }).navigation?.addEventListener(
        "currententrychange",
        routeCheck,
      );
    } catch {
      /* no Navigation API: the poll below covers pushState */
    }
    setInterval(routeCheck, 500);

    // Frames of this page without an address of their own (A-3).
    adoptFrames();

    // ── initial status (also nudges the SW awake) ──
    pullStatus(true);
  };

  const go = (): void => void draftsRestored.then(start);
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", go, { once: true });
  else go();
})();
