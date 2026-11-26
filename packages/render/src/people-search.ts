// Finding a person by what someone types: any word of their display name,
// their whole name, or their alias (the local part of their email, which only
// a space's members are given), each from its start, ignoring case and
// accents ("odile", "Varg", "rvarga", "jose" for "José"). One rule for
// every client's mention menu and people search.

/** Lower case, accents dropped, and the few letters that fold to two (ß → ss). */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[’']/g, "");
}

/** The words of a name: split at spaces and the punctuation names carry between parts. */
function wordsOf(folded: string): string[] {
  return folded.split(/[\s.,_\-()/]+/u).filter((word) => word.length > 0);
}

/** What a search reads of a person. */
export interface Searchable {
  name: string;
  alias?: string | undefined;
}

/**
 * How well `query` finds this person: 0 their name starts with it, 1 a word
 * of their name does (or, for a query of several words, each word starts a
 * word of the name), 2 their alias starts with it; null when nothing does.
 * An empty query finds everyone, at 0.
 */
export function personMatchRank(query: string, person: Searchable): number | null {
  const q = foldForSearch(query).trim();
  if (q === "") return 0;
  const name = foldForSearch(person.name);
  if (name.startsWith(q)) return 0;
  const words = wordsOf(name);
  const parts = wordsOf(q);
  if (parts.length > 0 && parts.every((part) => words.some((word) => word.startsWith(part)))) {
    return 1;
  }
  // A handle-like query typed without its separators (`adelal`): words run together.
  const squashed = q.replace(/[\s.,_\-()/]+/gu, "");
  if (squashed !== "" && words.some((_, i) => words.slice(i).join("").startsWith(squashed))) {
    return 1;
  }
  const alias = person.alias ? foldForSearch(person.alias) : "";
  if (alias !== "" && alias.startsWith(q)) return 2;
  return null;
}

/** True when `query` finds this person (`personMatchRank`). */
export function personMatches(query: string, person: Searchable): boolean {
  return personMatchRank(query, person) !== null;
}

/**
 * The people `query` finds, best first (by rank, then name), at most `limit`.
 * The list's own order breaks remaining ties.
 */
export function searchPeople<P extends Searchable>(
  query: string,
  people: Iterable<P>,
  limit = Number.POSITIVE_INFINITY,
): P[] {
  const ranked: { person: P; rank: number; at: number }[] = [];
  let at = 0;
  for (const person of people) {
    const rank = personMatchRank(query, person);
    if (rank !== null) ranked.push({ person, rank, at });
    at += 1;
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      foldForSearch(a.person.name).localeCompare(foldForSearch(b.person.name)) ||
      a.at - b.at,
  );
  return ranked.slice(0, limit).map((r) => r.person);
}
