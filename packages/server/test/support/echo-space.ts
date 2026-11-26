// A test-only stand-in for the space's Durable Object: it echoes what the
// edge forwarded and records the internal control calls, so the edge's
// routing, caller header and notifications are tested without the space
// runtime (which honours spec §5.1 and §7.1 on its own).
import { DurableObject } from "cloudflare:workers";

export interface Echo {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string;
}

/** An interaction id the stand-in answers `not_found` for. */
export const MISSING_INTERACTION = "00000000-0000-4000-8000-000000000000";

export class EchoSpace extends DurableObject {
  private async record(entry: Echo): Promise<void> {
    const log = (await this.ctx.storage.get<Echo[]>("log")) ?? [];
    log.push(entry);
    await this.ctx.storage.put("log", log);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const entry: Echo = {
      method: request.method,
      path,
      search: url.search,
      headers: Object.fromEntries(request.headers),
      body,
    };

    // Test controls, reached directly through env.SPACE.
    if (path === "/__test/log")
      return Response.json((await this.ctx.storage.get<Echo[]>("log")) ?? []);
    if (path === "/__test/attention" || path === "/__test/origins") {
      await this.ctx.storage.put(path, JSON.parse(body));
      return new Response(null, { status: 204 });
    }
    // Every later request fails, as a space that is down would.
    if (path === "/__test/fail") {
      await this.ctx.storage.put("fail", true);
      return new Response(null, { status: 204 });
    }
    if (await this.ctx.storage.get("fail")) return new Response("down", { status: 500 });
    // Every later request answers only after this many milliseconds.
    if (path === "/__test/slow") {
      await this.ctx.storage.put("slow", (JSON.parse(body) as { ms: number }).ms);
      return new Response(null, { status: 204 });
    }
    const slow = await this.ctx.storage.get<number>("slow");
    if (slow) await new Promise((r) => setTimeout(r, slow));

    if (path.startsWith("/internal/")) {
      await this.record(entry);
      return new Response(null, { status: 204 });
    }
    if (path === "/attention") {
      const stored = await this.ctx.storage.get("/__test/attention");
      return Response.json(stored ?? { needsYou: [], waiting: [], recent: [] });
    }
    if (path === "/origins") {
      return Response.json((await this.ctx.storage.get("/__test/origins")) ?? { origins: [] });
    }
    if (path === `/interaction/${MISSING_INTERACTION}`) {
      return Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      server.accept();
      server.send(JSON.stringify(entry));
      const protocol = request.headers.get("Sec-WebSocket-Protocol");
      return new Response(null, {
        status: 101,
        webSocket: client,
        ...(protocol ? { headers: { "Sec-WebSocket-Protocol": protocol } } : {}),
      });
    }
    return Response.json(entry);
  }
}
