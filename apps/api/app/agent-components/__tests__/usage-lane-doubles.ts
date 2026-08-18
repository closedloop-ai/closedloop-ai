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
 * Discriminated on the TOMBSTONED-FK arm, not the null-FK arm (shafty023 review
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

/** True when a `groupBy` reads only the `(kind, key)` identity spine. */
export function isIdentitySpineRead(by: string[] | undefined): boolean {
  return by !== undefined && by.length === 2;
}

/**
 * ISS-4660: evaluate the shared `usageSearchWhere` OR against a fixture row, so
 * both usage-lane doubles filter the way SQL would.
 *
 * The null-key guard below is a FIXTURE-TYPE guard, not a modelled SQL path (PR
 * #4285 reviewer thadeusb). `AgentComponentSessionUsage.componentKey` is
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
    if (arm.componentKey?.equals !== undefined) {
      return rowKey === arm.componentKey.equals.toLowerCase();
    }
    return true;
  });
}

/**
 * Evaluate the orphan lane's where clause against a fixture row: the optional
 * `?kinds=` facet, the shared `?search=` OR, the identity-cap `componentKey`
 * narrowing, and any `AND`-nested combination of those.
 */
export function matchesOrphanWhere(
  row: { componentKind: string; componentKey: string },
  where: WhereClause | undefined
): boolean {
  if (!where) {
    return true;
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

/**
 * Which half of a lane's NULLABLE recency column one spine read is narrowed to.
 * Mirrors the production `SpinePass`: the unnarrowed read every below-cap org
 * resolves its spine with, plus the two halves an above-cap org re-reads to
 * reproduce `NULLS LAST` (which Prisma cannot express on a `_max` order key).
 */
export const SpinePass = {
  All: "all",
  Stamped: "stamped",
  Unstamped: "unstamped",
} as const;
export type SpinePass = (typeof SpinePass)[keyof typeof SpinePass];

/**
 * Read a spine `where` back into the {@link SpinePass} it expresses, by looking
 * for the `column: null` / `column: { not: null }` predicate the production read
 * nests under `AND`.
 *
 * A window bound on the same column (`{ gte }` / `{ lte }`, which the orphan
 * lane's `?startDate=`/`?endDate=` facets add to the BASE where) is deliberately
 * not a pass predicate — it resolves to `All`, which is what makes the nesting
 * observable as a separate concern from the window.
 */
export function spinePassOf(
  where: WhereClause | undefined,
  column: string
): SpinePass {
  if (!where) {
    return SpinePass.All;
  }
  const and = Array.isArray(where.AND) ? (where.AND as WhereClause[]) : [];
  for (const clause of [where, ...and]) {
    const value = clause[column];
    if (value === null) {
      return SpinePass.Unstamped;
    }
    if (isNotNullFilter(value)) {
      return SpinePass.Stamped;
    }
  }
  return SpinePass.All;
}

/**
 * The `(componentKind, componentKey)` identity spine a capped read resolves:
 * the identities the pass admits, ordered by their aggregated recency, tiebroken
 * deterministically, then capped.
 *
 * Three SQL behaviors are modelled deliberately, because the production code
 * exists to work around them.
 *
 * `WHERE` filters ROWS and runs BEFORE the grouping, so the pass predicate is
 * applied per row here, not to the aggregate. That is what puts a STRADDLING
 * identity — one holding both a stamped and an unstamped row — into BOTH narrowed
 * passes, since each pass owns one of its rows. Filtering on the aggregate
 * instead would hide it from the `Unstamped` pass and make the production
 * dedupe (and the `truncated` flag that depends on it) untestable.
 *
 * `max()` IGNORES nulls, so within a pass an identity's aggregate takes its
 * newest non-null row and is null only when every row it kept was unstamped.
 *
 * Postgres sorts NULLs FIRST under `DESC`, and Prisma cannot express `NULLS
 * LAST` on a `_max` order key — so this orders nulls FIRST, exactly as the
 * database would. Sorting them last here would be the double asserting the fix
 * instead of the SQL, and every ISS-4797 cap test would pass vacuously.
 */
export function identitySpine(
  rows: readonly {
    componentKind: string;
    componentKey: string | null;
    recency: Date | null;
  }[],
  take: number | undefined,
  pass: SpinePass = SpinePass.All
) {
  const byIdentity = new Map<
    string,
    { componentKind: string; componentKey: string | null; recency: Date | null }
  >();
  for (const row of rows) {
    if (!matchesSpinePass(row.recency, pass)) {
      continue;
    }
    const key = `${row.componentKind} ${row.componentKey ?? ""}`;
    const existing = byIdentity.get(key);
    if (!existing || recencyRank(row.recency) > recencyRank(existing.recency)) {
      byIdentity.set(key, row);
    }
  }
  const spine = [...byIdentity.values()].sort(
    (a, b) =>
      compareRecencyDescNullsFirst(a.recency, b.recency) ||
      a.componentKind.localeCompare(b.componentKind) ||
      (a.componentKey ?? "").localeCompare(b.componentKey ?? "")
  );
  return takeRows(spine, take).map((row) => ({
    componentKind: row.componentKind,
    componentKey: row.componentKey,
    _max: { lastSeenAt: row.recency, lastInvokedAt: row.recency },
  }));
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
 * Serve one of the ORPHAN lane's two `agentComponentSessionUsage.groupBy` reads
 * from a flat list of fixture rows: the identity spine (a two-column `by`) or
 * the aggregated groups. Callers route here only after
 * {@link isOrphanUsageRead} has matched, so this never sees the FK lane.
 */
export function resolveOrphanUsageGroupBy(
  rows: readonly OrphanUsageShape[],
  args: { by?: string[]; where?: WhereClause; take?: number } | undefined
) {
  const matching = rows.filter((row) => matchesOrphanWhere(row, args?.where));
  if (isIdentitySpineRead(args?.by)) {
    return identitySpine(
      matching.map((row) => ({
        componentKind: row.componentKind,
        componentKey: row.componentKey,
        recency: row.lastInvokedAt ?? null,
      })),
      args?.take,
      spinePassOf(args?.where, "lastInvokedAt")
    );
  }
  return aggregateOrphanGroups(matching);
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
 * below-cap fixture org: the row read is narrowed to the spine's identities ONLY
 * when the spine came back AT `MAX_ORG_POPULATION_COMPONENTS`, so a
 * non-truncating spine leaves the row read exactly as the facets defined it, no
 * matter what it contained. Suites that exercise truncation must NOT rely on
 * this — they use a double whose spine is derived from the inventory fixtures.
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
 * SQL `min()` over two nullable timestamps: nulls are SKIPPED, not smallest, so
 * a null only survives when every input was null.
 */
function earlierOf(left: Date | null, right: Date | null): Date | null {
  if (left === null || right === null) {
    return left ?? right;
  }
  return left <= right ? left : right;
}

/** SQL `max()` over two nullable timestamps — the {@link earlierOf} twin. */
function laterOf(left: Date | null, right: Date | null): Date | null {
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

/** Whether an identity's aggregated recency belongs to the pass being read. */
function matchesSpinePass(recency: Date | null, pass: SpinePass): boolean {
  if (pass === SpinePass.Stamped) {
    return recency !== null;
  }
  if (pass === SpinePass.Unstamped) {
    return recency === null;
  }
  return true;
}

/**
 * Order two aggregated recencies the way Postgres orders `max(<nullable>) DESC`:
 * most recent first, with NULLs FIRST — NOT last. See {@link identitySpine}.
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
