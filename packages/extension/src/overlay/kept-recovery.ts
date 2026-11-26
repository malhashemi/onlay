// Recovery of kept entries a snapshot dropped to fit (`keptOmitted`, R3-C6).
// The caller pins the batch to what it was started under (the account and its
// generation, the person's membership of the space, the page key) and passes
// that as `still`. Every listed id is read, in pages, a few at a time; `still`
// is checked before each read and before anything is merged, so a batch that
// outlives its account, its space or its page stops without a trace.

export interface RecoveryOptions {
  /** Ids per page; each page is merged before the next starts. */
  pageSize?: number;
  /** Reads in flight at once. */
  workers?: number;
}

export async function recoverKept<T>(
  ids: readonly string[],
  read: (id: string) => Promise<T | null>,
  still: () => boolean,
  merge: (found: readonly T[]) => void,
  opts: RecoveryOptions = {},
): Promise<void> {
  const pageSize = Math.max(1, opts.pageSize ?? 50);
  const workers = Math.max(1, opts.workers ?? 3);
  const unique = [...new Set(ids)];
  const found: T[] = [];
  for (let at = 0; at < unique.length; at += pageSize) {
    if (!still()) return;
    const queue = unique.slice(at, at + pageSize);
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (!still()) return;
        const got = await read(id);
        if (got !== null) found.push(got);
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    if (!still()) return;
    if (found.length > 0) merge([...found]);
  }
}
