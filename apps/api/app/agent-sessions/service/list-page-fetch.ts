import { ListQueryExecution } from "@repo/api/src/types/list-query-observability";
import { Prisma, withDb } from "@repo/database";
import {
  recordRequestListQueryExecution,
  recordRequestListQueryScannedCount,
} from "@/lib/observability/request-span-attribution";
import type { AgentSessionListQuery } from "../validators";
import {
  type AgentSessionListRecord,
  agentSessionListSelectForOrganization,
} from "./records";
import {
  SESSION_CANDIDATE_KEYSET_ORDER_BY,
  selectOrderedSessionWindow,
} from "./session-candidate-stream";
import {
  type DisplaySortCandidate,
  displaySortCandidateSelect,
} from "./session-display-sort";
import { buildDisplaySortComparator } from "./session-sort-comparators";
import { resolveSessionSortRules } from "./session-sort-rules";

/** The resolved page, from whichever of the two fetch paths served it. */
export type SessionListPage = {
  items: AgentSessionListRecord[];
  total: number;
  idleCount: number;
  /** Rows inspected by the in-memory fallback; SQL-native pages omit it. */
  scannedCount?: number;
};

type DbPaginatedPageInput = {
  // ISS-8712: the reading org, so the artifact-tag join is scoped in SQL rather
  // than filtered in the mapper. Not a row filter — `where` already carries the
  // tenant predicate for the rows themselves.
  organizationId: string;
  where: Prisma.SessionDetailWhereInput;
  idleWhere: Prisma.SessionDetailWhereInput | null;
  orderBy: Prisma.SessionDetailOrderByWithRelationInput[];
  offset: number;
  limit: number;
};

type ResolveSessionListPageInput = {
  displayValueSorted: boolean;
  statusRootRank?: (status: string) => number | null;
  organizationId: string;
  where: Prisma.SessionDetailWhereInput;
  idleWhere: Prisma.SessionDetailWhereInput | null;
  orderBy: Prisma.SessionDetailOrderByWithRelationInput[];
  offset: number;
  limit: number;
  filters: AgentSessionListQuery;
};

/**
 * Dispatch a Sessions list page to the correct fetch path.
 *
 * TWO paths now, not three (ISS-7176). Duration, Owner and Updated need
 * bounded in-memory ordering. D5 flagged Status also uses that path because
 * raw database ordering cannot express artifact-root rank. With the flag off,
 * Status keeps its cheap DB-paginated path.
 *
 * COST IS NO LONGER ONE OF THEM. A cost bucket is a predicate on
 * `session_detail.estimated_cost` — the same column the row displays — so it
 * filters, orders and paginates in the database like any other facet. The third
 * path existed to re-derive cost from `agent_session_token_events` and re-apply
 * the bucket in memory, which is why it needed a 10,000-session candidate cap;
 * removing it removes the cap.
 */
export function resolveSessionListPage(
  input: ResolveSessionListPageInput
): Promise<SessionListPage> {
  const {
    displayValueSorted,
    statusRootRank,
    organizationId,
    where,
    idleWhere,
    orderBy,
    offset,
    limit,
    filters,
  } = input;
  if (displayValueSorted) {
    recordRequestListQueryExecution(ListQueryExecution.DisplayValueFallback);
    return findDisplayValueSortedPage({
      organizationId,
      where,
      idleWhere,
      offset,
      limit,
      filters,
      statusRootRank,
    });
  }
  recordRequestListQueryExecution(ListQueryExecution.DatabasePage);
  return findDbPaginatedPage({
    organizationId,
    where,
    idleWhere,
    orderBy,
    offset,
    limit,
  });
}

/**
 * The default path: the database filters, orders, counts, and paginates directly.
 * Rows and counts share one snapshot, including when a write races the read.
 */
export function findDbPaginatedPage(
  input: DbPaginatedPageInput
): Promise<SessionListPage> {
  const { organizationId, where, idleWhere, orderBy, offset, limit } = input;
  return withSessionListSnapshot(async () => {
    const items = await withDb((db) =>
      db.sessionDetail.findMany({
        where,
        select: agentSessionListSelectForOrganization(organizationId),
        orderBy,
        skip: offset,
        take: limit,
      })
    );
    const total = await withDb((db) => db.sessionDetail.count({ where }));
    const idleCount = idleWhere
      ? await withDb((db) => db.sessionDetail.count({ where: idleWhere }))
      : 0;
    return { items, total, idleCount };
  });
}

type DisplayValueSortedPageInput = {
  statusRootRank?: (status: string) => number | null;
  // ISS-8712: see DbPaginatedPageInput — the tag join's SQL scope, not a row
  // filter.
  organizationId: string;
  where: Prisma.SessionDetailWhereInput;
  idleWhere: Prisma.SessionDetailWhereInput | null;
  offset: number;
  limit: number;
  filters: AgentSessionListQuery;
};

/**
 * Duration, Owner and Updated require derived keys; D5 flagged Status requires
 * the canonical artifact-root rank. Prisma's ordinary orderBy cannot express
 * those keys, so the database filters/counts and streams bounded candidates;
 * this path orders and pages them on the requested rule chain. Duration and
 * Owner still track the displayed values, whereas Status intentionally ranks
 * the persisted lifecycle's root. Unknowns stay last in either direction, and
 * the unique artifactId closes every tie.
 *
 * ISS-5131 closes the ISS-4989 cell-vs-comparator divergence for Duration: the
 * comparator and the cell now read the SAME two inputs (status + `endedAt`), so
 * an event-less completed row no longer renders one span and sorts by another.
 * A row the cell renders BLANK — a terminal session with no end instant — keys
 * `null` here and collects with the other blanks in both directions rather than
 * ranking as a 0 among the real minima.
 */
