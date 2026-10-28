/**
 * Shared fake-Prisma helpers for the two ORG POPULATION lanes — the inventory
 * read and the USAGE-ONLY (no live inventory row owns it) usage read.
 *
 * ISS-4797/ISS-4799 moved both lanes from a single facet-scoped `findMany` with
 * a raw-row `take` to a two-pass shape: an identity spine (`groupBy` over
 * `(componentKind, componentKey)`, recency-ordered and capped) followed by a
 * read scoped to the retained identities. Every suite that doubles those reads
 * has to model the same two passes, so the modelling lives here rather than
 * being re-derived in `org-population-fixtures.ts` and the service-level DB
 * double.
 *
 * Not a test file: the vitest include pattern only collects `*.test.ts`.
 */

import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import { vi } from "vitest";

/** A fixture-visible subset of a Prisma `where` clause. */
export type WhereClause = Record<string, unknown>;

/**
 * The `OR` arms `usageSearchWhere` emits: a `contains` match on the usage row's
 * own `componentKey`, plus one exact `(kind, key)` arm per inventory row that
 * matched `search` on its display `name`.
 */
export type UsageSearchOr = readonly {
  componentKind?: string;
  componentKey?: { contains?: string; equals?: string };
  /** ISS-6756: the readmission arm's identity equality, on the persisted fold. */
  componentKeyNormalized?: string;
}[];

/**
 * One ORPHANED usage row — one no live inventory row owns — in the shape the
 * lane's doubles aggregate. Optional fields default the way the collector leaves them
 * when a fixture does not care.
 */
export type OrphanUsageShape = {
  agentSessionId: string;
  componentKind: string;
  componentKey: string;
  invocationCount: number;
  errorCount?: number;
  harness?: string | null;
  firstInvokedAt?: Date | null;
  lastInvokedAt?: Date | null;
  componentVersionHash?: string | null;
  definitionVersionId?: string | null;
};

/**
 * True when a usage read is scoped to the USAGE-ONLY lane, including the
 * `AND`-nested shape an identity-capped read uses to add its `componentKey`
 * narrowing without clobbering the `?search=` facet's `OR`.
 */
export function isOrphanUsageRead(where: WhereClause | undefined): boolean {
  if (!where) {
    return false;
  }
  if ("agentComponentId" in where && where.agentComponentId === null) {
    return true;
  }
  if (isUsageWithoutLiveInventoryOr(where.OR)) {
    return true;
  }
  const and = where.AND;
  return Array.isArray(and) && and.some((clause) => isOrphanUsageRead(clause));
}

/**
 * ISS-6180: the lane-membership predicate `usageWithoutLiveInventoryWhere()`
 * emits, as a suite asserting the lane's `where` shape expects to find it.
 * Exported so production changing that shape fails in ONE place rather than
 * drifting hand-copied expectations across suites.
 */
export const USAGE_WITHOUT_LIVE_INVENTORY_WHERE = {
  OR: [
    { agentComponentId: null },
    { agentComponent: { uninstalledAt: { not: null } } },
  ],
};

/**
 * ISS-6180: the lane-membership `OR` that `usageWithoutLiveInventoryWhere()`
 * emits — "no LIVE inventory row owns this usage", i.e. a null FK or a FK to a
 * tombstoned row. Recognized STRUCTURALLY so the doubles keep routing the lane,
 * and skipped by {@link matchesOrphanWhere} rather than evaluated:
 * {@link OrphanUsageShape} models no FK at all, so the fixture list already IS
 * this lane's population and there is nothing per-row left to decide.
 *
 * Discriminated on the TOMBSTONED-FK arm, not the null-FK arm (davetho review
 * on #5039). The CHILD-usage lane's own predicate
 * (`usageWithoutTombstonedInventoryWhere`) opens with an IDENTICAL
 * `{ agentComponentId: null }` arm — the two lanes deliberately overlap there —
 * so keying on it routed the plugin child-usage read into the orphan fixtures
 * and every plugin rolled up to zero. `uninstalledAt: { not: null }` appears in
 * exactly one of the two.
 */
