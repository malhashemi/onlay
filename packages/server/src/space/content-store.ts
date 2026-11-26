import type { Db } from "./ports";

/**
 * Captured HTML sidecars (ADR-0017 §1, spec §8). The block an anchor was
 * placed on (`anchor`, up to MAX_ANCHOR_CONTENT) and a page edit's sanitized
 * page body (`page`, up to MAX_PAGE_CONTENT) are large and untrusted, so they
 * live in their own table keyed by interaction — never inflating snapshots
 * or frames. Write-once per slot (the routes refuse a second upload); rows
 * ride interaction retention.
 */
export type ContentSlot = "anchor" | "page";

export interface StoredContent {
  format: string;
  content: string;
  truncated: boolean;
}

export interface ContentStore {
  write(
    interactionId: string,
    slot: ContentSlot,
    content: string,
    format: string,
    truncated: boolean,
    now: number,
  ): boolean;
  read(interactionId: string, slot: ContentSlot): StoredContent | null;
}

const SAFE_ID = /^[0-9a-f-]{1,64}$/i;

export function makeContentStore(db: Db): ContentStore {
  return {
    /** True when this write filled the slot; false when it was already taken (write-once). */
    write(interactionId, slot, content, format, truncated, now) {
      if (!SAFE_ID.test(interactionId)) return false;
      const r = db.run(
        "INSERT INTO contents (interaction_id, slot, content, format, truncated, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(interaction_id, slot) DO NOTHING",
        interactionId,
        slot,
        content,
        format,
        truncated ? 1 : 0,
        now,
      );
      return r.changes > 0;
    },
    read(interactionId, slot) {
      if (!SAFE_ID.test(interactionId)) return null;
      const row = db.get<{ content: string; format: string; truncated: number }>(
        "SELECT content, format, truncated FROM contents WHERE interaction_id = ? AND slot = ?",
        interactionId,
        slot,
      );
      return row
        ? { content: row.content, format: row.format, truncated: Number(row.truncated) === 1 }
        : null;
    },
  };
}
