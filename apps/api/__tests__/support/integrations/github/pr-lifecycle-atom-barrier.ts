import { randomUUID } from "node:crypto";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { Client } from "pg";
import { requireFixtureDatabaseUrl } from "@/__tests__/utils/fixture-db";

type AtomBarrierFixture = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestId: string | null;
};

const BARRIER_WAIT_TIMEOUT_MS = 10_000;
const BARRIER_POLL_INTERVAL_MS = 10;

/** Coordinate a competing lifecycle insert at the production transaction boundary. */
export async function installPullRequestLifecycleAtomInsertBarrier(
  branchArtifactId: string
) {
  // Both connections below are FIXTURE connections: installing the barrier
  // creates a function and a trigger on `branch_activity_atoms`, which is the
  // migrator's work under the ISS-5978 role split. The production insert it
  // parks still arrives on `DATABASE_URL`.
  const databaseUrl = requireFixtureDatabaseUrl("the advisory-lock barrier");
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `iss_6421_atom_barrier_${suffix}`;
  const triggerName = `iss_6421_atom_barrier_trigger_${suffix}`;
  const lockKeyOne = 6421;
  const lockKeyTwo = Number.parseInt(suffix.slice(0, 7), 16);
  const blocker = new Client({ connectionString: databaseUrl });
  const observer = new Client({ connectionString: databaseUrl });
  await Promise.all([blocker.connect(), observer.connect()]);
  await observer.query("SET application_name = 'iss-6421-race-writer'");
  await observer.query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
    BEGIN
      IF NEW.branch_artifact_id = '${branchArtifactId}'::uuid
         AND NEW.source = 'pull_request_lifecycle'
         AND current_setting('application_name') <> 'iss-6421-race-writer' THEN
        PERFORM pg_advisory_xact_lock(${lockKeyOne}, ${lockKeyTwo});
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await observer.query(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON branch_activity_atoms
    FOR EACH ROW EXECUTE FUNCTION ${functionName}();
  `);
  await blocker.query("SELECT pg_advisory_lock($1, $2)", [
    lockKeyOne,
    lockKeyTwo,
  ]);
  let released = false;
  return {
    async insertConflictingOpenedAtom(
      fixture: AtomBarrierFixture,
      occurredAt: Date
    ) {
      if (!fixture.pullRequestId) {
        throw new Error("Conflict fixture requires a pull request");
      }
      await observer.query(
        `INSERT INTO branch_activity_atoms (
           id, version, organization_id, branch_artifact_id, source,
           source_event_id, occurred_at, attribution_kind,
           pull_request_detail_id, completeness
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::uuid, $10
         )`,
        [
          randomUUID(),
          BranchActivityAtomVersion.V1,
          fixture.organizationId,
          fixture.branchArtifactId,
          BranchActivitySource.PullRequestLifecycle,
          `${fixture.pullRequestId}:opened`,
          occurredAt,
          BranchActivityAttributionKind.PullRequest,
          fixture.pullRequestId,
          BranchActivityEvidenceCompleteness.Complete,
        ]
      );
    },
    async waitUntilBlocked() {
      const deadline = Date.now() + BARRIER_WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const result = await observer.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_locks
             WHERE locktype = 'advisory'
               AND classid = $1::oid
               AND objid = $2::oid
               AND NOT granted
           ) AS waiting`,
          [lockKeyOne, lockKeyTwo]
        );
        if (result.rows[0]?.waiting) {
          return;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, BARRIER_POLL_INTERVAL_MS)
        );
      }
      throw new Error("Settlement did not reach the atom insert barrier");
    },
    async release() {
      if (!released) {
        await blocker.query("SELECT pg_advisory_unlock($1, $2)", [
          lockKeyOne,
          lockKeyTwo,
        ]);
        released = true;
      }
    },
    async dispose() {
      await this.release();
      await observer.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON branch_activity_atoms`
      );
      await observer.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await Promise.all([blocker.end(), observer.end()]);
    },
  };
}