function isUsageWithoutLiveInventoryOr(or: unknown): boolean {
  return Array.isArray(or) && or.some(isTombstonedFkArm);
}

/** The `{ agentComponent: { uninstalledAt: { not: null } } }` arm, precisely. */
function isTombstonedFkArm(arm: unknown): boolean {
  if (arm === null || typeof arm !== "object") {
    return false;
  }
  const relation = (arm as WhereClause).agentComponent;
  if (relation === null || typeof relation !== "object") {
    return false;
  }
  return isNotNullFilter((relation as WhereClause).uninstalledAt);
}

/**
 * ISS-10469: the FK-LIVENESS term of the used-only partition's OTHER arm —
 * `agentComponent: { uninstalledAt: null }`, "a live inventory row owns this
 * usage". Exported because the inline usage doubles in the detail suites need the
 * same test.
 *
 * A fixture list of {@link OrphanUsageShape} rows models no FK at all, so it IS
 * the no-live-owner population and a read asking for its COMPLEMENT selects none
 * of it. The doubles used to answer that arm with the whole orphan fixture list —
 * a row set the database cannot produce, since the two arms are complements — so
 * a used-only detail folding both arms reported every total twice. Evaluating the
 * term rather than ignoring it is what lets a suite tell the partition from a
 * double-count.
 */
export function requiresLiveInventoryOwner(
  where: WhereClause | undefined
): boolean {
  if (!where) {
    return false;
  }
  const relation = where.agentComponent;
  if (
    relation !== null &&
    typeof relation === "object" &&
    (relation as WhereClause).uninstalledAt === null
  ) {
    return true;
  }
  const and = where.AND;
  return (
    Array.isArray(and) &&
    and.some((clause) => requiresLiveInventoryOwner(clause as WhereClause))
  );
}

/**
 * ISS-10469: serve a usage `findMany` from a flat list of ORPHAN fixture rows,
 * evaluating {@link requiresLiveInventoryOwner} rather than routing past it. The
 * one shape every inline used-only double needs, so they cannot each decide it
 * differently.
 */
export function orphanFixtureFindMany<T>(
  rows: readonly T[],
  where: WhereClause | undefined
): T[] {
  return requiresLiveInventoryOwner(where) ? [] : [...rows];
}

/** True when a `groupBy` reads only the `(kind, key)` identity spine. */
export function isIdentitySpineRead(by: string[] | undefined): boolean {
  return by !== undefined && by.length === 2;
}

/**
 * ISS-4660: evaluate the shared `usageSearchWhere` OR against a fixture row, so
 * both usage-lane doubles filter the way SQL would.
 *
 * The null-key guard below is a FIXTURE-TYPE guard, not a modelled SQL path (PR
 * #4285 reviewer tamsinb). `AgentComponentSessionUsage.componentKey` is
 * `String` — NOT NULL — in `schema.prisma`, so no real grouped row can reach it;
 * it exists only because the FK lane's own `UsageRollup` fixture models the
 * column as nullable (`makeRollup` defaults it to `null` when a fixture does not
 * name an identity explicitly), and dropping the guard would make
 * `.toLowerCase()` throw on such a row rather than filter it. It deliberately
 * does NOT claim to mirror the fold's own-key-absent fallback, which an earlier
 * version of this comment did.
 */
