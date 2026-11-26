// "Nothing is sent or stored", checked on what the browser actually runs: the
// build looks through the page's own scripts for every API that could send or
// keep anything, and fails if one is there.
//
// It is a search for names, so it has limits. It cannot see a name built at
// run time (`window["local" + "Storage"]`), and it does not read the
// highlighter's chunks, whose grammars list these very names as words to
// color. Those limits are covered elsewhere: the page's policy has
// `connect-src 'none'`, so no script of any kind can make a request, and the
// demo's store is tested with every storage API trapped (store.test.ts).

/** Everything a page could send with or keep data in, by the name code must use to reach it. */
const NAMES = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "openDatabase",
  "cookieStore",
  "cookie",
  "caches",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebTransport",
  "EventSource",
  "sendBeacon",
  "BroadcastChannel",
  "SharedWorker",
  "serviceWorker",
  "RTCPeerConnection",
  "importScripts",
  "getDirectory",
] as const;

const FINDER = new RegExp(`(?<![\\w$])(${NAMES.join("|")})(?![\\w$])`, "g");

/** The sending and storing API names `code` mentions, each once. */
export function sendingOrStoringNames(code: string): string[] {
  const found = new Set<string>();
  for (const m of code.matchAll(FINDER)) found.add(m[1] as string);
  return [...found].sort();
}

const STATIC_IMPORT = /(?:from|import)\s*"\.\/([^"]+\.js)"/g;
const DYNAMIC_IMPORT = /import\(\s*"\.\/([^"]+\.js)"\s*\)/g;

function names(re: RegExp, code: string): string[] {
  return [...code.matchAll(re)].map((m) => m[1] as string);
}

/**
 * The page's own scripts: the entry, the chunk it brings in after load (the
 * demo and the fragments), and everything those import outright. What they
 * in turn import on demand (the highlighter and its grammars) is `later`.
 */
export function ownScripts(
  entry: string,
  read: (name: string) => string,
): { own: string[]; later: string[] } {
  const closure = (roots: string[]): Set<string> => {
    const seen = new Set<string>();
    const todo = [...roots];
    while (todo.length > 0) {
      const name = todo.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      todo.push(...names(STATIC_IMPORT, read(name)));
    }
    return seen;
  };
  const first = closure([entry]);
  const live = [...first].flatMap((name) => names(DYNAMIC_IMPORT, read(name)));
  const own = closure([...first, ...live]);
  const later = new Set<string>();
  for (const name of own) {
    for (const next of names(DYNAMIC_IMPORT, read(name))) if (!own.has(next)) later.add(next);
  }
  return { own: [...own].sort(), later: [...later].sort() };
}
