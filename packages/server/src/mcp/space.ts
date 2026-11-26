/**
 * Calling a space as an agent (spec §5.1, §9): the person's standing in the
 * space is resolved, then the request reaches the space's Durable Object with
 * the `agent`-class caller header, exactly as the edge forwards
 * `/s/<spaceId>/*`. A space the person cannot see is "not found", like a
 * missing item.
 *
 * Standing is resolved again before every forward, never kept across the
 * requests of one tool call: a share revoked between `look` loading the item
 * and fetching its image stops the fetch.
 */
import {
  API_ERROR_CODES,
  CALLER_HEADER,
  type Caller,
  type CallerAccess,
  encodeCaller,
  LIMITS,
  SPACE_HEADER,
} from "@onlay/protocol";
import { spacesOf, standingIn as standingInSpace } from "../directory/access";
import { Failure } from "../directory/failure";
import { deliverPending, spaceFactsHeader, spaceStub } from "../directory/notify";
import type { AgentIdentity } from "../edge/caller";
import { serviceOrigin } from "../edge/hosts";
import { limit, WRITES_PER_MINUTE } from "../edge/rate";
import { callerFor } from "../edge/space";
import type { Env } from "../env";
import { foreign, ToolError } from "./result";

// biome-ignore lint/suspicious/noExplicitAny: space bodies are read loosely and checked where used
export type Json = Record<string, any>;

export const NOT_FOUND_SENTENCE =
  "Nothing is at that ref, or your person can't open it. Check the ref with `inbox`.";

/** The person's standing in one space, read for one forward. */
interface Standing {
  access: CallerAccess;
  /** The space's access epoch, when the shared resolution reports one; a stale one is refused. */
  epoch?: number;
  /** The person's credential generation, read with the standing (the header's `credentialGeneration`). */
  generation?: number;
}

/**
 * The person's standing in a space right now. When the shared access
 * resolution also returns the space's access epoch, pass it through on the
 * one marked line; nothing else here changes.
 */
async function standingIn(
  env: Env,
  person: AgentIdentity["person"],
  spaceId: string,
): Promise<Standing | null> {
  const standing = await standingInSpace(env.DB, person, spaceId);
  if (standing === null) return null;
  // The space is owed control calls (the outbox): deliver them before it sees this caller.
  if (standing.pending) await deliverPending(env, spaceId);
  return { access: standing.access, epoch: standing.epoch, generation: standing.personGeneration };
}

/** A space's answer to a caller whose epoch is older than the space's: re-resolve, then retry once. */
async function staleAccess(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  try {
    const body = (await res.clone().json()) as Json;
    return body?.error?.reason === "stale-access";
  } catch {
    return false;
  }
}

/** One tool call's view of the spaces it touches. */
export class AgentSpaces {
  constructor(
    readonly env: Env,
    readonly agent: AgentIdentity,
  ) {}

  private listed: SpaceListing[] | undefined;

  /** Every space the person can see, with the role they hold there (for names and labels only). */
  async spaces(): Promise<SpaceListing[]> {
    this.listed ??= await spacesOf(this.env.DB, this.agent.person);
    return this.listed;
  }

  /**
   * How a space reads to the agent: "your personal space", or the space's
   * people-chosen name framed as data.
   */
  async label(spaceId: string): Promise<string> {
    const space = (await this.spaces()).find((s) => s.id === spaceId);
    if (space === undefined) return `space ${spaceId}`;
    return spaceLabel(space);
  }

  /**
   * Charges one write to the person's shared write bucket, the one the edge
   * charges for every client write (spec §6). Refuses with when to retry.
   */
  async chargeWrite(): Promise<void> {
    try {
      await limit(this.env.DB, `write:${this.agent.person.id}`, WRITES_PER_MINUTE);
    } catch (error) {
      if (!(error instanceof Failure) || error.code !== "rate_limited") throw error;
      const seconds = Math.max(1, Math.ceil((60_000 - (Date.now() % 60_000)) / 1000));
      throw new ToolError(
        `Slow down: your person's agents and clients share ${WRITES_PER_MINUTE} writes a minute, and that is used up. Try this write again in ${seconds} s.`,
      );
    }
  }

  private forward(
    spaceId: string,
    standing: Standing,
    space: SpaceListing | undefined,
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    // The caller header's field is `accessEpoch` (CallerSchema); callerFor sets it.
    const caller: Caller = callerFor(
      this.agent.person,
      "agent",
      standing.access,
      this.agent.credentialId,
      standing.epoch,
      standing.generation,
      spaceId,
    );
    const headers: Record<string, string> = {
      [CALLER_HEADER]: encodeCaller(caller),
      ...(space ? { [SPACE_HEADER]: spaceFactsHeader(space) } : {}),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return spaceStub(this.env, spaceId).fetch(
      new Request(`${serviceOrigin(this.env)}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      }),
    );
  }

  /**
   * The space's raw response. Standing is resolved for this forward alone;
   * none is "not found". A `stale-access` answer re-resolves once and
   * retries, then gives up as "not found". An aborted `signal` stops the
   * forward in flight and any not yet sent.
   */
  async fetch(
    spaceId: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const space = (await this.spaces()).find((s) => s.id === spaceId);
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const standing = await standingIn(this.env, this.agent.person, spaceId);
      if (standing === null) throw new ToolError(NOT_FOUND_SENTENCE);
      signal?.throwIfAborted();
      const res = await this.forward(spaceId, standing, space, method, path, body, signal);
      if (!(await staleAccess(res))) return res;
      await res.body?.cancel();
    }
    throw new ToolError(NOT_FOUND_SENTENCE);
  }

  /** The space's JSON answer with its status. */
  async call(
    spaceId: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: Json }> {
    const res = await this.fetch(spaceId, method, path, body, signal);
    let parsed: Json = {};
    try {
      parsed = (await res.json()) as Json;
    } catch {
      // A body that isn't JSON reads as empty; the status still tells.
    }
    return { status: res.status, body: parsed };
  }

  /** A successful read's body; "not found" for a 404, a plain failure otherwise. */
  async read(spaceId: string, path: string, signal?: AbortSignal): Promise<Json> {
    const res = await this.call(spaceId, "GET", path, undefined, signal);
    if (res.status === 404) throw new ToolError(NOT_FOUND_SENTENCE);
    if (res.status >= 400) {
      throw new ToolError(
        `onlay couldn't read that (${errorCode(res.status, res.body)}). Try again in a moment.`,
      );
    }
    return res.body;
  }
}

export type SpaceListing = Awaited<ReturnType<typeof spacesOf>>[number];

function spaceLabel(space: SpaceListing): string {
  if (space.kind === "workspace")
    return `the workspace ${foreign(space.name, LIMITS.MAX_ACTOR_NAME)}`;
  return space.role === "guest"
    ? `the personal space of ${foreign(space.name, LIMITS.MAX_ACTOR_NAME)}`
    : "your personal space";
}

/** The `{error: {reason}}` tag of a space refusal. */
export function errorReason(body: Json): string | undefined {
  const reason = body?.error?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * A refusal's error code from the shared table, else its status: the only
 * part of a space's refusal that a generic sentence repeats.
 */
export function errorCode(status: number, body: Json): string {
  const code = body?.error?.code;
  return typeof code === "string" && (API_ERROR_CODES as string[]).includes(code)
    ? `error ${code}`
    : `status ${status}`;
}