export function matchesUsageSearchOr(
  row: { componentKind: string | null; componentKey: string | null },
  or: UsageSearchOr | undefined
): boolean {
  if (!or) {
    return true;
  }
  if (row.componentKey === null) {
    return true;
  }
  const rowKey = row.componentKey.toLowerCase();
  return or.some((arm) => {
    if (
      arm.componentKind !== undefined &&
      arm.componentKind !== row.componentKind
    ) {
      return false;
    }
    if (arm.componentKey?.contains !== undefined) {
      return rowKey.includes(arm.componentKey.contains.toLowerCase());
    }
    // ISS-6756: the readmission arm now names the PERSISTED fold, so the double
    // compares the row's fold — `normalizeComponentKey`, the same function the
    // trigger mirrors — rather than a bare `toLowerCase`. Kept ahead of the
    // catch-all `true`: an unrecognised arm here would silently readmit every
    // row and turn a search-leak regression green.
    if (arm.componentKeyNormalized !== undefined) {
      return (
        normalizeComponentKey(row.componentKey) === arm.componentKeyNormalized
      );
    }
    if (arm.componentKey?.equals !== undefined) {
      return rowKey === arm.componentKey.equals.toLowerCase();
    }
    return true;
  });
}

/**
 * Evaluate the orphan lane's where clause against a fixture row: the optional
 * `?kinds=` facet, the shared `?search=` OR, the identity-cap `componentKey`
 * narrowing, the `?startDate=`/`?endDate=` window, and any `AND`-nested
 * combination of those.
 */
export function matchesOrphanWhere(
  row: {
    componentKind: string;
    componentKey: string;
    lastInvokedAt?: Date | null;
  },
  where: WhereClause | undefined
): boolean {
  if (!where) {
    return true;
  }
  // ISS-10469: the fixture rows model no FK, so they are exactly the rows the
  // live-owner arm excludes. Evaluated, not skipped — see
  // {@link requiresLiveInventoryOwner}.
  if (requiresLiveInventoryOwner(where)) {
    return false;
  }
  if (!matchesUsageWindow(row.lastInvokedAt ?? null, where.lastInvokedAt)) {
    return false;
  }
  const and = where.AND;
  if (
    Array.isArray(and) &&
    !and.every((clause) => matchesOrphanWhere(row, clause as WhereClause))
  ) {
    return false;
  }
  const kindFilter = where.componentKind as
    | { in?: string[] }
    | string
    | undefined;
  if (typeof kindFilter === "string" && kindFilter !== row.componentKind) {
    return false;
  }
  if (
    typeof kindFilter === "object" &&
    kindFilter?.in &&
    !kindFilter.in.includes(row.componentKind)
  ) {
    return false;
  }
  const keyFilter = where.componentKey as { in?: string[] } | undefined;
  if (keyFilter?.in && !keyFilter.in.includes(row.componentKey)) {
    return false;
  }
  // ISS-6756: the DETAIL lane narrows to one identity with the PERSISTED fold
  // (`usageNameIdentityWhere` → `componentKeyNormalized: { in: [...] }`), not with
  // the raw key. Unhandled, every arm below fell through and the clause read as
  // always-satisfied — a double strictly MORE permissive than the query, which
  // would admit another component's usage into a detail fold and let a
  // scoping regression pass green.
  const foldedKeyFilter = where.componentKeyNormalized as
    | { in?: string[] }
    | undefined;
  if (
    foldedKeyFilter?.in &&
    !foldedKeyFilter.in.includes(normalizeComponentKey(row.componentKey))
  ) {
    return false;
  }
  // A lane-membership `OR` is not a `?search=` facet — see
  // {@link isUsageWithoutLiveInventoryOr}. Feeding it to the search matcher would
  // pass every row vacuously, which reads as "the facet matched".
  if (isUsageWithoutLiveInventoryOr(where.OR)) {
    return true;
  }
  return matchesUsageSearchOr(row, where.OR as UsageSearchOr | undefined);
}

/**
 * Aggregate orphan fixture rows the way the lane's SQL `groupBy` does — summed
 * invocations/errors per (identity, session, harness, version) with min/max
 * invocation times. The point is that the double returns the AGGREGATE shape the
 * production mapper reads, not the raw-row shape it no longer reads.
 */
