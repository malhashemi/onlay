/**
 * The Worker's bindings (spec §12). Vars are strings; secrets are set with
 * `wrangler secret put` and absent in local dev unless `.dev.vars` sets them.
 */
import type { SpaceDO } from "./space-do";

export interface Env {
  /** The directory: people, spaces, members, invitations, shares (D1). */
  DB: D1Database;
  /** One Durable Object per space, named by the space id. */
  SPACE: DurableObjectNamespace<SpaceDO>;
  /** The web app build, served under /app/. */
  ASSETS: Fetcher;
  /** The service: the web app, sign-in, the API, spaces, MCP (`https://app.onlay.dev`). */
  PUBLIC_ORIGIN: string;
  /**
   * The public site (`https://onlay.dev`): `/`, `/install`, `/privacy`,
   * `/download/*`, and nothing that reads or sets a credential. Unset, or equal
   * to `PUBLIC_ORIGIN`, the one origin serves everything (src/edge/hosts.ts).
   */
  SITE_ORIGIN?: string;
  AUTHKIT_ISSUER: string;
  WORKOS_CLIENT_ID: string;
  /** Comma-separated extension ids allowed to sign in. */
  EXTENSION_IDS: string;
  /** The oldest client protocol served, as a decimal string. */
  MIN_CLIENT_PROTOCOL: string;
  /** "1" enables the dev sign-in stub. Set only in the dev environment, never in production. */
  DEV_AUTH?: string;
  /** The WorkOS API base; tests point it at a stand-in. Defaults to https://api.workos.com. */
  WORKOS_API_BASE?: string;
  /** The deployed commit, set at deploy time with `--var SHA:<sha>`. */
  SHA?: string;
  /**
   * The extension version /download/onlay-extension.zip holds, set at deploy
   * time with `--var EXTENSION_VERSION:0.2.<run>`; /healthz reports it.
   */
  EXTENSION_VERSION?: string;
  WORKOS_API_KEY?: string;
  SESSION_SECRET?: string;
  /** Comma-separated emails that become super admins at first sign-in. */
  SUPER_ADMINS?: string;
  /**
   * The deployment's web push keys, minted once with `generateVapidKeys()`
   * (src/space/webpush.ts): the base64url public point and the private key
   * as a JWK JSON string. Both absent: web push is off.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  /**
   * Who a push service may contact about this deployment's web push: a
   * `mailto:` address or an `https:` URL, sent as the VAPID JWT's `sub`. Unset
   * or not one of those, the service origin (`PUBLIC_ORIGIN`) is sent instead
   * (src/space/push-contact.ts).
   */
  PUSH_CONTACT?: string;
}
