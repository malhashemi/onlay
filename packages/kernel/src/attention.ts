/**
 * Attention — an Actor's personal debt, computed from interaction state
 * (ADR-0006). Server-absolute: the badge count and popover rows derive from
 * THIS, never from client-side counters.
 *
 * needs-you   an interaction is waiting on the actor right now
 * waiting     the actor participates; someone else is waited on
 * recent      resolved lately, for orientation
 *
 * Agent work (spec §7): the requester waits on a pending or taken item
 * ("waiting on agent"); an answered item whose last message is the agent's
 * needs the requester. An agent writes as its person, so its messages never
 * count as that person having read the thread.
 */
import { effectiveAgentWork, type InteractionState, isLive } from "./interaction";

export interface AttentionRef {
  interaction: InteractionState;
  /** Why it needs the actor (drives the row copy). */
  because:
    | "waiting-on"
    | "mentioned"
    | "thread-reply"
    | "verify"
    | "agent-answered"
    /** Shared with the actor, who has not opened, replied or reacted yet. */
    | "shared"
    /** Waiting bucket only: the actor asked for an agent, which has not answered yet. */
    | "waiting-on-agent";
}

export interface AttentionSets {
  needsYou: AttentionRef[];
  waiting: AttentionRef[];
  recent: InteractionState[];
}

/** Latest non-system message authored by someone else vs the actor's last touch. */
function needsThreadAttention(s: InteractionState, actorId: string): boolean {
  let lastOther = -1;
  let lastSelf = -1;
  for (let i = 0; i < s.thread.length; i++) {
    const m = s.thread[i];
    if (!m || m.system || m.deleted) continue;
    if (m.authorId === actorId && !m.agent) lastSelf = i;
    else lastOther = i;
    // a reaction from the actor also counts as having seen up to this msg
    if (m.reactions) {
      for (const who of Object.values(m.reactions)) {
        if (who.includes(actorId)) lastSelf = Math.max(lastSelf, i);
      }
    }
  }
  return lastOther > lastSelf;
}

/** Was the actor @mentioned after their own latest message/reaction? */
function mentionedUnanswered(s: InteractionState, actorId: string): boolean {
  let lastSelf = -1;
  let lastMention = -1;
  for (let i = 0; i < s.thread.length; i++) {
    const m = s.thread[i];
    if (!m || m.deleted) continue;
    if (m.authorId === actorId && !m.agent) lastSelf = i;
    if (m.reactions) {
      for (const who of Object.values(m.reactions)) {
        if (who.includes(actorId)) lastSelf = Math.max(lastSelf, i);
      }
    }
    if (!m.system && m.authorId !== actorId && m.body.tokens) {
      for (const t of m.body.tokens) {
        if (t.t === "actor" && t.actorId === actorId) lastMention = i;
      }
    }
  }
  return lastMention > lastSelf;
}

/**
 * The agent answered what this actor asked for, and the thread's latest
 * message is the agent's, not yet reacted to by the actor.
 */
function agentAnsweredFor(s: InteractionState, actorId: string): boolean {
  const w = s.agentWork;
  if (w?.status !== "answered" || w.requestedBy !== actorId) return false;
  for (let i = s.thread.length - 1; i >= 0; i--) {
    const m = s.thread[i];
    if (!m || m.system || m.deleted) continue;
    if (!m.agent) return false;
    const reacted = Object.values(m.reactions ?? {}).some((who) => who.includes(actorId));
    return !reacted;
  }
  return false;
}

/** Why (if at all) this live interaction needs this actor right now. */
export function needsActor(s: InteractionState, actorId: string): AttentionRef["because"] | null {
  if (!isLive(s)) return null;
  if ((s.shareUnseen ?? []).includes(actorId)) return "shared";
  if (agentAnsweredFor(s, actorId)) return "agent-answered";
  switch (s.kind) {
    case "ask":
      // answered → the ASKER owns confirming/resolving
      if (s.state === "answered") return s.authorId === actorId ? "waiting-on" : null;
      return s.waitingOn.includes(actorId) ? "waiting-on" : null;
    case "change":
      if (s.state === "verifying") return s.authorId === actorId ? "verify" : null;
      return s.waitingOn.includes(actorId) ? "waiting-on" : null;
    case "comment": {
      if (mentionedUnanswered(s, actorId)) return "mentioned";
      if (s.authorId === actorId && needsThreadAttention(s, actorId)) return "thread-reply";
      return null;
    }
  }
}

/** True when ANYONE is needed (used for the waiting bucket + escalation). */
function someoneNeeded(s: InteractionState, participants: Iterable<string>): boolean {
  for (const id of participants) if (needsActor(s, id)) return true;
  return false;
}

export function computeAttention(
  interactions: Iterable<InteractionState>,
  actorId: string,
  now: number,
  recentWindowMs: number,
): AttentionSets {
  const needsYou: AttentionRef[] = [];
  const waiting: AttentionRef[] = [];
  const authoredOpen: AttentionRef[] = [];
  const recent: InteractionState[] = [];

  for (const s of interactions) {
    if (isLive(s)) {
      // Waiting on an agent comes first (spec §7): the requester of pending or
      // taken work waits on it, whoever else wrote since; only someone else's
      // unanswered @mention of them still needs them.
      const work = effectiveAgentWork(s, now);
      if (work && work.status !== "answered" && work.requestedBy === actorId) {
        if (mentionedUnanswered(s, actorId))
          needsYou.push({ interaction: s, because: "mentioned" });
        else waiting.push({ interaction: s, because: "waiting-on-agent" });
        continue;
      }
      const because = needsActor(s, actorId);
      if (because) {
        needsYou.push({ interaction: s, because });
        continue;
      }
      // An open interaction stays in your `waiting` when someone is needed —
      // OR when YOU authored it (F7): an untagged comment waits on nobody, and
      // without this it vanished from its own author's inbox the moment it was
      // posted, reading as data loss from the author's seat. Authored-only
      // continuity rows go in a SECOND bucket so the row cap downstream
      // (MAX_ATTENTION_ROWS slice) evicts them before genuine waited-on work.
      if (s.participants.includes(actorId)) {
        if (someoneNeeded(s, s.participants)) {
          waiting.push({ interaction: s, because: "waiting-on" });
        } else if (s.authorId === actorId) {
          authoredOpen.push({ interaction: s, because: "waiting-on" });
        }
      }
      continue;
    }
    if (
      s.resolvedAt !== undefined &&
      now - s.resolvedAt <= recentWindowMs &&
      s.state !== "dropped" &&
      s.participants.includes(actorId)
    ) {
      recent.push(s);
    }
  }

  // oldest debt first — the thing you've been blocking longest leads
  needsYou.sort((a, b) => a.interaction.createdAt - b.interaction.createdAt);
  waiting.sort((a, b) => b.interaction.createdAt - a.interaction.createdAt);
  authoredOpen.sort((a, b) => b.interaction.createdAt - a.interaction.createdAt);
  waiting.push(...authoredOpen);
  recent.sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  return { needsYou, waiting, recent };
}
