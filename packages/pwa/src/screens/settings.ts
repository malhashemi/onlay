// #/settings and its sub-screens. The index leads to Account, Spaces,
// Deployment (super admins only) and Agent, and keeps this device's own
// settings: theme, notifications, offline. Each workspace's own screen lives
// in workspace.ts.
//   Account     — name (PATCH /api/me; theirs from then on, over the sign-in's),
//                 picture (choose one, resized here before PUT /api/me/picture;
//                 remove it; or the sign-in's), email, sign out, sign out
//                 everywhere, delete account (type your email; `last_admin` is said as sent).
//   Spaces      — the person's spaces with their role, create a workspace
//                 when allowed (live name check), leave a workspace.
//   Deployment  — who may create workspaces, the creators list, super admins.
//   Agent       — how to connect an agent: the MCP URL, a config, the plugins.
import type {
  AdminSettingsResponse,
  WorkspaceCreationPolicy,
  WorkspaceCreator,
} from "@onlay/protocol";
import { WORKSPACE_CREATION_POLICIES } from "@onlay/protocol";
import type { Result } from "../api";
import * as api from "../api";
import { errorState, header, screenBody } from "../chrome";
import { avatar } from "../components/avatar";
import { offlineBanner } from "../components/banner";
import {
  confirmButton,
  copyBlock,
  itemRow,
  labelledField,
  navRow,
  note,
  section,
} from "../components/settings";
import { failureToast, toast } from "../components/toast";
import { type AppCtx, type Screen, siteOrigin } from "../context";
import { mcpConfig, PLUGIN_LINES } from "../copy-for-agent";
import { button, clear, el } from "../dom";
import { preparePicture } from "../picture";
import { disablePush, enablePush, type PushState, pushState } from "../push";
import { applyTheme, getTheme, type Theme } from "../theme";
import {
  CREATION_POLICY_LABEL,
  creatorOf,
  hashFor,
  memberSpaces,
  type SettingsPage,
  workspaceNameHint,
} from "../view-model";

export function settingsScreen(ctx: AppCtx, page: SettingsPage): Screen {
  switch (page) {
    case "index":
      return indexScreen(ctx);
    case "account":
      return accountScreen(ctx);
    case "spaces":
      return spacesScreen(ctx);
    case "deployment":
      return ctx.me.superAdmin ? deploymentScreen(ctx) : indexScreen(ctx);
    case "agent":
      return agentScreen(ctx);
  }
}

function frame(ctx: AppCtx, title: string, back: string): { node: HTMLElement; body: HTMLElement } {
  const node = el("div", "screen settings");
  node.append(header(title, { back, onNav: (h) => ctx.router.go(h) }));
  const body = screenBody();
  node.append(body);
  return { node, body };
}

const go = (ctx: AppCtx, page: SettingsPage) => () =>
  ctx.router.go(hashFor({ name: "settings", page }));

/* ── index ─────────────────────────────────────────────────────────── */

const THEMES: Theme[] = ["light", "dark", "system"];

