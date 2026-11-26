export const ONLAY_SOURCE_ATTR = "data-onlay-source";

/**
 * Document-level provenance stamp (ADR-0017 §3): one opaque
 * `origin@sha;branch;dirty` string on the page root, joined to every element
 * anchor by the extension. Dev-only, like `data-onlay-source`.
 */
export const ONLAY_PROVENANCE_ATTR = "data-onlay-provenance";
