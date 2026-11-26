# Security Policy

## Reporting a vulnerability

Do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.

Report vulnerabilities privately through GitHub's private vulnerability reporting on this repository:

`https://github.com/malhashemi/onlay/security/advisories/new`

When testing a potential issue, prefer reproducing it against a local instance (`wrangler dev`) rather than probing accounts or spaces you do not own on the hosted service.

## What to include

A good report helps us verify and fix the issue quickly:

- The affected surface (`app.onlay.dev`, `onlay.dev`, the Chromium extension, or the MCP server) and the extension version or commit SHA if known.
- Step-by-step reproduction instructions, including relevant HTTP requests, headers, payloads, or minimal test pages.
- The security impact and who is affected (for example: cross-space data exposure, guest-to-member privilege escalation, host-page access into the closed shadow root, bypass of markup redaction, or bypass of the live variant `PagePolicy`).
- Any suggested fix or mitigation, if you have one.

## What to expect

We review every private report, work to reproduce and verify the impact, and coordinate a fix before public disclosure. We will keep you updated as we investigate, prepare a patch, and deploy or release the fix.

## Scope

### In scope

- **The hosted service (`https://app.onlay.dev`):** Web app, HTTP and WebSocket API, WorkOS AuthKit sign-in and session handling, credential revocation, D1 authorization checks, per-space Durable Object isolation, and web push.
- **The public site (`https://onlay.dev`):** Host-split isolation (no credentials read or set), Content-Security-Policy, and downloadable packages.
- **The Chromium extension (`packages/extension`):** Closed shadow root isolation, typing and drag routing, origin gating, URL binding, embedded frame handling, automatic variant captures, and markup redaction.
- **The MCP server (`https://app.onlay.dev/mcp`):** OAuth token validation, audience and revocation checks, lease enforcement, and untrusted-data framing.
- **Live variant rendering (`packages/render`):** Enforcement of `PagePolicy` for variant mutation programs applied to live pages.

### Out of scope

- **The local development sign-in stub (`DEV_AUTH=1`):** Restricted to `localhost` and `127.0.0.1` in `env.dev` and never deployed.
- **Compromised devices or mailboxes:** Attacks requiring physical access to an unlocked device, a compromised browser profile, or control of a user's verified email mailbox (Onlay treats verified email control as account identity).
- **Documented product limits:** Behavior explicitly accepted in [`AGENTS.md`](AGENTS.md) under "Known limits", such as a variant program restyling an allowed block to cover the viewport or a block screenshot capturing pixels visible inside the chosen block.
- **Volume-based testing:** Denial-of-service, load testing, or automated brute-force traffic against the hosted service without prior permission.
- **Non-exploitable findings:** Automated scanner output without a concrete exploit path, social engineering, or phishing.
- **Third-party platforms:** Vulnerabilities in Cloudflare, WorkOS, or upstream browsers unless caused by Onlay's own configuration or integration.
