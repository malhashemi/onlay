// The local stack every e2e run stands up once (spec §11): the real Worker,
// the space Durable Objects and a fresh local D1 under `wrangler dev` in the
// `dev` environment, on a free port, with its persistence in a temp directory
// so a run never shares state with another run or with a developer's
// `packages/server/.wrangler/state`. Global setup starts it and hands its
// address to the test workers through the environment; teardown stops it.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// The fixed test pair the Workers suite uses, so web push is on in the run as
// it is in production. Never a deployment's keys.
import { TEST_VAPID } from "../../packages/server/src/space/testing/test-vapid";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER_DIR = join(ROOT, "packages/server");
const EXTENSION_DIST = join(ROOT, "packages/extension/dist");
const WRANGLER = join(SERVER_DIR, "node_modules/.bin/wrangler");

/** The super admin of every run (SUPER_ADMINS): setup opens workspace creation with it. */
const ROOT_EMAIL = "root@e2e.test";

/** What global setup hands the test workers (through process.env). */
export interface StackInfo {
  /** `http://localhost:<port>`: the Worker's PUBLIC_ORIGIN for this run. */
  origin: string;
  /** The test copy of the unpacked extension, granted the run's origin. */
  extensionDir: string;
}

const ENV_ORIGIN = "ONLAY_E2E_ORIGIN";
const ENV_EXTENSION = "ONLAY_E2E_EXTENSION";

export function stackInfo(): StackInfo {
  const origin = process.env[ENV_ORIGIN];
  const extensionDir = process.env[ENV_EXTENSION];
  if (!origin || !extensionDir) {
    throw new Error("the e2e stack is not running: run the suite through its Playwright config");
  }
  return { origin, extensionDir };
}

/** A free loopback port (bind to 0, read it, release it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], cwd: string, what: string, env = {}): void {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${what} failed (exit ${result.status})`);
}

/**
 * Builds the web app (served at /app/), the landing page (at / and /site/*)
 * and the run's extension: pointed at
 * this run's origin (its host permission and `externally_connectable`, which
 * the sign-in hand-off needs) and with the overlay's shadow root open, so
 * Playwright can reach into it. The pinned manifest key keeps the id the dev
 * environment lists in EXTENSION_IDS. The build is copied out of `dist/`, and
 * `dist/` is rebuilt as `bun run build:ext` leaves it, so a developer's
 * unpacked extension never points at a test port.
 */
function buildClients(origin: string, into: string): string {
  // The web app and the landing page (its links on this run's one origin), staged together.
  run("bun", ["run", "build:web"], ROOT, "web app and landing page build", {
    ONLAY_SERVICE_ORIGIN: origin,
  });
  // Every build variable is set here, so a developer's root `.env` (which the
  // package builds read, and which the shell's values override) changes nothing.
  run("bun", ["run", "build:ext"], ROOT, "e2e extension build", {
    ONLAY_SERVER_ORIGIN: origin,
    ONLAY_SITE_ORIGIN: origin,
    ONLAY_EXTENSION_VERSION: "0.0.0",
    ONLAY_SHADOW_MODE: process.env.E2E_SHADOW_MODE === "closed" ? "closed" : "open",
  });
  const dir = join(into, "extension");
  cpSync(EXTENSION_DIST, dir, { recursive: true });
  run("bun", ["run", "build:ext"], ROOT, "extension build");
  return dir;
}

async function waitHealthy(origin: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log()}`);
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev did not answer /healthz within 60s:\n${log()}`);
}

/** Workspace creation open to anyone who signs in, set by the run's super admin. */
async function openWorkspaceCreation(origin: string): Promise<void> {
  const signIn = await fetch(`${origin}/auth/dev/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.255.0.1" },
    body: JSON.stringify({ email: ROOT_EMAIL }),
  });
  if (!signIn.ok) throw new Error(`super admin sign-in failed: ${signIn.status}`);
  const { token } = (await signIn.json()) as { token: string };
  const res = await fetch(`${origin}/api/admin/settings`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Onlay-Protocol": "2",
    },
    body: JSON.stringify({ workspaceCreation: "anyone", creators: [] }),
  });
  if (!res.ok) throw new Error(`opening workspace creation failed: ${res.status}`);
}

/**
 * Builds the clients, starts the stack and returns its teardown. The process group is killed on
 * teardown and, as a backstop, when the Playwright runner exits.
 */
export async function startStack(): Promise<() => Promise<void>> {
  const dir = mkdtempSync(join(tmpdir(), "onlay-e2e-"));
  const port = await freePort();
  const inspector = await freePort();
  const origin = `http://localhost:${port}`;
  const state = join(dir, "state");
  let extensionDir: string;
  try {
    extensionDir = buildClients(origin, dir);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  // --env-file replaces .dev.vars, so a developer's own secrets never leak in.
  const envFile = join(dir, "e2e.env");
  writeFileSync(
    envFile,
    [
      `PUBLIC_ORIGIN=${origin}`,
      "SESSION_SECRET=e2e-session-secret-0123456789abcdef0123456789abcdef",
      `SUPER_ADMINS=${ROOT_EMAIL}`,
      `VAPID_PUBLIC_KEY=${TEST_VAPID.publicKey}`,
      `VAPID_PRIVATE_JWK='${TEST_VAPID.privateJwk}'`,
      "",
    ].join("\n"),
  );

  run(
    WRANGLER,
    ["d1", "migrations", "apply", "onlay-dev", "--local", "--env", "dev", "--persist-to", state],
    SERVER_DIR,
    "local D1 migrations",
  );

  let output = "";
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "--env",
      "dev",
      "--ip",
      "localhost",
      "--port",
      String(port),
      "--inspector-port",
      String(inspector),
      "--persist-to",
      state,
      "--env-file",
      envFile,
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    { cwd: SERVER_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  let stopped = false;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  };
  const backstop = () => kill("SIGKILL");
  process.once("exit", backstop);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    process.off("exit", backstop);
    kill("SIGTERM");
    const exited = new Promise<void>((r) => {
      if (child.exitCode !== null) r();
      else child.once("exit", () => r());
    });
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000));
    if ((await Promise.race([exited, timeout])) === "timeout") kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    await waitHealthy(origin, child, () => output);
    await openWorkspaceCreation(origin);
    process.env[ENV_ORIGIN] = origin;
    process.env[ENV_EXTENSION] = extensionDir;
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
}
