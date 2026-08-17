/**
 * @file local-insights-non-delivery-gate.test.ts
 * @description ISS-5936 — the non-delivery-only artifact gate is resolved ONCE
 * per Insights/dashboard call instead of re-running a whole-table
 * `session_artifact_links` aggregate inside every statement that needs it.
 *
 * These live in their own file rather than in `local-insights-contract.test.ts`
 * because that file is in the shrink-only grandfather list in `biome.jsonc`.
 *
 * The counts are deliberately unchanged by this refactor, so the load-bearing
 * assertion is a STRUCTURAL one — how many times the aggregate is issued — per
 * the ticket's Rule T note and the `collectors/AGENTS.md` guidance to "test the
 * structural property, such as dependency call counts or shared cache use,
 * rather than wall-clock timing". The remaining suites pin the things that
 * refactor could plausibly break: the two render modes agreeing, the payload
 * being accepted at the cap, and the quote escape that is now load-bearing.
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, test } from "node:test";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { DeliveryInsightsResponse } from "@closedloop-ai/loops-api/insights";
import { InsightsPeriod, InsightsSection } from "@closedloop-ai/loops-api/insights";
import { createSqliteDashboardQueries } from "../src/main/database/dashboard-queries.js";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import {
  excludeNonDeliveryOnlyArtifacts,
  NON_DELIVERY_ID_INLINE_CAP,
  resolveNonDeliveryOnlyArtifactIds,
} from "../src/main/database/non-delivery-artifacts.js";
import type {
  CapturedStatement,
  DesktopPrismaReader,
} from "../src/main/database/prisma-client.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";

after(() => {
  if (ORIGINAL_TZ === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = ORIGINAL_TZ;
});

const NOW = new Date("2026-06-22T00:00:00.000Z");
const IN_WINDOW = "2026-06-20T10:00:00.000Z";
const SESSION_ID = "gate-sess";
const REPO = "org/repo";

/**
 * The aggregate's fingerprint. `HAVING SUM(CASE WHEN` appears in the
 * non-delivery gate and nowhere else in the Insights read path — the sibling
 * `createdArtifactLinksSubquery` reads the same table with a bare `WHERE`.
 */
const AGGREGATE_SIGNATURE = "HAVING SUM(CASE WHEN";

type SeededPr = {
  id: string;
  prNumber: number;
  /** One link per entry: `[relation, method]`. */
  links: readonly (readonly [string, string])[];
};

/**
 * The corpus every scenario shares. Two artifacts are non-delivery-ONLY and
 * must drop; two must survive — including `pr-mixed`, which carries a `reviewed`
 * link AND a `created` link. `pr-mixed` is the row that fails an over-broad gate
 * (FEA-3585: an artifact is only excluded when it has NOTHING but non-delivery
 * evidence), so it is what stops these assertions from passing vacuously.
 */
const SEEDED_PRS: readonly SeededPr[] = [
  {
    id: "pr-authored",
    prNumber: 1,
    links: [[ArtifactRefRelation.Created, ArtifactRefMethod.PrCreateOutput]],
  },
  {
    id: "pr-reviewed-only",
    prNumber: 2,
    links: [[ArtifactRefRelation.Reviewed, ArtifactRefMethod.UrlInMessage]],
  },
  {
    id: "pr-mention-only",
    prNumber: 3,
    links: [
      [ArtifactRefRelation.Referenced, ArtifactRefMethod.PrMentionInProse],
    ],
  },
  {
    id: "pr-mixed",
    prNumber: 4,
    links: [
      [ArtifactRefRelation.Reviewed, ArtifactRefMethod.UrlInMessage],
      [ArtifactRefRelation.Created, ArtifactRefMethod.PrCreateOutput],
    ],
  },
];

const EXCLUDED_IDS = ["pr-mention-only", "pr-reviewed-only"];
const RETAINED_IDS = ["pr-authored", "pr-mixed"];

type Db = Awaited<ReturnType<typeof openInsightsDb>>["db"];

async function seedPrs(db: Db, prs: readonly SeededPr[]): Promise<void> {
  await db.query(
    "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $3)",
    [SESSION_ID, SESSION_STATUS.INACTIVE, IN_WINDOW]
  );
  for (const pr of prs) {
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, pr_state,
          created_at, last_seen_at, observed_at)
       VALUES ($1, $2, 'pull_request', $3, $4, 'merged', $5, $5, $5)`,
      [pr.id, `pr:gate:${pr.id}`, REPO, pr.prNumber, IN_WINDOW]
    );
    for (const [relation, method] of pr.links) {
      await db.query(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence,
            extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, '{}', 1, $6, $6)`,
        [
          `sal:${pr.id}:${relation}`,
          SESSION_ID,
          pr.id,
          relation,
          method,
          IN_WINDOW,
        ]
      );
    }
  }
}

