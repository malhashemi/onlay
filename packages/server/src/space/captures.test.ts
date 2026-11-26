import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Caller, encodeCaller, LIMITS } from "@onlay/protocol";
import { ADA, BEA, GUS, guest, type Harness, makeHarness, member, PAGE } from "./testing/harness";

/**
 * The capture routes in a space (ADR-0022, spec §7): collapsed not_found for
 * anything unreadable or not allowed, possession per name and per credential,
 * the hostile-file gate, quotas, chunked blobs end to end, the snapshot ↔
 * fresh-look coupling, and pending uploads failing closed on eviction.
 */

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const text = (s: string) => new TextEncoder().encode(s);

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function gzip(payload = "flattened"): Uint8Array {
  const body = text(payload);
  const out = new Uint8Array(body.length + 2);
  out.set([0x1f, 0x8b], 0);
  out.set(body, 2);
  return out;
}

const fileManifest = (bytes: Uint8Array, mime = "text/plain") => ({
  kind: "attachment",
  format: mime,
  parts: [{ name: "file", role: "file", mime, byteLen: bytes.length, sha256: sha256(bytes) }],
});

async function seed(
  anchor: Record<string, unknown> = { level: "element", selector: "main > h1" },
  kind = "comment",
) {
  const h = makeHarness();
  const ada = member(ADA);
  const r = await h.request(ada, "POST", "/interaction", {
    kind,
    url: PAGE,
    anchor,
    ...(kind === "comment" ? { body: { text: "look" } } : { change: { intent: "calmer" } }),
  });
  return { h, ada, id: r.body.interactionId as string };
}

/** init → PUT → commit; returns each step's response. */
async function attach(h: Harness, who: Caller, id: string, bytes: Uint8Array, mime = "text/plain") {
  const init = await h.request(
    who,
    "POST",
    `/interaction/${id}/capture`,
    fileManifest(bytes, mime),
  );
  if (init.status !== 200) return { init };
  const captureId = init.body.captureId as string;
  const put = await h.request(
    who,
    "PUT",
    `/interaction/${id}/capture/${captureId}/part/file`,
    bytes,
  );
  const commit = await h.request(who, "POST", `/interaction/${id}/capture/${captureId}/commit`);
  return { init, put, commit, captureId };
}

describe("captures: who may, and the collapsed not_found", () => {
  test("unreadable, nonexistent and role-refused all answer the same not_found", async () => {
    const { h, id } = await seed();
    const other = await h.request(member(ADA), "POST", "/interaction", {
      kind: "comment",
      url: PAGE,
      anchor: { level: "page" },
      body: { text: "x" },
    });
    const gus = guest(GUS, [other.body.interactionId]);
    const doc = gzip();
    const snapshot = {
      kind: "snapshot",
      format: "onlay-cap/1",
      parts: [
        {
          name: "document",
          role: "document",
          mime: "application/gzip",
          byteLen: doc.length,
          sha256: sha256(doc),
        },
      ],
    };
    const unreadable = await h.request(
      gus,
      "POST",
      `/interaction/${id}/capture`,
      fileManifest(text("x")),
    );
    const missing = await h.request(
      member(ADA),
      "POST",
      `/interaction/${crypto.randomUUID()}/capture`,
      fileManifest(text("x")),
    );
    const roleRefused = await h.request(
      member(BEA, "interaction"),
      "POST",
      `/interaction/${id}/capture`,
      snapshot,
    );
    const guestRefused = await h.request(
      guest(GUS, [id], "full"),
      "POST",
      `/interaction/${id}/capture`,
      snapshot,
    );
    for (const r of [unreadable, missing, roleRefused, guestRefused]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(missing.body);
    }
    expect(
      (await h.request(member(ADA), "POST", `/interaction/${id}/capture`, snapshot)).status,
    ).toBe(200);
  });

  test("a guest attaches where shared; an agent may not attach", async () => {
    const { h, id } = await seed();
    const done = await attach(h, guest(GUS, [id]), id, text("from a guest"));
    expect(done.commit?.body.capture).toMatchObject({
      kind: "attachment",
      capturedBy: GUS,
      capturedFrom: "pwa",
    });
    const agent = await h.request(
      member(ADA, "agent"),
      "POST",
      `/interaction/${id}/capture`,
      fileManifest(text("x")),
    );
    expect(agent.body.error).toMatchObject({ code: "forbidden", reason: "agent" });
  });
});