function indexScreen(ctx: AppCtx): Screen {
  const { node, body } = frame(ctx, "Settings", "#/inbox");

  const nav = el("section", "inbox-section");
  const spaces = memberSpaces(ctx.me.spaces);
  nav.append(navRow("Account", ctx.me.person.email, go(ctx, "account")));
  nav.append(
    navRow(
      "Spaces",
      spaces.length === 1 ? "1 space" : `${spaces.length} spaces`,
      go(ctx, "spaces"),
    ),
  );
  if (ctx.me.superAdmin) {
    nav.append(navRow("Server", "Workspace creation and super admins", go(ctx, "deployment")));
  }
  nav.append(navRow("Agent", "Connect an agent to Onlay", go(ctx, "agent")));
  // The install steps are a page of the service, outside the app: a new tab.
  nav.append(
    navRow("Extension", "Install Onlay in Chrome", () => {
      window.open(`${siteOrigin(ctx)}/install`, "_blank", "noopener");
    }),
  );
  body.append(nav);

  // ── theme ──
  const themeSec = section("Theme");
  const segs = el("div", "segmented");
  const current = getTheme();
  for (const t of THEMES) {
    const b = el("button", `seg ${t === current ? "chosen" : ""}`) as HTMLButtonElement;
    b.type = "button";
    b.textContent = t === "system" ? "System" : t === "dark" ? "Dark" : "Light";
    b.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      applyTheme(t);
      for (const c of segs.children) c.classList.remove("chosen");
      b.classList.add("chosen");
    });
    segs.append(b);
  }
  themeSec.append(segs);
  body.append(themeSec);

  // ── notifications: unsupported / denied / off → Enable / on → Disable ──
  const notifSec = section("Notifications");
  const notifNote = note("");
  const notifBtn = button("btn btn-secondary", "", () => void toggleNotifications());
  notifBtn.hidden = true;
  notifSec.append(notifNote, notifBtn);
  body.append(notifSec);

  let notifState: PushState = "unsupported";
  void renderNotifications();

  async function renderNotifications(): Promise<void> {
    notifState = await pushState();
    const copy: Record<PushState, string> = {
      unsupported: "Notifications need a secure connection and a browser with push support.",
      denied:
        "The browser is blocking notifications for this site. Allow them in site settings, then come back.",
      off: "Get a notification when something needs you.",
      on: "This device is notified when something needs you.",
    };
    notifNote.textContent = copy[notifState];
    notifBtn.hidden = notifState === "unsupported" || notifState === "denied";
    notifBtn.textContent = notifState === "on" ? "Disable" : "Enable";
  }

  async function toggleNotifications(): Promise<void> {
    notifBtn.disabled = true;
    const spaceIds = ctx.me.spaces.map((s) => s.id);
    try {
      if (notifState === "on") {
        await disablePush(ctx.client, spaceIds);
      } else if (notifState === "off") {
        const got = await enablePush(ctx.client, spaceIds);
        if (got === "error") toast("Couldn't turn notifications on. Try again.");
      }
    } finally {
      notifBtn.disabled = false;
      await renderNotifications();
    }
  }

  // ── offline ──
  const offlineSec = section("Offline");
  const secure = typeof self !== "undefined" && self.isSecureContext;
  offlineSec.append(
    note(
      secure
        ? "You can open Onlay and read what you've seen without a connection, and your drafts are kept."
        : "Offline reading needs a secure connection. Running online-only.",
    ),
  );
  body.append(offlineSec);

  return { node };
}

/* ── account ───────────────────────────────────────────────────────── */

