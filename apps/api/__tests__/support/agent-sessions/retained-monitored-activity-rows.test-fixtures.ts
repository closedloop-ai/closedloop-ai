import {
  ArtifactActivityAction,
  type MonitoredActivityRetainedSnapshot,
} from "@repo/api/src/types/artifact-activity";
import { z } from "zod";
import {
  type RetainedMonitoredActivityRow,
  retainedMonitoredActivityRowsQuery,
  retainedTargetName,
} from "@/app/agent-sessions/service/monitored-session-activity-retained-rows";

/**
 * Constant whatever the delivery: every list binds as one array parameter.
 * Taken from the production builder, so the double cannot drift from it. Built
 * on first use, not at import: suites that mock `@repo/database` without
 * `Prisma` import this module but never issue the read.
 */
let retainedRowsSql: string | undefined;
function retainedRowsSqlText(): string {
  retainedRowsSql ??= retainedMonitoredActivityRowsQuery({
    organizationId: "",
    sessionArtifactId: "",
    targets: [],
    rowIds: [],
  }).sql;
  return retainedRowsSql;
}

/** A Prisma.Sql's observable shape, checked structurally for the same reason. */
const SQL_STATEMENT = z.object({
  sql: z.string(),
  values: z.array(z.unknown()),
});

/** The statement, when `query` is the retained-row read; otherwise ABSENT. */
function retainedRowsStatement(query: unknown) {
  const statement = SQL_STATEMENT.safeParse(query);
  return statement.success && statement.data.sql === retainedRowsSqlText()
    ? statement.data
    : undefined;
}

/** The builder's bind order; parsing it fails loudly if that order changes. */
const RETAINED_ROWS_VALUES = z.tuple([
  z.array(z.string()),
  z.array(z.string()),
  z.array(z.string()),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.array(z.string()),
]);

type StoredRetainedRow = {
  id: string;
  organizationId: string;
  artifactId: string;
  action: string;
  after: MonitoredActivityRetainedSnapshot;
};

/**
 * A transaction double's answer to `readRetainedMonitoredActivityRows`, or
 * ABSENT when `query` is some other statement. Applies the statement's own
 * semantics: this session's retained rows whose target, or id, the delivery
 * named — and no others.
 */
export function answerRetainedMonitoredActivityRowsQuery(
  query: unknown,
  rows: readonly StoredRetainedRow[]
): RetainedMonitoredActivityRow[] | undefined {
  const statement = retainedRowsStatement(query);
  if (statement === undefined) {
    return undefined;
  }
  const [
    kinds,
    repositoryFullNames,
    targetNames,
    organizationId,
    artifactId,
    ,
    ,
    ids,
  ] = RETAINED_ROWS_VALUES.parse(statement.values);
  const rowIds = new Set(ids);
  const wanted = new Set(
    kinds.map((kind, index) =>
      targetIdentity(kind, repositoryFullNames[index], targetNames[index])
    )
  );
  return rows
    .filter(
      (row) =>
        row.organizationId === organizationId &&
        row.artifactId === artifactId &&
        row.action === ArtifactActivityAction.MonitoredActivityRetained &&
        (rowIds.has(row.id) ||
          wanted.has(
            targetIdentity(
              row.after.kind,
              row.after.repositoryFullName,
              retainedTargetName(row.after)
            )
          ))
    )
    .map((row) => ({ id: row.id, after: row.after }));
}

/** Whether a statement is the retained-row read (for call-count assertions). */
export function isRetainedMonitoredActivityRowsQuery(query: unknown): boolean {
  return retainedRowsStatement(query) !== undefined;
}

/** The targets a recorded retained-row read asked for, as it bound them. */
export function retainedRowsQueryTargets(query: unknown) {
  const [kinds, repositoryFullNames, targetNames] = RETAINED_ROWS_VALUES.parse(
    SQL_STATEMENT.parse(query).values
  );
  return kinds.map((kind, index) => ({
    kind,
    repositoryFullName: repositoryFullNames[index],
    targetName: targetNames[index],
  }));
}

function targetIdentity(
  kind: string,
  repositoryFullName: string,
  targetName: string
): string {
  return `${kind}\u0000${repositoryFullName}\u0000${targetName}`;
}
