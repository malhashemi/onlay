import type { CallerAccess } from "@onlay/protocol";
import type { Db } from "./ports";

/**
 * Web Push persistence: one subscription per credential (a web app session;
 * upsert replaces), plus the space's own VAPID keypair for deployments that
 * provide none.
 */

/** The browser's PushSubscription.toJSON() shape, stored verbatim. */
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null | undefined;
  keys: { p256dh: string; auth: string };
}

export interface PushSubscriptionRow {
  credentialId: string;
  /** When the subscribing credential was issued (absent on rows from before it was recorded). */
  credentialGeneration?: number;
  personId: string;
  access: CallerAccess;
  subscription: PushSubscriptionJson;
  createdAt: number;
}

export interface PushStore {
  upsert(
    credentialId: string,
    personId: string,
    access: CallerAccess,
    sub: PushSubscriptionJson,
    now: number,
    credentialGeneration?: number,
  ): void;
  /** The person's access changed: re-scope their subscriptions. */
  setAccess(personId: string, access: CallerAccess): void;
  /** Idempotent delete by credential (unsubscribe, dead endpoint). */
  remove(credentialId: string): void;
  /** Access lost: every credential of the person sheds its subscription. */
  removeByPerson(personId: string): void;
  listAll(): PushSubscriptionRow[];
}

export function makePushStore(db: Db): PushStore {
  return {
    upsert(credentialId, personId, access, sub, now, credentialGeneration) {
      db.run(
        "INSERT INTO push_subscriptions (credential_id, person_id, access_json, json, created_at, credential_generation) " +
          "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(credential_id) DO UPDATE SET " +
          "person_id = excluded.person_id, access_json = excluded.access_json, " +
          "json = excluded.json, created_at = excluded.created_at, " +
          "credential_generation = excluded.credential_generation",
        credentialId,
        personId,
        JSON.stringify(access),
        JSON.stringify(sub),
        now,
        credentialGeneration ?? null,
      );
    },
    setAccess(personId, access) {
      db.run(
        "UPDATE push_subscriptions SET access_json = ? WHERE person_id = ?",
        JSON.stringify(access),
        personId,
      );
    },
    remove(credentialId) {
      db.run("DELETE FROM push_subscriptions WHERE credential_id = ?", credentialId);
    },
    removeByPerson(personId) {
      db.run("DELETE FROM push_subscriptions WHERE person_id = ?", personId);
    },
    listAll() {
      return db
        .all<{
          credential_id: string;
          person_id: string;
          access_json: string;
          json: string;
          created_at: number;
          credential_generation: number | null;
        }>(
          "SELECT credential_id, person_id, access_json, json, created_at, credential_generation FROM push_subscriptions " +
            "ORDER BY created_at ASC",
        )
        .map((r) => ({
          credentialId: r.credential_id,
          personId: r.person_id,
          access: JSON.parse(r.access_json) as CallerAccess,
          subscription: JSON.parse(r.json) as PushSubscriptionJson,
          createdAt: Number(r.created_at),
          ...(r.credential_generation !== null
            ? { credentialGeneration: Number(r.credential_generation) }
            : {}),
        }));
    },
  };
}
