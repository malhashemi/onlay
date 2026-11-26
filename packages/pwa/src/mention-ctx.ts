// The composer's view of one space: its people (never yourself) plus `@agent`,
// as a member sees them. A guest's composer lists nobody — a guest sees
// nothing of a workspace's people, and a guest's `@agent` never creates agent
// work. `space` may be a getter, so the compose screen can switch spaces under
// one composer.
import type { ComposerCtx } from "./components/composer";
import { type AppCtx, roleIn } from "./context";
import { type Mentionable, mentionablesFor } from "./mentions";
import { capabilitiesFor } from "./view-model";

export function mentionCtx(ctx: AppCtx, space: string | (() => string)): ComposerCtx {
  const spaceId = (): string => (typeof space === "string" ? space : space());
  const directory = new Map<string, Mentionable>();
  const fill = (): void => {
    const id = spaceId();
    const caps = capabilitiesFor(roleIn(ctx, id));
    const people = caps.seePeople
      ? [...(ctx.people.get(id)?.values() ?? [])].filter((p) => p.id !== ctx.me.person.id)
      : [];
    directory.clear();
    for (const [handle, m] of mentionablesFor(people, { agent: caps.mentionAgent })) {
      directory.set(handle, m);
    }
  };
  fill();
  return {
    directory,
    loadDirectory: async () => {
      const id = spaceId();
      if (capabilitiesFor(roleIn(ctx, id)).seePeople) await ctx.loadPeople(id);
      fill();
    },
    store: ctx.store,
    personId: ctx.me.person.id,
  };
}
