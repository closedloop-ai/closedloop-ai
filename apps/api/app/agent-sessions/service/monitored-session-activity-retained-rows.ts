import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  type MonitoredActivityTarget,
  monitoredActivityTargetKey,
} from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { Prisma } from "@repo/database";
import type { AgentSessionUpsertTx } from "./records";

/** One stored retained row: its id and the snapshot it was filed with. */
export type RetainedMonitoredActivityRow = { id: string; after: unknown };

/**
 * What one delivery's retained-row read is keyed by. `targets` are the
 * delivery's candidate targets; `rowIds` are the ids its candidates' retained
 * rows would carry, so a stored row whose `after` no longer parses (and so
 * matches no target expression) is still found by the id it was filed under.
 */
export type RetainedMonitoredActivityRowQuery = {
  organizationId: string;
  sessionArtifactId: string;
  targets: readonly MonitoredActivityTarget[];
  rowIds: readonly string[];
};

/**
 * The retained rows of one session that belong to the given targets or ids,
 * never the rest of the session's history (#8737 follow-up: the whole-session
 * read grew with every retained event and ran on every held delivery, inside
 * the sync transaction).
 *
 * Each list binds as ONE array parameter, so the statement text is constant
 * and needs no bind-parameter chunking whatever the delivery's width. The
 * target arm's expressions are exactly the key of
 * `artifact_activity_events_monitored_retained_target_idx` (migration
 * 20261013120000_monitored_retained_target_index); change them together or the
 * planner falls back to scanning the session's rows.
 */
export function retainedMonitoredActivityRowsQuery(
  query: RetainedMonitoredActivityRowQuery
): Prisma.Sql {
  const unique = new Map<string, MonitoredActivityTarget>();
  for (const target of query.targets) {
    unique.set(monitoredActivityTargetKey(target), target);
  }
  const kinds: string[] = [];
  const repositoryFullNames: string[] = [];
  const targetNames: string[] = [];
  for (const target of unique.values()) {
    kinds.push(target.kind);
    repositoryFullNames.push(target.repositoryFullName);
    targetNames.push(retainedTargetName(target));
  }
  // Inlined, not bound: the index is partial on this action, and a generic
  // plan cannot prove a bound parameter matches the predicate, so it would
  // skip the index. The value is our own constant, never input.
  const retainedAction = Prisma.raw(
    `'${ArtifactActivityAction.MonitoredActivityRetained}'`
  );
  // The two arms union their ids only, then fetch each row once by primary key:
  // a UNION over `(id, after)` would hash every returned jsonb document just
  // to drop the rows both arms found.
  return Prisma.sql`
    SELECT event.id, event.after
      FROM artifact_activity_events AS event
     WHERE event.id IN (
       SELECT target_match.id
         FROM artifact_activity_events AS target_match
         JOIN unnest(${kinds}::text[], ${repositoryFullNames}::text[], ${targetNames}::text[])
           AS wanted(kind, repository_full_name, target_name)
           ON (target_match.after->>'kind') = wanted.kind
          AND (target_match.after->>'repositoryFullName') = wanted.repository_full_name
          AND COALESCE(target_match.after->>'branchName', target_match.after->>'prNumber') = wanted.target_name
        WHERE target_match.organization_id = ${query.organizationId}::uuid
          AND target_match.artifact_id = ${query.sessionArtifactId}::uuid
          AND target_match.action = ${retainedAction}
       UNION
       SELECT id_match.id
         FROM artifact_activity_events AS id_match
        WHERE id_match.organization_id = ${query.organizationId}::uuid
          AND id_match.artifact_id = ${query.sessionArtifactId}::uuid
          AND id_match.action = ${retainedAction}
          AND id_match.id = ANY(${[...query.rowIds]}::uuid[])
     )
  `;
}

export function readRetainedMonitoredActivityRows(
  tx: AgentSessionUpsertTx,
  query: RetainedMonitoredActivityRowQuery
): Promise<RetainedMonitoredActivityRow[]> {
  if (query.targets.length === 0 && query.rowIds.length === 0) {
    return Promise.resolve([]);
  }
  return tx.$queryRaw<RetainedMonitoredActivityRow[]>(
    retainedMonitoredActivityRowsQuery(query)
  );
}

/**
 * The third index column's value for a target: the branch name, or the PR
 * number as `->>` renders a JSON integer (plain decimal digits).
 */
export function retainedTargetName(target: MonitoredActivityTarget): string {
  return target.kind === ArtifactRefTargetKind.Branch
    ? target.branchName
    : String(target.prNumber);
}
