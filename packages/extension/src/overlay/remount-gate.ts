// Remounting a host the page moved is bounded (3b-C2): it runs outside the
// observer or event that noticed (a timer), at most once per notice burst, and
// at most `max` times in any `windowMs`. Past that it says no for the rest of
// the page load, and the overlay stays down.

export interface RemountGate {
  /** Ask for a remount; runs once, on a timer, however many times it is asked meanwhile. */
  schedule(): void;
  /** Called by the remount itself: may it mount a fresh host now? */
  allow(): boolean;
  /** The gate said no: the overlay is down for this page load. */
  down(): boolean;
}

export function createRemountGate(opts: {
  run: () => void;
  max?: number;
  windowMs?: number;
  now?: () => number;
  defer?: (fn: () => void) => void;
}): RemountGate {
  const max = opts.max ?? 3;
  const windowMs = opts.windowMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const defer = opts.defer ?? ((fn) => setTimeout(fn, 0));
  let times: number[] = [];
  let queued = false;
  let isDown = false;
  return {
    schedule() {
      if (queued || isDown) return;
      queued = true;
      defer(() => {
        queued = false;
        if (!isDown) opts.run();
      });
    },
    allow() {
      if (isDown) return false;
      const t = now();
      times = times.filter((x) => t - x < windowMs);
      if (times.length >= max) {
        isDown = true;
        return false;
      }
      times.push(t);
      return true;
    },
    down: () => isDown,
  };
}
