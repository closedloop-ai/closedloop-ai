import type {
  SessionCursorRow,
  SessionListCursorFacets,
  SessionListCursorPage,
  SessionListCursorPageRequest,
} from "../agent-sync/agent-session-read-model.js";
import { SESSION_STARTED_AT_TS_EXPR } from "../agent-sync/session-date-window.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  buildListCursorFilterClause,
  listCursorPageSortSql,
} from "./session-aggregate-filters.js";
import { countSqliteSessions } from "./session-count.js";
import { resolveSessionListSearchContext } from "./session-list-search-context.js";
import { readRepositoryScopedSnapshot } from "./session-repository-snapshot.js";
import { assertValidSessionWorkOperands } from "./session-work-operand-validation.js";

/** Lightweight page cursor for the renderer Sessions list. */
export async function listSqliteSessionCursorPage(
  prisma: DesktopPrisma,
  request: SessionListCursorPageRequest
): Promise<SessionListCursorPage> {
  const direction = request.sortDir === "asc" ? "ASC" : "DESC";
  const { source, orderBy } = listCursorPageSortSql(
    request.sortBy,
    direction,
    hasListFacet(request)
  );
  const selectionWindow = buildListCursorFilterClause({
    ...request,
    quality: "all",
    search: undefined,
  });
  const searchContext = request.search
    ? await resolveSessionListSearchContext(
        prisma,
        request.search,
        selectionWindow
      )
    : null;
  return readRepositoryScopedSnapshot(
    prisma,
    request.repositories,
    selectionWindow,
    async (snapshot, repositoryPairKeys) => {
      const scopedRequest = {
        ...request,
        ...(repositoryPairKeys === undefined ? {} : { repositoryPairKeys }),
        ...(searchContext
          ? {
              searchMatchPairKeys: searchContext.matchingPairKeys,
              searchFallbackSessionIds: searchContext.fallbackSessionIds,
            }
          : {}),
      };
      if (request.quality && request.quality !== "all") {
        const validation = buildListCursorFilterClause({
          ...scopedRequest,
          quality: "all",
        });
        await assertValidSessionWorkOperands(
          snapshot,
          validation.clause,
          validation.params
        );
      }
      const { clause, params } = buildListCursorFilterClause(scopedRequest);
      const idleFilter =
        request.quality === "substantive"
          ? buildListCursorFilterClause({ ...scopedRequest, quality: "idle" })
          : null;
      const pageParams = [...params, request.limit, request.offset];
      const limitPlaceholder = `$${params.length + 1}`;
      const offsetPlaceholder = `$${params.length + 2}`;
      const total = await countSqliteSessions(snapshot, clause, params);
      const pageRows = await snapshot.$queryRawUnsafe<SessionCursorRow[]>(
        `
        WITH activity AS (
          SELECT
            s.id,
            s.updated_at,
            ${SESSION_STARTED_AT_TS_EXPR} AS sort_started_at,
            s.last_activity_at AS sort_last_activity_at,
            s.started_at AS tie_started_at
          FROM ${source}
          ${clause}
        )
        SELECT id, updated_at
        FROM activity
        ORDER BY ${orderBy}
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      `,
        ...pageParams
      );
      if ((!request.quality || request.quality === "all") && pageRows.length) {
        await assertValidSessionWorkOperands(
          snapshot,
          "WHERE s.id IN (SELECT value FROM json_each($1))",
          [JSON.stringify(pageRows.map((row) => row.id))]
        );
      }
      const idleCount = idleFilter
        ? await countSqliteSessions(
            snapshot,
            idleFilter.clause,
            idleFilter.params
          )
        : 0;
      return { rows: pageRows, total, idleCount };
    }
  );
}

/**
 * True when `request` carries an Owner, Harness, Model or Priority facet — the
 * facets {@link pushListFacetConditions} renders into SQL. Exported for
 * {@link canUseListCursorPage} (`session-read-fast-paths.ts`), which must
 * agree with this page on what counts as a facet. Search resolves the
 * on-disk attribution fields before this page's short SQLite snapshot.
 */
export function hasListFacet(request: SessionListCursorFacets): boolean {
  return Boolean(
    request.userIds?.length ||
      request.harness ||
      request.harnesses?.length ||
      request.models?.length ||
      request.priorities?.length
  );
}
