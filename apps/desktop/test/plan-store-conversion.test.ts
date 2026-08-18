/**
 * @file plan-store-conversion.test.ts
 * @description The WHOLE plan-store on the single DesktopPrisma client. The READ
 * section seeds `plans`/`plan_versions` via raw SQL and asserts the typed reads
 * produce the correct DTO mapping, derived `latestContent`/`versionCount`,
 * filtering, and ordering. The WRITE section drives
 * `upsertPlan`/`upsertPlanVersion`/`confirm`/`reject` (the raw-SQL-via-
 * `prisma.write` write path) and verifies results through the reads —
 * exercising create/dedup/new-version, the set-if-null COALESCE backfill,
 * null-safe (`IS NOT DISTINCT FROM`) dedup matching, and version numbering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  confirmPlan,
  getPlan,
  getPlanVersions,
  listPlans,
  makeCapture,
  rejectPlan,
  upsertPlan,
  upsertPlans,
  upsertPlanVersion,
} from "../src/main/plans/plan-store.js";
import { recordDesktopWrites } from "./discarded-write-narrowing-utils.js";
import { makeRecordingQueue, openTestPrisma } from "./prisma-test-utils.js";

/** Build a PlanCapture with sane defaults; override per-test. */
function capture(overrides: {
  content: string;
  sessionId?: string | null;
  filePath?: string | null;
  harness?: string;
  confidence?: number;
}) {
  return makeCapture({
    harness: overrides.harness ?? "claude",
    source: "test",
    captureMethod: "extractor",
    sessionId: overrides.sessionId ?? null,
    content: overrides.content,
    filePath: overrides.filePath ?? null,
    confidence: overrides.confidence ?? 1.0,
  });
}

async function seedPlan(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  plan: {
    id: string;
    sessionId: string | null;
    needsConfirmation: boolean;
    updatedAt: string;
  },
  versions: { n: number; markdown: string }[]
): Promise<void> {
  await db.query(
    `INSERT INTO plans
       (id, title, status, harness, created_from_session_id, plan_key,
        needs_confirmation, confidence, capture_method, created_at, updated_at)
     VALUES ($1, $2, 'active', 'claude', $3, $4, $5, 1.0, 'extractor', $6, $6)`,
    [
      plan.id,
      `Plan ${plan.id}`,
      plan.sessionId,
      `key-${plan.id}`,
      plan.needsConfirmation,
      plan.updatedAt,
    ]
  );
  for (const v of versions) {
    await db.query(
      `INSERT INTO plan_versions
         (id, plan_id, version_number, content_markdown, content_sha256,
          author_type, capture_method, created_at)
       VALUES ($1, $2, $3, $4, $5, 'agent', 'hook', $6)`,
      [
        `${plan.id}-v${v.n}`,
        plan.id,
        v.n,
        v.markdown,
        `sha-${plan.id}-${v.n}`,
        plan.updatedAt,
      ]
    );
  }
}

async function setup() {
  const opened = await openTestPrisma();
  await seedPlan(
    opened.db,
    {
      id: "A",
      sessionId: "s1",
      needsConfirmation: true,
      updatedAt: "2026-06-17T02:00:00.000Z",
    },
    [
      { n: 1, markdown: "A v1" },
      { n: 2, markdown: "A v2 (latest)" },
    ]
  );
  await seedPlan(
    opened.db,
    {
      id: "B",
      sessionId: "s2",
      needsConfirmation: false,
      updatedAt: "2026-06-17T01:00:00.000Z",
    },
    [{ n: 1, markdown: "B v1" }]
  );
  return opened;
}

test("listPlans maps derived latestContent + versionCount, ordered by updatedAt desc", async () => {
  const { prisma, close } = await setup();
  try {
    const plans = await listPlans(prisma);
    assert.deepEqual(
      plans.map((p) => p.id),
      ["A", "B"]
    );
    const a = plans[0]!;
    assert.equal(a.latestContent, "A v2 (latest)");
    assert.equal(a.versionCount, 2);
    assert.equal(a.sessionId, "s1");
    assert.equal(a.captureMethod, "extractor");
    assert.equal(plans[1]?.versionCount, 1);
  } finally {
    await close();
  }
});

test("listPlans filters by sessionId and needsConfirmation", async () => {
  const { prisma, close } = await setup();
  try {
    assert.deepEqual(
      (await listPlans(prisma, { sessionId: "s2" })).map((p) => p.id),
      ["B"]
    );
    assert.deepEqual(
      (await listPlans(prisma, { needsConfirmation: true })).map((p) => p.id),
      ["A"]
    );
  } finally {
    await close();
  }
});

test("getPlan returns derived fields; null for missing", async () => {
  const { prisma, close } = await setup();
  try {
    const a = await getPlan(prisma, "A");
    assert.equal(a?.latestContent, "A v2 (latest)");
    assert.equal(a?.versionCount, 2);
    assert.equal(await getPlan(prisma, "missing"), null);
  } finally {
    await close();
  }
});

