import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BranchKpiState, encodeBranchId } from "@repo/api/src/types/branch.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  type BranchSyncSource,
  getSharedBranchAnalytics,
  getSharedBranchDetail,
} from "../src/main/shared-branches-api.js";

/**
 * Real-boundary coverage for FEA-2181: persisted SQLite rows flow through the
 * production branch reads, list projection, analytics derivation, and detail
 * projection without mock-shaped PR LOC.
 */
test("FEA-2181: analytics uses merged PR artifact LOC when branch artifact LOC is absent", async () => {
  const { close, source } = await openSeededBranchesSource();
  try {
    const analytics = await getSharedBranchAnalytics(source);

    assert.equal(analytics.medianPrSize.state, BranchKpiState.Available);
    assert.equal(analytics.medianPrSize.value, 622);
  } finally {
    await close();
  }
});

test("FEA-2159: analytics folds missing branch+PR LOC in as 0 (dashboard parity)", async () => {
  const { close, source } = await openSeededBranchesSource({
    seedPrArtifactLoc: false,
  });
  try {
    const analytics = await getSharedBranchAnalytics(source);

    // Neither the branch nor its PR artifact carries LOC, but the merged
    // single-PR branch still contributes 0 to the median (matching the delivery
    // dashboard's `getDelivery`), so the card is available at 0 rather than "—".
    assert.equal(analytics.medianPrSize.state, BranchKpiState.Available);
    assert.equal(analytics.medianPrSize.value, 0);
  } finally {
    await close();
  }
});

test("FEA-2181: detail projects PR artifact LOC and branch artifact LOC still wins", async () => {
  const { close, source } = await openSeededBranchesSource({
    seedBranchArtifactLoc: true,
  });
  try {
    const detail = await getSharedBranchDetail(
      source,
      encodeBranchId({
        repoFullName: REAL_BOUNDARY_REPO,
        branchName: REAL_BOUNDARY_BRANCH,
      })
    );

    assert.ok(detail, "expected real SQLite branch detail");
    assert.equal(detail.additions, 50);
    assert.equal(detail.deletions, 5);
    assert.equal(detail.filesChanged, 2);
  } finally {
    await close();
  }
});

test("FEA-2181: detail falls back to PR artifact LOC for an un-enriched branch artifact", async () => {
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
    assert.equal(detail.additions, 600);
    assert.equal(detail.deletions, 22);
    assert.equal(detail.filesChanged, 9);
  } finally {
    await close();
  }
});

test("FEA-2181: partial branch artifact LOC falls back to complete PR artifact LOC", async () => {
  const { close, source } = await openSeededBranchesSource({
    branchArtifactLoc: {
      linesAdded: 50,
      linesRemoved: null,
      filesChanged: null,
    },
  });
  try {
    const analytics = await getSharedBranchAnalytics(source);
    const detail = await getSharedBranchDetail(
      source,
      encodeBranchId({
        repoFullName: REAL_BOUNDARY_REPO,
        branchName: REAL_BOUNDARY_BRANCH,
      })
    );

    assert.equal(analytics.medianPrSize.state, BranchKpiState.Available);
    assert.equal(analytics.medianPrSize.value, 622);
    assert.ok(detail, "expected real SQLite branch detail");
    assert.equal(detail.additions, 600);
    assert.equal(detail.deletions, 22);
    assert.equal(detail.filesChanged, 9);
  } finally {
    await close();
  }
});