/**
 * The visible "Captured PRs" count. Desktop keys it `merged` — that tile
 * deliberately carries the CAPTURED population (all states), not the merged
 * count (FEA-2946) — so read it by key rather than by name.
 */
function capturedPrKpi(delivery: DeliveryInsightsResponse): number | null {
  return delivery.kpis.find((entry) => entry.key === "merged")?.value ?? null;
}

async function capturedPrIds(
  reader: DesktopPrismaReader,
  predicate: string
): Promise<string[]> {
  const rows = await reader.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM artifacts
     WHERE kind = 'pull_request' AND ${predicate}
     ORDER BY id`
  );
  return rows.map((row) => row.id);
}

/** How many times the gate's whole-table aggregate was issued. */
function countGateAggregates(statements: readonly CapturedStatement[]): number {
  return statements.filter((statement) =>
    statement.sql.includes(AGGREGATE_SIGNATURE)
  ).length;
}

test("ISS-5936: a Delivery Insights call issues the gate aggregate exactly ONCE", async () => {
  const statements: CapturedStatement[] = [];
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-gate-once-",
    (statement) => statements.push(statement)
  );
  try {
    await seedPrs(db, SEEDED_PRS);

    statements.length = 0;
    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );

    const aggregates = countGateAggregates(statements);
    assert.equal(
      aggregates,
      1,
      `the delivery gate aggregate must run once per call, not once per statement; saw ${aggregates}`
    );
    // Guard against the assertion passing because nothing ran at all: the same
    // call must still have issued the several gated statements around it.
    assert.ok(
      statements.length > 1,
      `expected the Delivery section to issue multiple statements; saw ${statements.length}`
    );
    // ...and the section still answers, over the retained population only.
    // The `merged` key carries the CAPTURED-PR count (label "Captured PRs").
    assert.equal(capturedPrKpi(delivery), RETAINED_IDS.length);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5936: a Utilization Insights call issues the gate aggregate exactly ONCE", async () => {
  const statements: CapturedStatement[] = [];
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-gate-util-",
    (statement) => statements.push(statement)
  );
  try {
    await seedPrs(db, SEEDED_PRS);

    statements.length = 0;
    await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      InsightsPeriod.Quarter,
      NOW
    );

    assert.equal(countGateAggregates(statements), 1);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5936: the gate excludes non-delivery-ONLY artifacts and keeps mixed evidence", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-gate-parity-"
  );
  try {
    await seedPrs(db, SEEDED_PRS);

    const ids = await resolveNonDeliveryOnlyArtifactIds(prisma.client);
    assert.deepEqual([...ids].sort(), EXCLUDED_IDS);

    const kept = await capturedPrIds(
      prisma.client,
      excludeNonDeliveryOnlyArtifacts("artifacts.id", ids)
    );
    assert.deepEqual(kept, RETAINED_IDS);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5936: the over-cap subquery fallback returns exactly what the inline literals return", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-gate-cap-");
  try {
    await seedPrs(db, SEEDED_PRS);
    const ids = await resolveNonDeliveryOnlyArtifactIds(prisma.client);
    assert.ok(
      ids.length > 1,
      "the fixture must resolve more than one id so cap=1 selects the fallback"
    );

    const inline = excludeNonDeliveryOnlyArtifacts("artifacts.id", ids);
    const fallback = excludeNonDeliveryOnlyArtifacts("artifacts.id", ids, 1);
    // Prove the two branches were actually taken, so the row comparison below
    // is comparing two DIFFERENT renderings rather than the same one twice.
    assert.ok(inline.includes("'pr-reviewed-only'"));
    assert.ok(fallback.includes(AGGREGATE_SIGNATURE));

    // The fallback is production SQL that only fires above the cap — larger
    // than any fixture — so this is the only place it is executed at all.
    assert.deepEqual(
      await capturedPrIds(prisma.client, fallback),
      await capturedPrIds(prisma.client, inline)
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5936: libSQL accepts a cap-sized inline id list", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-gate-bound-"
  );
  try {
    await seedPrs(db, SEEDED_PRS);

    // A full-cap payload (~39 KB of SQL text) carrying the real excluded ids,
    // padded with synthetic ones. The cardinality sweep behind the cap ran under
    // node:sqlite; this is the same shape against the production libSQL adapter.
    const padding = Array.from(
      { length: NON_DELIVERY_ID_INLINE_CAP - EXCLUDED_IDS.length },
      (_unused, index) => `synthetic-${index.toString(16).padStart(16, "0")}`
    );
    const ids = [...EXCLUDED_IDS, ...padding];
    assert.equal(ids.length, NON_DELIVERY_ID_INLINE_CAP);

    const predicate = excludeNonDeliveryOnlyArtifacts("artifacts.id", ids);
    assert.ok(
      !predicate.includes(AGGREGATE_SIGNATURE),
      "a cap-sized list must still take the inline branch, not the fallback"
    );
    assert.deepEqual(
      await capturedPrIds(prisma.client, predicate),
      RETAINED_IDS
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * An id that cannot be safely inlined must still be EXCLUDED — it routes to the
 * subquery branch rather than being dropped from the gate. `artifacts.id` is an
 * untyped TEXT column and this set is read back out of a persisted store, so
 * both shapes are reachable at the boundary even though production ids are
 * 16-char md5 hex.
 *
 * The `$1` case is the one that matters most and is not obvious: every raw read
 * passes through `translateNumberedParams`, which rewrites `$N` to `?N` across
 * the WHOLE statement INCLUDING quoted literals. Inlined, that id would be
 * compared as `'…?1…'`, match nothing, and let a non-delivery-only PR back into
 * the delivery population — the exact regression FEA-3585 / ISS-5764 prevent.
 * Escaping quotes does not help, because the corruption is not a quote.
 */
for (const [label, unsafeId] of [
  ["a quote", "pr-o'brien"],
  ["a positional-parameter marker", "pr-$1-id"],
] as const) {
  test(`ISS-5936: an artifact id containing ${label} is still excluded`, async () => {
    const { dir, db, prisma } = await openInsightsDb(
      "local-insights-gate-unsafe-"
    );
    try {
      await seedPrs(db, [
        ...SEEDED_PRS,
        {
          id: unsafeId,
          prNumber: 5,
          links: [
            [ArtifactRefRelation.Reviewed, ArtifactRefMethod.UrlInMessage],
          ],
        },
      ]);

      const ids = await resolveNonDeliveryOnlyArtifactIds(prisma.client);
      assert.ok(ids.includes(unsafeId));

      const predicate = excludeNonDeliveryOnlyArtifacts("artifacts.id", ids);
      // Behaviour first: the row must actually be excluded. This is the
      // assertion that goes red for the `$1` id if the safety guard is removed
      // and the id is inlined — proof the corruption is real, not theoretical.
      assert.deepEqual(
        await capturedPrIds(prisma.client, predicate),
        RETAINED_IDS
      );
      assert.ok(
        predicate.includes(AGGREGATE_SIGNATURE),
        `an id that cannot be inlined must take the subquery branch, got: ${predicate}`
      );
    } finally {
      await prisma.disconnect();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("ISS-5936: a corpus with no non-delivery-only artifacts keeps every captured PR", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-gate-empty-"
  );
  try {
    // The measured DOMINANT production path: on a real corpus the gate resolves
    // to zero ids. Not an edge case.
    const deliveryOnly = SEEDED_PRS.filter((pr) =>
      RETAINED_IDS.includes(pr.id)
    );
    await seedPrs(db, deliveryOnly);

    const ids = await resolveNonDeliveryOnlyArtifactIds(prisma.client);
    assert.deepEqual(ids, []);

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Quarter,
      NOW
    );
    assert.equal(capturedPrKpi(delivery), deliveryOnly.length);

    // Utilization's review-backlog read and the dashboard PR list run the same
    // empty-branch predicate; both must return rows, not throw and not filter
    // everything out.
    await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      InsightsPeriod.Quarter,
      NOW
    );
    const pullRequests =
      await createSqliteDashboardQueries(prisma).getPullRequests();
    assert.deepEqual(pullRequests.map((pr) => pr.id).sort(), RETAINED_IDS);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5936: getPullRequests applies the same gate", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-gate-prs-");
  try {
    await seedPrs(db, SEEDED_PRS);

    // This read was converted from one statement to resolve-then-query, and had
    // no coverage of the exclusion gate at all before this test — the existing
    // dashboard suites exercise ordinary workspace links, so a broken gate here
    // shipped green.
    const pullRequests =
      await createSqliteDashboardQueries(prisma).getPullRequests();
    assert.deepEqual(
      pullRequests.map((pr) => pr.id).sort(),
      RETAINED_IDS,
      "reviewed-only and prose-mention-only PRs must not appear; a PR that is both reviewed AND authored must"
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5936: the empty id set renders a no-op rather than NOT IN ()", () => {
  // Not a crash guard: SQLite (and libSQL with it) accepts an empty `NOT IN ()`
  // as a documented deviation from standard SQL and reads it as "in nothing", so
  // the bare form would also be correct. This pins the deliberate choice not to
  // depend on that extension in a hot read path.
  assert.equal(excludeNonDeliveryOnlyArtifacts("artifacts.id", []), "1 = 1");
});

test("ISS-5936: the renderer switches to the subquery form above the cap", () => {
  const ids = ["a", "b", "c"];
  assert.ok(
    excludeNonDeliveryOnlyArtifacts("x.id", ids, 3).includes("'a', 'b', 'c'"),
    "at the cap the ids are inlined"
  );
  assert.ok(
    excludeNonDeliveryOnlyArtifacts("x.id", ids, 2).includes(
      AGGREGATE_SIGNATURE
    ),
    "one over the cap switches to the subquery"
  );
});
