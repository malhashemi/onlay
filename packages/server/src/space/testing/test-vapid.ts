/**
 * A fixed VAPID key pair for tests only (the in-process harness and the
 * Workers suite's bindings). Never a deployment's keys: those are minted with
 * `generateVapidKeys()` and set as secrets (README, "Deploying production").
 */
export const TEST_VAPID = {
  publicKey:
    "BMYd8duKfHjJqfMeimqVpmIsYDsKN9tb9NOD2e498dcXFpUXGSg6ONTbHL1Mv4lxbqP6BPR-nP0Ht4NQEFqi0f0",
  privateJwk: JSON.stringify({
    crv: "P-256",
    d: "StCfTyQvG2Uv89BwZ-UZU-MtyH6O11xER7IFSHUH_U0",
    ext: true,
    key_ops: ["sign"],
    kty: "EC",
    x: "xh3x24p8eMmp8x6KapWmYixgOwo321v004PZ7j3x1xc",
    y: "FpUXGSg6ONTbHL1Mv4lxbqP6BPR-nP0Ht4NQEFqi0f0",
  }),
} as const;
