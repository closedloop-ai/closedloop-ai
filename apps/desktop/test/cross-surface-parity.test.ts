import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type BranchSession,
  encodeBranchId,
} from "@repo/api/src/types/branch.js";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace.js";
import {
  CROSS_SURFACE_ACTIVITY,
  CROSS_SURFACE_BOUNDED_END,
  CROSS_SURFACE_BOUNDED_START,
  CROSS_SURFACE_BRANCH_NAME,
  CROSS_SURFACE_MULTI_BRANCH_SESSION_ID,
  CROSS_SURFACE_REPO_FULL_NAME,
  CROSS_SURFACE_SECOND_BRANCH_NAME,
  CROSS_SURFACE_SESSIONS,
  computeExpectedActivityRollup,
  computeExpectedBoundedCostCompleteness,
  computeExpectedBranchRollup,
  computeExpectedCostCompleteness,
  computeExpectedMergedTrace,
  type ParityPerSessionUsage,
  parityCostEvidenceForEvent,
  paritySessionUsageSortKey,
} from "@repo/lib/branches/__tests__/cross-surface-parity-fixture.js";
import { rollupBranchActivity } from "@repo/lib/branches/activity-rollup.js";
import { getSharedBranchTrace } from "../src/main/branch/shared-branch-trace.js";
import {
  type BranchSyncSource,
  getSharedBranchDetail,
  getSharedBranchUsage,
} from "../src/main/branch/shared-branches-api.js";
import { openTestDb } from "./agent-db-test-utils.js";

/**
 * PLN-1389 Phase 0 (PRD-522 R6) — DESKTOP-LOCAL side of the cross-surface branch-
 * parity test. Seeds the SAME shared scenario
 * (@repo/lib/branches/cross-surface-parity-fixture) into SQLite via raw writes and
 * asserts the desktop-local branch read (getSharedBranchDetail) produces the SAME
 * surface-invariant expectation the cloud test
 * (apps/api/app/branches/cross-surface-parity.integration.test.ts) asserts. Both
 * passing proves cloud == desktop-local == expected: the two hand-written branch
 * projection adapters have not drifted.
 */

const BRANCH_ARTIFACT_ID = "cross-surface-branch-artifact";
// FEA-3826: a SECOND branch the multi-branch session also pushes to, lifting its
// global active-write branch_count to 2 (its spend even-splits). Desktop has no
// project dimension; the cloud parity fixture places this branch in another
// project and asserts a project-filtered read still produces this same divisor.
const SECOND_BRANCH_ARTIFACT_ID = "cross-surface-branch-artifact-2";
const NOW = "2026-06-15T13:00:00.000Z";

async function seedScenario(
  db: Awaited<ReturnType<typeof openTestDb>>
): Promise<void> {
  // One branch artifact, linked from each session by a write-evidence git_push
  // link (the desktop read's display gate).
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
    BRANCH_ARTIFACT_ID,
    "cross-surface-branch",
    CROSS_SURFACE_REPO_FULL_NAME,
    CROSS_SURFACE_BRANCH_NAME,
    CROSS_SURFACE_SESSIONS[0].startedAt
  );
  // FEA-2276: the second branch the multi-branch session also touches.
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
    SECOND_BRANCH_ARTIFACT_ID,
    "cross-surface-branch-2",
    CROSS_SURFACE_REPO_FULL_NAME,
    CROSS_SURFACE_SECOND_BRANCH_NAME,
    CROSS_SURFACE_SESSIONS[0].startedAt
  );

  for (const spec of CROSS_SURFACE_SESSIONS) {
    await db.run(
      `INSERT INTO sessions
         (id, status, started_at, ended_at, billing_mode, user_id, model, cost_usd_estimated)
       VALUES ($1, 'completed', $2, $3, 'metered_api', $4, $5, $6)`,
      spec.externalSessionId,
      spec.startedAt,
      spec.endedAt,
      spec.userId,
      spec.model,
      spec.usage.estimatedCostUsd
    );
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      spec.externalSessionId,
      spec.model,
      spec.usage.inputTokens,
      spec.usage.outputTokens,
      spec.usage.cacheReadTokens,
      spec.usage.cacheWriteTokens,
      spec.usage.estimatedCostUsd
    );
    // Canonical write-evidence shape: production push writes emit
    // relation='created' (see apps/desktop/src/main/parsing/artifact-ref-extractor.ts).
    // The read gates on method (git_push), not relation, but seed the production
    // value so the row shape matches what the collectors actually write.
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, 'created', 'git_push', 'e', 1, 1, $4, $4)`,
      `cross-surface-link-${spec.externalSessionId}`,
      spec.externalSessionId,
      BRANCH_ARTIFACT_ID,
      spec.startedAt
    );
    // FEA-2276: the multi-branch session also pushes to the second branch — a
    // second active-write (git_push) link → branch_count 2, so its spend
    // even-splits on the branch under test.
    if (spec.externalSessionId === CROSS_SURFACE_MULTI_BRANCH_SESSION_ID) {
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, is_primary, extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, 'created', 'git_push', 'e', 0, 1, $4, $4)`,
        `cross-surface-link-${spec.externalSessionId}-2`,
        spec.externalSessionId,
        SECOND_BRANCH_ARTIFACT_ID,
        spec.startedAt
      );
    }

    // FEA-2276: seed this session's activity tiling + per-turn spend (the local
    // `session_activity_segments` + `token_events` stores). Sessions absent from
    // CROSS_SURFACE_ACTIVITY (gamma) get none — exercising the no-tiling path.
    const activity = CROSS_SURFACE_ACTIVITY[spec.externalSessionId];
    if (activity) {
      for (const [index, segment] of activity.segments.entries()) {
        await db.run(
          `INSERT INTO session_activity_segments
             (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, '[]', 1, $7)`,
          `cross-surface-seg-${spec.externalSessionId}-${index}`,
          spec.externalSessionId,
          segment.phase,
          segment.startMs,
          segment.endMs,
          segment.confidence,
          spec.startedAt
        );
      }
      for (const [index, event] of activity.tokenEvents.entries()) {
        const evidence = parityCostEvidenceForEvent(
          spec.externalSessionId,
          index,
          event.costUsd
        );
        await db.run(
          `INSERT INTO token_events
             (session_id, model, created_at, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd_estimated,
              source_identity, cost_summary)
           VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $7, $8)`,
          spec.externalSessionId,
          spec.model,
          event.createdAt,
          event.inputTokens,
          event.outputTokens,
          event.costUsd,
          JSON.stringify(evidence.sourceIdentity),
          "costSummary" in evidence
            ? JSON.stringify(evidence.costSummary)
            : null
        );
      }
    }
  }
}

