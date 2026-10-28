import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BranchKpiState, encodeBranchId } from "@repo/api/src/types/branch.js";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics.js";
import { test } from "vitest";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import {
  type BranchSyncSource,
  getSharedBranchDetail,
} from "../src/main/branch/shared-branches-api.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * Real-boundary coverage: persisted SQLite rows flow through the production
 * branch reads, list projection, analytics derivation, and detail projection.
 * The local store holds no PR LOC or merge time (ISS-12709), so a pushed
 * branch with a PR row reads as size-unavailable.
 */
test("analytics reports the median PR size as unavailable when no LOC is persisted", async () => {
  const { close, source } = await openSeededBranchesSource();
  try {
    const analytics = await getSharedBranchAnalytics(source);

    assert.equal(analytics.medianPrSize.state, BranchKpiState.Unavailable);
    assert.equal(analytics.medianPrSize.value, null);
  } finally {
    await close();
  }
});

test("detail carries null LOC for a branch with a PR row and no persisted LOC", async () => {
  const { close, source } = await openSeededBranchesSource();
  try {
    const detail = await getSharedBranchDetail(
      source,
      encodeBranchId({
        repoFullName: REAL_BOUNDARY_REPO,
        branchName: REAL_BOUNDARY_BRANCH,
      })
    );

    assert.ok(detail, "expected real SQLite branch detail");
    assert.equal(detail.additions, null);
    assert.equal(detail.deletions, null);
    assert.equal(detail.filesChanged, null);
    assert.equal(
      detail.canonicalMetrics?.leadTimeMs.state,
      BranchMetricAvailability.Unavailable
    );
  } finally {
    await close();
  }
});

const REAL_BOUNDARY_REPO = "acme/web";
const REAL_BOUNDARY_BRANCH = "feature/pr-enriched";
const REAL_BOUNDARY_NOW = "2026-06-22T00:00:00.000Z";

async function openSeededBranchesSource(): Promise<{
  close: () => Promise<void>;
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
  source: BranchSyncSource;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shared-branches-real-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => REAL_BOUNDARY_NOW,
  });

  await seedBranchSession(db);
  await seedPullRequest(db);

  return {
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
    db,
    source: db,
  };
}

async function seedBranchSession(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
): Promise<void> {
  await db.run(
    "INSERT INTO sessions (id, status, started_at, ended_at, billing_mode) VALUES ($1, $2, $3, $4, $5)",
    "real-s1",
    "completed",
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T01:00:00.000Z",
    "metered_api"
  );
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name,
        created_at, last_seen_at)
     VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
    "real-art-branch",
    "real-branch",
    REAL_BOUNDARY_REPO,
    REAL_BOUNDARY_BRANCH,
    "2026-06-01T00:00:00.000Z"
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        is_primary, extractor_version, observed_at, created_at)
     VALUES ($1, 'real-s1', 'real-art-branch', 'worked_on', 'git_push', 'e', 1, 1, $2, $2)`,
    "real-link-branch",
    "2026-06-01T00:30:00.000Z"
  );
}

async function seedPullRequest(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
       (id, pr_url, pr_number, repo_full_name, branch_name,
        closed_at, opened_at, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7)`,
    "real-pr-7",
    "https://github.com/acme/web/pull/7",
    7,
    REAL_BOUNDARY_REPO,
    REAL_BOUNDARY_BRANCH,
    "2026-06-11T10:00:00.000Z",
    "2026-06-10T10:00:00.000Z"
  );
}
