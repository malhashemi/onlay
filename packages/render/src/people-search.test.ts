import { describe, expect, test } from "bun:test";
import { foldForSearch, personMatches, personMatchRank, searchPeople } from "./people-search";

const odile = { name: "R. Odile Varga", alias: "rvarga" };
const jose = { name: "José Núñez" };
const ann = { name: "Ann Lee", alias: "ann.lee" };

describe("finding a person", () => {
  test("by any word of their name, from its start, in any case", () => {
    for (const q of [
      "odile",
      "Odile",
      "VARG",
      "r",
      "r. odile",
      "odile var",
      "r-odile-va",
      "odileva",
    ]) {
      expect(personMatches(q, odile)).toBe(true);
    }
    for (const q of ["dile", "arga", "odile x", "zz"]) expect(personMatches(q, odile)).toBe(false);
  });

  test("by their alias, from its start", () => {
    expect(personMatchRank("rvar", odile)).toBe(2);
    expect(personMatchRank("rvarga", odile)).toBe(2);
    expect(personMatches("ann.l", ann)).toBe(true);
    expect(personMatches("arga", odile)).toBe(false);
    // Without an alias (a guest's view), only the name finds them.
    expect(personMatches("rvarga", { name: odile.name })).toBe(false);
  });

  test("accents and case fold away, both ways", () => {
    expect(personMatches("jose", jose)).toBe(true);
    expect(personMatches("nunez", jose)).toBe(true);
    expect(personMatches("NÚÑ", jose)).toBe(true);
    expect(personMatches("José", { name: "Jose Nunez" })).toBe(true);
    expect(foldForSearch("Straße")).toBe("strasse");
    expect(personMatches("obrien", { name: "Sean O’Brien" })).toBe(true);
  });

  test("an empty query finds everyone; the best match comes first", () => {
    const people = [ann, odile, jose, { name: "Odila Ann" }];
    expect(searchPeople("", people)).toHaveLength(4);
    expect(searchPeople("ann", people).map((p) => p.name)).toEqual(["Ann Lee", "Odila Ann"]);
    expect(searchPeople("od", people).map((p) => p.name)).toEqual(["Odila Ann", "R. Odile Varga"]);
    expect(searchPeople("a", people, 2)).toHaveLength(2);
  });
});