export function aggregateOrphanGroups(rows: readonly OrphanUsageShape[]) {
  const groups = new Map<
    string,
    {
      componentKind: string;
      componentKey: string;
      agentSessionId: string;
      harness: string | null;
      componentVersionHash: string | null;
      definitionVersionId: string | null;
      _sum: { invocationCount: number | null; errorCount: number | null };
      _min: { firstInvokedAt: Date | null };
      _max: { lastInvokedAt: Date | null };
    }
  >();
  for (const row of rows) {
    const harness = row.harness ?? null;
    const key = [
      row.componentKind,
      row.componentKey,
      row.agentSessionId,
      harness ?? "",
      row.componentVersionHash ?? "",
    ].join("\u0000");
    const existing = groups.get(key);
    if (existing) {
      existing._sum.invocationCount =
        (existing._sum.invocationCount ?? 0) + row.invocationCount;
      existing._sum.errorCount =
        (existing._sum.errorCount ?? 0) + (row.errorCount ?? 0);
      // The timestamps fold too, exactly as SQL's `min()`/`max()` would. Repeat
      // keys are the NORMAL case here, not an edge: the table's natural key
      // carries `gitBranch` and this lane's grouping folds it away, so one
      // component used on two branches in one session arrives as two rows with
      // different timestamps. Keeping only the first row's values would let a
      // future assertion on orphan `firstInvokedAt`/`lastInvokedAt` pass against
      // a real regression.
      existing._min.firstInvokedAt = earlierOf(
        existing._min.firstInvokedAt,
        row.firstInvokedAt ?? null
      );
      existing._max.lastInvokedAt = laterOf(
        existing._max.lastInvokedAt,
        row.lastInvokedAt ?? null
      );
      continue;
    }
    groups.set(key, {
      componentKind: row.componentKind,
      componentKey: row.componentKey,
      agentSessionId: row.agentSessionId,
      harness,
      componentVersionHash: row.componentVersionHash ?? null,
      definitionVersionId: row.definitionVersionId ?? null,
      _sum: {
        invocationCount: row.invocationCount,
        errorCount: row.errorCount ?? 0,
      },
      _min: { firstInvokedAt: row.firstInvokedAt ?? null },
      _max: { lastInvokedAt: row.lastInvokedAt ?? null },
    });
  }
  return [...groups.values()];
}

/** Sort rows most-recent-first with nulls last, matching the reads' `orderBy`. */
export function sortByRecency<T>(
  rows: readonly T[],
  recencyOf: (row: T) => Date | null
): T[] {
  return [...rows].sort(
    (a, b) => recencyRank(recencyOf(b)) - recencyRank(recencyOf(a))
  );
}

/** Sortable rank for a nullable timestamp; nulls sort last under `desc`. */
export function recencyRank(value: Date | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : value.getTime();
}

/** Apply a Prisma `take` when the read declares one. */
export function takeRows<T>(rows: readonly T[], take: number | undefined): T[] {
  return take === undefined ? [...rows] : rows.slice(0, take);
}

/**
 * Serve the ORPHAN lane's aggregated `agentComponentSessionUsage.groupBy` from a
 * flat list of fixture rows. Callers route here only after
 * {@link isOrphanUsageRead} has matched, so this never sees the FK lane.
 *
 * ISS-6891 removed the identity-spine read this used to also serve: it applied
 * the request's facets and only then capped, so the lane resolved a different
 * population depending on which facet asked for it. The aggregate is the whole
 * lane now.
 */
export function resolveOrphanUsageGroupBy(
  rows: readonly OrphanUsageShape[],
  args: { by?: string[]; where?: WhereClause; take?: number } | undefined
) {
  return takeRows(
    orderAggregatedGroups(
      aggregateOrphanGroups(
        rows.filter((row) => matchesOrphanWhere(row, args?.where))
      )
    ),
    args?.take
  );
}