test("getPlanVersions returns versions ascending by versionNumber", async () => {
  const { prisma, close } = await setup();
  try {
    const versions = await getPlanVersions(prisma, "A");
    assert.deepEqual(
      versions.map((v) => v.versionNumber),
      [1, 2]
    );
    assert.equal(versions[0]?.planId, "A");
    assert.equal(versions[0]?.contentMarkdown, "A v1");
    assert.equal(versions[0]?.captureMethod, "hook");
    assert.equal(versions[1]?.contentSha256, "sha-A-2");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Write path (raw SQL via prisma.write) — equivalence harness
// ---------------------------------------------------------------------------

test("upsertPlan: new capture creates a plan with version 1 and mapped fields", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const r = await upsertPlan(
      prisma,
      capture({
        content: "# Title\n\nBody v1",
        sessionId: "s1",
        filePath: "/tmp/p1.md",
      })
    );
    assert.equal(r.created, true);
    assert.equal(r.deduped, false);
    assert.equal(r.version, 1);

    const plan = await getPlan(prisma, r.planId);
    assert.equal(plan?.versionCount, 1);
    assert.equal(plan?.latestContent, "# Title\n\nBody v1");
    assert.equal(plan?.sessionId, "s1");
    assert.equal(plan?.captureMethod, "extractor");
    assert.equal(plan?.filePath, "/tmp/p1.md");
    assert.equal(plan?.status, "active");
    assert.equal(plan?.needsConfirmation, false); // confidence 1.0 >= 0.9
  } finally {
    await close();
  }
});

test("upsertPlan: identical content_sha256 dedups (no new version)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const cap = capture({
      content: "same body",
      sessionId: "s1",
      filePath: "/tmp/p2.md",
    });
    const first = await upsertPlan(prisma, cap);
    const second = await upsertPlan(prisma, cap);

    assert.equal(second.deduped, true);
    assert.equal(second.created, false);
    assert.equal(second.versionId, null);
    assert.equal(second.version, 1);
    assert.equal(second.planId, first.planId);
    assert.equal((await getPlan(prisma, first.planId))?.versionCount, 1);
  } finally {
    await close();
  }
});

test("upsertPlan: new content adds version 2 and backfills session via set-if-null COALESCE", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Created with no session; same file_path so it dedups by key on re-capture.
    const r1 = await upsertPlan(
      prisma,
      capture({ content: "v1", sessionId: null, filePath: "/tmp/p3.md" })
    );
    assert.equal(r1.version, 1);
    assert.equal((await getPlan(prisma, r1.planId))?.sessionId, null);

    const r2 = await upsertPlan(
      prisma,
      capture({
        content: "v2 — different",
        sessionId: "s9",
        filePath: "/tmp/p3.md",
      })
    );
    assert.equal(r2.planId, r1.planId);
    assert.equal(r2.created, false);
    assert.equal(r2.deduped, false);
    assert.equal(r2.version, 2);

    const plan = await getPlan(prisma, r1.planId);
    assert.equal(plan?.versionCount, 2);
    assert.equal(plan?.latestContent, "v2 — different");
    assert.equal(plan?.sessionId, "s9"); // COALESCE(NULL, 's9') => 's9'
  } finally {
    await close();
  }
});

test("upsertPlan: null harness dedups via IS NOT DISTINCT FROM (not = NULL)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // harness "" => stored NULL; re-capture must MATCH the NULL-harness row.
    // A plain `harness = NULL` predicate would never match, forcing a 2nd plan.
    const cap = capture({
      content: "no-file body",
      sessionId: "s1",
      harness: "",
    });
    const r1 = await upsertPlan(prisma, cap);
    const r2 = await upsertPlan(prisma, cap);

    assert.equal(r2.deduped, true);
    assert.equal(r2.planId, r1.planId);
    assert.deepEqual(
      (await listPlans(prisma)).map((p) => p.id),
      [r1.planId]
    );
  } finally {
    await close();
  }
});

test("upsertPlanVersion: dedups identical content, increments version on new", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const created = await upsertPlan(
      prisma,
      capture({ content: "orig", sessionId: "s1", filePath: "/tmp/pv.md" })
    );

    const dedup = await upsertPlanVersion(prisma, {
      plan_id: created.planId,
      content_markdown: "orig",
    });
    assert.equal(dedup.deduped, true);
    assert.equal(dedup.versionNumber, 1);

    const next = await upsertPlanVersion(prisma, {
      plan_id: created.planId,
      content_markdown: "new content",
    });
    assert.equal(next.deduped, false);
    assert.equal(next.versionNumber, 2);

    const versions = await getPlanVersions(prisma, created.planId);
    assert.equal(versions.length, 2);
    assert.equal(versions[1]?.contentMarkdown, "new content");
  } finally {
    await close();
  }
});

