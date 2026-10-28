import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

/**
 * Contract tests for the PR-DERIVED Insights metrics: everything the local
 * backend computes out of captured `pull_request` artifacts and their
 * `session_artifact_link` rows — Delivery's Median PR size and its KLOC delta,
 * the merge-rate KPI and its denominators, the agent/manual `prTrend` split,
 * and Utilization's Review backlog.
 *
 * Split out of `local-insights-contract.test.ts` (ISS-10541 / #7678), which is
 * in the shrink-only grandfather list and could not host another scenario. The
 * seam is the input corpus, not a line count: nothing here seeds `token_usage`
 * or reads a cost/spend/heatmap chart, and nothing left behind in the contract
 * suite reads a PR artifact. `local-insights-test-helpers.ts` already exists
 * for exactly this (ISS-5412), so the fixture is shared rather than re-derived.
 */

// Same timezone pin as the sibling contract suite: the insights SQL buckets by
// process-local day, so a fixed non-UTC zone keeps the conversion exercised and
// deterministic. Runs at module evaluation, before any DB opens.
process.env.TZ = "America/Chicago";

const NOW = new Date("2026-06-22T00:00:00.000Z"); // = June 21 19:00 CDT
const IN_WINDOW = "2026-06-20T10:00:00.000Z"; // = June 20 05:00 CDT (same local day)

