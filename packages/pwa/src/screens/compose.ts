// #/compose — a new UNANCHORED Comment (the web app holds no page, so it
// creates nothing anchored; Ask is hidden). The person picks the space it
// goes to — only spaces they are a member of — and the mention list is that
// space's people plus `@agent`. Attach ordering: a new Comment has no id until
// Send, and capture-init is interaction-scoped, so attachments are staged
// locally and the send sequence is strict — (1) create → obtain id; (2) upload
// each staged file against that id; (3) done. A mid-flight upload failure
// leaves the Comment posted; the composer keeps the file and offers Retry
// against the now-known id (the Comment is not re-sent).

import { type SpaceSelect, spaceSelect } from "@onlay/render/space-select";
import * as api from "../api";
import { type StagedFile, uploadAttachment } from "../attach";
import { emptyState, header, screenBody } from "../chrome";
import { composer } from "../components/composer";
import { toast } from "../components/toast";
import type { AppCtx, Screen } from "../context";
import { button, el } from "../dom";
import { mentionCtx } from "../mention-ctx";
import { COMPOSE_DRAFT_ID, draftKey, hashFor, memberSpaces } from "../view-model";

/** The space field's words (the extension's composer says the same). */
const SPACE_SELECT_COPY = {
  label: "Space",
  search: "Search spaces…",
  searchLabel: "Search spaces",
  list: "Spaces",
  empty: "No matching spaces.",
  personal: "Just you",
  /** Under Send when the chosen space was lost since: nothing was sent, the text stays. */
  lost: "You're no longer a member of that space. Choose another space, then send again.",
} as const;

/** The last space a Comment went to, offered first next time. */
let lastSpace: string | null = null;