export function findDisplayValueSortedPage(
  input: DisplayValueSortedPageInput
): Promise<SessionListPage> {
  const {
    organizationId,
    where,
    idleWhere,
    offset,
    limit,
    filters,
    statusRootRank,
  } = input;
  // ISS-8335: EVERY rule, in priority order, ending in the unique tiebreaker.
  // The chain is what makes a secondary rule decide the ties the primary leaves
  // open; a single comparator here ordered by rule 1 and settled the rest on
  // `artifactId`, so a toolbar showing "Status, then Owner" produced rows the
  // Owner rule had no part in.
  const compare = buildDisplaySortComparator(
    resolveSessionSortRules(filters),
    statusRootRank
  );
  // ISS-6892: `total`/`idleCount` are the UNCAPPED size of the filtered
  // population. They used to be the length of a 10,000-row candidate
  // materialization, which made an in-memory memory bound the list's public
  // denominator: past the ceiling the list served at most 10,000 as a COMPLETE
  // total while the usage summary aggregated the whole population over the same
  // filter, and no page could reach a session past the ceiling. The ordering now
  // streams the population in keyset chunks
  // (`selectOrderedSessionWindow`), so the count no longer has to describe a
  // truncation — it describes the same `where` the summary aggregates.
  return withSessionListSnapshot(async () => {
    const total = await withDb((db) => db.sessionDetail.count({ where }));
    const idleCount = idleWhere
      ? await withDb((db) => db.sessionDetail.count({ where: idleWhere }))
      : 0;

    let scannedCount = 0;
    const ordered = await selectOrderedSessionWindow<
      DisplaySortCandidate,
      DisplaySortCandidate
    >({
      where,
      offset,
      limit,
      total,
      compare,
      fetchChunk: async (chunkWhere, take) => {
        const rows = await withDb((db) =>
          db.sessionDetail.findMany({
            where: chunkWhere,
            select: displaySortCandidateSelect,
            orderBy: SESSION_CANDIDATE_KEYSET_ORDER_BY,
            take,
          })
        );
        scannedCount += rows.length;
        return rows;
      },
      // The display comparators read the candidate row itself, so a chunk needs
      // no resolution beyond the scan — and, critically, nothing here drops a
      // row, so `total` above stays the population this page is a window into.
      mapChunk: (rows) => Promise.resolve([...rows]),
    });

    const items = await hydrateSessionRows(
      organizationId,
      where,
      ordered.map((candidate) => candidate.artifactId)
    );
    recordRequestListQueryScannedCount(scannedCount);
    return { items, total, idleCount, scannedCount };
  });
}

/**
 * Hydrate the page's rows through the full list select, then re-order them to
 * match the reconciled `pageIds` order (a `WHERE id IN (...)` does not preserve
 * input order).
 */
async function hydrateSessionRows(
  organizationId: string,
  where: Prisma.SessionDetailWhereInput,
  pageIds: readonly string[]
): Promise<AgentSessionListRecord[]> {
  if (pageIds.length === 0) {
    return [];
  }
  const rows = await withDb((db) =>
    db.sessionDetail.findMany({
      // Re-apply the org/facet `where` AND the page id set so a row can never
      // escape the tenant scope through the id filter.
      where: { AND: [where, { artifactId: { in: [...pageIds] } }] },
      select: agentSessionListSelectForOrganization(organizationId),
    })
  );
  const byId = new Map(rows.map((row) => [row.artifactId, row]));
  const ordered: AgentSessionListRecord[] = [];
  for (const id of pageIds) {
    const row = byId.get(id);
    if (row) {
      ordered.push(row);
    }
  }
  return ordered;
}

/**
 * ISS-6892 (codex review): the sorted list paths walk the whole filtered
 * population, which previously ran on the pool with NO transaction timeout at
 * all. Wrapping them in an interactive transaction newly bounds them by Prisma's
 * 5s default, so a large org that used to return slowly could start erroring.
 * Raise the ceiling to the same 30s the sibling usage snapshots use (ISS-4669,
 * `USAGE_SNAPSHOT_TX_TIMEOUT_MS`); the real cost stays far below it.
 */
export const SESSION_LIST_SNAPSHOT_TX_TIMEOUT_MS = 30_000;

/**
 * ISS-6892 (codex review): run a list page's reads against ONE consistent
 * snapshot.
 *
 * `withDb` is NOT transactional — it hands back the pooled client, so each
 * statement takes its own READ COMMITTED snapshot. A session inserted, deleted,
 * or updated after the `count` but while the multi-query keyset scan is still
 * running therefore left `total` and the ranked population describing two
 * different database states, and the envelope contradicted itself: a short page
 * under a `total` still advertising the old count, or a `total` that never
 * contained the rows served beside it.
 *
 * `RepeatableRead` pins one MVCC snapshot for the whole sequence — the count,
 * every keyset chunk, the per-chunk reconciled-cost aggregate, and the final
 * hydrate — so `items`, `total`, and `idleCount` are one observation of one
 * population (`apps/api/AGENTS.md`: "A page and its total read in two statements
 * are not one snapshot"). The inner `withDb` calls join this transaction through
 * the `@repo/database` AsyncLocalStorage, so no client has to be threaded
 * through `selectOrderedSessionWindow`'s `fetchChunk`/`mapChunk` seams.
 *
 * The reads are sequential rather than `Promise.all` because an interactive
 * transaction pins a single connection and queues its statements on it anyway —
 * the same reasoning as `documentListService.findPageWithCustomFields`, which
 * closed this defect class for the Documents list.
 */
function withSessionListSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  return withDb.tx(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: SESSION_LIST_SNAPSHOT_TX_TIMEOUT_MS,
  });
}
