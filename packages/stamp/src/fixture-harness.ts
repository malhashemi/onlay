import { type ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const STAMP_PACKAGE_ROOT = join(REPO_ROOT, "packages/stamp");

export function buildStampPackage(): void {
  const res = spawnSync("bun", ["run", "build"], {
    cwd: STAMP_PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`@onlay/stamp build failed: ${res.stderr || res.stdout}`);
}

/**
 * Fixtures live in a git-ignored cache inside the repository: Turbopack
 * resolves `next` only within the project's root, and the fixtures' packages
 * are symlinks into this repository. Not under node_modules, which the Next
 * rule excludes. Each fixture is removed when its test ends.
 */
export const FIXTURE_ROOT = join(REPO_ROOT, ".cache/stamp-fixtures");

const liveFixtures = new Set<string>();

export function makeFixtureDir(prefix: string): string {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
  const fixture = mkdtempSync(join(FIXTURE_ROOT, prefix));
  liveFixtures.add(fixture);
  mkdirSync(join(fixture, "node_modules"));
  return fixture;
}

/** Removes every fixture made since the last call; each fixture test file runs it in afterEach. */
export function removeFixtures(): void {
  for (const fixture of liveFixtures) {
    // Symlinks are removed, never followed: the linked packages stay.
    rmSync(fixture, { recursive: true, force: true });
    liveFixtures.delete(fixture);
  }
}

export function makeViteReactFixture(options: { prefix: string; stamped: boolean }): string {
  const fixture = makeFixtureDir(options.prefix);
  mkdirSync(join(fixture, "src"), { recursive: true });
  linkStampNodeModules(fixture, ["@vitejs", "vite", "react", "react-dom"]);
  linkStampPackage(fixture);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      dependencies: {
        "@vitejs/plugin-react": "*",
        "@onlay/stamp": "*",
        react: "*",
        "react-dom": "*",
        vite: "*",
      },
      type: "module",
    }),
  );
  writeFileSync(
    join(fixture, "index.html"),
    '<div id="root"></div><script type="module" src="/src/main.jsx"></script>',
  );
  writeFileSync(join(fixture, "vite.config.mjs"), viteReactConfig(options.stamped));
  writeFileSync(
    join(fixture, "src/App.jsx"),
    [
      "export function App() {",
      "  return (",
      '    <main id="target">',
      "      <button>Click</button>",
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fixture, "src/main.jsx"),
    [
      'import { createRoot } from "react-dom/client";',
      'import { App } from "./App.jsx";',
      "",
      'createRoot(document.getElementById("root")).render(<App />);',
      "",
    ].join("\n"),
  );
  return fixture;
}

export function linkStampPackage(fixture: string): void {
  linkNodeModule(fixture, "@onlay/stamp", STAMP_PACKAGE_ROOT);
}

export function linkStampNodeModules(fixture: string, packageNames: readonly string[]): void {
  for (const packageName of packageNames) {
    linkNodeModule(fixture, packageName, join(STAMP_PACKAGE_ROOT, "node_modules", packageName));
  }
}

export function linkPackageStoreNodeModules(fixture: string, packageName: string): void {
  const sourceNodeModules = packageStoreNodeModules(packageName);
  for (const entry of readdirSync(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const source = join(sourceNodeModules, entry.name);
    linkNodeModule(fixture, entry.name, realpathSync(source));
  }
}

export function readTree(root: string): string {
  if (!existsSync(root)) return "";
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? readTree(path) : readFileSync(path, "utf8");
    })
    .join("\n");
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate TCP port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForHttpText(options: {
  child: ChildProcessWithoutNullStreams;
  label: string;
  readyText: string;
  timeoutMs?: number;
  url: string;
}): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const output: string[] = [];
  options.child.stdout.on("data", (chunk) => output.push(String(chunk)));
  options.child.stderr.on("data", (chunk) => output.push(String(chunk)));

  while (Date.now() < deadline) {
    if (options.child.exitCode !== null) {
      throw new Error(`${options.label} exited early: ${output.join("\n")}`);
    }
    try {
      const response = await fetch(options.url);
      if (response.ok) {
        const html = await response.text();
        if (html.includes(options.readyText)) return html;
      }
    } catch {
      // Server not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`timed out waiting for ${options.label}: ${output.join("\n")}`);
}

export async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

function linkNodeModule(fixture: string, packageName: string, source: string): void {
  const target = join(fixture, "node_modules", packageName);
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, "dir");
}

function viteReactConfig(stamped: boolean): string {
  const stampImport = stamped ? ['import onlayStampVite from "@onlay/stamp/vite";'] : [];
  const stampPlugin = stamped ? "onlayStampVite(), " : "";
  return [
    'import react from "@vitejs/plugin-react";',
    ...stampImport,
    "",
    "export default {",
    `  plugins: [${stampPlugin}react()],`,
    "};",
    "",
  ].join("\n");
}

function packageStoreNodeModules(packageName: string): string {
  let dir = realpathSync(join(STAMP_PACKAGE_ROOT, "node_modules", packageName));
  const packagePathSegments = packageName.startsWith("@") ? 2 : 1;
  for (let i = 0; i < packagePathSegments; i += 1) dir = dirname(dir);
  return dir;
}
