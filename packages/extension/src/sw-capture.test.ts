// Unit tests for the SW capture-contract helpers (ADR-0022 §4/§5/§8): the
// port-stripping grant pattern, the private-network guard, part hashing, and
// manifest assembly — all pure, no `chrome.*`.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  base64ToBytes,
  buildEditContextUpload,
  bytesToBase64,
  harvestGuard,
  isPrivateHost,
  patternForOrigin,
  type RawPart,
  sha256HexBytes,
  targetKeyFrom,
} from "./sw-capture";

const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("patternForOrigin (F8 port-stripping)", () => {
  test("strips the port to a host-granularity pattern", () => {
    expect(patternForOrigin("http://localhost:5173/x.css")).toBe("http://localhost/*");
    expect(patternForOrigin("https://cdn.example.com:8443")).toBe("https://cdn.example.com/*");
    expect(patternForOrigin("http://127.0.0.1:3000/")).toBe("http://127.0.0.1/*");
  });
  test("localhost and 127.0.0.1 are distinct hosts (proven distinct — proto a5)", () => {
    expect(patternForOrigin("http://localhost:1/a")).not.toBe(
      patternForOrigin("http://127.0.0.1:1/a"),
    );
  });
});

describe("isPrivateHost", () => {
  test("loopback + RFC-1918 + link-local + .local are private", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.1.1",
      "printer.local",
      "::1",
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });
  test("public hosts and 172.32.x are not private", () => {
    for (const h of ["example.com", "cdn.jsdelivr.net", "8.8.8.8", "172.32.0.1"]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
  test("IPv4-mapped IPv6 loopback/private literals are private (gpt56-1)", () => {
    for (const h of [
      "::ffff:127.0.0.1",
      "[::ffff:127.0.0.1]",
      "::ffff:192.168.0.1",
      "::ffff:7f00:0001", // hex-form 127.0.0.1
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
    expect(isPrivateHost("::ffff:8.8.8.8")).toBe(false); // mapped PUBLIC stays public
  });
});

describe("harvestGuard (F7 SSRF guard)", () => {
  const page = "http://localhost:5173/app";
  const server = "http://127.0.0.1:8123";

  test("public cross-origin asset passes (grant-gated elsewhere)", () => {
    expect(harvestGuard("https://cdn.example.com/font.woff2", page, server)).toEqual({ ok: true });
  });
  test("the page's OWN loopback assets and other ports are allowed", () => {
    expect(harvestGuard("http://localhost:5173/a.png", page, server).ok).toBe(true);
    expect(harvestGuard("http://localhost:4000/asset.css", page, server).ok).toBe(true);
  });
  test("the paired server's own origin is allowed", () => {
    expect(harvestGuard("http://127.0.0.1:8123/x", page, server).ok).toBe(true);
  });
  test("the server's OTHER ports are refused — server matches by exact ORIGIN (gpt56-1)", () => {
    // The real default: page on localhost, server on 127.0.0.1:8123. A page must
    // NOT reach 127.0.0.1:9999 just because it shares the server's HOST — that is
    // the SSRF surface a hostname-only server match would open.
    const r = harvestGuard("http://127.0.0.1:9999/probe", page, server);
    expect(r).toEqual({ ok: false, reason: "blocked", detail: "private-network" });
    // An IPv4-mapped loopback literal is refused the same way.
    expect(harvestGuard("http://[::ffff:127.0.0.1]:9999/probe", page, server).ok).toBe(false);
  });
  test("an UNRELATED private host is refused with the private-network detail", () => {
    const r = harvestGuard("http://192.168.1.1/admin", page, server);
    expect(r).toEqual({ ok: false, reason: "blocked", detail: "private-network" });
    // A loopback host that is NOT the page's host and NOT the server's host is
    // refused — here the server is on localhost, so 127.0.0.1 is unrelated.
    const r2 = harvestGuard("http://127.0.0.1:9999/probe", page, "http://localhost:8123");
    expect(r2).toEqual({ ok: false, reason: "blocked", detail: "private-network" });
  });
  test("non-http protocols are blocked", () => {
    expect(harvestGuard("file:///etc/passwd", page, server).ok).toBe(false);
    expect(harvestGuard("ftp://host/x", page, server).ok).toBe(false);
  });
});

describe("sha256HexBytes / targetKeyFrom", () => {
  test("matches node's SHA-256 over the same bytes", async () => {
    const bytes = new TextEncoder().encode("the flattened document");
    expect(await sha256HexBytes(bytes)).toBe(nodeSha(bytes));
  });
  test("targetKey is the 32-hex prefix of the source-string hash (≤ MAX_CAPTURE_ID after 'edit:')", async () => {
    const raw = "src/components/Hero.tsx:42:8";
    const key = await targetKeyFrom(raw);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(nodeSha(new TextEncoder().encode(raw)).slice(0, 32));
    expect(`edit:${key}`.length).toBeLessThanOrEqual(64);
  });
});

describe("buildEditContextUpload", () => {
  const gzipMagic = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3]);
  const parts: RawPart[] = [
    { name: "document", role: "document", mime: "application/gzip", bytes: gzipMagic },
    {
      name: "font-abc12345",
      role: "font",
      mime: "font/woff2",
      bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
    },
  ];

  test("fills sha256 + byteLen per part and threads targetKey into meta", async () => {
    const { manifest, bytesBySha } = await buildEditContextUpload({
      format: "onlay-cap/1",
      parts,
      meta: { viewport: { innerWidth: 800, innerHeight: 600, dpr: 2, layoutWidth: 800 } },
      targetKeyRaw: "selector-or-source",
    });
    expect(manifest.kind).toBe("edit-context");
    expect(manifest.format).toBe("onlay-cap/1");
    expect(manifest.parts.map((p) => p.name)).toEqual(["document", "font-abc12345"]);
    for (const p of manifest.parts) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(bytesBySha.has(p.sha256)).toBe(true);
    }
    expect(manifest.parts[0]?.byteLen).toBe(gzipMagic.byteLength);
    expect(manifest.parts[0]?.sha256).toBe(nodeSha(gzipMagic));
    expect((manifest.meta?.targetKey as string).length).toBe(32);
    expect(manifest.meta?.viewport).toEqual({
      innerWidth: 800,
      innerHeight: 600,
      dpr: 2,
      layoutWidth: 800,
    });
  });

  test("omits meta entirely when neither meta nor a target key is supplied", async () => {
    const { manifest } = await buildEditContextUpload({ format: "onlay-cap/1", parts });
    expect(manifest.meta).toBeUndefined();
  });

  test("kind rides the manifest; a snapshot omits meta.targetKey (Stage 2 §1.2)", async () => {
    // A snapshot upload passes NO targetKeyRaw (its lineage is server-derived),
    // so the SW writes no meta.targetKey while keeping the rest of meta.
    const { manifest } = await buildEditContextUpload({
      kind: "snapshot",
      format: "onlay-cap/1",
      parts,
      meta: { viewport: { innerWidth: 800, innerHeight: 600, dpr: 2, layoutWidth: 800 } },
    });
    expect(manifest.kind).toBe("snapshot");
    expect(manifest.meta?.targetKey).toBeUndefined();
    expect(manifest.meta?.viewport).toEqual({
      innerWidth: 800,
      innerHeight: 600,
      dpr: 2,
      layoutWidth: 800,
    });
    // Default kind stays edit-context (Stage-1 caller unchanged).
    const { manifest: dflt } = await buildEditContextUpload({ format: "onlay-cap/1", parts });
    expect(dflt.kind).toBe("edit-context");
  });
});

describe("base64 round-trip", () => {
  test("bytesToBase64 → base64ToBytes is identity (incl. a > 32 KiB chunk boundary)", () => {
    const big = new Uint8Array(0x8000 + 1234);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) & 0xff;
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
});
