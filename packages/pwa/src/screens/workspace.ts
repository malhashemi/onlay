// #/settings/workspace/<spaceId> — one workspace. Admins manage it: members
// (role change, remove), invite by email (no email is sent; the person joins
// when they next sign in, or at once if they already have an account),
// pending invitations (cancel), rename (live name check), delete (type the
// name). Members who are not admins see the member list read-only and may
// leave. Refusals (`last_admin`, `conflict`) are said as the server sends them.
import {
  INVITATION_WAITING_SPACE_LIMIT,
  LIMITS,
  type WorkspaceMember,
  type WorkspaceResponse,
} from "@onlay/protocol";
import { age } from "@onlay/render/interaction-view";
import * as api from "../api";
import { errorState, header, notHere, screenBody } from "../chrome";
import { avatar } from "../components/avatar";
import { offlineBanner } from "../components/banner";
import { confirmButton, itemRow, labelledField, note, section } from "../components/settings";
import { failureToast, toast } from "../components/toast";
import { type AppCtx, roleIn, type Screen } from "../context";
import { button, clear, el } from "../dom";
import { workspaceNameHint } from "../view-model";

/** A pending invitation whose invitee is already a member of the most spaces one person may join (S-3). */
const WAITING_ON_LIMIT = `waiting: member of ${LIMITS.MAX_SPACES_PER_PERSON} spaces, needs to leave one`;