/**
 * The raw-row ceiling ISS-5516 removed, kept as a literal.
 *
 * The constant is gone from PRODUCTION, so there is nothing there to import —
 * and importing one would have made a suite measure the code against itself.
 * Living here instead keeps that property (this module is test-owned) while
 * giving the regression suites sized against it ONE value and one rationale to
 * maintain, so they cannot silently disagree about which ceiling they are
 * policing. A fixture sized past it keeps biting if a ceiling is reintroduced at
 * any value at or below it.
 */
export const REMOVED_ROW_CEILING = 32_000;

/**
 * The DETAIL orphan lane's row read (`fetchDetailOrphanUsage`), which — unlike
 * the list lane — is still a row read: filter, order `lastInvokedAt desc`, then
 * APPLY the `take` it declares. Honoring the cap is the point: a double that
 * ignored it would report every fixture row and no suite could tell a truncated
 * org from an untruncated one, which is the exact distinction the seen-window
 * fallback turns on.
 */
export function detailOrphanRowRead(
  rows: readonly OrphanUsageShape[],
  args?: { where?: WhereClause; take?: number }
) {
  const matching = rows.filter((row) => matchesOrphanWhere(row, args?.where));
  const ordered = sortByRecency(matching, (row) => row.lastInvokedAt ?? null);
  return takeRows(ordered, args?.take).map((row) => ({
    agentSessionId: row.agentSessionId,
    componentKind: row.componentKind,
    componentKey: row.componentKey,
    invocationCount: row.invocationCount,
    errorCount: row.errorCount ?? 0,
    harness: row.harness ?? null,
    firstInvokedAt: row.firstInvokedAt ?? null,
    lastInvokedAt: row.lastInvokedAt ?? null,
    componentVersionHash: row.componentVersionHash ?? null,
    definitionVersionId: row.definitionVersionId ?? null,
    gitBranch: "",
  }));
}

/**
 * `fetchDetailUsageSeenBounds`' UNCAPPED aggregate over the same rows: one arm
 * per lane in the `OR`, `min()`/`max()` skipping nulls through the same
 * {@link earlierOf}/{@link laterOf} the list lane's `groupBy` double folds with,
 * and no `take` to apply. Sharing the fold is what stops the two doubles from
 * modelling Postgres MIN/MAX differently if either is ever corrected.
 */
export function detailSeenBoundsAggregate(
  rows: readonly OrphanUsageShape[],
  args?: { where?: { OR?: WhereClause[] } }
) {
  const lanes = args?.where?.OR ?? [];
  let firstInvokedAt: Date | null = null;
  let lastInvokedAt: Date | null = null;
  for (const row of rows) {
    if (!lanes.some((lane) => matchesOrphanWhere(row, lane))) {
      continue;
    }
    firstInvokedAt = earlierOf(firstInvokedAt, row.firstInvokedAt ?? null);
    lastInvokedAt = laterOf(lastInvokedAt, row.lastInvokedAt ?? null);
  }
  return { _min: { firstInvokedAt }, _max: { lastInvokedAt } };
}

/** The arguments one org-population `groupBy` read was issued with. */
export type LaneGroupByArgs = {
  by?: string[];
  where?: WhereClause;
  take?: number;
  // ISS-4797: both identity-spine reads order before they cap — that ordering is
  // what makes an above-cap org drop a STABLE set of components — so the recorded
  // args carry it and a suite can assert it was passed at all.
  orderBy?: unknown;
};

/**
 * Every ORPHAN-lane `agentComponentSessionUsage.groupBy` call a double recorded,
 * so a suite can assert the lane's query shape from the TEST BODY instead of
 * from inside a mock implementation that may never run (an assertion that never
 * executes is not coverage). Returns the spine read and the aggregate read in
 * call order; the FK-linked lane's calls are filtered out.
 */
export function orphanGroupByCalls(
  usageDelegate: Record<string, unknown>
): LaneGroupByArgs[] {
  const groupBy = usageDelegate.groupBy as
    | { mock?: { calls: unknown[][] } }
    | undefined;
  const calls = groupBy?.mock?.calls ?? [];
  const args = calls.map(([first]) => first as LaneGroupByArgs | undefined);
  return args.filter((entry): entry is LaneGroupByArgs =>
    isOrphanUsageRead(entry?.where)
  );
}

