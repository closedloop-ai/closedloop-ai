/**
 * @file artifact-link-observed-at-resync.test.ts
 * @description ISS-5236, the direction its sibling
 * {@link ./artifact-link-observed-at-noop.test.ts} deliberately does not cover.
 *
 * That suite pins the NO-OP: an unchanged session re-derived at a later clock
 * must not re-enqueue. This one pins the opposite and equally load-bearing half —
 * a session whose stored `observed_at` is a legacy IMPORT-CLOCK value MUST
 * re-enqueue when the rebuild re-derives it off the source, or the correction
 * heals local SQLite while the cloud keeps the wrong instant forever and the two
 * surfaces disagree about the same branch.
 *
 * Both halves are properties of the same FEA-3659 child-row fingerprint.
 * ISS-5148 had removed `observed_at` from it because the value churned on every
 * rebuild; ISS-5236 makes the value stable and restores the column, so the gate
 * can be blind to churn and sighted to a real correction at the same time. A
 * suite that tested only the no-op would stay green if the column were dropped
 * again, which is exactly the defect being closed.
 *
 * Written against the production entry point (`runDataRevisionRebuild`) and
 * asserted on what it reported plus the row's real sync watermark, never on an
 * internal fingerprint.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { LAUNCH_METADATA_REF_METHOD } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession,
} from "./normalized-session-test-utils.js";

const IMPORT_CLOCK = "2026-06-07T12:00:00.000Z";
const REBUILD_CLOCK = "2026-06-08T09:30:00.000Z";
const SESSION_ENDED_AT = "2026-06-07T11:00:00.000Z";
const STALE_WATERMARK = "2026-06-07T11:30:00.000Z";
/**
 * The shape a pre-ISS-5236 row actually carries: whatever wall-clock moment the
 * old import happened to run at, which is unrelated to the session's own span.
 */
const LEGACY_IMPORT_CLOCK_OBSERVED_AT = "2026-05-01T03:14:15.000Z";
const SESSION_ID = "iss5236-observed-at-resync";
const GIT_BRANCH = "main";

type RebuildOutcome = {
  rebuilt: number;
  changedSessionIds: string[];
  updatedAt: string;
  observedAts: string[];
  launchMetadataRows: number;
};

/**
 * Import a session, then mutate its stored links to look like the legacy corpus
 * (`mutateStoredLinks`), then re-derive it through the production rebuild at a
 * strictly later clock.
 *
 * The mutation is the whole point: it is how a row imported by a PRE-ISS-5236
 * build is reproduced without checking in a fixture database. Everything after
 * it — the staling, the rebuild, the assertions — is the real production path.
 */
async function importThenRebuildWithLegacyLinks(
  dir: string,
  mutateStoredLinks: (
    run: (sql: string, ...args: unknown[]) => Promise<unknown>
  ) => Promise<void>
): Promise<RebuildOutcome> {
  let clock = IMPORT_CLOCK;
  const db = await openTestDb(dir, { now: () => clock });
  try {
    const build = () =>
      makePopulatedSession({
        sessionId: SESSION_ID,
        endedAt: SESSION_ENDED_AT,
        gitBranch: GIT_BRANCH,
      });
    await db.importer.importSession(build(), "claude");
    await mutateStoredLinks((sql, ...args) => db.run(sql, ...args));
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
          parse: () => Promise.resolve([build()]),
        }),
      ],
      db,
    });
    const [row] = await db.prisma.client.$queryRawUnsafe<
      { updated_at: string }[]
    >("SELECT updated_at FROM sessions WHERE id = $1", SESSION_ID);
    const linkRows = await db.prisma.client.$queryRawUnsafe<
      { observed_at: string; method: string }[]
    >(
      "SELECT observed_at, method FROM session_artifact_links WHERE session_id = $1",
      SESSION_ID
    );
    return {
      rebuilt: summary.rebuilt,
      changedSessionIds: summary.changedSessionIds,
      updatedAt: row.updated_at,
      observedAts: linkRows.map((r) => r.observed_at),
      launchMetadataRows: linkRows.filter(
        (r) => r.method === LAUNCH_METADATA_REF_METHOD
      ).length,
    };
  } finally {
    await db.close();
  }
}

describe("ISS-5236: a corrected observed_at must reach the cloud", () => {
  test("a legacy import-clock link re-enqueues the session for cloud re-sync", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss5236-resync-"));
    try {
      const result = await importThenRebuildWithLegacyLinks(
        dir,
        async (run) => {
          await run(
            "UPDATE session_artifact_links SET observed_at = $1 WHERE session_id = $2",
            LEGACY_IMPORT_CLOCK_OBSERVED_AT,
            SESSION_ID
          );
        }
      );

      assert.equal(result.rebuilt, 1, "the session was actually rebuilt");
      assert.ok(
        result.observedAts.length > 0,
        "the fixture must actually carry artifact links"
      );
      assert.ok(
        !result.observedAts.includes(LEGACY_IMPORT_CLOCK_OBSERVED_AT),
        "the rebuild must re-stamp the legacy import-clock instant off the source"
      );
      // The load-bearing pair: without `observed_at` in the synced child-row
      // projection BOTH of these are silently wrong — the rebuild corrects the
      // local row and reports nothing, so the cloud is never told.
      assert.deepEqual(
        result.changedSessionIds,
        [SESSION_ID],
        "an observed_at-only correction must enqueue the session for re-sync"
      );
      assert.equal(
        result.updatedAt,
        REBUILD_CLOCK,
        "the sync watermark must advance past the preserved cursor"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the rebuild's teardown reaches launch_metadata links, unlike the backfill's", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "iss5236-launchmeta-"));
    try {
      // `launch_metadata` is in `NON_REDERIVED_LINK_METHODS`, so
      // `artifact-link-backfill.ts` PRESERVES it and never re-derives it — an
      // EXTRACTOR_VERSION bump alone therefore leaves one session carrying mixed
      // instants (transcript-derived siblings re-stamped, this one still on the
      // import clock). The DATA_REVISION rebuild re-imports through
      // `importSessionWithTx`, whose artifact-links phase deletes every method
      // except `commit_sha_correlation`. Relabelling a real link is how a
      // launch-metadata row is put in front of that teardown without needing a
      // `.closedloop-ai/work/launch-metadata.json` on disk.
      const result = await importThenRebuildWithLegacyLinks(
        dir,
        async (run) => {
          await run(
            "UPDATE session_artifact_links SET method = $1, observed_at = $2 WHERE session_id = $3",
            LAUNCH_METADATA_REF_METHOD,
            LEGACY_IMPORT_CLOCK_OBSERVED_AT,
            SESSION_ID
          );
        }
      );

      assert.equal(result.rebuilt, 1);
      assert.equal(
        result.launchMetadataRows,
        0,
        "the stale launch_metadata row must not survive the rebuild's teardown"
      );
      assert.ok(
        !result.observedAts.includes(LEGACY_IMPORT_CLOCK_OBSERVED_AT),
        "no re-derived link may keep the legacy import-clock instant"
      );
      assert.deepEqual(
        result.changedSessionIds,
        [SESSION_ID],
        "re-deriving it must enqueue the session for re-sync"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