export function workspaceScreen(ctx: AppCtx, spaceId: string): Screen {
  const node = el("div", "screen settings");
  const head = header("Workspace", { back: "#/settings/spaces", onNav: (h) => ctx.router.go(h) });
  node.append(head);
  const body = screenBody();
  node.append(body);
  // Live refreshes repaint the lists only; the forms keep what's typed.
  const lists = el("div", "settings-stack");
  const forms = el("div", "settings-stack");
  let formsFor = "";
  let lastPaint = "";

  async function load(): Promise<boolean> {
    const role = roleIn(ctx, spaceId);
    if (role !== "admin" && role !== "member") {
      clear(body);
      body.append(notHere(() => ctx.router.go("#/inbox")));
      return true;
    }
    const res = await api.workspace(ctx.client, spaceId);
    if (!res.ok) {
      clear(body);
      lastPaint = "";
      formsFor = "";
      if (res.verdict === "hidden") body.append(notHere(() => ctx.router.go("#/inbox")));
      else if (res.verdict === "offline") body.append(offlineBanner());
      else body.append(errorState("Couldn't reach the server.", () => void load()));
      return false;
    }
    const key = JSON.stringify([res.data, res.fromCache, role]);
    if (key !== lastPaint) {
      lastPaint = key;
      if (!body.contains(lists)) {
        clear(body);
        body.append(lists, forms);
      }
      renderLists(res.data, role === "admin", res.fromCache ? res.syncedAt : undefined);
      const formKey = JSON.stringify([res.data.space.name, role]);
      if (formKey !== formsFor) {
        formsFor = formKey;
        renderForms(res.data, role === "admin");
      }
    }
    return !res.fromCache;
  }

  async function after(res: { ok: true } | api.Fail, done: string): Promise<boolean> {
    if (!res.ok) {
      toast(failureToast(res));
      return false;
    }
    toast(done);
    lastPaint = "";
    await ctx.reloadMe();
    await load();
    return true;
  }

  function renderLists(w: WorkspaceResponse, admin: boolean, syncedAt?: number): void {
    clear(lists);
    const title = head.querySelector(".app-title");
    if (title) title.textContent = w.space.name;
    if (syncedAt !== undefined) lists.append(offlineBanner(syncedAt));

    // ── members ──
    const members = section(`Members · ${w.members.length}`);
    for (const m of w.members) members.append(memberRow(m, admin));
    lists.append(members);

    // ── pending invitations (admins) ──
    if (admin) {
      const pending = section("Pending invitations");
      const invites = w.invitations ?? [];
      if (invites.length === 0) pending.append(note("No one is waiting to join."));
      for (const inv of invites) {
        const cancel = button("btn btn-ghost btn-sm", "Cancel", () => {
          cancel.disabled = true;
          void api
            .cancelInvitation(ctx.client, spaceId, inv.email)
            .then((res) => after(res, `Invitation for ${inv.email} canceled.`))
            .then((ok) => {
              if (!ok) cancel.disabled = false;
            });
        });
        cancel.setAttribute("aria-label", `Cancel the invitation for ${inv.email}`);
        pending.append(
          itemRow(
            inv.email,
            `invited by ${inv.invitedBy.name} · ${age(inv.createdAt)} ago${
              inv.waiting === INVITATION_WAITING_SPACE_LIMIT ? ` · ${WAITING_ON_LIMIT}` : ""
            }`,
            [cancel],
          ),
        );
      }
      lists.append(pending);
    }
  }

  function memberRow(m: WorkspaceMember, admin: boolean): HTMLElement {
    const self = m.person.id === ctx.me.person.id;
    const title = self ? `${m.person.name} (you)` : m.person.name;
    const meta = `${m.person.email} · ${m.role}`;
    if (!admin || self) return itemRow(title, meta, [], avatar(m.person, "sm"));
    const nextRole = m.role === "admin" ? "member" : "admin";
    const roleBtn = button(
      "btn btn-ghost btn-sm",
      m.role === "admin" ? "Make member" : "Make admin",
      () => {
        roleBtn.disabled = true;
        void api
          .setMemberRole(ctx.client, spaceId, m.person.id, nextRole)
          .then((res) =>
            after(
              res,
              `${m.person.name} is now ${nextRole === "admin" ? "an admin" : "a member"}.`,
            ),
          )
          .then((ok) => {
            if (!ok) roleBtn.disabled = false;
          });
      },
    );
    const remove = confirmButton("btn btn-ghost btn-sm", "Remove", "Tap again to remove", () => {
      void api
        .removeMember(ctx.client, spaceId, m.person.id)
        .then((res) => after(res, `${m.person.name} was removed.`));
    });
    remove.setAttribute("aria-label", `Remove ${m.person.name}`);
    return itemRow(title, meta, [roleBtn, remove], avatar(m.person, "sm"));
  }

  function renderForms(w: WorkspaceResponse, admin: boolean): void {
    clear(forms);
    if (admin) {
      // ── invite ──
      const invite = section("Invite");
      invite.append(
        note(
          "No email is sent. Tell them yourself: they join when they next sign in with this email, or at once if they already have an account.",
        ),
      );
      const email = labelledField("Email", { type: "email", placeholder: "name@example.com" });
      const send = button("btn btn-primary", "Invite", () => void doInvite());
      email.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.isTrusted) void doInvite();
      });
      invite.append(email.wrap, send);
      forms.append(invite);

      async function doInvite(): Promise<void> {
        const value = email.input.value.trim();
        if (!value || send.disabled) return;
        send.disabled = true;
        const res = await api.invite(ctx.client, spaceId, value);
        send.disabled = false;
        if (!res.ok) {
          email.hint.textContent = res.message ?? failureToast(res);
          return;
        }
        email.input.value = "";
        email.hint.textContent = "";
        await after(
          { ok: true },
          res.data.joined
            ? `${value} joined ${w.space.name}.`
            : res.data.waiting === INVITATION_WAITING_SPACE_LIMIT
              ? `Invited ${value}. They're already a member of ${LIMITS.MAX_SPACES_PER_PERSON} spaces, so they join after they leave one and sign in again.`
              : `Invited ${value}. They join when they next sign in.`,
        );
      }

      // ── rename ──
      const rename = section("Name");
      const name = labelledField("Workspace name", { value: w.space.name });
      const save = button("btn btn-secondary", "Rename", () => void doRename());
      save.disabled = true;
      name.input.addEventListener("input", () => {
        const hint = workspaceNameHint(name.input.value);
        name.hint.textContent = hint.message;
        save.disabled = !hint.ok || name.input.value === w.space.name;
      });
      rename.append(name.wrap, save);
      forms.append(rename);

      async function doRename(): Promise<void> {
        if (save.disabled) return;
        save.disabled = true;
        const res = await api.renameWorkspace(ctx.client, spaceId, name.input.value);
        if (!res.ok) {
          save.disabled = false;
          name.hint.textContent = res.message ?? failureToast(res);
          return;
        }
        formsFor = "";
        await after({ ok: true }, `Renamed to ${name.input.value}.`);
      }
    }

    // ── leave ──
    const leave = section("Leave");
    leave.append(note(`Leave ${w.space.name}. You'll need a new invitation to come back.`));
    const leaveBtn = confirmButton(
      "btn btn-secondary",
      "Leave workspace",
      "Tap again to leave",
      () => {
        void api.removeMember(ctx.client, spaceId, ctx.me.person.id).then(async (res) => {
          if (!res.ok) {
            toast(failureToast(res));
            return;
          }
          toast(`You left ${w.space.name}.`);
          await ctx.reloadMe();
          ctx.router.go("#/settings/spaces");
        });
      },
    );
    leave.append(leaveBtn);
    forms.append(leave);

    // ── delete (admins) ──
    if (admin) {
      const danger = section("Delete workspace", "danger");
      danger.append(
        note(
          `This deletes ${w.space.name} and every thread in it for everyone. This can't be undone.`,
        ),
      );
      const confirm = labelledField("Type the workspace's name to confirm", {
        placeholder: w.space.name,
      });
      const del = button("btn btn-danger", "Delete workspace", () => void doDelete());
      del.disabled = true;
      confirm.input.addEventListener("input", () => {
        del.disabled = confirm.input.value !== w.space.name;
        confirm.hint.textContent = "";
      });
      danger.append(confirm.wrap, del);
      forms.append(danger);

      async function doDelete(): Promise<void> {
        if (del.disabled) return;
        del.disabled = true;
        const res = await api.deleteWorkspace(ctx.client, spaceId, confirm.input.value);
        if (!res.ok) {
          del.disabled = false;
          confirm.hint.textContent = res.message ?? failureToast(res);
          return;
        }
        toast(`Deleted ${w.space.name}.`);
        await ctx.reloadMe();
        ctx.router.go("#/settings/spaces");
      }
    }
  }

  void load();
  return { node, refresh: () => load() };
}