test("FEA-2159: partial PR artifact LOC folds the merged branch in as 0 in the median while detail stays null", async () => {
  const { close, source } = await openSeededBranchesSource({
    prArtifactLoc: {
      linesAdded: 600,
      linesRemoved: null,
      filesChanged: null,
    },
  });
  try {
    const analytics = await getSharedBranchAnalytics(source);
    const detail = await getSharedBranchDetail(
      source,
      encodeBranchId({
        repoFullName: REAL_BOUNDARY_REPO,
        branchName: REAL_BOUNDARY_BRANCH,
      })
    );

    // Partial PR LOC leaves the row's additions/deletions null (the detail
    // projection refuses a partial size), so the merged single-PR branch folds
    // in as 0 in the median (dashboard parity) — available at 0, not "—".
    assert.equal(analytics.medianPrSize.state, BranchKpiState.Available);
    assert.equal(analytics.medianPrSize.value, 0);
    assert.ok(detail, "expected real SQLite branch detail");
    assert.equal(detail.additions, null);
    assert.equal(detail.deletions, null);
    assert.equal(detail.filesChanged, null);
  } finally {
    await close();
  }
});

type SeedOptions = {
  branchArtifactLoc?: ArtifactLoc;
  prArtifactLoc?: ArtifactLoc;
  seedBranchArtifactLoc?: boolean;
  seedPrArtifactLoc?: boolean;
};

type ArtifactLoc = {
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
};

const REAL_BOUNDARY_REPO = "acme/web";
const REAL_BOUNDARY_BRANCH = "feature/pr-enriched";
const REAL_BOUNDARY_NOW = "2026-06-22T00:00:00.000Z";
const COMPLETE_BRANCH_ARTIFACT_LOC: ArtifactLoc = {
  linesAdded: 50,
  linesRemoved: 5,
  filesChanged: 2,
};
const COMPLETE_PR_ARTIFACT_LOC: ArtifactLoc = {
  linesAdded: 600,
  linesRemoved: 22,
  filesChanged: 9,
};

async function openSeededBranchesSource(options: SeedOptions = {}): Promise<{
  close: () => Promise<void>;
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
  source: BranchSyncSource;
}> {
  const {
    branchArtifactLoc,
    prArtifactLoc,
    seedBranchArtifactLoc = false,
    seedPrArtifactLoc = true,
  } = options;
  const dir = await mkdtemp(path.join(os.tmpdir(), "shared-branches-real-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => REAL_BOUNDARY_NOW,
  });

  await seedBranchSession(
    db,
    branchArtifactLoc ??
      (seedBranchArtifactLoc ? COMPLETE_BRANCH_ARTIFACT_LOC : null)
  );
  await seedMergedPullRequest(db);
  if (seedPrArtifactLoc) {
    await seedPullRequestArtifact(
      db,
      prArtifactLoc ?? COMPLETE_PR_ARTIFACT_LOC
    );
  }

  return {
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
    db,
    source: { prisma: db.prisma },
  };
}

async function seedBranchSession(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  branchArtifactLoc: ArtifactLoc | null
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
        lines_added, lines_removed, files_changed, created_at, last_seen_at)
     VALUES ($1, $2, 'branch', $3, $4, $5, $6, $7, $8, $8)`,
    "real-art-branch",
    "real-branch",
    REAL_BOUNDARY_REPO,
    REAL_BOUNDARY_BRANCH,
    branchArtifactLoc?.linesAdded ?? null,
    branchArtifactLoc?.linesRemoved ?? null,
    branchArtifactLoc?.filesChanged ?? null,
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

async function seedMergedPullRequest(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
       (id, pr_url, pr_number, repo_full_name, branch_name, state,
        merged_at, closed_at, opened_at, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'closed', $6, $6, $7, $6, $7)`,
    "real-pr-7",
    "https://github.com/acme/web/pull/7",
    7,
    REAL_BOUNDARY_REPO,
    REAL_BOUNDARY_BRANCH,
    "2026-06-11T10:00:00.000Z",
    "2026-06-10T10:00:00.000Z"
  );
}

async function seedPullRequestArtifact(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  prArtifactLoc: ArtifactLoc
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number,
        lines_added, lines_removed, files_changed, created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, $6, $7, $8, $8)`,
    "real-art-pr",
    "real-pr-artifact",
    REAL_BOUNDARY_REPO,
    7,
    prArtifactLoc.linesAdded,
    prArtifactLoc.linesRemoved,
    prArtifactLoc.filesChanged,
    "2026-06-01T00:00:00.000Z"
  );
}
