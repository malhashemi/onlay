// Every HTTP call the service worker makes belongs to one account: a server
// origin, the token that origin issued, and a generation that moves whenever
// either changes (sign-in, sign-out, an origin override). A call is pinned to
// the account it started under and is never re-pointed: its token only ever
// goes to its own origin, and once the account moves on the call sends nothing
// more and its answer — data, 401, 426 — is dropped. One status handler for
// every request, capture uploads included. Chrome-free, so it is tested
// without a browser.
import { authHeaders } from "./server";

/** The account a request belongs to. */
export interface Pin {
  readonly origin: string;
  readonly token: string | null;
  readonly generation: number;
}

export interface AccountPorts {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** The account right now. */
  current(): Pin;
  /** A 401 under the current account: sign out (the generation is the one that got it). */
  signedOut(generation: number): Promise<void>;
  /** A 426 under the current account: this client is too old for `origin`. */
  upgradeRequired(origin: string): Promise<void>;
}

export interface CallOptions {
  /** JSON body: sets the content type. */
  json?: boolean;
  /** Abort after this long (capture uploads raise it). */
  timeoutMs?: number;
}

export interface AccountApi {
  /** Pin the account a request (or a multi-request upload) starts under. */
  pin(): Pin;
  /** The pinned account is still the current one. */
  isCurrent(pin: Pin): boolean;
  /**
   * One request under `pin`. Null when nothing was sent (the account moved
   * on, or there is no token), on a network failure, or when the account moved
   * on before the answer arrived.
   */
  call(pin: Pin, path: string, init?: RequestInit, opts?: CallOptions): Promise<Response | null>;
  /** A JSON body read under `pin`: null when it is not ok, not JSON, or stale by the time it parsed. */
  json<T>(pin: Pin, res: Response | null): Promise<T | null>;
}

export function createAccountApi(ports: AccountPorts): AccountApi {
  const isCurrent = (pin: Pin): boolean => {
    const now = ports.current();
    return (
      now.generation === pin.generation && now.origin === pin.origin && now.token === pin.token
    );
  };

  return {
    pin: () => ({ ...ports.current() }),
    isCurrent,
    async call(pin, path, init = {}, opts = {}) {
      if (!pin.token || !isCurrent(pin)) return null;
      const ctrl = opts.timeoutMs !== undefined ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
      let res: Response;
      try {
        res = await ports.fetch(`${pin.origin}${path}`, {
          ...init,
          headers: {
            ...authHeaders(pin.token, opts.json === true),
            ...(init.headers as Record<string, string> | undefined),
          },
          ...(ctrl ? { signal: ctrl.signal } : {}),
        });
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
      // The account moved on while this was in flight: not ours to act on.
      if (!isCurrent(pin)) return null;
      if (res.status === 401) await ports.signedOut(pin.generation);
      else if (res.status === 426) await ports.upgradeRequired(pin.origin);
      return res;
    },
    async json<T>(pin: Pin, res: Response | null): Promise<T | null> {
      if (!res?.ok) return null;
      let data: T;
      try {
        data = (await res.json()) as T;
      } catch {
        return null;
      }
      return isCurrent(pin) ? data : null;
    },
  };
}
