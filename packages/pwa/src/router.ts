// The hash router (D-ROUTER): the interaction id lives in the URL *fragment*, so
// the broker's served route space stays the closed `/app/` + fixed asset list —
// no per-artifact server route, no SPA fallback config, and deep links survive
// offline. This module owns nothing but navigation; screens render from the
// parsed Route.
import { parseHash, type Route } from "./view-model";

export class Router {
  private handler: ((route: Route) => void) | null = null;
  private readonly onHash = (): void => this.dispatch();

  /** Start listening; fires immediately with the current route. */
  start(handler: (route: Route) => void): void {
    this.handler = handler;
    window.addEventListener("hashchange", this.onHash);
    this.dispatch();
  }

  /** Stop: no route mounts anything from here on (the app came down). */
  stop(): void {
    this.handler = null;
    window.removeEventListener("hashchange", this.onHash);
  }

  private dispatch(): void {
    this.handler?.(parseHash(window.location.hash));
  }

  /** Navigate by setting the fragment; the hashchange listener re-renders. */
  go(hash: string): void {
    if (window.location.hash === hash) this.dispatch();
    else window.location.hash = hash;
  }
}