describe("captures: upload integrity", () => {
  test("a blob above 1 MiB round-trips byte-exact through the chunked store", async () => {
    const { h, ada, id } = await seed();
    const bytes = text("onlay ".repeat(Math.ceil((LIMITS.MAX_BLOB_CHUNK * 1.5) / 6)));
    expect(bytes.length).toBeGreaterThan(LIMITS.MAX_BLOB_CHUNK);
    const done = await attach(h, ada, id, bytes);
    expect(done.commit?.status).toBe(200);
    const res = await h.space.fetch(
      new Request(`https://space/interaction/${id}/capture/${done.captureId}/part/file`, {
        headers: { "X-Onlay-Caller": encodeCaller(member(BEA)) },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    const back = new Uint8Array(await res.arrayBuffer());
    expect(back.length).toBe(bytes.length);
    expect(sha256(back)).toBe(sha256(bytes));
  });

  test("hash and length must match the manifest; commit before upload is incomplete", async () => {
    const { h, ada, id } = await seed();
    const bytes = text("evidence");
    const init = await h.request(ada, "POST", `/interaction/${id}/capture`, fileManifest(bytes));
    const cid = init.body.captureId;
    expect(init.body.missing).toEqual([sha256(bytes)]);
    const early = await h.request(ada, "POST", `/interaction/${id}/capture/${cid}/commit`);
    expect(early.body.error).toMatchObject({ code: "conflict", reason: "incomplete" });
    const wrong = await h.request(
      ada,
      "PUT",
      `/interaction/${id}/capture/${cid}/part/file`,
      text("tampered"),
    );
    expect(wrong.body.error.reason).toBe("hash-mismatch");
    const ok = await h.request(ada, "PUT", `/interaction/${id}/capture/${cid}/part/file`, bytes);
    expect(ok.body).toEqual({ ok: true, received: "file", sha256: sha256(bytes) });
  });

  test("hostile files are refused on their bytes, not their declaration", async () => {
    const { h, ada, id } = await seed();
    const html = await attach(h, ada, id, text("hello <script>alert(1)</script>"), "text/plain");
    expect(html.put?.body.error).toMatchObject({ code: "invalid", reason: "unsupported-media" });
    const declared = await attach(h, ada, id, text("<p>hi</p>"), "text/html");
    expect(declared.put?.body.error.reason).toBe("unsupported-media");
    const huge = await attach(h, ada, id, png(10_000, 5_000), "image/png");
    expect(huge.put?.body.error.reason).toBe("image-too-large");
    expect((await attach(h, ada, id, png(2, 2), "image/png")).commit?.status).toBe(200);
  });

  test("possession is bound to the credential that opened the upload", async () => {
    const { h, ada, id } = await seed();
    const bytes = text("mine");
    const init = await h.request(ada, "POST", `/interaction/${id}/capture`, fileManifest(bytes));
    const otherDevice = { ...ada, credentialId: "another-device" };
    const put = await h.request(
      otherDevice,
      "PUT",
      `/interaction/${id}/capture/${init.body.captureId}/part/file`,
      bytes,
    );
    expect(put.status).toBe(404);
  });

  test("a pending upload fails closed when the space is evicted", async () => {
    const { h, ada, id } = await seed();
    const bytes = text("in flight");
    const init = await h.request(ada, "POST", `/interaction/${id}/capture`, fileManifest(bytes));
    h.evict();
    const put = await h.request(
      ada,
      "PUT",
      `/interaction/${id}/capture/${init.body.captureId}/part/file`,
      bytes,
    );
    expect(put.status).toBe(404);
  });

  test("liveness is re-checked at PUT and commit", async () => {
    const { h, ada, id } = await seed();
    const bytes = text("late");
    const init = await h.request(ada, "POST", `/interaction/${id}/capture`, fileManifest(bytes));
    await h.request(ada, "POST", `/interaction/${id}/resolve`);
    const put = await h.request(
      ada,
      "PUT",
      `/interaction/${id}/capture/${init.body.captureId}/part/file`,
      bytes,
    );
    expect(put.body.error).toMatchObject({ code: "conflict", reason: "closed" });
  });
});

describe("captures: quotas and caps", () => {
  test("the person's committed bytes bind the staged quota", async () => {
    const { h, ada, id } = await seed();
    h.db.run(
      "INSERT INTO captures (id, interaction_id, kind, lineage_id, revision, captured_by, captured_from, format, total_bytes, meta_json, created_at) VALUES ('seeded', ?, 'attachment', 'seeded', 1, ?, 'extension', 'text/plain', ?, '{}', 0)",
      id,
      ADA,
      LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES,
    );
    const over = await attach(h, ada, id, text("one byte too many"));
    expect(over.put?.body).toMatchObject({
      error: { code: "conflict", reason: "quota" },
      scope: "actor",
      limitBytes: LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES,
    });
    expect((await attach(h, member(BEA), id, text("Bea has room"))).commit?.status).toBe(200);
    const usage = await h.request(ada, "GET", "/captures/usage");
    expect(usage.body.actor.usedBytes).toBe(LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES);
  });

  test("too many concurrent uploads is rate_limited", async () => {
    const { h, ada, id } = await seed();
    for (let i = 0; i < LIMITS.MAX_PENDING_CAPTURES_PER_ACTOR; i++) {
      expect(
        (await h.request(ada, "POST", `/interaction/${id}/capture`, fileManifest(text(`p${i}`))))
          .status,
      ).toBe(200);
    }
    const r = await h.request(
      ada,
      "POST",
      `/interaction/${id}/capture`,
      fileManifest(text("one more")),
    );
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ code: "rate_limited", reason: "too-many-pending" });
  });
});

describe("captures: snapshots and variant looks", () => {
  test("a snapshot commit discharges a pending fresh look", async () => {
    const { h, ada, id } = await seed();
    const asked = await h.request(member(BEA, "interaction"), "POST", `/interaction/${id}/resnap`);
    expect(asked.body).toMatchObject({ ok: true, requested: true });
    expect(
      (await h.request(ada, "GET", `/interaction/${id}`)).body.interaction.resnap.requestedBy,
    ).toBe(BEA);
    const doc = gzip();
    const init = await h.request(ada, "POST", `/interaction/${id}/capture`, {
      kind: "snapshot",
      format: "onlay-cap/1",
      meta: { targetKey: "spoof" },
      parts: [
        {
          name: "document",
          role: "document",
          mime: "application/gzip",
          byteLen: doc.length,
          sha256: sha256(doc),
        },
      ],
    });
    await h.request(
      ada,
      "PUT",
      `/interaction/${id}/capture/${init.body.captureId}/part/document`,
      doc,
    );
    const commit = await h.request(
      ada,
      "POST",
      `/interaction/${id}/capture/${init.body.captureId}/commit`,
    );
    expect(commit.body.capture).toMatchObject({
      kind: "snapshot",
      lineageId: `snap:${id}`,
      revision: 1,
    });
    const read = await h.request(ada, "GET", `/interaction/${id}`);
    expect(read.body.interaction.resnap).toBeUndefined();
    expect(read.body.interaction.captures).toHaveLength(1);
    const meta = h.db.get<{ meta_json: string }>(
      "SELECT meta_json FROM captures WHERE id = ?",
      init.body.captureId,
    );
    expect(meta?.meta_json).not.toContain("spoof");
  });

  test("a variant look binds to a variant of a set this Edit owns", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, {
      v: 1,
      type: "variant-create",
      nonce: "n1",
      frameUrl: PAGE,
      root: {
        kind: "block",
        element: { selector: "h1", tag: "h1", classes: [], textSnippet: "x", markup: "<h1>x</h1>" },
      },
      command: "calmer",
      count: 1,
    });
    const frame = s.frames().find((f) => (f as { type?: string }).type === "variant-state") as {
      setId: string;
      changeInteractionId: string;
    };
    const posted = await h.request(
      member(ADA, "agent"),
      "POST",
      `/variant-set/${frame.setId}/variants`,
      {
        variants: [{ variantId: "v1", label: "Calm", program: [] }],
      },
    );
    expect(posted.status).toBe(200);
    const witness = png(4, 4);
    const look = (variantSetId: string, variantVersion = 1) => ({
      kind: "variant-look",
      format: "onlay-varlook/1",
      meta: { variantSetId, variantId: "v1", variantVersion },
      parts: [
        {
          name: "witness",
          role: "witness",
          mime: "image/png",
          byteLen: witness.length,
          sha256: sha256(witness),
        },
      ],
    });
    const id = frame.changeInteractionId;
    expect(
      (await h.request(member(ADA), "POST", `/interaction/${id}/capture`, look("nope"))).status,
    ).toBe(404);
    expect(
      (await h.request(member(ADA), "POST", `/interaction/${id}/capture`, look(frame.setId, 2)))
        .status,
    ).toBe(404);
    const init = await h.request(
      member(ADA),
      "POST",
      `/interaction/${id}/capture`,
      look(frame.setId),
    );
    await h.request(
      member(ADA),
      "PUT",
      `/interaction/${id}/capture/${init.body.captureId}/part/witness`,
      witness,
    );
    const commit = await h.request(
      member(ADA),
      "POST",
      `/interaction/${id}/capture/${init.body.captureId}/commit`,
    );
    expect(commit.body.capture).toMatchObject({
      kind: "variant-look",
      variantSetId: frame.setId,
      variantId: "v1",
    });
    expect(commit.body.capture.lineageId).toMatch(/^varlook:[0-9a-f]{48}$/);
  });
});

