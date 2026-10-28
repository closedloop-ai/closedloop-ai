import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/branch-activity-kind";
import {
  MonitoredHoldExpiryCause,
  MonitoredTargetDisposition,
} from "@repo/api/src/types/monitored-activity-target";
import {
  ArtifactRefTargetKind,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma } from "@repo/database";

/**
 * The retained rows a session-detail read needs to render its untracked
 * repositories, instead of every retained row of the session (#8737 follow-up,
 * operator ruling "fold it in").
 *
 * It returns, in `(created_at, id)` order:
 * - every row SQL cannot CERTIFY as one the snapshot schema accepts, through
 *   `artifact_activity_events_monitored_retained_uncertified_idx`, a partial
 *   index holding only those rows, and
 * - for each target, the earliest other row with an untracked disposition
 *   (`DISTINCT ON` the key of
 *   `artifact_activity_events_monitored_retained_target_idx`).
 *
 * The caller then runs the same in-memory pass as before over these rows, and
 * gets the same answer as over the whole session:
 * - A certified row always parses, so it is never counted unreadable. Every row
 *   that would be counted is uncertified and shipped, so the count is exact.
 * - A certified row that is tracked, or a later delivery of a target, can never
 *   be the one the caller keeps, so dropping it changes nothing. The caller's
 *   first-row-wins dedup (on the normalized key) still sees the earliest
 *   candidate of every target.
 *
 * Certification is evaluated once, when a row is written, by the partial
 * index's predicate, not on every read. That predicate is
 * {@link UNCERTIFIED_RETAINED_SNAPSHOT_SQL} verbatim; the read splices the same
 * text so the planner can prove it. The migration that creates the index holds
 * a copy, and the integration suite fails if the read stops using it.
 */