test("FEA-2923: Delivery Median PR size is `—` (non-finite), not 0, when no window PR is sized", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-prsize-empty-"
  );
  try {
    // Line counts are not stored (ISS-12709), so no PR can be sized: nothing to
    // median, and the KPI must dash rather than report 0.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
      ["pr-unsized-only", "pr:org/repo:9", 9, IN_WINDOW]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const prSize = delivery.kpis.find((k) => k.key === "pr-size");
    assert.equal(prSize?.value, null);
    assert.equal(prSize?.deltaPct, null);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2868 (thread 1): full prior period with no sized PRs → PR-size and merged-LOC deltas suppressed (no bogus +100%)", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-prsize-delta-"
  );
  try {
    // Sentinel record older than priorStartIso so hasFullPriorPeriod is TRUE —
    // the delta gate that thread 1 warns about.
    const SENTINEL_DATE = "2025-12-01T00:00:00.000Z";
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 0)`,
      ["sentinel", SENTINEL_DATE]
    );

    const PRIOR_WINDOW = "2026-01-15T10:00:00.000Z";
    for (const [id, prNum, createdAt] of [
      ["cur-pr", 1, IN_WINDOW],
      ["prior-pr", 2, PRIOR_WINDOW],
    ] as [string, number, string][]) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
        [id, `pr:delta/repo:${prNum}`, prNum, createdAt]
      );
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const prSize = delivery.kpis.find((k) => k.key === "pr-size");
    assert.equal(prSize?.value, null);
    assert.equal(prSize?.deltaPct, null);
    const kloc = delivery.kpis.find((k) => k.key === "kloc");
    assert.equal(kloc?.value, null);
    assert.equal(kloc?.deltaPct, null);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3217: merged-PR figures read as absent (merge-rate null, not 0) when PR state is not stored", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-merge-rate-open-"
  );
  try {
    // PR state and line counts are not stored (ISS-12709): captured PRs are
    // still scanned, but there is no decided cohort, so merge-rate must dash
    // rather than read 0% (FEA-3217) and the merged-lines figures stay unknown.
    // The Captured PRs KPI itself is unknown (ISS-12902).
    for (const [id, prNum] of [
      ["mr-open-1", 1],
      ["mr-open-2", 2],
      ["mr-open-3", 3],
    ] as [string, number][]) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
        [id, `pr:mr-open:${prNum}`, prNum, IN_WINDOW]
      );
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    assert.equal(delivery.kpis.find((k) => k.key === "merged")?.value, null);
    assert.equal(
      delivery.kpis.find((k) => k.key === "capturedPrsScanned")?.value,
      3
    );
    assert.equal(
      delivery.kpis.find((k) => k.key === "merge-rate")?.value,
      null
    );
    assert.equal(
      delivery.kpis.find((k) => k.key === "mergedCount")?.value,
      null
    );
    assert.equal(
      delivery.kpis.find((k) => k.key === "mergedKloc")?.value,
      null
    );
    assert.equal(delivery.kpis.find((k) => k.key === "mergedLoc")?.value, null);
    assert.deepEqual(delivery.charts.prByRepo, []);
    assert.deepEqual(delivery.charts.prByState, []);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2486: prTrend agent/manual split — PR with created link counts as agent, without as manual", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-pr-split-");
  try {
    // Session required by the session_artifact_link FK constraint.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
      ["split-session", "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
    );

    // PR1: has a session_artifact_link with relation='created' → agent bucket.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
      ["pr-agent", "pr:split-test:1", 1, IN_WINDOW]
    );
    await db.query(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "sal-split-agent",
        "split-session",
        "pr-agent",
        ArtifactRefRelation.Created,
        ArtifactRefMethod.PrCreateOutput,
        "{}",
        1,
        IN_WINDOW,
        IN_WINDOW,
      ]
    );

    // PR2: no session_artifact_link at all → manual bucket.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
      ["pr-manual", "pr:split-test:2", 2, IN_WINDOW]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const { prTrend } = delivery.charts;

    // Series must declare exactly agent and manual — "merged" is an undeclared
    // total key in values but must NOT appear in series (would double-count in
    // bar/heatmap renderers that sum only declared series).
    assert.deepEqual(prTrend.series, [
      { key: "agent", label: "Agent-raised" },
      { key: "manual", label: "Manual/untracked" },
    ]);

    // The local day 2026-06-20 (IN_WINDOW = 05:00 CDT) gets both PRs.
    const dayPoint = prTrend.points.find((p) => p.date === "2026-06-20");
    assert.ok(dayPoint, "expected a prTrend point for 2026-06-20");
    assert.deepEqual(dayPoint.values, { agent: 1, manual: 1, merged: 2 });

    // Structural invariant: agent + manual === merged across every day.
    // Violations indicate a gap in the split logic (e.g. a PR counted twice).
    let sumAgent = 0;
    let sumManual = 0;
    let sumMerged = 0;
    for (const p of prTrend.points) {
      sumAgent += present(p.values.agent);
      sumManual += present(p.values.manual);
      sumMerged += present(p.values.merged);
    }
    assert.equal(sumAgent + sumManual, sumMerged);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2486: prTrend DISTINCT collapses two created links from different sessions into agent=1", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-pr-fanout-");
  try {
    // Two distinct sessions — the unique constraint (session_id, artifact_id,
    // relation) permits one 'created' link row per session, so two sessions can
    // each link to the same PR with relation='created'.
    for (const sessionId of ["fanout-s1", "fanout-s2"]) {
      await db.query(
        "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $3)",
        [sessionId, "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
      );
    }

    // One PR artifact — 1 captured PR, 1 total for the day.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
      ["pr-fanout", "pr:fanout-test:99", 99, IN_WINDOW]
    );

    // Two 'created' links from two different sessions pointing at the same PR.
    // The subquery SELECT DISTINCT artifact_id collapses these to one artifact_id
    // so the LEFT JOIN yields cl.artifact_id IS NOT NULL exactly once → agent=1.
    for (const [linkId, sessionId] of [
      ["sal-fanout-1", "fanout-s1"],
      ["sal-fanout-2", "fanout-s2"],
    ] as [string, string][]) {
      await db.query(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence,
            extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          linkId,
          sessionId,
          "pr-fanout",
          ArtifactRefRelation.Created,
          ArtifactRefMethod.PrCreateOutput,
          "{}",
          1,
          IN_WINDOW,
          IN_WINDOW,
        ]
      );
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const dayPoint = delivery.charts.prTrend.points.find(
      (p) => p.date === "2026-06-20"
    );
    assert.ok(dayPoint, "expected a prTrend point for 2026-06-20");
    // DISTINCT collapses two created-link rows into one artifact → agent=1, not 2.
    assert.deepEqual(dayPoint.values, { agent: 1, manual: 0, merged: 1 });
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2951: Utilization Review backlog KPI counts every captured delivery PR; reviewQueue stays empty", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-backlog-");
  try {
    // No PR state is stored (ISS-12709), so each captured PR counts toward the
    // backlog.
    for (const [id, prNum] of [
      ["bk-1", 1],
      ["bk-2", 2],
      ["bk-3", 3],
    ] as [string, number][]) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
        [id, `pr:backlog:${prNum}`, prNum, IN_WINDOW]
      );
    }

    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    assert.equal(utilization.kpis.find((k) => k.key === "backlog")?.value, 3);
    // FEA-3455: reviewQueue no longer fabricates a "Captured locally" placeholder
    // (the local store has no review-decision signal) — it is emitted empty and
    // its tile is marked Unavailable under the desktop's personal scope.
    assert.deepEqual(utilization.charts.reviewQueue, []);
    assert.equal(
      utilization.tileAvailability?.["chart:reviewQueue"],
      "unavailable"
    );
    assert.equal(utilization.tileAvailability?.["kpi:backlog"], "unavailable");
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Narrow an additive chart (or per-series bucket value) the local backend ALWAYS
 * emits. The shared `@closedloop-ai/loops-api` contract types these optional/nullable
 * only so older peers may omit them; absent HERE is a contract regression.
 */
function present<T>(value: T | null | undefined): T {
  if (value == null) {
    throw new Error("local insights must emit this value");
  }
  return value;
}