/* ── review findings 9, 10 and 13 ──────────────────────────────────── */

function snapshotManifest(
  parts: Array<{
    name: string;
    role: string;
    bytes: Uint8Array;
    byteLen?: number;
    sha?: string;
    mime: string;
  }>,
) {
  return {
    kind: "snapshot",
    format: "onlay-cap/1",
    parts: parts.map((p) => ({
      name: p.name,
      role: p.role,
      mime: p.mime,
      byteLen: p.byteLen ?? p.bytes.length,
      sha256: p.sha ?? sha256(p.bytes),
    })),
  };
}

describe("captures: authority re-checked at every phase (finding 9)", () => {
  test("a structured upload started as a member can't be finished as a guest", async () => {
    const { h, ada, id } = await seed();
    const doc = gzip();
    const init = await h.request(
      ada,
      "POST",
      `/interaction/${id}/capture`,
      snapshotManifest([
        { name: "document", role: "document", bytes: doc, mime: "application/gzip" },
      ]),
    );
    expect(init.status).toBe(200);
    // Ada is now a guest holding a share on this very thread, on the same extension credential.
    const asGuest: Caller = { ...guest(ADA, [id], "full"), credentialId: ada.credentialId };
    const path = `/interaction/${id}/capture/${init.body.captureId}`;
    expect((await h.request(asGuest, "PUT", `${path}/part/document`, doc)).status).toBe(404);
    expect((await h.request(ada, "PUT", `${path}/part/document`, doc)).status).toBe(200);
    expect((await h.request(asGuest, "POST", `${path}/commit`)).status).toBe(404);
    expect((await h.request(ada, "POST", `${path}/commit`)).status).toBe(200);
  });

  test("access revoked while a part uploads: the PUT finishes as not_found", async () => {
    const { h, ada, id } = await seed();
    const bytes = text("evidence");
    const init = await h.request(ada, "POST", `/interaction/${id}/capture`, fileManifest(bytes));
    const req = h.request(
      ada,
      "PUT",
      `/interaction/${id}/capture/${init.body.captureId}/part/file`,
      bytes,
    );
    // The edge revokes Ada while the PUT is reading its body.
    await h.internal("POST", "/internal/access-changed", { personId: ADA, access: null });
    expect((await req).status).toBe(404);
  });

  test("two commits of one upload both answer with the first commit's capture", async () => {
    const { h, ada, id } = await seed();
    const bytes = text("once");
    const init = await h.request(ada, "POST", `/interaction/${id}/capture`, fileManifest(bytes));
    const path = `/interaction/${id}/capture/${init.body.captureId}`;
    await h.request(ada, "PUT", `${path}/part/file`, bytes);
    const [a, b] = await Promise.all([
      h.request(ada, "POST", `${path}/commit`),
      h.request(ada, "POST", `${path}/commit`),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.capture).toEqual(a.body.capture);
    const again = await h.request(ada, "POST", `${path}/commit`);
    expect(again.body.capture).toEqual(a.body.capture);
    expect((await h.request(member(BEA), "POST", `${path}/commit`)).status).toBe(404);
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM captures")?.n).toBe(1);
  });
});

describe("captures: same-hash parts carry honest lengths (finding 10)", () => {
  test("a sibling declaring another length is not registered by its twin's upload", async () => {
    const { h, ada, id } = await seed();
    const doc = gzip();
    const witness = png(4, 4);
    const init = await h.request(
      ada,
      "POST",
      `/interaction/${id}/capture`,
      snapshotManifest([
        { name: "document", role: "document", bytes: doc, mime: "application/gzip" },
        { name: "witness", role: "witness", bytes: witness, mime: "image/png" },
        {
          name: "thumbnail",
          role: "thumbnail",
          bytes: witness,
          byteLen: witness.length + 100,
          mime: "image/png",
        },
      ]),
    );
    const path = `/interaction/${id}/capture/${init.body.captureId}`;
    await h.request(ada, "PUT", `${path}/part/document`, doc);
    await h.request(ada, "PUT", `${path}/part/witness`, witness);
    const commit = await h.request(ada, "POST", `${path}/commit`);
    expect(commit.status).toBe(409);
    expect(commit.body.error.reason).toBe("incomplete");
    const put = await h.request(ada, "PUT", `${path}/part/thumbnail`, witness);
    expect(put.body.error.reason).toBe("length-mismatch");
  });
});

describe("captures: a guest sees only their own usage (finding 13)", () => {
  test("usage for a guest leaves out the space's totals; a member sees both", async () => {
    const { h, ada, id } = await seed();
    await attach(h, ada, id, text("member evidence"));
    const asGuest = await h.request(guest(GUS, [id]), "GET", "/captures/usage");
    expect(asGuest.body).toEqual({
      ok: true,
      actor: { usedBytes: 0, limitBytes: LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES },
    });
    const asMember = await h.request(ada, "GET", "/captures/usage");
    expect(asMember.body.global.usedBytes).toBe("member evidence".length);
  });

  test("a space-full refusal to a guest carries no space-wide numbers", async () => {
    const { h, id } = await seed();
    const store = h.space.runtime.captureStore;
    store.committedGlobalBytes = () => LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES;
    const gus = guest(GUS, [id]);
    const bytes = text("guest evidence");
    const init = await h.request(gus, "POST", `/interaction/${id}/capture`, fileManifest(bytes));
    const put = await h.request(
      gus,
      "PUT",
      `/interaction/${id}/capture/${init.body.captureId}/part/file`,
      bytes,
    );
    expect(put.status).toBe(409);
    expect(put.body.error.reason).toBe("quota");
    expect(JSON.stringify(put.body)).not.toContain("usedBytes");
    expect(JSON.stringify(put.body)).not.toContain(String(LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES));
  });
});
