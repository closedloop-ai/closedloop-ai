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
 * ISS-11106 adds the third case: the projection's correlated aggregate over
 * `pull_requests.opened_at` must pick the earliest INSTANT, not the lowest BYTES.
 * `pull_requests` holds one row per (harness, session, pr_url), so one PR can
 * carry several rows, and the column is TEXT with no live writer left in this
 * repo — PLN-1535 deleted the GitHub enrichment lane that wrote it, so an
 * installed DB holds whatever some earlier release stored and nothing constrains
 * its width.
 *
 * Drives the real SQLite → `loadSyncedSessions` boundary, mirroring
 * sync-source-commit-refs.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { COMMIT_SHA_CORRELATION_METHOD } from "../src/main/database/pr-link-maintenance.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const REPO = "acme/repo";
const BOOT_TIME = "2026-07-28T09:00:00.000Z";
const PR_OPENED_AT = "2026-07-01T08:15:00.000Z";

// ISS-11106: two stored forms of the SAME half-second window, chosen so LEXICAL
// and TEMPORAL order DISAGREE. `Z` is 0x5A and `.` is 0x2E, so byte-wise
// `…08:15:00.500Z` sorts BELOW `…08:15:00Z` — a bare `MIN(pr.opened_at)` returns
// the fractional one, which is the LATER instant by 500ms. A fixture whose two
// orderings agreed would pass either implementation and prove nothing.
const PR_OPENED_AT_WHOLE_SECOND = "2026-07-01T08:15:00Z";
const PR_OPENED_AT_HALF_SECOND_LATER = "2026-07-01T08:15:00.500Z";
// What the whole-second form canonicalizes to, and therefore the earliest
// instant the ranked aggregate must name.
const PR_OPENED_AT_EARLIEST_CANONICAL = "2026-07-01T08:15:00.000Z";

// A form `canonicalizeHealableTimestampSql` deliberately declines: the SQLite
// space separator matches neither its T-form glob nor its exact-10-character
// date-only glob, so its canonical arm is NULL. It is also the byte-wise
// earliest of the three, which is what makes it the fold's proof — the
// all-or-nothing fold must drop the WHOLE group to the raw column and return
// this value verbatim. Ranking on the canonical key alone would DROP this row
// from the aggregate and name a later instant than even the byte-wise MIN.
const PR_OPENED_AT_UNCANONICALIZABLE = "2026-06-22 10:00:00";

// A BLANK stored value, which is ABSENT rather than un-canonicalizable. Without
// the `NULLIF(TRIM(...), '')` normalization it is counted as present but never
// canonicalizes, so it drops the whole group to the raw arm AND then wins the
// byte-wise MIN (the empty string sorts below everything under BINARY
// collation) — discarding a real measured instant from the sibling row.
const PR_OPENED_AT_BLANK = "   ";

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
       (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
     VALUES (?, ?, 'pull_request', ?, ?, 't1', 't1')`,
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

/** A SECOND `pull_requests` row for the same PR, as a different session's read. */
async function seedExtraPullRequestRow(
  db: DbRun,
  opts: { sessionId: string; prNumber: number; openedAt: string }
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
       (id, session_id, pr_number, repo_full_name, pr_url, opened_at, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `pr-row-extra-${opts.sessionId}-${opts.prNumber}`,
    opts.sessionId,
    opts.prNumber,
    REPO,
    `https://github.com/${REPO}/pull/${opts.prNumber}`,
    opts.openedAt,
    BOOT_TIME
  );
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

test("ISS-11106: pr_opened_at names the EARLIEST instant across mixed-width stored forms", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss11106-pr-opened-min-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => BOOT_TIME,
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s3','completed')"
      );
      await seedCorrelatedPrLink(db, {
        sessionId: "s3",
        prNumber: 103,
        openedAt: PR_OPENED_AT_WHOLE_SECOND,
      });
      // A second row for the SAME PR, 500ms LATER but LOWER byte-wise.
      await seedExtraPullRequestRow(db, {
        sessionId: "s3-other",
        prNumber: 103,
        openedAt: PR_OPENED_AT_HALF_SECOND_LATER,
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s3"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const prRef = session.artifactRefs?.find(
        (r) => r.kind === ArtifactRefTargetKind.PullRequest
      );
      assert.ok(prRef, "a pull_request ref was emitted");
      const raised = (prRef.branchLifecycleEvents ?? []).find(
        (e) => e.kind === BranchLifecycleBoundaryKind.PrRaised
      );
      assert.ok(raised, "a PrRaised event was emitted");
      assert.equal(
        raised.observedAt,
        PR_OPENED_AT_EARLIEST_CANONICAL,
        "the aggregate ranks by instant: the whole-second form is the earlier open time"
      );
      assert.notEqual(
        raised.observedAt,
        PR_OPENED_AT_HALF_SECOND_LATER,
        "a byte-wise MIN would have returned this LATER instant"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-11106: one un-canonicalizable row drops the WHOLE group to the raw column", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss11106-pr-opened-raw-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => BOOT_TIME,
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s4','completed')"
      );
      await seedCorrelatedPrLink(db, {
        sessionId: "s4",
        prNumber: 104,
        openedAt: PR_OPENED_AT_WHOLE_SECOND,
      });
      await seedExtraPullRequestRow(db, {
        sessionId: "s4-other",
        prNumber: 104,
        openedAt: PR_OPENED_AT_HALF_SECOND_LATER,
      });
      await seedExtraPullRequestRow(db, {
        sessionId: "s4-third",
        prNumber: 104,
        openedAt: PR_OPENED_AT_UNCANONICALIZABLE,
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s4"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const prRef = session.artifactRefs?.find(
        (r) => r.kind === ArtifactRefTargetKind.PullRequest
      );
      assert.ok(prRef, "a pull_request ref was emitted");
      const raised = (prRef.branchLifecycleEvents ?? []).find(
        (e) => e.kind === BranchLifecycleBoundaryKind.PrRaised
      );
      assert.ok(raised, "a PrRaised event was emitted");
      assert.equal(
        raised.observedAt,
        PR_OPENED_AT_UNCANONICALIZABLE,
        "the group falls back to the raw column verbatim, which is what shipped"
      );
      assert.notEqual(
        raised.observedAt,
        PR_OPENED_AT_EARLIEST_CANONICAL,
        "ranking on the canonical key alone would have DROPPED the raw row"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-11106: a BLANK opened_at row is absent, and cannot beat a real sibling", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "iss11106-pr-opened-blank-")
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
        "INSERT INTO sessions (id, status) VALUES ('s5','completed')"
      );
      await seedCorrelatedPrLink(db, {
        sessionId: "s5",
        prNumber: 105,
        openedAt: PR_OPENED_AT_WHOLE_SECOND,
      });
      await seedExtraPullRequestRow(db, {
        sessionId: "s5-other",
        prNumber: 105,
        openedAt: PR_OPENED_AT_BLANK,
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s5"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const prRef = session.artifactRefs?.find(
        (r) => r.kind === ArtifactRefTargetKind.PullRequest
      );
      assert.ok(prRef, "a pull_request ref was emitted");
      const raised = (prRef.branchLifecycleEvents ?? []).find(
        (e) => e.kind === BranchLifecycleBoundaryKind.PrRaised
      );
      assert.ok(raised, "a PrRaised event was emitted");
      assert.equal(
        raised.observedAt,
        PR_OPENED_AT_EARLIEST_CANONICAL,
        "the blank row is absent, so the sibling's real instant is the answer"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
