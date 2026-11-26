/**
 * The two hostnames one Worker answers (ADR-0024 follow-up): the service at
 * `PUBLIC_ORIGIN` (every route that involves a credential or a person) and
 * the public site at `SITE_ORIGIN` (the pages anyone may read). Without a
 * `SITE_ORIGIN`, or with one equal to `PUBLIC_ORIGIN`, the Worker serves
 * everything on one host: local development, `env.dev`, e2e and the
 * Workers-runtime suites.
 *
 * This module is the one place both settings are read. Each must be an
 * absolute `https:` URL (or `http:` for a loopback host) that is exactly an
 * origin: no path beyond `/`, no query, no fragment, no credentials. Every
 * other part of the Worker uses the canonical origins from here
 * (`serviceOrigin`, `originsOf`), never the raw strings, so routing, the
 * cookie's `Origin` rule, the WorkOS callback and the MCP audience all agree.
 * An invalid setting makes `originsOf` null, and the Worker then answers
 * every request with a plain failure and reads no credential.
 *
 * In both modes a request is matched exactly (scheme, host and port, and a
 * `Host` header that agrees with its URL) against the configured origins.
 * Anything else is neither and answered `not_found`, so an unexpected host is
 * never taken for the service. Both production hostnames reach this Worker,
 * so a missing `SITE_ORIGIN` takes the site's host offline; it never serves
 * the service there.
 */
import type { Env } from "../env";

/** Which origin a request arrived for. `one` is single-origin mode. */
export type Host = "one" | "service" | "site" | "other";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The canonical origin `raw` names, or null when it is not exactly an origin:
 * an absolute `https:` URL, or `http:` for a loopback host, with no
 * credentials, no path beyond `/`, and no query or fragment (not even an
 * empty `?` or `#`).
 */
export function canonicalOrigin(raw: string): string | null {
  const value = raw.trim();
  if (value.includes("?") || value.includes("#") || value.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  // A scheme with no `//` after it (`https:onlay.dev`) still parses; refuse it.
  if (!/^https?:\/\//i.test(value)) return null;
  return url.origin;
}

/** The deployment's two origins, canonical; `site` is null with one origin. */
export interface Origins {
  service: string;
  site: string | null;
}

/** The origins the settings name, or null when either setting is invalid. */
export function originsOf(env: Env): Origins | null {
  const service = canonicalOrigin(env.PUBLIC_ORIGIN ?? "");
  if (service === null) return null;
  const rawSite = env.SITE_ORIGIN?.trim() ?? "";
  if (rawSite === "") return { service, site: null };
  const site = canonicalOrigin(rawSite);
  if (site === null) return null;
  return { service, site: site === service ? null : site };
}

/**
 * The canonical service origin. Requests reach it only after `route` has
 * checked the settings, so the throw is for code outside a request (crons)
 * running under a broken config: it fails, it never guesses.
 */
export function serviceOrigin(env: Env): string {
  const origins = originsOf(env);
  if (origins === null) throw new Error("PUBLIC_ORIGIN or SITE_ORIGIN is not a valid origin");
  return origins.service;
}

/** Where the public pages live: the site origin, or the one origin. */
export function publicSiteOrigin(env: Env): string {
  const origins = originsOf(env);
  if (origins === null) throw new Error("PUBLIC_ORIGIN or SITE_ORIGIN is not a valid origin");
  return origins.site ?? origins.service;
}

/**
 * The origin this request arrived for: `one` (single-origin mode) or
 * `service` for exactly the service origin, `site` for exactly the site
 * origin, `other` for anything else. A `Host` header that disagrees with the
 * request's URL makes it `other`.
 */
export function hostOf(request: Request, origins: Origins): Host {
  const url = new URL(request.url);
  const header = request.headers.get("Host");
  if (header !== null && header.toLowerCase() !== url.host.toLowerCase()) return "other";
  if (url.origin === origins.service) return origins.site === null ? "one" : "service";
  if (origins.site !== null && url.origin === origins.site) return "site";
  return "other";
}

/**
 * The prefixes links in the edge's pages carry: empty (a relative link) in
 * single-origin mode, else the absolute origin each page lives on.
 */
export interface Links {
  /** Before `/auth/…` and `/app/…`. */
  service: string;
  /** Before `/install`, `/privacy`, `/download/…` and `/`. */
  site: string;
}

export function linksOf(env: Env): Links {
  const origins = originsOf(env);
  if (origins === null) throw new Error("PUBLIC_ORIGIN or SITE_ORIGIN is not a valid origin");
  return origins.site === null
    ? { service: "", site: "" }
    : { service: origins.service, site: origins.site };
}
