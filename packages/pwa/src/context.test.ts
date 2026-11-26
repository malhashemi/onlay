// The public site's origin, as /api/me names it: the welcome page, /install
// and /privacy live there once the service has an origin of its own.
import { describe, expect, test } from "bun:test";
import type { MeResponse } from "@onlay/protocol";
import { type AppCtx, siteOrigin } from "./context";

function ctxWith(site: string | undefined): AppCtx {
  const me = {
    person: { id: "p_a", email: "a@acme.test", name: "A", initials: "A", tint: "#000" },
    spaces: [],
    canCreateWorkspace: false,
    superAdmin: false,
    ...(site === undefined ? {} : { siteOrigin: site }),
  } as MeResponse;
  return { me, origin: "https://app.onlay.test" } as AppCtx;
}

describe("siteOrigin", () => {
  test("is the origin the server names", () => {
    expect(siteOrigin(ctxWith("https://onlay.test"))).toBe("https://onlay.test");
    expect(siteOrigin(ctxWith("https://onlay.test/ignored?x"))).toBe("https://onlay.test");
  });

  test("is the service's own from an older server or a value that isn't a web origin", () => {
    expect(siteOrigin(ctxWith(undefined))).toBe("https://app.onlay.test");
    expect(siteOrigin(ctxWith("javascript:alert(1)"))).toBe("https://app.onlay.test");
    expect(siteOrigin(ctxWith("not a url"))).toBe("https://app.onlay.test");
  });
});
