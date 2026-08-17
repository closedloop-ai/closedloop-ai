/**
 * @file artifact-link-observed-at-noop.test.ts
 * @description ISS-5148: the DATA_REVISION rebuild's "true sync no-op" path must
 * stay reachable for a session that carries artifact links.
 *
 * The FEA-3659 child-row fingerprint
 * ({@link ../src/main/database/synced-child-row-fingerprint.ts}) is the gate that
 * decides whether a rebuild re-derived anything. It hashed
 * `session_artifact_links.observed_at`, which the artifact-ref extractor stamps
 * from the IMPORT CLOCK for every scan-time ref (`start_branch` from
 * `session.gitBranch`, cwd/branch slug refs, commit refs, MCP tool-call refs).
 * The import clock advances between the original import and every later rebuild,
 * so the fingerprint moved on every rebuild of any session that had a git branch
 * — which is nearly all of them — and the no-op path never fired in production.
 *
 * The pre-existing FEA-3659 coverage (`data-revision-rebuild.test.ts` TEST 16)
 * could not see this: it opens the store with a single FIXED clock, so import and
 * rebuild stamp the identical `observed_at` and the churn is invisible. These
 * tests ADVANCE the clock between the two, which is what production does.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession,
} from "./normalized-session-test-utils.js";

const IMPORT_CLOCK = "2026-06-07T12:00:00.000Z";
// Strictly later than IMPORT_CLOCK: a rebuild always runs after the import it
// re-derives, and this is the ONLY difference between the two passes below.
const REBUILD_CLOCK = "2026-06-08T09:30:00.000Z";
const SESSION_ENDED_AT = "2026-06-07T11:00:00.000Z";
const STALE_WATERMARK = "2026-06-07T11:30:00.000Z";
const SESSION_ID = "iss5148-observed-at";

/** What the production rebuild reported, for the caller to assert on. */
type RebuildOutcome = {
  rebuilt: number;
  changedSessionIds: string[];
  updatedAt: string;
  dataRevision: number;
};

/**
 * Import a session at `IMPORT_CLOCK`, stale the row, then re-derive it at
 * `REBUILD_CLOCK` — the advancing import clock is the ONLY difference between the
 * two passes. `rebuiltGitBranch` selects whether the re-derived session is
 * byte-identical (same branch) or genuinely different (a different branch mints a
 * different artifact link).
 *
 * Returns the production rebuild's own report plus the row's post-rebuild sync
 * watermark; every assertion lives in the tests so the no-op contract is checked
 * through the production entry point rather than through an internal fingerprint.
 */
async function importThenRebuildWithAdvancedClock(
  dir: string,
  gitBranch: string | undefined,
  rebuiltGitBranch: string | undefined = gitBranch
): Promise<RebuildOutcome> {
  let clock = IMPORT_CLOCK;
  // `openTestDb` (not a raw `openSqliteAgentDatabase`) so teardown also runs the
  // ISS-5100 `PRAGMA foreign_key_check` — this suite drives the rebuild's
  // delete-then-reinsert of `session_artifact_links`, exactly the path that class
  // of orphan comes from. The clock is the only override: it must ADVANCE between
  // the import and the rebuild, which the helper's fixed default cannot do.
  const db = await openTestDb(dir, { now: () => clock });
  try {
    const build = (branch: string | undefined) =>
      makePopulatedSession({
        sessionId: SESSION_ID,
        endedAt: SESSION_ENDED_AT,
        gitBranch: branch,
      });
    await db.importer.importSession(build(gitBranch), "claude");
    await db.run(
      "UPDATE sessions SET data_revision = 0, status = 'inactive', updated_at = $1 WHERE id = $2",
      STALE_WATERMARK,
      SESSION_ID
    );

    clock = REBUILD_CLOCK;
    const summary = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${SESSION_ID}.jsonl`],
          sessionIdForSource: () => SESSION_ID,
          parse: () => Promise.resolve([build(rebuiltGitBranch)]),
        }),
      ],
      db,
    });
    const [row] = await db.prisma.client.$queryRawUnsafe<
      { updated_at: string; data_revision: number }[]
    >(
      "SELECT updated_at, data_revision FROM sessions WHERE id = $1",
      SESSION_ID
    );
    return {
      rebuilt: summary.rebuilt,
      changedSessionIds: summary.changedSessionIds,
      updatedAt: row.updated_at,
      dataRevision: row.data_revision,
    };
  } finally {
    await db.close();
  }
}

describe("ISS-5148: artifact-link observed_at must not churn the rebuild change-gate", () => {
  test("a branch-carrying session re-derived under an ADVANCED import clock is still a true sync no-op", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss5148-branch-"));
    try {
      // `makePopulatedSession` defaults gitBranch to "main", which mints the
      // `start_branch` workspace link — the exact production shape the ticket
      // calls out ("any session that has a git branch").
      const result = await importThenRebuildWithAdvancedClock(dir, "main");
      assert.equal(result.rebuilt, 1, "the session was actually rebuilt");
      assert.equal(
        result.dataRevision,
        DATA_REVISION,
        "data_revision healed so the row is not re-rebuilt next boot"
      );
      assert.deepEqual(
        result.changedSessionIds,
        [],
        "unchanged source data must not enqueue the session for cloud re-sync"
      );
      assert.equal(
        result.updatedAt,
        STALE_WATERMARK,
        "updated_at must NOT be bumped by a byte-identical re-derivation"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the no-op also holds for a branchless session (control: no scan-time branch link)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss5148-nobranch-"));
    try {
      const result = await importThenRebuildWithAdvancedClock(dir, undefined);
      assert.equal(result.rebuilt, 1);
      assert.equal(result.dataRevision, DATA_REVISION);
      assert.deepEqual(result.changedSessionIds, []);
      assert.equal(result.updatedAt, STALE_WATERMARK);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a genuine content change is still detected under the same advanced clock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss5148-changed-"));
    try {
      // A DIFFERENT branch re-derives a different artifact link, so the gate must
      // still fire — the fix must not blind it to real changes.
      const result = await importThenRebuildWithAdvancedClock(
        dir,
        "main",
        "feat/iss-5148"
      );
      assert.equal(result.rebuilt, 1);
      assert.deepEqual(
        result.changedSessionIds,
        [SESSION_ID],
        "a re-derived artifact link must still enqueue the session for re-sync"
      );
      assert.equal(
        result.updatedAt,
        REBUILD_CLOCK,
        "a genuine change advances the sync watermark to the rebuild clock"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
