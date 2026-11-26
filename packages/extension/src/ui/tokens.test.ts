// D-TOKENS drift guard (ADVISORY-5). The PWA (`packages/pwa`) ships its own
// static `tokens.css` / `fonts.css` authored from the same design tokens — the
// same source the extension's generated `PAGE_TOKENS_CSS` / `FONTS_CSS` come
// from. Nothing else forces the two copies to stay identical, so this lock pins
// them byte-for-byte.
//
// The guard lives in the EXTENSION zone on purpose (spec D-TOKENS): importing
// the extension from `pwa` is a fallow boundary error, and reading the built
// extension dist from `pwa` would race the gate order. Reading the PWA's two
// files from DISK crosses no boundary and needs no build, so `bun run check`
// stays green on a fresh checkout.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FONTS_CSS, PAGE_TOKENS_CSS } from "./tokens";

const PWA_SRC = join(import.meta.dir, "../../../pwa/src");
const read = (name: string): string => readFileSync(join(PWA_SRC, name), "utf8");

describe("D-TOKENS: the PWA's token CSS never drifts from the extension's", () => {
  test("tokens.css byte-equals PAGE_TOKENS_CSS", () => {
    expect(read("tokens.css")).toBe(PAGE_TOKENS_CSS);
  });

  test("fonts.css byte-equals FONTS_CSS", () => {
    expect(read("fonts.css")).toBe(FONTS_CSS);
  });
});