export function composeScreen(ctx: AppCtx): Screen {
  const node = el("div", "screen compose");
  node.append(header("New comment", { back: "#/inbox", onNav: (h) => ctx.router.go(h) }));
  const body = screenBody();
  node.append(body);

  const spaces = memberSpaces(ctx.me.spaces);
  const first = spaces[0];
  if (!first) {
    body.append(emptyState("There's no space you can comment in."));
    return { node };
  }
  let spaceId = spaces.some((s) => s.id === lastSpace) ? (lastSpace as string) : first.id;

  const staged: StagedFile[] = [];
  let createdId: string | null = null; // set once (1) succeeds; drives Retry
  let createdIn: string | null = null;

  // ── which space: one field and a searchable menu when there is more than one ──
  /** The spaces the person may comment in now (`ctx.me` is replaced on every reload). */
  const spaceOptions = () =>
    memberSpaces(ctx.me.spaces).map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.kind === "personal" ? { note: SPACE_SELECT_COPY.personal } : {}),
    }));
  const optionsKey = (): string =>
    spaceOptions()
      .map((s) => `${s.id}:${s.name}`)
      .join("\n");
  let shownOptions = optionsKey();
  let select: SpaceSelect | null = null;
  if (spaces.length > 1) {
    const choice = el("div", "stakes-dial space-choice");
    select = spaceSelect({
      doc: document,
      spaces: spaceOptions,
      value: spaceId,
      copy: SPACE_SELECT_COPY,
      classes: { label: "field-label" },
      metrics: () => ({ margin: 12, gap: 6, minWidth: 240 }),
      // A posted Comment's space is fixed, and so is one being sent.
      locked: () => createdId !== null || send.disabled,
      onChange: (id) => {
        if (createdId || send.disabled) return;
        spaceId = id;
        lastSpace = id;
        void mentions.loadDirectory();
      },
    });
    choice.append(select.element);
    body.append(choice);
  }

  const note = el("p", "composer-note");
  const mentions = mentionCtx(ctx, () => spaceId);
  void mentions.loadDirectory();

  // ── the body: the shared token composer inside the card shell ──
  const fieldCard = el("div", "compose-card");
  const c = composer(mentions, {
    placeholder: "Your comment… @agent hands it to an agent",
    draftKey: draftKey("compose", COMPOSE_DRAFT_ID),
    onDraftRestored: () => {
      note.textContent = "Your draft is still here.";
    },
    onSubmit: () => void doSend(),
  });
  fieldCard.append(c.node);
  body.append(fieldCard);

  // ── attach evidence — the composer-toolbar 📎, staged chips in the card ──
  const fileInput = el("input", "attach-input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.arrayBuffer().then((buf) => {
      staged.push({ file, bytes: new Uint8Array(buf) });
      renderStaged();
      fileInput.value = "";
    });
  });
  const attachBtn = button("icon-btn tool-btn", "📎", () => fileInput.click());
  attachBtn.setAttribute("aria-label", "Attach evidence");
  const attachHolder = el("span", "attach-tool");
  attachHolder.append(attachBtn, fileInput);
  c.tools.append(attachHolder);
  const stagedList = el("div", "staged-list");
  fieldCard.append(stagedList);
  function renderStaged(): void {
    stagedList.textContent = "";
    staged.forEach((s, i) => {
      const chip = el("div", "staged-chip");
      chip.append(el("span", "staged-name", s.file.name));
      const x = button("icon-btn", "×", () => {
        staged.splice(i, 1);
        renderStaged();
      });
      x.setAttribute("aria-label", `Remove ${s.file.name}`);
      chip.append(x);
      stagedList.append(chip);
    });
  }

  // ── send ──
  const send = button("btn btn-primary compose-send", "Send", () => void doSend());
  body.append(send, note);

  async function doSend(): Promise<void> {
    // Enter and the Send button share one in-flight guard.
    if (send.disabled) return;
    const msgBody = c.value();
    if (!msgBody.text && !createdId) {
      note.textContent = "Write something first.";
      return;
    }
    // A menu still open would change nothing now: it closes as sending starts.
    select?.close();
    // The space chosen, lost since (a reload of who you are said so): nothing
    // goes, the draft stays.
    if (!createdId && !memberSpaces(ctx.me.spaces).some((s) => s.id === spaceId)) {
      note.textContent = SPACE_SELECT_COPY.lost;
      return;
    }
    send.disabled = true;
    note.textContent = "";

    // (1) create — unless we already have an id from a prior partial send (Retry)
    if (!createdId) {
      // Where it goes is fixed before the wait: nothing chosen meanwhile moves it.
      const target = spaceId;
      const res = await api.createComment(ctx.client, target, msgBody);
      if (!res.ok) {
        send.disabled = false;
        note.textContent =
          res.verdict === "refused" && res.message
            ? res.message
            : res.verdict === "offline"
              ? "You're offline. Your draft is still here."
              : "Couldn't reach the server. Your draft is still here.";
        return;
      }
      createdId = res.data.interactionId;
      createdIn = target;
    }

    // (2) upload each staged attachment against the id
    const id = createdId;
    const where = createdIn ?? spaceId;
    for (let i = staged.length - 1; i >= 0; i--) {
      const s = staged[i];
      if (!s) continue;
      const okUpload = await uploadAttachment(ctx.client, where, id, s);
      if (!okUpload) {
        send.disabled = false;
        send.textContent = "Retry";
        note.textContent =
          "Your comment is posted, but the attachment didn't upload. Retry to send it.";
        return; // keep remaining staged files; Retry re-runs (2) against the same id
      }
      staged.splice(i, 1);
      renderStaged();
    }

    // (3) done
    c.clear();
    toast("Comment sent.");
    ctx.router.go(hashFor({ name: "thread", spaceId: where, id }));
  }

  return {
    node,
    // A refresh round re-read who you are: spaces joined, left or renamed
    // close an open menu, which offers them as they are now when it opens again.
    refresh() {
      const now = optionsKey();
      if (now === shownOptions) return true;
      shownOptions = now;
      select?.refresh();
      return true;
    },
    dispose() {
      select?.close();
    },
  };
}