/**
 * ISS-4797: install the default `agentComponent.groupBy` — the identity-spine
 * read `readOrgInventoryRows` issues before its row read — onto a hand-rolled
 * test double that only stubs `findMany`.
 *
 * The default resolves an EMPTY spine, which is the honest answer for every
 * fixture org: a non-truncating spine leaves the row read exactly as the facets
 * defined it, no matter what it contained.
 *
 * ISS-6891 removed the identity cap that made the spine narrow anything, and
 * with it the truncation this default existed to stay clear of — the row read is
 * now the facets' complete population. The stub is kept so a hand-rolled double
 * that only stubs `findMany` still loads, not because a spine read remains to
 * model.
 */
export function ensureInventorySpineDefault(
  inventoryDelegate: Record<string, unknown>
): void {
  if (typeof inventoryDelegate.groupBy !== "function") {
    inventoryDelegate.groupBy = vi.fn().mockResolvedValue([]);
  }
}

/**
 * ISS-4797: the identity-spine `agentComponent.groupBy` call a double recorded,
 * read from the TEST BODY for the same reason {@link orphanGroupByCalls} is.
 *
 * Reading it through a helper rather than reaching into the delegate at the call
 * site is what keeps the assertion honest: `buildServiceDb` installs this
 * `groupBy` at RUNTIME (via {@link ensureInventorySpineDefault}) onto a case that
 * overrode `agentComponent` with only `findMany`, so the built object's inferred
 * type does not carry it and every call site would otherwise need its own cast.
 *
 * The inventory lane issues exactly one spine read per population build, so the
 * first recorded call is the whole story.
 */
export function inventorySpineCall(
  inventoryDelegate: Record<string, unknown>
): LaneGroupByArgs | undefined {
  const groupBy = inventoryDelegate.groupBy as
    | { mock?: { calls: unknown[][] } }
    | undefined;
  const [firstCall] = groupBy?.mock?.calls ?? [];
  return firstCall?.[0] as LaneGroupByArgs | undefined;
}

/**
 * The USAGE-ONLY lane's `agentComponentSessionUsage.findMany` calls a double
 * recorded (the ISS-6180 shape: an `AND` clause carrying an `OR` arm with a null
 * `agentComponentId`), read from the test body rather than at the call site for
 * the same reason {@link orphanGroupByCalls} is.
 */
export function orphanUsageFindManyCalls(findMany: {
  mock: { calls: unknown[][] };
}): unknown[][] {
  return findMany.mock.calls.filter(([args]) =>
    (
      (args as { where?: Record<string, unknown> })?.where?.AND as
        | Record<string, unknown>[]
        | undefined
    )?.some((clause) =>
      (clause.OR as Record<string, unknown>[] | undefined)?.some(
        (arm) => arm.agentComponentId === null
      )
    )
  );
}

/**
 * ISS-6891: the ORG-WIDE `agentComponent.findMany` calls a double recorded — the
 * unfaceted `readOrgInventoryIds` scan, told apart from a DETAIL read of the same
 * delegate by the absence of a `componentKind` predicate (a detail read always
 * names the one kind it answers for).
 *
 * Lives here beside {@link inventorySpineCall} for the same reason: the org-wide
 * read used to have its own delegate (the identity spine) and so was its own
 * marker for which snapshot resolved it. The spine is gone, so the PREDICATE is
 * the marker now, and deriving it once keeps two suites from disagreeing about
 * which call was the org-wide one.
 */
export function orgWideInventoryReads(
  inventoryDelegate: { mock?: { calls: unknown[][] } } | undefined
): unknown[] {
  return (inventoryDelegate?.mock?.calls ?? []).filter(
    ([args]) =>
      (args as { where?: Record<string, unknown> } | undefined)?.where
        ?.componentKind === undefined
  );
}