function accountScreen(ctx: AppCtx): Screen {
  const { node, body } = frame(ctx, "Account", "#/settings");
  const person = ctx.me.person;

  const you = section("You");
  const idRow = el("div", "identity-row");
  const face = el("span", "identity-face");
  face.append(avatar(person, "md"));
  idRow.append(face);
  const nameField = el("input", "field name-field") as HTMLInputElement;
  nameField.type = "text";
  nameField.value = person.name;
  nameField.setAttribute("aria-label", "Your name");
  const save = button("btn btn-secondary", "Save name", () => void doRename());
  nameField.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.isTrusted) void doRename();
  });
  idRow.append(nameField, save);
  you.append(idRow);
  const nameNote = note("");
  you.append(nameNote);
  you.append(
    itemRow(person.email, "Your email comes from your sign-in and can't be changed here."),
  );
  body.append(you);

  // ── picture: the person's own, their sign-in's, or initials ──
  const pictureSec = section("Picture");
  const pictureNote = note("");
  const file = el("input") as HTMLInputElement;
  file.type = "file";
  file.hidden = true;
  file.accept = "image/png,image/jpeg,image/webp";
  file.setAttribute("aria-label", "Choose picture");
  file.addEventListener("change", () => void doUpload());
  const choose = button("btn btn-secondary", "Choose picture", () => file.click());
  const useProvider = button(
    "btn btn-ghost",
    "Use sign-in picture",
    () => void doChoose("provider"),
  );
  const remove = button("btn btn-ghost", "Remove picture", () => void doChoose("none"));
  const pictureActions = el("div", "picture-actions");
  pictureActions.append(choose, useProvider, remove, file);
  pictureSec.append(pictureNote, pictureActions);
  // An older server says nothing of the profile: no picture controls then.
  if (ctx.me.profile) body.append(pictureSec);
  paintProfile();

  function paintProfile(): void {
    const me = ctx.me.person;
    face.replaceChildren(avatar(me, "md"));
    const profile = ctx.me.profile;
    // Neither once the person saved their own name.
    nameNote.textContent =
      !profile || profile.nameSet
        ? ""
        : profile.nameFromEmail === true
          ? "Taken from your email until you save a name."
          : "Your sign-in sets this name until you save your own.";
    nameNote.hidden = nameNote.textContent === "";
    if (!profile) return;
    const shows = me.avatarUrl !== undefined;
    pictureNote.textContent =
      profile.picture === "own"
        ? "You chose this picture. It shows next to your name in every space."
        : profile.picture === "provider" && shows
          ? "This picture comes from your sign-in."
          : "No picture set. Your initials show instead.";
    useProvider.hidden = !(profile.providerPicture && profile.picture !== "provider");
    remove.hidden = !shows;
  }

  async function settle(res: Result<unknown>, done: string): Promise<void> {
    if (!res.ok) {
      // The server's own sentence when it refused the image; otherwise this, not
      // the generic "Your work is still here."
      toast(
        res.verdict === "refused" && res.code === "invalid" && res.message
          ? res.message
          : "Couldn't update your picture. Check your connection and try again.",
      );
      return;
    }
    await ctx.reloadMe();
    paintProfile();
    toast(done);
  }

  async function doUpload(): Promise<void> {
    const chosen = file.files?.[0];
    file.value = "";
    if (!chosen || choose.disabled) return;
    choose.disabled = true;
    choose.textContent = "Saving…";
    try {
      const prepared = await preparePicture(chosen);
      if (!prepared.ok) {
        toast(
          prepared.reason === "too-large"
            ? "That image is too large. Choose a smaller one."
            : "Couldn't read that image. Choose a PNG, JPEG or WebP file.",
        );
        return;
      }
      await settle(await api.uploadPicture(ctx.client, prepared.image), "Picture saved.");
    } finally {
      choose.disabled = false;
      choose.textContent = "Choose picture";
    }
  }

  async function doChoose(picture: "provider" | "none"): Promise<void> {
    useProvider.disabled = true;
    remove.disabled = true;
    const busy = picture === "none" ? remove : useProvider;
    busy.textContent = picture === "none" ? "Removing…" : "Saving…";
    try {
      await settle(
        await api.choosePicture(ctx.client, picture),
        picture === "none" ? "Picture removed." : "Using your sign-in picture.",
      );
    } finally {
      useProvider.disabled = false;
      remove.disabled = false;
      useProvider.textContent = "Use sign-in picture";
      remove.textContent = "Remove picture";
    }
  }

  async function doRename(): Promise<void> {
    const name = nameField.value.trim();
    if (!name || save.disabled) return;
    // The same name saves too while it is still the sign-in's: it pins it.
    if (name === ctx.me.person.name && ctx.me.profile?.nameSet !== false) return;
    save.disabled = true;
    const res = await api.rename(ctx.client, name);
    save.disabled = false;
    if (!res.ok) {
      toast(failureToast(res));
      return;
    }
    await ctx.reloadMe();
    paintProfile();
    toast("Name saved.");
  }

  const sessions = section("Sessions");
  sessions.append(note("Sign out of this browser."));
  const out = button("btn btn-secondary", "Sign out", () => {
    out.disabled = true;
    void ctx.signOut("this").then((ok) => {
      if (!ok) {
        out.disabled = false;
        toast("Couldn't sign out. Check your connection and try again.");
      }
    });
  });
  sessions.append(out);
  sessions.append(note("Sign out of this browser, your other devices, and the extension."));
  const everywhere = confirmButton(
    "btn btn-secondary",
    "Sign out everywhere",
    "Tap again to sign out everywhere",
    () => {
      everywhere.disabled = true;
      void ctx.signOut("everywhere").then((ok) => {
        if (!ok) {
          everywhere.disabled = false;
          toast("Couldn't sign out. Check your connection and try again.");
        }
      });
    },
  );
  sessions.append(everywhere);
  body.append(sessions);

  const danger = section("Delete account", "danger");
  danger.append(
    note(
      'Deletes your personal space and everything in it, and removes you from every workspace. Your messages in workspaces stay, shown as "Deleted person". This can\'t be undone.',
    ),
  );
  const confirm = labelledField("Type your email to confirm", {
    type: "email",
    placeholder: person.email,
  });
  const del = button("btn btn-danger", "Delete my account", () => void doDelete());
  del.disabled = true;
  confirm.input.addEventListener("input", () => {
    del.disabled = confirm.input.value.trim().toLowerCase() !== person.email.toLowerCase();
    confirm.hint.textContent = "";
  });
  danger.append(confirm.wrap, del);
  body.append(danger);

  async function doDelete(): Promise<void> {
    if (del.disabled) return;
    del.disabled = true;
    const res = await api.deleteAccount(ctx.client, confirm.input.value.trim());
    if (!res.ok) {
      del.disabled = false;
      confirm.hint.textContent = res.message ?? failureToast(res);
      return;
    }
    await ctx.signOut("gone");
  }

  return { node };
}