export function sessionUntrackedRepositoryRowsQuery(input: {
  organizationId: string;
  sessionArtifactId: string;
  untrackedDispositions: readonly MonitoredTargetDisposition[];
}): Prisma.Sql {
  // Inlined, not bound: both indexes are partial on the action (and one on the
  // certification predicate), which a generic plan can only prove from
  // literals. Every value below is our own constant, never input.
  const retainedAction = Prisma.raw(
    sqlLiteral(ArtifactActivityAction.MonitoredActivityRetained)
  );
  const uncertified = Prisma.raw(UNCERTIFIED_RETAINED_SNAPSHOT_SQL);
  // The DISTINCT ON keys group by equality, which is byte equality under the
  // database's deterministic default collation too; COLLATE "C" only spares
  // the sort the locale-aware comparisons (measured: ~40 ms of a 55 ms read
  // over a 20,000-row session went to that sort).
  return Prisma.sql`
    WITH uncertified AS MATERIALIZED (
      SELECT id
        FROM artifact_activity_events
       WHERE organization_id = ${input.organizationId}::uuid
         AND artifact_id = ${input.sessionArtifactId}::uuid
         AND action = ${retainedAction}
         AND ${uncertified}
    ),
    earliest AS (
      SELECT DISTINCT ON (
               (after->>'kind') COLLATE "C",
               (after->>'repositoryFullName') COLLATE "C",
               COALESCE(after->>'branchName', after->>'prNumber') COLLATE "C"
             ) id
        FROM artifact_activity_events
       WHERE organization_id = ${input.organizationId}::uuid
         AND artifact_id = ${input.sessionArtifactId}::uuid
         AND action = ${retainedAction}
         AND (after->>'disposition') = ANY(${[...input.untrackedDispositions]}::text[])
         AND id NOT IN (SELECT id FROM uncertified)
       ORDER BY (after->>'kind') COLLATE "C",
                (after->>'repositoryFullName') COLLATE "C",
                COALESCE(after->>'branchName', after->>'prNumber') COLLATE "C",
                created_at,
                id
    )
    SELECT event.id, event.after
      FROM artifact_activity_events AS event
     WHERE event.id = ANY(ARRAY(SELECT id FROM uncertified UNION ALL SELECT id FROM earliest))
       AND event.organization_id = ${input.organizationId}::uuid
       AND event.artifact_id = ${input.sessionArtifactId}::uuid
     ORDER BY event.created_at, event.id
  `;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map(sqlLiteral).join(", ")}]`;
}

/**
 * zod 4.3.6 `iso.datetime()` (no offset, no local, any precision) without its
 * 29 February branch, with ASCII digit classes (Postgres `\d` follows the
 * locale), so every match is a datetime zod accepts.
 */
const CERTIFIED_OCCURRED_AT_PATTERN =
  "^[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\\.[0-9]+)?)?Z$";

/**
 * `MONITORED_ACTIVITY_RETAINED_SNAPSHOT_SCHEMA`, plus the caller's non-empty
 * repository rule, as a SQL predicate over `after`. A SUBSET of the schema,
 * never a superset: it may refuse a row Zod accepts (that row is just shipped
 * and parsed), but must never accept one Zod refuses, or the unreadable count
 * would miss it. An absent key yields NULL, which the `IS NOT TRUE` below reads
 * as "not certified"; every cast is guarded by a CASE, because SQL does not
 * order AND operands.
 */
const CERTIFIED_RETAINED_SNAPSHOT_SQL = [
  "jsonb_typeof(after -> 'repositoryFullName') = 'string'",
  "(after ->> 'repositoryFullName') <> ''",
  `CASE (after ->> 'kind')
     WHEN ${sqlLiteral(ArtifactRefTargetKind.Branch)} THEN
       jsonb_typeof(after -> 'branchName') = 'string' AND length(after ->> 'branchName') >= 1
     WHEN ${sqlLiteral(ArtifactRefTargetKind.PullRequest)} THEN
       CASE WHEN jsonb_typeof(after -> 'prNumber') = 'number' THEN
         (after ->> 'prNumber')::numeric = trunc((after ->> 'prNumber')::numeric)
         AND (after ->> 'prNumber')::numeric > 0
         AND (after ->> 'prNumber')::numeric <= ${PR_INT_MAX}
       ELSE false END
     ELSE false
   END`,
  "jsonb_typeof(after -> 'kind') = 'string'",
  "((after -> 'url') IS NULL OR jsonb_typeof(after -> 'url') = 'string')",
  "jsonb_typeof(after -> 'eventKind') = 'string'",
  `(after ->> 'eventKind') = ANY (${sqlTextArray(Object.values(MonitoredSessionActivityEventKind))})`,
  "jsonb_typeof(after -> 'occurredAt') = 'string'",
  `(after ->> 'occurredAt') ~ ${sqlLiteral(CERTIFIED_OCCURRED_AT_PATTERN)}`,
  "jsonb_typeof(after -> 'completeness') = 'string'",
  `(after ->> 'completeness') = ANY (${sqlTextArray([
    BranchActivityEvidenceCompleteness.Complete,
    BranchActivityEvidenceCompleteness.Partial,
  ])})`,
  "jsonb_typeof(after -> 'disposition') = 'string'",
  `(after ->> 'disposition') = ANY (${sqlTextArray(Object.values(MonitoredTargetDisposition))})`,
  `((after -> 'holdExpiryCause') IS NULL OR (jsonb_typeof(after -> 'holdExpiryCause') = 'string' AND (after ->> 'holdExpiryCause') = ANY (${sqlTextArray(Object.values(MonitoredHoldExpiryCause))})))`,
].join("\n   AND ");

/**
 * The predicate of `artifact_activity_events_monitored_retained_uncertified_idx`
 * (migration 20261013120100), exported so the migration's copy can be checked
 * against it.
 */
export const UNCERTIFIED_RETAINED_SNAPSHOT_SQL = `(${CERTIFIED_RETAINED_SNAPSHOT_SQL}) IS NOT TRUE`;
