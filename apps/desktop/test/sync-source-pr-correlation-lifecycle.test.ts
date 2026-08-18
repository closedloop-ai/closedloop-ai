/**
 * @file sync-source-pr-correlation-lifecycle.test.ts
 * @description FEA-4379 — a `created` session→PR link minted by the commit-SHA
 * correlation maintenance pass (`method='commit_sha_correlation'`) carries a
 * boot-time `observed_at`, NOT a real PR-raised instant. The sync source must
 * therefore stamp the PrRaised lifecycle event with the canonical GitHub open
 * time (`pull_requests.opened_at`) when known, and emit NO instant when it is
 * unknown — never Desktop wall-clock time. Genuine transcript-derived PR links
 * keep their real tool-use `observed_at`.
 *
 * Drives the real SQLite → `loadSyncedSessions` boundary, mirroring
 * sync-source-commit-refs.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { COMMIT_SHA_CORRELATION_METHOD } from "../src/main/database/pr-link-maintenance.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const REPO = "acme/repo";
const BOOT_TIME = "2026-07-28T09:00:00.000Z";
const PR_OPENED_AT = "2026-07-01T08:15:00.000Z";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

type DbRun = { run(sql: string, ...params: unknown[]): Promise<void> };

async function seedCorrelatedPrLink(
  db: DbRun,
  opts: { sessionId: string; prNumber: number; openedAt: string | null }
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, pr_state, created_at, last_seen_at)
     VALUES (?, ?, 'pull_request', ?, ?, 'open', 't1', 't1')`,
    `art-pr-${opts.prNumber}`,
    `pr:${REPO}:${opts.prNumber}`,
    REPO,
    opts.prNumber
  );
  // The correlation-minted link: observed_at is the maintenance pass's boot-time
  // wall clock, NOT a real raise instant.
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES (?, ?, ?, 'created', ?, '{}', 1, ?, ?)`,
    `l-pr-${opts.prNumber}`,
    opts.sessionId,
    `art-pr-${opts.prNumber}`,
    COMMIT_SHA_CORRELATION_METHOD,
    BOOT_TIME,
    BOOT_TIME
  );
  // The canonical PR-opened instant lives on pull_requests.opened_at, which the
  // projection joins as pr_opened_at. Absent when openedAt is null.
  if (opts.openedAt !== null) {
    await db.run(
      `INSERT INTO pull_requests
         (id, session_id, pr_number, repo_full_name, pr_url, opened_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      `pr-row-${opts.sessionId}-${opts.prNumber}`,
      opts.sessionId,
      opts.prNumber,
      REPO,
      `https://github.com/${REPO}/pull/${opts.prNumber}`,
      opts.openedAt,
      BOOT_TIME
    );
  }
}

test("FEA-4379: a commit_sha_correlation PR link stamps PrRaised with pr_opened_at, not boot time", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea4379-pr-lifecycle-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => BOOT_TIME,
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s1','completed')"
      );
      await seedCorrelatedPrLink(db, {
        sessionId: "s1",
        prNumber: 101,
        openedAt: PR_OPENED_AT,
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const prRef = session.artifactRefs?.find(
        (r) => r.kind === ArtifactRefTargetKind.PullRequest
      );
      assert.ok(prRef, "a pull_request ref was emitted");
      const events = prRef.branchLifecycleEvents ?? [];
      const raised = events.find(
        (e) => e.kind === BranchLifecycleBoundaryKind.PrRaised
      );
      assert.ok(raised, "a PrRaised event was emitted");
      assert.equal(
        raised.observedAt,
        PR_OPENED_AT,
        "PrRaised uses the canonical GitHub open time, not the boot-time observed_at"
      );
      assert.notEqual(
        raised.observedAt,
        BOOT_TIME,
        "PrRaised never stamps Desktop boot wall-clock time"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-4379: a commit_sha_correlation PR link with no pr_opened_at emits PrRaised with NO instant", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "fea4379-pr-lifecycle-null-")
  );
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => BOOT_TIME,
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s2','completed')"
      );
      await seedCorrelatedPrLink(db, {
        sessionId: "s2",
        prNumber: 102,
        openedAt: null,
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s2"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const prRef = session.artifactRefs?.find(
        (r) => r.kind === ArtifactRefTargetKind.PullRequest
      );
      assert.ok(prRef, "a pull_request ref was emitted");
      const events = prRef.branchLifecycleEvents ?? [];
      const raised = events.find(
        (e) => e.kind === BranchLifecycleBoundaryKind.PrRaised
      );
      assert.ok(raised, "a PrRaised event was still emitted");
      assert.equal(
        raised.observedAt,
        undefined,
        "with no canonical open time, PrRaised carries no fabricated boot-time instant"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