/**
 * SQL `min()` over two nullable timestamps: nulls are SKIPPED, not smallest, so
 * a null only survives when every input was null.
 */
export function earlierOf(left: Date | null, right: Date | null): Date | null {
  if (left === null || right === null) {
    return left ?? right;
  }
  return left <= right ? left : right;
}

/** SQL `max()` over two nullable timestamps — the {@link earlierOf} twin. */
export function laterOf(left: Date | null, right: Date | null): Date | null {
  if (left === null || right === null) {
    return left ?? right;
  }
  return left >= right ? left : right;
}

/** True for the `{ not: null }` filter a `Stamped` spine pass narrows with. */
function isNotNullFilter(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "not" in value &&
    (value as { not: unknown }).not === null
  );
}

/**
 * Order two aggregated recencies the way Postgres orders `max(<nullable>) DESC`:
 * most recent first, with NULLs FIRST — NOT last.
 */
function compareRecencyDescNullsFirst(a: Date | null, b: Date | null): number {
  if (a === null) {
    return b === null ? 0 : -1;
  }
  if (b === null) {
    return 1;
  }
  return b.getTime() - a.getTime();
}

/**
 * Evaluate the `?startDate=`/`?endDate=` window `usageWindowWhere` emits against
 * a fixture row's `lastInvokedAt`.
 *
 * Modelled honestly rather than ignored: without it every windowed read matches
 * every fixture row, so a suite asserting that narrowing a window cannot GROW a
 * count would pass against a read that truncates — the exact false-green the
 * window symptoms of ISS-5516 needed ruling out. A row with no `lastInvokedAt`
 * is outside any bounded window, matching SQL's NULL comparison.
 */
function matchesUsageWindow(
  lastInvokedAt: Date | null,
  bound: unknown
): boolean {
  if (bound === undefined || bound === null || typeof bound !== "object") {
    return true;
  }
  const { gte, lte } = bound as { gte?: Date; lte?: Date };
  if (gte === undefined && lte === undefined) {
    return true;
  }
  if (lastInvokedAt === null) {
    return false;
  }
  if (gte !== undefined && lastInvokedAt < gte) {
    return false;
  }
  return !(lte !== undefined && lastInvokedAt > lte);
}

/**
 * Order aggregated orphan groups the way the lane's `groupBy` asks Postgres to:
 * `max(lastInvokedAt) DESC` (NULLs first, as Postgres sorts them) then
 * `(componentKind, componentKey, agentSessionId)` ascending.
 *
 * Exists so {@link resolveOrphanUsageGroupBy} can apply a `take` to the AGGREGATE
 * read at all. It could not before: the double honored `take` on the identity
 * spine and silently ignored it here, so the raw-row ceiling production applied to
 * this read was invisible to every suite that doubled it — including the
 * facet-invariant suites written specifically to catch a facet-dependent
 * truncation. That is why ISS-5516 reached production behind green tests, and why
 * a suite seeded above the ceiling still needs this to bite.
 */
function orderAggregatedGroups<
  T extends {
    componentKind: string;
    componentKey: string;
    agentSessionId: string;
    _max: { lastInvokedAt: Date | null };
  },
>(groups: T[]): T[] {
  return [...groups].sort((a, b) => {
    const byRecency = compareRecencyDescNullsFirst(
      a._max.lastInvokedAt,
      b._max.lastInvokedAt
    );
    if (byRecency !== 0) {
      return byRecency;
    }
    if (a.componentKind !== b.componentKind) {
      return a.componentKind < b.componentKind ? -1 : 1;
    }
    if (a.componentKey !== b.componentKey) {
      return a.componentKey < b.componentKey ? -1 : 1;
    }
    if (a.agentSessionId === b.agentSessionId) {
      return 0;
    }
    return a.agentSessionId < b.agentSessionId ? -1 : 1;
  });
}
