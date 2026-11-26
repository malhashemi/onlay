// The Variants the demo agent has ready, as real mutation programs: the same
// shape an agent posts through the MCP `post_variants` tool, applied to the
// page by @onlay/render's preview engine. The demo has them for one block,
// the page's headline; the two rewordings are the copywriter's other
// headlines, the third restyles the one that is there.
import type { MutationProgram } from "@onlay/protocol";
import { COPY, OWN } from "../copy";
import type { Variant } from "../overlay/model";

/** The class the "Lighter" variant adds to the headline (styled in site.css). */
export const HEADLINE_LIGHT_CLASS = "is-light";

const HEADLINE: ReadonlyArray<{ label: string; program: MutationProgram }> = [
  {
    label: OWN.demo.variantLabels[0],
    program: [{ op: "setText", target: ":scope", text: COPY.hero.headlineAlternates[0] }],
  },
  {
    label: OWN.demo.variantLabels[1],
    program: [{ op: "setText", target: ":scope", text: COPY.hero.headlineAlternates[1] }],
  },
  {
    label: OWN.demo.variantLabels[2],
    program: [{ op: "setClass", target: ":scope", add: [HEADLINE_LIGHT_CLASS], remove: [] }],
  },
];

const PREPARED: Readonly<Record<string, typeof HEADLINE>> = { headline: HEADLINE };

/** Every prepared variant for a block, by the name in its `data-variants`. */
export function preparedVariants(key: string | undefined): Variant[] {
  const list = key ? PREPARED[key] : undefined;
  if (!list) return [];
  return list.map((v, i) => ({ id: `${key}-${i + 1}`, label: v.label, program: v.program }));
}

/** The sample page's Variants in the Edit section's fragment (the film's own two). */
export function sampleVariants(): Variant[] {
  return [
    {
      id: "sample-1",
      label: OWN.sample.variantLabels[0],
      program: [
        { op: "setClass", target: ":scope", add: ["is-highlighted"], remove: [] },
        { op: "setText", target: ".mini-plan-name", text: OWN.sample.planTeamPopular },
      ],
    },
    {
      id: "sample-2",
      label: OWN.sample.variantLabels[1],
      program: [
        {
          op: "insertFragment",
          target: ".mini-plan-name",
          position: "append",
          html: `<span class="mini-badge">${OWN.sample.badge}</span>`,
        },
      ],
    },
  ];
}