test("upsertPlans: batches multiple captures into one write-queue entry, one result per capture", async () => {
  const queue = makeRecordingQueue();
  const { prisma, close } = await openTestPrisma(queue);
  try {
    const runsBefore = queue.runs;
    const results = await upsertPlans(prisma, [
      capture({ content: "batch a", sessionId: "s1", filePath: "/tmp/ba.md" }),
      capture({ content: "batch b", sessionId: "s2", filePath: "/tmp/bb.md" }),
      capture({ content: "batch c", sessionId: "s3", filePath: "/tmp/bc.md" }),
    ]);
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.created && r.version === 1));

    // Pins FEA-4154: all three captures share ONE write-queue entry (a single
    // bounded chunk), NOT three per-capture prisma.write calls. Regressing to a
    // per-file upsertPlan loop would bump `runs` to 3 and fail here.
    assert.equal(queue.runs - runsBefore, 1);

    const plans = await listPlans(prisma);
    assert.deepEqual(plans.map((p) => p.filePath).sort(), [
      "/tmp/ba.md",
      "/tmp/bb.md",
      "/tmp/bc.md",
    ]);
  } finally {
    await close();
  }
});

test("upsertPlans: dedups a repeated capture within the same batch", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const cap = capture({
      content: "same batch body",
      sessionId: "s1",
      filePath: "/tmp/dup.md",
    });
    const [first, second] = await upsertPlans(prisma, [cap, cap]);
    assert.equal(first?.created, true);
    assert.equal(first?.deduped, false);
    assert.equal(second?.deduped, true);
    assert.equal(second?.planId, first?.planId);
    assert.equal((await getPlan(prisma, first!.planId))?.versionCount, 1);
  } finally {
    await close();
  }
});

test("upsertPlans: empty batch is a no-op", async () => {
  const queue = makeRecordingQueue();
  const { prisma, close } = await openTestPrisma(queue);
  try {
    const runsBefore = queue.runs;
    assert.deepEqual(await upsertPlans(prisma, []), []);
    assert.deepEqual(await listPlans(prisma), []);
    // No write-queue entry for an empty batch.
    assert.equal(queue.runs, runsBefore);
  } finally {
    await close();
  }
});

test("confirmPlan / rejectPlan update status and return whether a row matched", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const a = await upsertPlan(
      prisma,
      capture({ content: "a", sessionId: "s1", filePath: "/tmp/a.md" })
    );
    assert.equal(await confirmPlan(prisma, a.planId), true);
    const pa = await getPlan(prisma, a.planId);
    assert.equal(pa?.status, "confirmed");
    assert.equal(pa?.needsConfirmation, false);

    const b = await upsertPlan(
      prisma,
      capture({ content: "b", sessionId: "s2", filePath: "/tmp/b.md" })
    );
    assert.equal(await rejectPlan(prisma, b.planId), true);
    assert.equal((await getPlan(prisma, b.planId))?.status, "rejected");

    assert.equal(await confirmPlan(prisma, "missing"), false);
  } finally {
    await close();
  }
});

/**
 * ISS-6321 (batch 5/6): `findExistingPlan`'s two reads used `SELECT *`, hydrating
 * all 16 `plans` columns when the only consumer is `existingPlan.id`. Both now
 * select the primary key.
 *
 * Asserted on the SQL the production path actually issues, not on the source:
 * the dedup case above already proves the behaviour survives, and this proves
 * the read stopped being wide. Both `findExistingPlan` branches are exercised —
 * with a `file_path` (the first query) and without (the fallback).
 */
for (const filePath of ["/tmp/narrow.md", undefined]) {
  test(`upsertPlan: the existing-plan lookup selects only id (filePath=${filePath ?? "none"})`, async () => {
    const { prisma, close } = await openTestPrisma();
    try {
      const recorded = recordDesktopWrites(prisma);
      const cap = capture({
        content: "narrowing body",
        sessionId: "s-narrow",
        ...(filePath === undefined ? {} : { filePath }),
      });
      const first = await upsertPlan(recorded.prisma, cap);
      recorded.reset();
      const second = await upsertPlan(recorded.prisma, cap);

      // The dedup path only resolves when the lookup actually found the row.
      assert.equal(second.deduped, true);
      assert.equal(second.planId, first.planId);

      const planLookups = recorded.rawQueries.filter((q) =>
        q.includes("FROM plans")
      );
      assert.equal(
        planLookups.length,
        1,
        `expected one plans lookup, saw ${planLookups.length}`
      );
      assert.ok(
        !planLookups[0].includes("SELECT *"),
        "the existing-plan lookup must not hydrate every column"
      );
      assert.ok(
        planLookups[0].includes("SELECT id FROM plans"),
        `expected a primary-key projection, got: ${planLookups[0]}`
      );
    } finally {
      await close();
    }
  });
}