/* ── spaces ────────────────────────────────────────────────────────── */

function spacesScreen(ctx: AppCtx): Screen {
  const { node, body } = frame(ctx, "Spaces", "#/settings");
  const list = section("Your spaces");
  const create = section("New workspace");
  body.append(list, create);

  function paintList(): void {
    clear(list);
    list.append(el("h2", "section-head", "Your spaces"));
    for (const s of memberSpaces(ctx.me.spaces)) {
      if (s.kind === "personal") {
        list.append(
          itemRow(s.name, "Your personal space. Only you can see it, unless you share a thread."),
        );
        continue;
      }
      const open = button("btn btn-ghost btn-sm", s.role === "admin" ? "Manage" : "Members", () =>
        ctx.router.go(hashFor({ name: "workspace", spaceId: s.id })),
      );
      const leave = confirmButton("btn btn-ghost btn-sm", "Leave", "Tap again to leave", () => {
        void api.removeMember(ctx.client, s.id, ctx.me.person.id).then(async (res) => {
          if (!res.ok) {
            toast(failureToast(res));
            return;
          }
          toast(`You left ${s.name}.`);
          await ctx.reloadMe();
          paintList();
        });
      });
      list.append(itemRow(s.name, s.role === "admin" ? "admin" : "member", [open, leave]));
    }
  }

  function paintCreate(): void {
    clear(create);
    create.append(el("h2", "section-head", "New workspace"));
    if (!ctx.me.canCreateWorkspace) {
      create.append(note("Only the people this Onlay server allows can create workspaces."));
      return;
    }
    create.append(
      note(
        "A workspace is a space you share with other people. Use lowercase letters, digits, and hyphens.",
      ),
    );
    const name = labelledField("Name", { placeholder: "acme-design" });
    const go = button("btn btn-primary", "Create workspace", () => void doCreate());
    go.disabled = true;
    name.input.addEventListener("input", () => {
      const hint = workspaceNameHint(name.input.value);
      name.hint.textContent = hint.message;
      go.disabled = !hint.ok;
    });
    name.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.isTrusted) void doCreate();
    });
    create.append(name.wrap, go);

    async function doCreate(): Promise<void> {
      if (go.disabled) return;
      go.disabled = true;
      const res = await api.createWorkspace(ctx.client, name.input.value);
      if (!res.ok) {
        go.disabled = false;
        name.hint.textContent = res.message ?? failureToast(res);
        return;
      }
      await ctx.reloadMe();
      toast(`Created ${res.data.space.name}.`);
      ctx.router.go(hashFor({ name: "workspace", spaceId: res.data.space.id }));
    }
  }

  paintList();
  paintCreate();
  return {
    node,
    refresh: () => {
      // Only the list follows live truth; a half-typed name stays put.
      paintList();
      return true;
    },
  };
}

