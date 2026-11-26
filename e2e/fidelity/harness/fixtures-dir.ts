import { fileURLToPath } from "node:url";

/** Absolute path to the fidelity fixture pages (served on an ephemeral localhost port). */
export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));