test("PLN-1389 Phase 0: desktop-local branch read matches the shared expectation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cross-surface-parity-"));
  const db = await openTestDb(dir, { now: () => NOW });
  try {
    await seedScenario(db);
    const source: BranchSyncSource = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };
    const expected = computeExpectedBranchRollup();

    const detail = await getSharedBranchDetail(
      source,
      encodeBranchId({
        repoFullName: CROSS_SURFACE_REPO_FULL_NAME,
        branchName: CROSS_SURFACE_BRANCH_NAME,
      })
    );
    assert.ok(detail, "expected a desktop-local branch detail");

    // Distinct linked sessions.
    assert.equal(detail.sessionIds.length, expected.sessionCount);
    assert.equal(detail.sessions.length, expected.sessionCount);

    // Aggregate token sums across linked sessions.
    const sum = (pick: (s: BranchSession) => number) =>
      detail.sessions.reduce((acc, s) => acc + pick(s), 0);
    assert.equal(
      sum((s) => s.inputTokens),
      expected.inputTokens
    );
    assert.equal(
      sum((s) => s.outputTokens),
      expected.outputTokens
    );
    assert.equal(
      sum((s) => s.cacheReadTokens),
      expected.cacheReadTokens
    );
    assert.equal(
      sum((s) => s.cacheWriteTokens),
      expected.cacheWriteTokens
    );

    // ISS-5550: preserve the raw compatibility total (all three sessions = $1)
    // while exposing the canonical even split separately (beta ÷ 2 = $0.875).
    assert.equal(detail.estimatedCostUsd, 1);
    assert.equal(detail.attributedCostUsd, expected.estimatedCostUsd);

    // Per-session usage multiset (order-independent; no cross-surface id).
    const actualPerSession: ParityPerSessionUsage[] = detail.sessions.map(
      (s) => ({
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
        estimatedCostUsd: s.estimatedCostUsd ?? 0,
      })
    );
    assert.deepEqual(
      actualPerSession.map(paritySessionUsageSortKey).sort(),
      expected.perSession.map(paritySessionUsageSortKey).sort()
    );

    // Merged-trace ordering (R6.3): same session ordering + idle synthesis.
    // Normalize to {type, tMs, gapMs} — the epoch-ms instant pins ordering
    // (indistinguishable `sessionstart`s can't hide a mis-order) while staying
    // robust to timestamp-string format; sessionId is excluded (not comparable).
    const trace = await getSharedBranchTrace(
      source,
      encodeBranchId({
        repoFullName: CROSS_SURFACE_REPO_FULL_NAME,
        branchName: CROSS_SURFACE_BRANCH_NAME,
      })
    );
    const normalizedTrace = trace.items.map((item) => ({
      type: item.type,
      tMs: Date.parse((item as { t?: string }).t ?? ""),
      gapMs: (item as { gapMs?: number }).gapMs ?? null,
    }));
    assert.deepEqual(normalizedTrace, computeExpectedMergedTrace());
    assert.equal(trace.qualifyingSessionCount, detail.sessionIds.length);
    assert.deepEqual(
      trace.sessions.map((session) => session.identity.artifactId).sort(),
      detail.sessionIds.toSorted()
    );
    assert.ok(
      trace.sessions.every(
        (session) => session.state === BranchTraceSessionHydrationState.Loaded
      )
    );
    assert.equal(
      trace.aggregateCompleteness.state,
      BranchTraceCompletenessState.Complete
    );

    // FEA-2276: the per-activity cost rollup must match the shared expectation
    // (the SAME the cloud test asserts) — proves the desktop-local projection
    // attributes segment spend identically to the cloud read.
    assert.deepEqual(
      rollupBranchActivity(detail),
      computeExpectedActivityRollup()
    );
    const usage = await getSharedBranchUsage(source);
    assert.deepEqual(usage.costCompleteness, computeExpectedCostCompleteness());
    const boundedUsage = await getSharedBranchUsage(source, {
      startDate: CROSS_SURFACE_BOUNDED_START,
      endDate: CROSS_SURFACE_BOUNDED_END,
    });
    const expectedBounded = computeExpectedBoundedCostCompleteness();
    assert.deepEqual(boundedUsage.costCompleteness, expectedBounded);
    assert.equal(
      boundedUsage.totalEstimatedCost,
      "subtotalUsd" in expectedBounded ? expectedBounded.subtotalUsd : 0
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