/* ── deployment (super admins) ─────────────────────────────────────── */

function deploymentScreen(ctx: AppCtx): Screen {
  const { node, body } = frame(ctx, "Server", "#/settings");
  let settings: AdminSettingsResponse | null = null;
  let busy = false;

  async function load(): Promise<boolean> {
    if (busy) return true;
    const res = await api.adminSettings(ctx.client);
    clear(body);
    if (!res.ok) {
      if (res.verdict === "offline") body.append(offlineBanner());
      else body.append(errorState(res.message ?? "Couldn't reach the server.", () => void load()));
      return false;
    }
    settings = res.data;
    if (res.fromCache) body.append(offlineBanner(res.syncedAt));
    render(res.data);
    return !res.fromCache;
  }

  async function save(
    workspaceCreation: WorkspaceCreationPolicy,
    creators: WorkspaceCreator[],
  ): Promise<void> {
    busy = true;
    const res = await api.putAdminSettings(ctx.client, { workspaceCreation, creators });
    busy = false;
    if (!res.ok) toast(failureToast(res));
    else toast("Saved.");
    await load();
    await ctx.reloadMe();
  }

  function render(s: AdminSettingsResponse): void {
    // ── who may create workspaces ──
    const policy = section("Who can create workspaces");
    const segs = el("div", "segmented");
    for (const p of WORKSPACE_CREATION_POLICIES) {
      const b = el(
        "button",
        `seg${p === s.workspaceCreation ? " chosen" : ""}`,
      ) as HTMLButtonElement;
      b.type = "button";
      b.textContent = CREATION_POLICY_LABEL[p];
      b.setAttribute("aria-pressed", String(p === s.workspaceCreation));
      b.addEventListener("click", (e) => {
        if (!e.isTrusted || p === settings?.workspaceCreation) return;
        void save(p, s.creators);
      });
      segs.append(b);
    }
    policy.append(segs);
    policy.append(
      note(
        s.workspaceCreation === "listed"
          ? "People whose email, or email domain, is on the list below can create workspaces. Super admins always can."
          : s.workspaceCreation === "anyone"
            ? "Anyone who signs in can create workspaces."
            : "Only super admins can create workspaces.",
      ),
    );
    body.append(policy);

    // ── the creators list ──
    const creators = section("Creators");
    for (const c of s.creators) {
      const remove = button(
        "btn btn-ghost btn-sm",
        "Remove",
        () =>
          void save(
            s.workspaceCreation,
            s.creators.filter((x) => x.entry !== c.entry),
          ),
      );
      remove.setAttribute("aria-label", `Remove ${c.entry}`);
      creators.append(
        itemRow(c.entry, c.kind === "domain" ? "everyone at this domain" : "email", [remove]),
      );
    }
    if (s.creators.length === 0) creators.append(note("No one is listed yet."));
    const add = labelledField("Add an email or domain", {
      placeholder: "name@example.com or example.com",
    });
    const addBtn = button("btn btn-secondary", "Add", () => doAdd());
    const doAdd = (): void => {
      const entry = creatorOf(add.input.value);
      if (!entry) {
        add.hint.textContent = "Enter an email address or a domain like example.com.";
        return;
      }
      if (s.creators.some((c) => c.entry === entry.entry)) {
        add.hint.textContent = `${entry.entry} is already listed.`;
        return;
      }
      void save(s.workspaceCreation, [...s.creators, entry]);
    };
    add.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.isTrusted) doAdd();
    });
    creators.append(add.wrap, addBtn);
    body.append(creators);

    // ── super admins ──
    const admins = section("Super admins");
    admins.append(
      note("Super admins manage this Onlay server's settings and can always create workspaces."),
    );
    for (const p of s.superAdmins) {
      const self = p.id === ctx.me.person.id;
      const remove = confirmButton("btn btn-ghost btn-sm", "Remove", "Tap again to remove", () => {
        busy = true;
        void api.removeSuperAdmin(ctx.client, p.id).then(async (res) => {
          busy = false;
          if (!res.ok) toast(failureToast(res));
          await load();
          await ctx.reloadMe();
        });
      });
      remove.setAttribute("aria-label", `Remove ${p.name} as super admin`);
      admins.append(itemRow(self ? `${p.name} (you)` : p.name, p.email, [remove], avatar(p, "sm")));
    }
    const addAdmin = labelledField("Add a super admin by email", {
      type: "email",
      placeholder: "name@example.com",
    });
    const addAdminBtn = button("btn btn-secondary", "Add super admin", () => void doAddAdmin());
    async function doAddAdmin(): Promise<void> {
      const email = addAdmin.input.value.trim();
      if (!email || addAdminBtn.disabled) return;
      addAdminBtn.disabled = true;
      busy = true;
      const res = await api.addSuperAdmin(ctx.client, email);
      busy = false;
      addAdminBtn.disabled = false;
      if (!res.ok) {
        addAdmin.hint.textContent = res.message ?? failureToast(res);
        return;
      }
      toast(`${email} is now a super admin.`);
      await load();
    }
    addAdmin.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.isTrusted) void doAddAdmin();
    });
    admins.append(addAdmin.wrap, addAdminBtn);
    body.append(admins);
  }

  void load();
  return { node, refresh: () => load() };
}

