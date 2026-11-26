// The caller rules (spec §4): bearer precedence, malformed credentials, and
// the cookie's fetch-metadata, CSRF and Origin rules, for HTTP and upgrades.
import { CSRF_HEADER, decodeCaller } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { devSignIn, edge, errorOf, ORIGIN, personalSpaceOf, webHeaders } from "../support/client";
import type { Echo } from "../support/echo-space";

async function meAs(headers: Record<string, string>): Promise<Response> {
  return edge("/api/me", { headers });
}

describe("the caller", () => {
  test("a well-formed Bearer token takes precedence over the cookie", async () => {
    const tokenHolder = await devSignIn();
    const cookieHolder = await devSignIn();
    const res = await meAs({
      ...webHeaders(cookieHolder),
      Authorization: `Bearer ${tokenHolder.token}`,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { person: { id: string } }).person.id).toBe(
      tokenHolder.person.id,
    );
  });

  test("malformed, multiple or unknown credentials are sign_in_required, never read past for the cookie", async () => {
    const who = await devSignIn();
    const bad = [
      `Bearer ${who.token} extra`,
      `Bearer ${who.token}, Bearer ${who.token}`,
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer onl_short",
      `Bearer onl_${"A".repeat(43)}`,
    ];
    for (const authorization of bad) {
      const res = await meAs({ ...webHeaders(who), Authorization: authorization });
      expect(await errorOf(res)).toMatchObject({ status: 401, code: "sign_in_required" });
    }
    const twoCookies = await meAs({ ...webHeaders(who), Cookie: `${who.cookie}; ${who.cookie}` });
    expect(twoCookies.status).toBe(401);
  });

  test("a cookie counts for reads only with Sec-Fetch-Site: same-origin", async () => {
    const who = await devSignIn();
    expect((await meAs({ Cookie: who.cookie })).status).toBe(401);
    expect((await meAs({ Cookie: who.cookie, "Sec-Fetch-Site": "cross-site" })).status).toBe(401);
    expect((await meAs({ Cookie: who.cookie, "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  });

  test("a cookie write needs the CSRF header and our own Origin", async () => {
    const who = await devSignIn();
    const patch = (headers: Record<string, string>) =>
      edge("/api/me", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });
    const full = webHeaders(who, "PATCH");
    const { [CSRF_HEADER]: _csrf, ...noCsrf } = full;
    expect((await patch(noCsrf)).status).toBe(401);
    expect((await patch({ ...full, Origin: "https://evil.test" })).status).toBe(401);
    const { Origin: _origin, ...noOrigin } = full;
    expect((await patch(noOrigin)).status).toBe(401);
    expect((await patch({ ...full, "Sec-Fetch-Site": "same-site" })).status).toBe(401);
    expect((await patch(full)).status).toBe(200);
  });

  test("a WebSocket upgrade with the cookie needs our own Origin", async () => {
    const who = await devSignIn();
    const spaceId = await personalSpaceOf(who);
    const upgrade = (headers: Record<string, string>) =>
      edge(`/s/${spaceId}/ws`, {
        headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "onlay.v1", ...headers },
      });
    expect((await upgrade({ Cookie: who.cookie, Origin: "https://evil.test" })).status).toBe(401);
    expect((await upgrade({ Cookie: who.cookie })).status).toBe(401);

    const res = await upgrade({ Cookie: who.cookie, Origin: ORIGIN });
    expect(res.status).toBe(101);
    const echo = await firstMessage(res);
    expect(echo.path).toBe("/ws");
    expect(echo.headers["sec-websocket-protocol"]).toBe("onlay.v1");
    expect(echo.headers.cookie).toBeUndefined();
    expect(decodeCaller(echo.headers["x-onlay-caller"] ?? "")?.class).toBe("interaction");
  });

  test("a WebSocket upgrade may carry the token as the bearer subprotocol, consumed at the edge", async () => {
    const who = await devSignIn();
    const spaceId = await personalSpaceOf(who);
    const res = await edge(`/s/${spaceId}/ws`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `onlay.v1, bearer.${who.token}` },
    });
    expect(res.status).toBe(101);
    const echo = await firstMessage(res);
    expect(echo.headers["sec-websocket-protocol"]).toBe("onlay.v1");
    expect(decodeCaller(echo.headers["x-onlay-caller"] ?? "")?.class).toBe("full");

    const two = await edge(`/s/${spaceId}/ws`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `onlay.v1, bearer.${who.token}`,
        Authorization: `Bearer ${who.token}`,
      },
    });
    expect(two.status).toBe(401);
  });
});

async function firstMessage(res: Response): Promise<Echo> {
  const socket = res.webSocket;
  if (!socket) throw new Error("no socket");
  const message = new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
  );
  socket.accept();
  const echo = JSON.parse(await message) as Echo;
  socket.close();
  return echo;
}
