import assert from "node:assert/strict";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { test } from "vitest";
import { getSharedBranchDetail } from "../src/main/branch/shared-branches-api.js";
import { createBranchCanonicalActivityReadMethods } from "../src/main/database/branch-activity-read.js";
import { createBranchMetricEventEvidenceMethods } from "../src/main/database/branch-metric-event-provenance.js";
import {
  readBranchCommitRowsForSessions,
  readSessionBranchCounts,
} from "../src/main/database/branch-reads.js";
import {
  BRANCH_WRITE_METHOD_VALUES,
  EVENT_INSERT_PARAM_CAP,
} from "../src/main/database/db-constants.js";
import {
  AC_T0,
  type AcDb,
  insertCommitArtifact,
  seeder,
  spyOnBoundParameters,
  withAcDb,
} from "./branch-reads-ac-test-helpers.js";

/**
 * ISS-10365: the branch DETAIL page bound one SQLite host parameter per session
 * that ever wrote the opened branch. `getSharedBranchDetail` hands the same
 * `sessionIds` list to `readBranchCommitRowsForSessions` and to
 * `readSessionBranchCounts`, and both spelled it as a `?`-per-id `IN (…)`, so a
 * long-lived branch past SQLITE_MAX_VARIABLE_NUMBER (999 on older builds, the
 * floor `EVENT_INSERT_PARAM_CAP` is set against) threw and the page would not
 * open. Sibling defect on the LISTING side: ISS-10324.
 *
 * WHAT THESE ASSERT, AND WHY IT IS THE BIND COUNT. The runtime these tests run
 * on carries the modern 32,766-variable ceiling, so the pre-fix shape ALSO
 * returns every row at 1,200 sessions — a row-count assertion here cannot fail
 * and proves nothing. What the fix guarantees is a bind count that does not
 * scale with the session set at all, so each case asserts the statement's bound
 * parameters stay at the small constant the folded `json_each` list costs, and
 * keeps the row count only as the positive control that a real, complete read
 * happened. Every session is still read: nothing is capped, chunked away, or
 * dropped.
 */

// Comfortably past the 999 floor so the failure is the limit, not the edge.
const WIDE_SESSION_COUNT = 1200;
const BRANCH = { repoFullName: "acme/web", branchName: "main" };

/** One branch written by `count` sessions, each contributing its own commit. */
async function seedWideSessionBranch(db: AcDb, count: number): Promise<void> {
  const seed = seeder(db);
  const artifactId = await seed.branch({
    branch: BRANCH.branchName,
    firstPushedAt: AC_T0,
  });
  for (let index = 0; index < count; index++) {
    const sessionId = `session-wide-${index}`;
    await seed.session(sessionId);
    await seed.link({
      session: sessionId,
      artifactId,
      method: BRANCH_WRITE_METHOD_VALUES[0],
    });
    await insertCommitArtifact(db, {
      id: `commit-wide-${index}`,
      session: sessionId,
      branch: BRANCH.branchName,
      committedAt: `2026-06-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      sha: `sha-wide-${index}`,
    });
  }
}

const sessionIdsFor = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `session-wide-${index}`);

test("the detail commit read binds a constant parameter count at any session width", async () => {
  await withAcDb(async (db) => {
    await seedWideSessionBranch(db, WIDE_SESSION_COUNT);
    const spy = spyOnBoundParameters(db.prisma);

    const rows = await readBranchCommitRowsForSessions(
      spy.prisma,
      sessionIdsFor(WIDE_SESSION_COUNT),
      BRANCH
    );

    // Positive control: the whole commit set came back, one row per session's
    // commit — the history is not shortened to fit the parameter budget.
    assert.equal(rows.length, WIDE_SESSION_COUNT);
    assert.ok(
      spy.boundParameterCounts.length > 0,
      "the spy must have observed the read"
    );
    // The session list is ONE bound JSON array, so the statement binds exactly
    // one parameter whether the branch has two sessions or two hundred thousand.
    assert.deepEqual(
      spy.boundParameterCounts.filter((count) => count !== 1),
      []
    );
    assert.ok(
      spy.boundParameterCounts.every((count) => count <= EVENT_INSERT_PARAM_CAP)
    );
  });
});

test("the detail even-split divisor read binds a constant parameter count at any session width", async () => {
  await withAcDb(async (db) => {
    await seedWideSessionBranch(db, WIDE_SESSION_COUNT);
    const spy = spyOnBoundParameters(db.prisma);

    const counts = await readSessionBranchCounts(
      spy.prisma,
      sessionIdsFor(WIDE_SESSION_COUNT),
      [BRANCH]
    );

    // Positive control: every session got a divisor, so no session's attributed
    // cost silently divides by a count the read failed to produce.
    assert.equal(counts.size, WIDE_SESSION_COUNT);
    assert.equal(counts.get("session-wide-0"), 1);
    assert.ok(
      spy.boundParameterCounts.length > 0,
      "the spy must have observed the read"
    );
    // Two bound parameters: the denominator key set and the session id list,
    // each a single JSON array. Neither scales with the session count.
    assert.deepEqual(
      spy.boundParameterCounts.filter((count) => count !== 2),
      []
    );
    assert.ok(
      spy.boundParameterCounts.every((count) => count <= EVENT_INSERT_PARAM_CAP)
    );
  });
});

/**
 * The reads above are the unit; this is the SERVING path that broke. A read
 * failure inside `getSharedBranchDetail` is not a degraded field — the whole
 * detail page fails to open. Driving the real op against the same wide corpus
 * proves the page still resolves, with its full commit rail.
 */
test("the branch detail opens for a branch written by more sessions than the cap", async () => {
  await withAcDb(async (db) => {
    await seedWideSessionBranch(db, WIDE_SESSION_COUNT);
    const source = {
      prisma: db.prisma,
      ...createBranchCanonicalActivityReadMethods(db.prisma),
      ...createBranchMetricEventEvidenceMethods(db.prisma),
    };

    const detail = await getSharedBranchDetail(source, encodeBranchId(BRANCH));

    assert.ok(detail, "the wide-session branch must still resolve a detail");
    assert.equal(detail.branchName, BRANCH.branchName);
    assert.equal(detail.commits.length, WIDE_SESSION_COUNT);
  });
});