/* ── agent ─────────────────────────────────────────────────────────── */

function agentScreen(ctx: AppCtx): Screen {
  const { node, body } = frame(ctx, "Agent", "#/settings");
  const mcpUrl = `${ctx.origin}/mcp`;

  const intro = section("Connect an agent");
  intro.append(
    note(
      "Once connected, your agent works as you: it reads what you hand it, takes items, replies, and posts variants. Everything it writes carries an agent tag.",
    ),
  );
  body.append(intro);

  const plugin = section("Install the plugin");
  plugin.append(
    note("Claude Code"),
    copyBlock(PLUGIN_LINES.claude, "Copy the Claude Code commands", "bash"),
  );
  plugin.append(note("Codex"), copyBlock(PLUGIN_LINES.codex, "Copy the Codex commands", "bash"));
  plugin.append(
    note("Other agents"),
    copyBlock(PLUGIN_LINES.others, "Copy the install command", "bash"),
  );
  plugin.append(note("Your agent asks you to sign in the first time it connects."));
  body.append(plugin);

  const mcp = section("Or add the MCP server yourself");
  mcp.append(note("The MCP server's URL:"), copyBlock(mcpUrl, "Copy the MCP URL"));
  mcp.append(
    note("As an MCP config:"),
    copyBlock(mcpConfig(ctx.origin), "Copy the MCP config", "json"),
  );
  body.append(mcp);

  const handoff = section("Handing work to an agent");
  handoff.append(
    note(
      "Write @agent in a thread, then use Copy for agent and paste it into the session you choose.",
    ),
  );
  body.append(handoff);

  return { node };
}
