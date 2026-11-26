import { startStack } from "./stack";

/**
 * Builds the web app and the run's extension, then starts the local stack
 * (stack.ts). Returns the teardown that stops `wrangler dev` and deletes the
 * run's persistence directory and extension copy.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  return startStack();
}
