/**
 * The bound `VALUES` tuple `searchIndexService.upsertMany` inserts for one
 * `search_document` row, with the in-statement reads of the columns a stale
 * capture must not overwrite.
 */
import {
  boundSearchText,
  MAX_SEARCH_BODY_CHARS,
  MAX_SEARCH_TITLE_CHARS,
} from "@repo/api/src/types/search";
import {
  isStatusTriggerOwned,
  SearchEntityType,
  type StatusTriggerOwnedEntityType,
} from "@repo/api/src/types/search-entity-kind";
import { Prisma } from "@repo/database";
import type { SearchProjectionInput } from "./search-index-service";

/**
 * Build one bound `VALUES` tuple for a projection row, shared by the single and
 * batch upsert paths so the column order and per-column casts cannot drift. The
 * generated `id`/`tsv` columns are Postgres-owned; `title`/`body` are bounded to
 * the same caps everywhere (a pathological name/prompt cannot bloat the `tsv`).
 */
export function projectionValuesRow(input: SearchProjectionInput): Prisma.Sql {
  const title = boundSearchText(input.title, MAX_SEARCH_TITLE_CHARS) ?? "";
  const body = boundSearchText(input.body, MAX_SEARCH_BODY_CHARS);
  return Prisma.sql`(
    gen_random_uuid(),
    ${input.organizationId}::uuid,
    ${input.entityType},
    ${input.entityId}::uuid,
    ${title},
    ${body},
    ${input.projectId ? Prisma.sql`${input.projectId}::uuid` : Prisma.sql`NULL`},
    ${input.assigneeId ? Prisma.sql`${input.assigneeId}::uuid` : Prisma.sql`NULL`},
    ${insertedStatusSql(input)},
    ${insertedPrioritySql(input)},
    ${input.updatedAt},
    ${input.slug},
    ${input.entitySubtype},
    ${input.teamId ? Prisma.sql`${input.teamId}::uuid` : Prisma.sql`NULL`},
    ${input.anchorEntityId ? Prisma.sql`${input.anchorEntityId}::uuid` : Prisma.sql`NULL`}
  )`;
}

/**
 * The `status` a row is inserted with. For a trigger-owned row type it is the
 * source row's status, read inside the upsert statement, falling back to the
 * captured value only when the source row is gone.
 */
function insertedStatusSql(input: SearchProjectionInput): Prisma.Sql {
  if (isStatusTriggerOwned(input.entityType)) {
    const readSource = STATUS_SOURCE_READS[input.entityType];
    return Prisma.sql`COALESCE((${readSource(input.entityId, input.organizationId)}), ${input.status})`;
  }
  return Prisma.sql`${input.status}`;
}

/**
 * The `priority` a session or branch row is written with: its artifact's,
 * read inside the upsert statement (#7762 review). The transcript indexer
 * captures the session before a slow object-storage read, so a priority `PATCH`
 * landing in that window would otherwise be overwritten by the stale capture
 * after its own re-projection ran. The captured value is the fallback only when
 * the artifact row is gone — not `COALESCE`, because `null` is a real priority.
 */
function insertedPrioritySql(input: SearchProjectionInput): Prisma.Sql {
  if (
    input.entityType !== SearchEntityType.AgentSession &&
    input.entityType !== SearchEntityType.Branch
  ) {
    return Prisma.sql`${input.priority}`;
  }
  const source = Prisma.sql`FROM "artifacts" AS a WHERE a."id" = ${input.entityId}::uuid AND a."organization_id" = ${input.organizationId}::uuid`;
  return Prisma.sql`CASE WHEN EXISTS (SELECT 1 ${source}) THEN (SELECT a."priority"::text ${source}) ELSE ${input.priority} END`;
}

/**
 * Each trigger-owned row type's read of its source row's current status
 * (ISS-9938). Keyed on the shared set, so a kind added to it does not compile
 * until it has a read here; the backfill carries the same record.
 */
const STATUS_SOURCE_READS: Record<
  StatusTriggerOwnedEntityType,
  (entityId: string, organizationId: string) => Prisma.Sql
> = {
  [SearchEntityType.Document]: (entityId, organizationId) =>
    Prisma.sql`SELECT a."status" FROM "artifacts" AS a WHERE a."id" = ${entityId}::uuid AND a."organization_id" = ${organizationId}::uuid`,
};
