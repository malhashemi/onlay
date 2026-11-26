import { describe, expect, test } from "bun:test";
import type { CaptureRef } from "@onlay/protocol";
import { hasFutureVariantLook, variantLooks, variantRungVerdict } from "./interaction-view";
import type { RenderResidue } from "./portable-renderer";

const SET = "set-1";
const IID = "11111111-1111-4111-8111-111111111111";

function ref(over: Partial<CaptureRef>): CaptureRef {
  return {
    captureId: "cap",
    interactionId: IID,
    kind: "variant-look",
    lineageId: "varlook:x",
    revision: 1,
    capturedAt: 100,
    capturedBy: "you",
    capturedFrom: "extension",
    format: "onlay-varlook/1",
    totalBytes: 10,
    parts: [{ name: "witness", role: "witness", mime: "image/webp", byteLen: 10 }],
    variantSetId: SET,
    variantId: "v1",
    variantVersion: 1,
    ...over,
  };
}

const snap = (captures: CaptureRef[]) =>
  ({ captures }) as unknown as Parameters<typeof variantLooks>[0];

describe("variantLooks (F30)", () => {
  test("matches by set+variant, ignores other kinds and foreign sets", () => {
    const looks = variantLooks(
      snap([
        ref({}),
        ref({ captureId: "other-set", variantSetId: "set-2" }),
        ref({ captureId: "snapshot", kind: "snapshot" }),
      ]),
      SET,
      [{ variantId: "v1", version: 1 }],
    );
    expect(looks.get("v1")?.ref.captureId).toBe("cap");
    expect(looks.get("v1")?.stale).toBe(false);
  });

  test("freshest VERSION wins over a newer revision of an older version (sol-8)", () => {
    // A slow v1 upload committed AFTER the v2 witness: higher revision, older version.
    const looks = variantLooks(
      snap([
        ref({ captureId: "fresh", variantVersion: 2, revision: 1 }),
        ref({ captureId: "slow-stale", variantVersion: 1, revision: 3 }),
      ]),
      SET,
      [{ variantId: "v1", version: 2 }],
    );
    expect(looks.get("v1")?.ref.captureId).toBe("fresh");
    expect(looks.get("v1")?.stale).toBe(false);
  });

  test("an older-version-only witness is served but marked STALE", () => {
    const looks = variantLooks(snap([ref({ variantVersion: 1 })]), SET, [
      { variantId: "v1", version: 2 },
    ]);
    expect(looks.get("v1")?.stale).toBe(true);
  });

  test("a FUTURE witness (stale cached set) is excluded and flagged (sol-14)", () => {
    const s = snap([ref({ variantVersion: 3 })]);
    const vs = [{ variantId: "v1", version: 2 }];
    expect(variantLooks(s, SET, vs).get("v1")).toBeUndefined();
    expect(hasFutureVariantLook(s, SET, vs)).toBe(true);
    expect(hasFutureVariantLook(snap([ref({})]), SET, vs)).toBe(false);
  });
});

describe("variantRungVerdict (F30 display law)", () => {
  const clean: RenderResidue = {
    strippedPlaceholders: 0,
    strippedUrls: 0,
    authorRulesMissing: false,
    applied: 2,
    misses: 0,
    rejected: 0,
  };

  test("fresh witness beside a trusted original → rung 2, primary", () => {
    const v = variantRungVerdict({
      look: { ref: ref({}), stale: false },
      originalTrusted: true,
    });
    expect(v).toEqual({ rung: 2, pick: "primary", caution: "" });
  });

  test("fresh witness with NO trustworthy original demotes (evidence pair)", () => {
    const v = variantRungVerdict({ look: { ref: ref({}), stale: false }, originalTrusted: false });
    expect(v.pick).toBe("demoted");
  });

  test("stale witness demotes with the earlier-revision copy", () => {
    const v = variantRungVerdict({
      look: { ref: ref({}), stale: true },
      render: clean,
      originalTrusted: true,
    });
    expect(v.rung).toBe(3);
    expect(v.caution).toContain("earlier revision");
  });

  test("program misses/rejected demote even with a spotless meter (fable-serious)", () => {
    const v = variantRungVerdict({
      render: { ...clean, misses: 2, rejected: 1 },
      originalTrusted: true,
    });
    expect(v.pick).toBe("demoted");
    expect(v.caution).toContain("3 of this variant's edits");
  });

  test("the honest failure page is rung 4, never clean rung 3 (sol-13)", () => {
    const v = variantRungVerdict({ render: clean, renderFailed: true, originalTrusted: true });
    expect(v.rung).toBe(4);
    expect(v.pick).toBe("demoted");
  });

  test("authorRulesMissing counts as dirty; a truly clean recon earns primary", () => {
    expect(
      variantRungVerdict({
        render: { ...clean, authorRulesMissing: true },
        originalTrusted: true,
      }).pick,
    ).toBe("demoted");
    expect(variantRungVerdict({ render: clean, originalTrusted: true })).toEqual({
      rung: 3,
      pick: "primary",
      caution: "",
    });
  });
});
