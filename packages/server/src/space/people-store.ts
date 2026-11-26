import type { InternalPerson, PersonSummary } from "@onlay/protocol";
import type { Db } from "./ports";

/**
 * The people cache (spec §5.1, §7): who the edge says the space's members
 * are (replaced wholesale by `PUT /internal/people`), plus guests learned
 * from share changes and from the callers themselves. Display data only —
 * access always comes from the caller header, never from this table.
 */
export interface CachedPerson extends PersonSummary {
  member: boolean;
  /** A non-member holding a share here now. */
  guest: boolean;
}

export interface PeopleStore {
  get(personId: string): CachedPerson | undefined;
  all(): CachedPerson[];
  /** Sets one person exactly as the edge sees them now (member, share holder, display data). */
  set(person: InternalPerson): void;
  /** The person left, was removed or deleted: kept only for names in past messages. */
  remove(personId: string): void;
  /** Upserts one person without changing their membership if already known. */
  remember(person: PersonSummary, member: boolean): boolean;
  /** Marks a person as holding a share here (a share-change notice named them). */
  markGuest(personId: string): void;
}

interface Row {
  id: string;
  name: string;
  initials: string;
  tint: string;
  avatar_url: string | null;
  alias: string | null;
  member: number;
  guest: number;
  [k: string]: string | number | null;
}

function fromRow(r: Row): CachedPerson {
  return {
    id: r.id,
    name: r.name,
    initials: r.initials,
    tint: r.tint,
    ...(r.avatar_url ? { avatarUrl: r.avatar_url } : {}),
    ...(r.alias ? { alias: r.alias } : {}),
    member: Number(r.member) === 1,
    guest: Number(r.guest) === 1,
  };
}

export function makePeopleStore(db: Db): PeopleStore {
  const upsert = (p: PersonSummary, member: boolean) =>
    db.run(
      "INSERT INTO people (id, name, initials, tint, avatar_url, alias, member) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, initials = excluded.initials, " +
        "tint = excluded.tint, avatar_url = excluded.avatar_url, alias = excluded.alias, " +
        "member = excluded.member",
      p.id,
      p.name,
      p.initials,
      p.tint,
      p.avatarUrl ?? null,
      // Only a member has an alias here.
      member ? (p.alias ?? null) : null,
      member ? 1 : 0,
    );
  const get = (personId: string) => {
    const row = db.get<Row>("SELECT * FROM people WHERE id = ?", personId);
    return row ? fromRow(row) : undefined;
  };
  return {
    get,
    all() {
      return db.all<Row>("SELECT * FROM people ORDER BY name ASC, id ASC").map(fromRow);
    },
    set(person) {
      db.transaction(() => {
        upsert(person, person.member);
        db.run(
          "UPDATE people SET guest = ? WHERE id = ?",
          person.guest && !person.member ? 1 : 0,
          person.id,
        );
      });
    },
    remove(personId) {
      // Kept for the names in past messages; no picture, no alias.
      db.run(
        "UPDATE people SET member = 0, guest = 0, avatar_url = NULL, alias = NULL WHERE id = ?",
        personId,
      );
    },
    markGuest(personId) {
      db.run("UPDATE people SET guest = 1 WHERE id = ? AND member = 0", personId);
    },
    remember(person, member) {
      const prev = get(person.id);
      const next = {
        ...person,
        member: prev ? prev.member || member : member,
        guest: prev?.guest ?? false,
      };
      if (
        prev &&
        prev.name === next.name &&
        prev.initials === next.initials &&
        prev.tint === next.tint &&
        prev.avatarUrl === next.avatarUrl &&
        (prev.alias ?? null) === (next.member ? (next.alias ?? null) : null) &&
        prev.member === next.member
      ) {
        return false;
      }
      upsert(next, next.member);
      return true;
    },
  };
}
