import { type Prisma, withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";
import type { AgentSessionListQuery } from "../validators";
import {
  type CostReconcileCandidate,
  reconcileAndOrderByCost,
  SESSION_COST_SORT_BY,
  type SessionCostAuthorityMap,
} from "./cost-authority";
import { getReconciledCostsBySessionId } from "./cost-reconciled-reader";
import { buildAgentSessionOrderBy } from "./query-builder";
import { type AgentSessionListRecord, agentSessionListSelect } from "./records";
import {
  compareByDisplayDuration,
  compareByDisplayedStatus,
  compareByOwnerDisplayName,
  compareByRecordUpdatedAt,
  type DisplaySortCandidate,
  displaySortCandidateSelect,
} from "./session-display-sort";

/** The resolved page shared by both the DB-paginated and cost-reconciled paths. */
export type SessionListPage = {
  items: AgentSessionListRecord[];
  total: number;
  idleCount: number;
  /**
   * FEA-4276 (shafty review, thread E): the per-event cost authority the
   * cost-reconciled path ALREADY resolved for the page's rows, so the caller can
   * project each row's displayed cost from the SAME snapshot it filtered,
   * ordered, and paginated on — instead of issuing a SECOND
   * `getReconciledCostsBySessionId` read for display (a sync/reprice landing
   * between the two reads could otherwise show a cost outside the selected
   * bucket/order). The DB-paginated path leaves this `undefined`; cost plays no
   * part in its filter/order there, so it resolves the display cost with its own
   * single read.
   */
  costAuthorityById?: SessionCostAuthorityMap;
};

type DbPaginatedPageInput = {
  where: Prisma.SessionDetailWhereInput;
  idleWhere: Prisma.SessionDetailWhereInput | null;
  orderBy: Prisma.SessionDetailOrderByWithRelationInput[];
  offset: number;
  limit: number;
};

type ResolveSessionListPageInput = {
  costSensitive: boolean;
  displayValueSorted: boolean;
  organizationId: string;
  where: Prisma.SessionDetailWhereInput;
  idleWhere: Prisma.SessionDetailWhereInput | null;
  orderBy: Prisma.SessionDetailOrderByWithRelationInput[];
  offset: number;
  limit: number;
  filters: AgentSessionListQuery;
};

/**
 * Dispatch a Sessions list page to the correct fetch path. Cost and the
 * display-value sorts (duration/user/status) each order by a value the DB column
 * can't be trusted for, so they fetch a bounded candidate set and order/paginate
 * in memory; every other query keeps the cheap DB-paginated path. The paths are
 * mutually exclusive (a single `sortBy`), and cost is checked first because its
 * candidate `where` was already stripped of the rollup cost-bucket clause.
 */
export function resolveSessionListPage(
  input: ResolveSessionListPageInput
): Promise<SessionListPage> {
  const {
    costSensitive,
    displayValueSorted,
    organizationId,
    where,
    idleWhere,
    orderBy,
    offset,
    limit,
    filters,
  } = input;
  if (costSensitive) {
    // A canonical `costBuckets` filter makes the query cost-sensitive even when
    // the sort is Owner/Duration; the cost path filters on the reconciled value
    // AND (when `displayValueSorted`) re-orders the survivors by the display
    // comparator, so the requested sort is honored, not dropped (thread #1/#4).
    return findCostReconciledPage({
      organizationId,
      where,
      idleWhere,
      offset,
      limit,
      filters,
      displayValueSorted,
    });
  }
  if (displayValueSorted) {
    return findDisplayValueSortedPage({
      where,
      idleWhere,
      offset,
      limit,
      filters,
    });
  }
  return findDbPaginatedPage({ where, idleWhere, orderBy, offset, limit });
}

/**
 * The default path: cost plays no part in filtering or ordering, so the database
 * filters, orders, counts, and paginates directly — the reconciled cost only
 * affects each row's DISPLAYED figure, applied later by `toSessionListItem`.
 */
export async function findDbPaginatedPage(
  input: DbPaginatedPageInput
): Promise<SessionListPage> {
  const { where, idleWhere, orderBy, offset, limit } = input;
  const [items, total, idleCount] = await withDb((db) =>
    Promise.all([
      db.sessionDetail.findMany({
        where,
        select: agentSessionListSelect,
        orderBy,
        skip: offset,
        take: limit,
      }),
      db.sessionDetail.count({ where }),
      idleWhere
        ? db.sessionDetail.count({ where: idleWhere })
        : Promise.resolve(0),
    ])
  );
  return { items, total, idleCount };
}

type DisplayValueSortedPageInput = {
  where: Prisma.SessionDetailWhereInput;
  idleWhere: Prisma.SessionDetailWhereInput | null;
  offset: number;
  limit: number;
  filters: AgentSessionListQuery;
};

/**
 * FEA-4297/FEA-4300/FEA-4301: the display-value sort path — Duration, Owner, and
 * Status. Their displayed value is a derivation (Duration = the ISS-5131 wall
 * time, `now - start` while running and `end - start` once terminal, resolved
 * from the session's own status and `sessionEndedAt`; `"First Last"`/email; and
 * the projected status that reads Waiting from `awaitingInputSince`) with no
 * single trustworthy DB column to `ORDER BY`,
 * so — exactly like the cost-reconcile path — the DB filters/counts and
 * materializes a bounded candidate set, then the ordering + pagination happen in
 * memory against the SAME value the row renders (`session-display-sort.ts`). This
 * guarantees the order matches the displayed cell (FEA-4297: monotonic by shown
 * duration; FEA-4300: by shown owner name, case-insensitive; FEA-4301: monotonic
 * by shown status, Waiting sorting as Waiting), keeps blanks last regardless of
 * direction (FEA-4330), and paginates deterministically on the unique
 * `artifactId` tiebreaker (FEA-4329).
 *
 * ISS-5131 closes the ISS-4989 cell-vs-comparator divergence for Duration: the
 * comparator and the cell now read the SAME two inputs (status + `endedAt`), so
 * an event-less completed row no longer renders one span and sorts by another.
 * A row the cell renders BLANK — a terminal session with no end instant — keys
 * `null` here and collects with the other blanks in both directions rather than
 * ranking as a 0 among the real minima.
 */
export async function findDisplayValueSortedPage(
  input: DisplayValueSortedPageInput
): Promise<SessionListPage> {
  const { where, idleWhere, offset, limit, filters } = input;
  const dir = filters.sortDir ?? "desc";
  const [candidates, idleCount] = await withDb((db) =>
    Promise.all([
      db.sessionDetail.findMany({
        where,
        select: displaySortCandidateSelect,
        // Deterministic recency order for the bounded candidate scan; the real
        // order is applied in memory below.
        orderBy: buildAgentSessionOrderBy(filters),
        take: SESSION_COST_RECONCILE_CANDIDATE_CAP,
      }),
      // Unlike the cost-reconciled path, nothing here CONSUMES the idle rows —
      // only their number — so this stays an aggregate rather than a capped
      // materialization of up to `SESSION_COST_RECONCILE_CANDIDATE_CAP` rows.
      // `take` bounds the aggregate itself rather than only its answer: Prisma
      // compiles it to `COUNT(*) FROM (SELECT … LIMIT cap)`, so Postgres stops
      // at the cap instead of scanning a pathological org's whole idle set.
      idleWhere
        ? db.sessionDetail.count({
            where: idleWhere,
            take: SESSION_COST_RECONCILE_CANDIDATE_CAP,
          })
        : Promise.resolve(0),
    ])
  );

  const compare = resolveDisplayComparator(filters, dir);
  const ordered = [...candidates].sort((a, b) => compare(a, b));
  const pageIds = ordered
    .slice(offset, offset + limit)
    .map((candidate) => candidate.artifactId);

  const items = await hydrateSessionRows(where, pageIds);
  // thread #2/#5: `total`/`idleCount` are the SIZE OF THE ORDERED POPULATION —
  // the bounded candidate scan — NOT an uncapped `count(where)`. The in-memory
  // sort can only order what it materialized (`SESSION_COST_RECONCILE_CANDIDATE_CAP`
  // rows), so advertising the uncapped count would expose pages past `offset >=
  // cap` that resolve empty while claiming more rows exist. Counting the capped
  // set keeps `total` honest: for any org under the (generous) cap this is the
  // exact population; only a pathological org is bounded, and it is bounded the
  // same honest-partial way the cost-reconciled path already counts. `idleCount`
  // is capped the same honest-partial way by the `take` on the aggregate above,
  // so the cap lives in the query and has exactly one owner.
  return { items, total: candidates.length, idleCount };
}

/**
 * FEA-4276 (shafty review, thread H): a bounded ceiling on the number of
 * candidate sessions the cost-reconciled path materializes per read.
 *
 * The reconciled path resolves cost in memory (the stored rollup can't be
 * trusted for a cost bucket/sort — that's the bug), so it must first pull the
 * filtered candidate set out of the DB. Without a `take`, a cost query over an
 * org with a very long session history would read the ENTIRE filtered history
 * into memory just to slice one page — `sortBy=cost&limit=1` still doing
 * full-organization work. We cap the candidate read at
 * `SESSION_COST_RECONCILE_CANDIDATE_CAP` sessions, the same honest-partial
 * philosophy as the per-event `RECONCILED_COST_EVENT_SCAN_CAP` (`ROW_NUMBER`)
 * cap: a session beyond the cap is honestly excluded from the reconciled page
 * rather than silently blowing the read up. The cap is generous (10,000
 * sessions) so it only bites pathological orgs; the candidates are fetched in
 * the query's own non-cost order (recency for a cost sort, the requested column
 * order otherwise), so the cap keeps the newest / most-relevant candidates.
 *
 * This is a mitigation, not the durable fix. The durable fix is a maintained
 * per-session reconciled-cost projection column so the DB itself can filter,
 * order, and paginate on the reconciled value with no in-memory candidate scan
 * at all — the same schema + producer change tracked as the FEA-4276 follow-up
 * for `RECONCILED_COST_EVENT_SCAN_CAP`.
 */
export const SESSION_COST_RECONCILE_CANDIDATE_CAP = 10_000;

/**
 * The narrow candidate columns cost reconciliation needs: id + rollup cost
 * fallback + rollup input/output token totals (the completeness reference the
 * per-event token cross-check in `reconcileSessionCost` compares against) +
 * the `sessionUpdatedAt` cost-sort tiebreak, PLUS the {@link DisplaySortCandidate}
 * columns so a cost-bucket filter composed with an Owner/Duration sort can order
 * the survivors by the displayed value in memory (thread #1/#4) without a second
 * read. The extra columns are a few scalars + a narrow user relation — cheap on
 * the same bounded candidate scan.
 */
const costCandidateSelect = {
  ...displaySortCandidateSelect,
  estimatedCost: true,
  inputTokens: true,
  outputTokens: true,
  // ISS-4481: the substantive-work counts the numeric-vs-unknown boundary gates
  // on. `deriveCostAvailability` renders "—" for a no-work session BEFORE it
  // looks at billing mode, so the reconciled cost-bucket / Unknown filter must
  // read the same signals or a no-work subscription session lands in the wrong
  // cohort (`turns`/`toolUseCount` plus the cache-token columns not already
  // selected above for the rollup token total).
  turns: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  toolUseCount: true,
  sessionUpdatedAt: true,
  // `billingMode` serves two cost readers: the cost sort tells a real
  // subscription `$0.00` from a blank `—` row (shafty thread — see
  // `resolveCostSortKey`), and the FEA-4294 cost-bucket filter uses it to
  // distinguish a KNOWN $0 (subscription session, which still displays a `$`
  // figure) from an UNKNOWN cost (renders "—"), excluding the latter from
  // numeric buckets.
  billingMode: true,
} satisfies Prisma.SessionDetailSelect;

type CostReconciledPageInput = {
  organizationId: string;
  where: Prisma.SessionDetailWhereInput;
  idleWhere: Prisma.SessionDetailWhereInput | null;
  offset: number;
  limit: number;
  filters: AgentSessionListQuery;
  /**
   * FEA-4297/FEA-4300 (thread #1/#4): the sort is a display-value column
   * (Owner/Duration) composed with a canonical cost-bucket filter, so after
   * filtering on reconciled cost the survivors are re-ordered by the displayed
   * value instead of preserving DB recency order.
   */
  displayValueSorted: boolean;
};

/**
 * FEA-4276: the cost-sensitive path. `buildCostBucketWhere` /
 * `buildAgentSessionOrderBy` key off the stored `SessionDetail.estimatedCost`
 * rollup, which can diverge from the reconciled captured cost the UI shows, so
 * filtering, ordering, counting, and pagination on the rollup would place a
 * session in the wrong bucket or the wrong page position relative to its
 * displayed figure. Instead:
 *
 *   1. Fetch the FULL filtered candidate set (id + rollup + updatedAt only —
 *      NO cost-bucket predicate here; that's applied on the reconciled value)
 *      in the DB's own non-cost order, so a cost-bucket filter can still compose
 *      with a non-cost sort without disturbing it.
 *   2. Batch the per-event reconciled cost for those candidates and resolve each
 *      session's captured cost via the SAME `reconcileSessionCost` authority.
 *   3. Apply the cost-bucket filter and (when sorting by cost) the cost order on
 *      the RECONCILED value, then paginate the resulting id list.
 *   4. Hydrate only the page's rows through the full list select, preserving the
 *      reconciled order.
 *
 * `total` and `idleCount` are counted AFTER reconciled filtering so no count
 * exceeds its parent population and the idle-reveal label stays accurate. The
 * candidate/idle sets are the SAME org- + date- + facet-scoped `where` the DB
 * path uses; only cost is resolved in memory.
 */
export async function findCostReconciledPage(
  input: CostReconciledPageInput
): Promise<SessionListPage> {
  const {
    organizationId,
    where,
    idleWhere,
    offset,
    limit,
    filters,
    displayValueSorted,
  } = input;
  // `where` / `idleWhere` here are built WITHOUT the rollup-based cost-bucket
  // clause (the caller strips `costBuckets` before `buildWhere` on this path),
  // because that clause predicates on the stale `estimatedCost` column. The
  // cost-bucket filter is instead applied on the RECONCILED value in
  // `reconcileAndOrderByCost` below, so a session is bucketed by the figure it
  // displays. Every other facet (org, date, harness, quality, …) is still in
  // `where`, so the candidate set is the correct filtered population minus only
  // the cost bucket.
  const [candidates, idleCandidates] = await withDb((db) =>
    Promise.all([
      db.sessionDetail.findMany({
        where,
        select: costCandidateSelect,
        orderBy: nonCostOrderBy(filters),
        // Bound the in-memory candidate scan (thread H): a session beyond the
        // cap is honestly excluded from the reconciled page rather than reading
        // the org's entire filtered history to slice one page.
        take: SESSION_COST_RECONCILE_CANDIDATE_CAP,
      }),
      idleWhere
        ? db.sessionDetail.findMany({
            where: idleWhere,
            select: costCandidateSelect,
            // Deterministic recency order so the cap keeps a stable candidate
            // set for `idleCount` rather than an arbitrary page.
            orderBy: [{ sessionUpdatedAt: "desc" }],
            take: SESSION_COST_RECONCILE_CANDIDATE_CAP,
          })
        : Promise.resolve([]),
    ])
  );

  const allIds = [
    ...candidates.map((c) => c.artifactId),
    ...idleCandidates.map((c) => c.artifactId),
  ];
  const costAuthorityById = await getReconciledCostsBySessionId({
    organizationId,
    sessionIds: allIds,
  });

  const sortByCost = filters.sortBy === SESSION_COST_SORT_BY;
  const dir = filters.sortDir ?? "desc";
  // When the sort is Owner/Duration (composed with the cost-bucket filter),
  // re-order the cost-filtered survivors by the DISPLAYED value (thread #1/#4).
  const postFilterCompare = displayValueSorted
    ? resolveDisplayComparator(filters, dir)
    : undefined;
  const reconciled = reconcileAndOrderByCost(
    candidates.map(toCostReconcileCandidate),
    costAuthorityById,
    { costBuckets: filters.costBuckets, sortByCost, dir, postFilterCompare }
  );

  const idleReconciled = reconcileAndOrderByCost(
    idleCandidates.map(toCostReconcileCandidate),
    costAuthorityById,
    { costBuckets: filters.costBuckets, sortByCost: false, dir }
  );

  const total = reconciled.length;
  const idleCount = idleReconciled.length;
  const pageIds = reconciled
    .slice(offset, offset + limit)
    .map((candidate) => candidate.artifactId);

  const items = await hydrateSessionRows(where, pageIds);
  // Hand back the authority we already resolved for these candidates so the
  // caller projects each row's displayed cost from the SAME snapshot it
  // filtered/ordered/paginated on — no second reconciled-cost read (thread E).
  return { items, total, idleCount, costAuthorityById };
}

/**
 * The DB order-by for the candidate fetch. When the query sorts by cost we can't
 * order candidates by the stale rollup (that's the bug) — `reconcileAndOrderByCost`
 * re-orders those on the reconciled value, so a deterministic recency order here
 * only fixes the pre-sort scan. For a NON-cost sort (a cost-bucket filter
 * composed with, say, lastActivity), we must fetch candidates in the requested
 * column order because `reconcileAndOrderByCost` preserves that order and the
 * page is sliced from it — so we reuse the real `buildAgentSessionOrderBy`.
 */
function nonCostOrderBy(
  filters: AgentSessionListQuery
): Prisma.SessionDetailOrderByWithRelationInput[] {
  if (filters.sortBy === SESSION_COST_SORT_BY) {
    return [{ sessionUpdatedAt: "desc" }];
  }
  return buildAgentSessionOrderBy(filters);
}

/**
 * Hydrate the page's rows through the full list select, then re-order them to
 * match the reconciled `pageIds` order (a `WHERE id IN (...)` does not preserve
 * input order).
 */
async function hydrateSessionRows(
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
      select: agentSessionListSelect,
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
 * FEA-4297/FEA-4300: bind the display-value comparator (Duration or Owner) to a
 * direction, so both the display-value path and the cost-bucket-composed display
 * sort (thread #1/#4) order candidates by the exact rendered value. Operates on
 * any row carrying the {@link DisplaySortCandidate} columns.
 */
function resolveDisplayComparator(
  filters: AgentSessionListQuery,
  dir: "asc" | "desc"
): (a: DisplaySortCandidate, b: DisplaySortCandidate) => number {
  const compare = resolveDisplayCompareFn(filters.sortBy);
  return (a, b) => compare(a, b, dir);
}

/**
 * Pick the in-memory comparator for a display-value sort column. Only the
 * display-value columns (`user`, `status`, `duration`) route through
 * {@link resolveDisplayComparator}; `duration` is the default because it is the
 * fallback candidate order for the cost-reconcile path when the sort is not itself
 * a display-value column.
 */
function resolveDisplayCompareFn(
  sortBy: AgentSessionListQuery["sortBy"]
): (
  a: DisplaySortCandidate,
  b: DisplaySortCandidate,
  dir: "asc" | "desc"
) => number {
  if (sortBy === "user") {
    return compareByOwnerDisplayName;
  }
  if (sortBy === "status") {
    return compareByDisplayedStatus;
  }
  if (sortBy === "updated") {
    return compareByRecordUpdatedAt;
  }
  return compareByDisplayDuration;
}

/** The `costCandidateSelect` row shape. */
type CostCandidateRow = Prisma.SessionDetailGetPayload<{
  select: typeof costCandidateSelect;
}>;

/**
 * Narrow a candidate row to the cost-reconciliation input, carrying the rollup
 * cost fallback and the rollup input+output token total (the completeness
 * reference for the per-event token cross-check — FEA-4276 shafty review), PLUS
 * the {@link DisplaySortCandidate} columns so a display-value sort composed with
 * a cost-bucket filter can order the survivors in memory (thread #1/#4).
 */
function toCostReconcileCandidate(
  row: CostCandidateRow
): CostReconcileCandidate & DisplaySortCandidate {
  return {
    artifactId: row.artifactId,
    storedRollup: toNumber(row.estimatedCost),
    rollupTokenTotal: toNumber(row.inputTokens) + toNumber(row.outputTokens),
    sessionUpdatedAt: row.sessionUpdatedAt,
    billingMode: row.billingMode ?? null,
    // ISS-4481: carry the substantive-work counts so the reconciled cost filter
    // gates numeric-vs-unknown on measurable work, exactly as the Cost cell does.
    substantiveCounts: {
      // Token/tool columns are Postgres BigInt (int8) — coerce to JS number
      // through the shared `toNumber` (null → 0), matching the rollup-token
      // coercion above, so `isSubstantiveSession` reads plain numbers.
      turns: toNumber(row.turns),
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      cacheReadTokens: toNumber(row.cacheReadTokens),
      cacheWriteTokens: toNumber(row.cacheWriteTokens),
      toolUseCount: toNumber(row.toolUseCount),
    },
    sessionStartedAt: row.sessionStartedAt,
    // ISS-5131: the Duration comparator's two inputs are the session's status
    // (carried on `artifact` below) and this end instant, so a cost-bucket
    // filter composed with a duration sort has to carry them through this
    // narrowing too — dropping either would order the cost-filtered page by a
    // different rule than the plain path for the same session.
    sessionEndedAt: row.sessionEndedAt,
    awaitingInputSince: row.awaitingInputSince,
    // ISS-5366: the staleness anchor, carried for the same reason as the two
    // fields above — the displayed-status comparator folds a long-silent
    // `active` row to `stale`, so dropping it here would rank the cost-filtered
    // page under a different status vocabulary than the plain path.
    lastActivityAt: row.lastActivityAt,
    // ISS-6005: the record-mutation clock, carried so a cost-bucket filter
    // composed with an `updated` sort orders the survivors by the same MAX rule
    // as the plain path (`compareByRecordUpdatedAt` reads it off `artifact`
    // below too).
    updatedAt: row.updatedAt,
    artifact: row.artifact,
    user: row.user,
  };
}

/**
 * FEA-4293/4294 (thread wongk, table↔summary parity): resolve the SAME
 * reconciled-cost-matched session population the Sessions TABLE paints for a
 * cost-bucket filter, so the usage SUMMARY cards aggregate exactly that set.
 *
 * The table's cost-bucket filter is applied on the RECONCILED captured cost
 * (`findCostReconciledPage` → `reconcileAndOrderByCost`), NOT on the stored
 * `SessionDetail.estimatedCost` rollup the `buildCostBucketWhere` DB predicate
 * keys off. Those diverge for legacy rows (e.g. a row stored at 0 whose priced
 * events total $0.42 displays under "≤ $1" in the table but is dropped by a
 * `estimatedCost > 0` DB predicate). Feeding the summary the SAME predicate as
 * the table would keep them consistent, but the summary aggregates in the DB and
 * can't reconcile per-event cost inline — so instead it resolves the matched id
 * set here (identical candidate scan + reconcile authority as the table) and
 * scopes its aggregation to those ids.
 *
 * `where` MUST already have the rollup cost-bucket clause STRIPPED (the caller
 * omits `costBuckets` before `buildWhere`), exactly like the table path — every
 * other facet stays, so the candidate population is correct minus only cost. The
 * candidate scan is bounded by the same `SESSION_COST_RECONCILE_CANDIDATE_CAP`
 * AND ordered by the same `nonCostOrderBy(filters)` (thread wongk, FEA-4326), so
 * when the cap bites both this path and the table keep the IDENTICAL 10,000-row
 * candidate set instead of two different sets ordered by `sessionUpdatedAt` vs
 * `lastActivityAt` — otherwise a heavy org's export/summary cohort could diverge
 * from the painted table even though every other predicate matched.
 */
export async function resolveCostBucketMatchedSessionIds(input: {
  organizationId: string;
  where: Prisma.SessionDetailWhereInput;
  costBuckets: readonly string[];
  filters: AgentSessionListQuery;
}): Promise<string[]> {
  const { organizationId, where, costBuckets, filters } = input;
  const candidates = await withDb((db) =>
    db.sessionDetail.findMany({
      where,
      select: costCandidateSelect,
      // thread wongk (FEA-4326): order the capped candidate scan with the SAME
      // `nonCostOrderBy(filters)` the table's cost path uses in
      // `findCostReconciledPage`, NOT a bare `sessionUpdatedAt desc`. When the
      // `SESSION_COST_RECONCILE_CANDIDATE_CAP` bites, the surviving 10,000-row
      // set is defined by this ordering; if the summary/export ordered by
      // `sessionUpdatedAt` while the table ordered by `lastActivityAt` (+
      // `sessionStartedAt`), a heavy org would keep DIFFERENT candidate sets and
      // the exported/summarized cohort would diverge from the painted table. For
      // the summary/export path `filters.sortBy` is unset, so this resolves to
      // `SESSION_DEFAULT_ORDER_BY` (`lastActivityAt` + `sessionStartedAt`) — byte
      // for byte the table's default cost-path candidate order. Cost order within
      // the set is still irrelevant (a set has no order); only WHICH ids survive
      // the cap matters, and now both paths pick the same ones.
      orderBy: nonCostOrderBy(filters),
      take: SESSION_COST_RECONCILE_CANDIDATE_CAP,
    })
  );
  const costAuthorityById = await getReconciledCostsBySessionId({
    organizationId,
    sessionIds: candidates.map((candidate) => candidate.artifactId),
  });
  // `sortByCost: false` — a set has no order; reuse the SAME reconcile + bucket
  // + numeric-cost filter the table applies so the population is identical.
  const matched = reconcileAndOrderByCost(
    candidates.map(toCostReconcileCandidate),
    costAuthorityById,
    { costBuckets, sortByCost: false, dir: "desc" }
  );
  return matched.map((candidate) => candidate.artifactId);
}
