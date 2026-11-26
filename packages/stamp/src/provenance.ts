import { execFileSync } from "node:child_process";
import { ONLAY_PROVENANCE_ATTR } from "@onlay/protocol";

/**
 * Dev-stamp provenance (ADR-0017 §3). The stamp build plugins read git ONCE
 * per dev-server boot and emit ONE document-level attribute
 * `data-onlay-provenance="<origin>@<sha>;<branch>;dirty|clean"`. Repo-relative
 * path (the per-element `data-onlay-source`) + origin + SHA is portable: an
 * agent on another machine can find the file. Everything fails soft to
 * `undefined` outside a git repo — provenance is a bonus, never a build gate,
 * and (like the stamp) is dev-only, never riding a public deployment.
 */

/** One git invocation, trimmed output, or undefined on any failure. */
function git(root: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a git remote URL to a portable `host/owner/repo` identifier,
 * dropping scheme, credentials, `.git` suffix, and SSH `git@` shorthand.
 */
export function normalizeOrigin(remote: string): string {
  let s = remote.trim();
  // scp-like SSH: git@github.com:owner/repo.git
  const scp = /^[^@/]+@([^:]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z]+:\/\//i, ""); // strip scheme
    s = s.replace(/^[^@/]+@/, ""); // strip user@ (https creds)
    s = s.replace(/:(?=\d)/, ":"); // keep :port as-is
  }
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  return s;
}

/**
 * Read the current repo's provenance once. Returns the opaque attribute value
 * `origin@sha;branch;dirty|clean`, or undefined outside a repo / when HEAD is
 * unreadable. Memoized per root so plugins reading it per request pay one git
 * cost per boot.
 */
const cache = new Map<string, string | undefined>();

export function readGitProvenance(root: string = process.cwd()): string | undefined {
  if (cache.has(root)) return cache.get(root);
  const value = computeGitProvenance(root);
  cache.set(root, value);
  return value;
}

/** Provenance value as a quoted HTML attribute (`data-onlay-provenance="…"`). */
export function provenanceHtmlAttr(value: string): string {
  const escaped = value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `${ONLAY_PROVENANCE_ATTR}="${escaped}"`;
}

/**
 * Inject the provenance attribute onto the document's `<html>` tag (Vite's
 * `transformIndexHtml`). No-op when already stamped or when the template has
 * no `<html>` tag.
 */
export function injectProvenanceIntoHtml(html: string, value: string): string {
  if (new RegExp(`\\b${ONLAY_PROVENANCE_ATTR}=`).test(html)) return html;
  return html.replace(
    /<html(\s|>)/i,
    (_m, tail: string) => `<html ${provenanceHtmlAttr(value)}${tail}`,
  );
}

function computeGitProvenance(root: string): string | undefined {
  const sha = git(root, ["rev-parse", "HEAD"]);
  if (!sha) return undefined; // not a repo (or no commits) → no provenance
  const remote = git(root, ["remote", "get-url", "origin"]);
  const origin = remote ? normalizeOrigin(remote) : "local";
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
  const dirty = git(root, ["status", "--porcelain"]) ? "dirty" : "clean";
  return `${origin}@${sha};${branch};${dirty}`;
}
