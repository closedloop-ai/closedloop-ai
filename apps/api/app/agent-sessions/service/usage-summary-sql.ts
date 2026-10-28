/**
 * ISS-8554 / PLN-1853 Phase 2 — the composer.
 *
 * Assembles an `AgentSessionUsageSummary` from the six TypedSQL statements, the
 * projections, and the folds that already exist. This is the flag's candidate
 * path; nothing routes to it yet.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It reimplements no arithmetic that already
 * has an owner. `foldUsageComparison`, `foldLocPerDollarCoverage`,
 * `resolveLocPerDollarCostBasis` and `locPerDollarFromLines` are all pure and
 * are called, not copied. The point of this change is to remove a second copy of
 * the query layer, and replacing it with a second copy of the arithmetic layer
 * would be a lateral move at best.
 *
 * READ CONCURRENCY. The six statements are mutually independent and are issued
 * together. That is safe here in a way it was not for the code being replaced:
 * this is six queries, not the thirteen the old first stage fanned out, so it
 * does not need `DB_FANOUT_MAX_CONCURRENCY` to keep off the connection pool's
 * ceiling. If that ever stops being true the limiter is the fix, not a serial
 * chain — the old path's four-deep sequential stage is what ISS-7343 was opened
 * to unpick.
 *
 * THE PRIOR WINDOW costs a few more statements, not a second everything. Only
 * the figures `foldUsageComparison` actually compares have a prior period, so
 * {@link readComparison} re-reads exactly the statements those come from — the
 * totals, the cost split and the merged-PR LOC — and nothing else. The facet
 * counts, the LOC-coverage counts and the sync targets are current-window only.
 */

import {
  costBucketRawBounds,
  getSessionCostBucket,
  isExhaustiveCostFilter,
  resolveSessionQuality,
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  SessionPrAssociationId,
  type SessionQuality,
} from "@repo/api/src/agent-session-filters";
import { autonomyTierRange } from "@repo/api/src/session-autonomy-tiers";
import type {
  AgentSessionLastSyncTarget,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { splitPriorityFilter } from "@repo/api/src/types/priority-filter";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import { withDb } from "@repo/database";
import { SESSIONS_USAGE_TYPED_SQL_SHADOW_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { toDeliverySummaryFields } from "./delivery-metrics";
import { LAST_SYNC_TARGET_PAGE_SIZE } from "./last-sync-targets";
import { resolveLocPerDollarCostBasis } from "./loc-per-dollar-basis";
import { foldLocPerDollarCoverage } from "./loc-per-dollar-coverage";
import { toViewerScope } from "./project-resolution";
import { toBasicUser } from "./projections";
import { resolvePersistedStatusFilter } from "./query-builder";
import type { SessionFacetFilterInput, SessionUsageInput } from "./records";
import {
  foldUsageComparison,
  resolvePriorUsageWindow,
  type UsageComparisonWindow,
} from "./usage-comparison";
import { buildUsageOwnerMap } from "./usage-owner-lookup";
import {
  toCostSplitFields,
  toPriorUsageFigures,
} from "./usage-sql-cost-fields";
import {
  pinOwnerArmToDeepLink,
  resolveCreatorUserIds,
  resolveOwnerUserIds,
} from "./usage-sql-person-scope";
import {
  projectByHarness,
  projectByProject,
  projectByRepository,
  projectByUser,
  projectModelFilterOptions,
} from "./usage-sql-projections";
import {
  type QualityMode,
  readCostSplit,
  readFacetCounts,
  readLastSyncTargets,
  readLocCoverageCounts,
  readMergedPrLoc,
  readUsageTotals,
  type UsageSqlFacetCount,
  type UsageSqlFacets,
  type UsageSqlWindow,
} from "./usage-sql-reader";

/**
 * The PostHog key for the shadow-comparison rollout.
 *
 * Named for what it does — run a comparison — rather than for the feature, so
 * nobody reads it as "serve the TypedSQL summary". The cutover, when it comes,
 * gets its own key rather than reusing this one, because the two decisions have
 * different blast radii and must be independently reversible.
 *
 * App-local (not `packages/api`) because only `apps/api` consumes it, matching
 * its two sibling gates.
 */
export const SESSIONS_USAGE_TYPED_SQL_SHADOW_FLAG_KEY =
  SESSIONS_USAGE_TYPED_SQL_SHADOW_SERVER_FLAG.key;

/**
 * The fields this path produces, for the differ's `covered` argument.
 *
 * Stated as data rather than derived from the returned object's keys, for the
 * reason `diffUsageSummary` documents: a field the composer omits because it
 * cannot produce one is indistinguishable, by inspection, from one whose value
 * is genuinely absent. This list is the assertion; the object is the evidence.
 *
 * `byBranch` and `byPr` are absent on purpose -- neither was ever part of this
 * endpoint's summary.
 *
 * `byModel` IS listed, and that is not a contradiction: it is a decided
 * REMOVAL, and a removal has to be in the covered set for `diffUsageSummary` to
 * classify it as expected rather than not-compared. It is the only consumer of
 * `agent_session_token_usage` on this path and renders nowhere -- confirmed
 * 2026-09-08 against every other `byModel` in the repo, the frontend, and the
 * published OpenAPI reference. Listing it makes that decision legible to the
 * differ instead of silence (tamsinb on #6281).
 *
 * `mergedKlocPerDollar` and `mergedLocPerDollarCoverage` are also listed, and
 * are NOT removals -- both are emitted. They are not expected to agree with live
 * either, and conflating those two things was a mistake worth naming: fixing the
 * DEFECTS in each (ISS-9769, ISS-9768) did not make either field match live.
 *
 * `mergedLocPerDollarBasis` (ISS-9848) is listed and is expected to MATCH: both
 * paths emit it through the shared `toDeliverySummaryFields` from their own
 * `resolveLocPerDollarCostBasis` result, and both resolve the same ledger basis.
 * Leaving it out would file the new field as `not-compared` and, per
 * `summarizeDiff`, make a clean shadow run unreachable.
 *
 * The coverage field still diverges by D3 -- live scopes its cohort to PRs
 * merged inside the window and this surface models no merge window -- and the
 * alias is `mergedLocPerDollar / 1000`, so it moves whenever that sanctioned
 * field moves. Both therefore keep an EXPECTED_MOVEMENT entry, rewritten rather
 * than removed (three reviewers on #6853).
 */
export const SQL_COMPOSED_SUMMARY_FIELDS: ReadonlySet<string> = new Set([
  "viewerScope",
  "totalSessions",
  "earliestSessionAt",
  "latestSessionAt",
  "totalInputTokens",
  "totalOutputTokens",
  "totalCacheReadTokens",
  "totalCacheWriteTokens",
  "totalEstimatedCost",
  "subscriptionEstimatedCost",
  "apiEstimatedCost",
  "meteredEstimatedCost",
  "unknownEstimatedCost",
  "mergedPrCount",
  "medianPrSize",
  "mergedLocPerDollar",
  "mergedLocPerDollarBasis",
  "mergedKlocPerDollar",
  "byModel",
  "mergedLocPerDollarCoverage",
  // ISS-11117 (whitlockk, PR #7863). COVERED so the differ judges it, not so the
  // candidate produces it — the Pensero read runs at the route, outside this
  // composition, and will until the cutover. Left uncovered it lands in
  // `notCompared`, and `summarizeDiff` gates `clean` on that list being empty,
  // so every shadow run for a principal inside the rollout would report
  // non-clean forever. Its EXPECTED_MOVEMENT entry sanctions the one shape the
  // difference can take.
  "penseroPointsPerDollar",
  "byUser",
  "byHarness",
  "byRepository",
  "byProject",
  "modelFilterOptions",
  "lastSyncTargets",
  "comparison",
]);

/**
 * The caller's INCLUSIVE `endDate`, as the EXCLUSIVE bound the statements want.
 *
 * The live builder filters `{ lte: new Date(endDate) }` (query-builder.ts:698),
 * so its window is CLOSED — `usage-comparison.ts` confirms it independently,
 * because `startMs - (endMs - startMs + 1)` only computes a whole prior period
 * on `[start, end]`. Every statement guards `sd.last_activity_at < $3`, and
 * `UsageSqlWindow.end` documents itself as the half-open bound they are written
 * against. Nothing converted between the two, so a session whose activity landed
 * exactly ON the boundary tick was in every live figure and none of the SQL ones
 * (marisolashgrove on #6281).
 *
 * `+1` millisecond is exact rather than approximate here: `last_activity_at` is
 * `timestamp(3)`, so a millisecond IS the column's resolution and no value can
 * fall between `end` and `end + 1ms`.
 */
function toExclusiveEnd(inclusiveEnd: string): Date {
  return new Date(new Date(inclusiveEnd).getTime() + 1);
}

/**
 * `startDate` and `endDate` are OPTIONAL ISO strings on the query, so an
 * unbounded read is a real request rather than a caller error. The statements
 * take nullable bounds for exactly that reason — a required bound would have
 * forced a sentinel date, which is a fabricated value pretending to be a filter.
 *
 * `start` needs no conversion: live filters it `gte` and the statements guard
 * `>= $2`, so both are already inclusive.
 */
/**
 * ISS-8554 Phase 3: exported (and its parameter type widened to
 * {@link SessionFacetFilterInput}) so the list-sort reader can build the SAME
 * window the summary statements take, from `AgentSessionListQuery` — every
 * field read here is on the shared base query shape.
 */
export function toWindow(input: SessionFacetFilterInput): UsageSqlWindow {
  return {
    organizationId: input.organizationId,
    start: input.filters.startDate ? new Date(input.filters.startDate) : null,
    end: input.filters.endDate ? toExclusiveEnd(input.filters.endDate) : null,
  };
}

/**
 * Maps the parsed query onto the reader's facet shape.
 *
 * THE SINGULAR SPELLINGS COLLAPSE INTO THEIR PLURALS. `harness` is a
 * back-compat spelling of a one-element `harnesses` selection. Folding here
 * rather than adding parameters keeps the statements from carrying two ways to
 * say one thing — which is how they would come to disagree about which one wins.
 *
 * ISS-12251 splits the person: the `userIds` facet and the singular `userId`
 * deep link are the Owner (the assignee), intersected — see
 * {@link resolveOwnerUserIds}; `viewerScope=self` is whose session it is
 * (Created by) — see {@link resolveCreatorUserIds}.
 */
export function toFacets(input: SessionFacetFilterInput): UsageSqlFacets {
  const { filters } = input;
  const autonomy = resolveAutonomyTierBounds(filters.autonomyTiers ?? []);
  const costBuckets = resolveCostBucketBounds(filters.costBuckets ?? []);
  // ISS-10332 landed this facet on the D13 cohort while ISS-10753 was deleting
  // that cohort, so it needs a predicate of its own or the narrowing is lost.
  // `splitPriorityFilter` is the resolver `buildPriorityFacetWhere` already
  // uses, so the unset token is split once rather than in two places.
  const priorities = splitPriorityFilter(filters.priorities);
  return {
    ownerUserIds: resolveOwnerUserIds(input),
    creatorUserIds: resolveCreatorUserIds(input),
    harnesses: preferPlural(filters.harnesses, filters.harness),
    repositories: filters.repositories ?? [],
    models: filters.models ?? [],
    projectIds: filters.projectIds ?? [],
    projectId: filters.projectId ?? null,
    completedAfter: filters.completedAfter
      ? new Date(filters.completedAfter)
      : null,
    teamId: filters.teamId ?? null,
    changePresence: retainKnownFacetIds(
      filters.changePresence,
      CHANGE_PRESENCE_IDS
    ),
    prAssociation: retainKnownFacetIds(
      filters.prAssociation,
      PR_ASSOCIATION_IDS
    ),
    autonomyLowerBounds: autonomy.lowerBounds,
    autonomyUpperBounds: autonomy.upperBounds,
    autonomyIncludesNull: autonomy.includesNull,
    statuses: resolvePersistedStatusFilter(filters),
    costBucketLowerBounds: costBuckets.lowerBounds,
    costBucketUpperBounds: costBuckets.upperBounds,
    costBucketIncludesUnknown: costBuckets.includesUnknown,
    subscriptionBillingModes: [...SUBSCRIPTION_BILLING_MODES].sort(),
    priorityMembers: priorities.members,
    priorityIncludesUnset: priorities.includesUnset,
    qualityMode: resolveQualityMode(filters.quality),
  };
}

/**
 * ISS-10150: `quality`'s graduated SQL predicate — {@link QualityMode}, the
 * `SessionQuality` vocabulary minus its no-op `"all"` member. No cohort, no
 * cap: the statements apply this directly
 * (`prisma/sql-fragments/session-substantive.sql`), which is what graduating
 * it off the D13 cohort below was for.
 *
 * The absent-default resolution is `resolveSessionQuality`'s job, not
 * restated here — it is the one resolver every other `quality` seam
 * (`applyQualityFilter`, the `findSessions` idle-count guard) already goes
 * through, so this stays a second caller rather than a second copy of the
 * fail-open default.
 */
function resolveQualityMode(quality: SessionQuality | undefined): QualityMode {
  const resolved = resolveSessionQuality(quality);
  // Compared against the literal, not a binding: only a literal narrows
  // `resolved` to exclude "all" in the else branch.
  return resolved === "all" ? null : resolved;
}

/**
 * PLN-1853 D13 is now EMPTY. `quality` graduated at ISS-10150, `costBuckets`
 * at ISS-7176 (live path) / ISS-10753 (this SQL-summary path), and `statuses`
 * at ISS-10629 (live path) / ISS-10753 (here). All three are ordinary SQL
 * predicates spliced into `facet-common.sql` — none is resolved in
 * TypeScript, so there is no cohort left to bound and no candidate cap to
 * pay. `resolveCostBucketBounds` below is the direct replacement for the
 * capped scan this section used to run: it translates a bucket SELECTION
 * into the parallel bound arrays the fragment's `unnest` join reads,
 * exactly as {@link resolveAutonomyTierBounds} already does for autonomy
 * tiers.
 *
 * AN EXHAUSTIVE SELECTION IS NO SELECTION, and that is not an optimisation —
 * it is the only spelling that agrees with `buildCostBucketWhere`, which
 * returns a null clause for one. Emitting the full predicate instead would
 * differ wherever the predicate is not total, and it is not: the numeric arm
 * requires `estimated_cost IS NOT NULL` while the Unknown arm rejects a KNOWN
 * cost, so a subscription row with measurable work and a null
 * `estimated_cost` satisfies neither and the SQL drops a row the live path
 * keeps (tamsinb on #7684).
 *
 * The TOP bucket's absent ceiling is `Number.POSITIVE_INFINITY`, which reaches
 * the statement as SQL NULL — see {@link resolveAutonomyTierBounds} for why,
 * and `facet-common.sql` for the `IS NULL` arm that reads it as unbounded.
 * Without that arm, selecting `$50+` returns zero sessions on every statement.
 */
function resolveCostBucketBounds(buckets: readonly string[]): {
  lowerBounds: number[];
  upperBounds: number[];
  includesUnknown: boolean;
} {
  const lowerBounds: number[] = [];
  const upperBounds: number[] = [];
  let includesUnknown = false;
  if (isExhaustiveCostFilter(buckets)) {
    return { lowerBounds, upperBounds, includesUnknown };
  }
  for (const bucketId of buckets) {
    if (bucketId === SESSION_UNKNOWN_COST_BUCKET_ID) {
      includesUnknown = true;
      continue;
    }
    const bucket = getSessionCostBucket(bucketId);
    if (!bucket) {
      continue;
    }
    const { gte, lt } = costBucketRawBounds(bucket);
    lowerBounds.push(gte);
    upperBounds.push(lt ?? Number.POSITIVE_INFINITY);
  }
  return { lowerBounds, upperBounds, includesUnknown };
}

/**
 * Resolves the autonomy-tier LABELS into the half-open ranges the statements
 * take, paired by position. `autonomyTierRange` stays the vocabulary's single
 * source of truth (`@repo/api/src/session-autonomy-tiers`); only its output
 * crosses into SQL, so a tier added there needs no statement change.
 *
 * AN ABSENT BOUND IS ±INFINITY, NOT A SENTINEL. `autonomyTierRange` leaves
 * `gte` and `lt` individually optional — "high" is `{ gte }` with no ceiling.
 * A magic 101 would be a fabricated value that silently becomes wrong the day
 * the scale changes.
 *
 * ±INFINITY DOES NOT SURVIVE THE TRIP, and the statement, not this function, is
 * where that is handled. Postgres `float8` holds infinity, but serialising a
 * non-finite JS number into a `float8[]` parameter yields SQL NULL, so a bare
 * `sd.autonomy < tier.hi` would be NULL rather than TRUE and the whole "high"
 * tier would select nothing. `facet-common.sql` guards both comparisons with an
 * `IS NULL` arm, which reads a NULL bound as unbounded — the same meaning this
 * function intends, and still correct if the value ever arrives intact
 * (tamsinb on #7684).
 *
 * An UNRECOGNISED tier id contributes nothing, matching `buildAutonomyTierWhere`,
 * which skips a null range. That is why an all-unknown selection returns empty
 * bounds AND `includesNull: false` — the statements read that as "no autonomy
 * filter", exactly as the live builder returns a null clause.
 */
function resolveAutonomyTierBounds(tiers: readonly string[]): {
  lowerBounds: number[];
  upperBounds: number[];
  includesNull: boolean;
} {
  const lowerBounds: number[] = [];
  const upperBounds: number[] = [];
  let includesNull = false;
  for (const tier of tiers) {
    const range = autonomyTierRange(tier);
    if (range === null) {
      continue;
    }
    if (range.isNull === true) {
      includesNull = true;
      continue;
    }
    lowerBounds.push(range.gte ?? Number.NEGATIVE_INFINITY);
    upperBounds.push(range.lt ?? Number.POSITIVE_INFINITY);
  }
  return { lowerBounds, upperBounds, includesNull };
}

/**
 * The PLURAL facet wins outright when non-empty; the singular is the back-compat
 * spelling used only in its absence. This is `else if` in the live builder, NOT
 * a union — unioning them would widen a request that sends both.
 */
function preferPlural(
  plural: readonly string[] | undefined,
  singular: string | undefined
): string[] {
  if (plural && plural.length > 0) {
    return [...plural];
  }
  return singular === undefined ? [] : [singular];
}

/** Project names for the Project facet, keyed by id. */
async function readProjectNames(
  organizationId: string,
  rows: readonly UsageSqlFacetCount[]
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows
        .filter((row) => row.dimension === "project")
        .map((row) => row.value)
        .filter((value): value is string => value !== null)
    ),
  ];
  if (ids.length === 0) {
    return new Map();
  }
  const projects = await withDb((db) =>
    db.project.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true, name: true },
    })
  );
  return new Map(projects.map((project) => [project.id, project.name]));
}

/**
 * The public entry point.
 *
 * ISS-10753 removed the D13 candidate cap, so there is no longer an expected
 * refusal to convert here — every facet is an ordinary SQL predicate, and a
 * throw from `composeUsageSummary` is always a genuine failure (a statement
 * error, an acquisition failure, a projection meeting an unknown shape).
 * `apps/api/AGENTS.md`'s `Result` convention is for expected outcomes; this
 * has none left, so it propagates the plain summary rather than wrapping one.
 *
 * `priorWindowOverride` exists for exactly one caller: the shadow. Left unset,
 * {@link readComparison} resolves its own prior window from `now()`, which is
 * correct once this path is the only one running. While it runs ALONGSIDE
 * `buildUsageSummary`, the two resolve at genuinely different wall-clock
 * moments — `shadowUsageSummary` starts this build only after the live one has
 * already returned — and a rolling window (`endDate` at or after `now`) is
 * elapsed-truncated against whichever `now()` each side happened to read. That
 * skew, not a translation defect, is what produced the
 * `comparison.priorEndDate` divergence observed in production (ISS-10867): the
 * two builds were asked to agree on a window neither of them was given. The
 * shadow now hands over the window the live build already published
 * (`live.comparison.priorStartDate`/`priorEndDate` — see
 * `usage-summary-shadow.ts`), so both sides compare the SAME window instead of
 * two independently-resolved ones.
 *
 * IT DOES NOT FOLLOW that `comparison.deltas.prsShipped` goes quiet, and
 * reading it that way would misread the next report (tamsinb on #7751). That
 * delta divides a merged-PR count by the prior window's, and both operands come
 * from the two populations `EXPECTED_MOVEMENT` already sanctions the TOP-LEVEL
 * `mergedPrCount` for: live's merge-bounded `deliveryMetrics.mergedPrCount`
 * against this path's existence-only `readMergedPrLoc` (D3). The current operand
 * reads the caller's own bounds and never `now()`, so its share of the
 * divergence is clock-INDEPENDENT and this override cannot remove it. Measured
 * over 30d of `sessions_usage_typed_sql_shadow`: of 1933 runs reporting the
 * delta a defect, 241 already had an identical prior window on both sides, and
 * all 1933 reported `mergedPrCount` as `expected` in the same run. The field
 * therefore scores a defect while its own operand is sanctioned — an
 * inconsistency in the differ table rather than in the window, and one this
 * change deliberately does not decide.
 *
 * AN EXPLICIT `null` IS NOT THE SAME AS OMITTING IT. Omitted means "resolve
 * your own window"; `null` means "live resolved one and got nothing", and the
 * candidate must then produce no comparison rather than resolving a second
 * opinion. That state is load-bearing because the absent case is itself
 * clock-dependent: `resolvePriorUsageWindow` returns null while `now` is still
 * before `startDate`, so a range that OPENS in the gap between the two builds
 * would leave live with no comparison and the candidate with one. `comparison`
 * has no `EXPECTED_MOVEMENT` entry (`usage-summary-differ.ts`) and is not
 * descended when absent on one side, so that lands as a whole-field defect —
 * the same clock race this override exists to remove, arriving through the
 * other edge (whitlockk on #7751).
 */
export function buildUsageSummaryFromSql(
  input: SessionUsageInput,
  priorWindowOverride?: UsageComparisonWindow | null
): Promise<AgentSessionUsageSummary> {
  return composeUsageSummary(input, priorWindowOverride);
}

async function composeUsageSummary(
  input: SessionUsageInput,
  priorWindowOverride?: UsageComparisonWindow | null
): Promise<AgentSessionUsageSummary> {
  const window = toWindow(input);
  const facets = toFacets(input);

  // ONE acquisition budget for all six, not six budgets of one.
  //
  // Each reader enters its own `withDb`, so unwrapped they open six INDEPENDENT
  // scopes, each with a fresh ceiling of DB_ACQUISITION_BUDGET_MAX -- budgets
  // that do not compose (davetho on #6281). `withDb` joins an ambient budget
  // rather than opening a second one (acquisition-budget.ts:111), so wrapping
  // here makes all six spend the SAME ceiling.
  //
  // WHAT THIS ACTUALLY BUYS, stated honestly: each reader is one
  // `$queryRawTyped` that acquires, runs and releases, so six unwrapped budgets
  // never admitted more than six connections either. The wrapper lowers this
  // call's ceiling from 6 to 5 (DB_ACQUISITION_BUDGET_MAX is 5), which means one
  // of the six now queues behind the first to release -- roughly one extra
  // serial round trip on a path that is already behind `waitUntil`. It is the
  // discipline that composes, not a large reduction in connections.
  //
  // Applied HERE and not to the other reads in this file (the owner/project
  // lookups below, `readComparison`'s three). Those are smaller groups that
  // cannot reach the ceiling on their own; the same rationale would extend to
  // them and has not been.
  //
  // The await is INSIDE the scope deliberately: a Prisma query is a lazy
  // PrismaPromise, so returning one without awaiting it would leave the scope
  // before any work began and the gate would silently do nothing.
  const [totals, costSplit, facetRows, mergedPr, coverageCounts, syncTargets] =
    await withDb(() =>
      Promise.all([
        readUsageTotals(window, facets),
        readCostSplit(window, facets),
        readFacetCounts(window, facets).then((rows) =>
          pinOwnerArmToDeepLink(rows, input.filters)
        ),
        readMergedPrLoc(window, facets),
        readLocCoverageCounts(window, facets),
        readLastSyncTargets(window.organizationId, LAST_SYNC_TARGET_PAGE_SIZE, {
          // Mirrors buildLastSyncTargetWhere. Without these the freshness card
          // would show every target in the org beside figures scoped to one user.
          userId: input.filters.userId ?? null,
          teamId: input.filters.teamId ?? null,
        }),
      ])
    );

  // Labels the session rows do not carry. Issued after the facet read because
  // they are keyed by ITS results — the alternative is reading every user and
  // project in the org to avoid one dependent round trip, which trades a bounded
  // lookup for an unbounded one.
  const [usersById, projectNamesById] = await Promise.all([
    buildUsageOwnerMap(
      window.organizationId,
      facetRows
        .filter((row) => row.dimension === "owner")
        .map((row) => ({ userId: row.value }))
    ),
    readProjectNames(window.organizationId, facetRows),
  ]);

  const cost = toCostSplitFields(costSplit);
  const basis = resolveLocPerDollarCostBasis({
    totalEstimatedCost: cost.totalEstimatedCost,
    subscriptionEstimatedCost: cost.subscriptionEstimatedCost,
    apiEstimatedCost: cost.apiEstimatedCost,
    meteredEstimatedCost: cost.meteredEstimatedCost ?? 0,
    unknownEstimatedCost: cost.unknownEstimatedCost ?? 0,
  });

  // AC-2 (ISS-9964): the denominator is the canonical total estimated cost
  // (ISS-9956) resolved by `resolveLocPerDollarCostBasis`, never a locally
  // re-summed one.
  //
  // `locPerDollarFromLines` owns the null semantics, and since ISS-9980 (RULED
  // 2026-09-11) they hang off the DENOMINATOR: no cost to divide by, or a
  // non-finite input, yields null. A cohort that merged nothing is a MEASURED
  // zero and divides into a real `0`. The `mergedLoc === null` guard above is
  // the other half — a numerator nobody could resolve, which must not collapse
  // onto that measured zero.
  const mergedLocPerDollar =
    mergedPr.mergedLoc === null
      ? null
      : locPerDollarFromLines(mergedPr.mergedLoc, basis.costUsd);

  const comparison = await readComparison(
    input,
    window,
    facets,
    {
      currentTotals: totals,
      currentCost: cost,
      currentMergedPrCount: mergedPr.mergedPrCount,
    },
    priorWindowOverride
  );

  return {
    viewerScope: toViewerScope(input.filters),
    totalSessions: totals.sessionCount,
    earliestSessionAt: totals.earliestSessionAt,
    latestSessionAt: totals.latestSessionAt,
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheWriteTokens: totals.cacheWriteTokens,
    ...cost,
    // THROUGH THE SHARED EMIT HELPER, not four fields assembled here. It is the
    // same `toDeliverySummaryFields` the live producer uses, so the two cannot
    // drift on the merged-PR set -- which is what its own docstring says it is
    // for -- and the deprecated `mergedKlocPerDollar` alias travels with them.
    //
    // The alias is NOT optional (ISS-9769): a pre-ISS-4667 Desktop still reads
    // it, `loc-per-dollar.ts` records that removing the shim needs human
    // approval, and it is in the published OpenAPI reference. The operator
    // ruling on 2026-09-08 was to keep emitting it. An earlier revision dropped
    // it to avoid naming the retired identifier in new code, which traded a
    // wire-contract break for a clean `no-kloc-per-dollar-metric` count --
    // reusing the helper keeps both, because the identifier stays in the one
    // module already pinned for it.
    ...toDeliverySummaryFields(
      {
        mergedPrCount: mergedPr.mergedPrCount,
        medianPrSize: mergedPr.medianPrSize,
        mergedLocPerDollar,
      },
      basis
    ),
    // OMITTED unless at least one MERGED PR is in scope, which is the field's
    // documented contract: "Present only on a producer that measured it AND only
    // when there is a ratio to gate (at least one merged PR); ABSENT -- never
    // `null` -- otherwise" (packages/api/src/types/agent-session.ts). An absent
    // verdict is not a `complete` one, and the verdict drives `unavailableReason`
    // on the LOC/$ card, so emitting it without merged work captions the card
    // about merged work that is not there.
    //
    // EXISTENCE, NOT A WINDOW. D3 says the window applies to the SESSION's
    // `last_activity_at` and a PR's own `merged_at` bounds nothing -- that is
    // about WINDOWING. "The PR must be merged, but it doesn't matter when"
    // (operator, 2026-09-08), so an existence check is consistent with D3 and
    // `mergedPrCount` is exactly it: `sessionMergedPrLoc.sql` requires
    // `p.merged_at IS NOT NULL` with no bound on when.
    //
    // This is deliberately NOT live's gate either. Live scopes its cohort to PRs
    // merged INSIDE the window, which D3 rejects. The candidate matches the
    // CONTRACT, not live. An earlier revision gated on
    // `coverageCounts.numeratorSessionCount > 0` -- delivery-linked sessions,
    // merge state never consulted -- and registered the difference as decided;
    // it was a defect (ISS-9768).
    ...(mergedPr.mergedPrCount > 0
      ? {
          mergedLocPerDollarCoverage: foldLocPerDollarCoverage(coverageCounts, {
            denominatorSessionCount: totals.sessionCount,
            costBasisCoveredUsd: basis.costUsd,
            costBasisExcludedUsd: basis.excludedUsd,
          }),
        }
      : {}),
    byUser: projectByUser(facetRows, usersById),
    byHarness: projectByHarness(facetRows),
    byRepository: projectByRepository(facetRows),
    byProject: projectByProject(facetRows, projectNamesById),
    modelFilterOptions: projectModelFilterOptions(facetRows),
    lastSyncTargets: syncTargets.map(toLastSyncTargetField),
    ...(comparison ? { comparison } : {}),
  };
}

/**
 * The prior-period comparison, or undefined when the caller did not ask for one
 * or the active range has no period before it.
 *
 * Not a second everything: only the figures `foldUsageComparison` compares have
 * a prior period, so this re-reads the totals, the cost split and the merged-PR
 * LOC, and none of the other statements.
 *
 * `priorWindowOverride` skips re-resolving the window from `now()`, and an
 * explicit `null` skips the comparison entirely — see
 * {@link buildUsageSummaryFromSql} for why the shadow needs both.
 */
async function readComparison(
  input: SessionUsageInput,
  window: UsageSqlWindow,
  facets: UsageSqlFacets,
  current: {
    currentTotals: Awaited<ReturnType<typeof readUsageTotals>>;
    currentCost: ReturnType<typeof toCostSplitFields>;
    currentMergedPrCount: number;
  },
  priorWindowOverride?: UsageComparisonWindow | null
) {
  if (input.filters.comparison !== AgentSessionComparisonMode.Prior) {
    return undefined;
  }
  const priorWindow =
    priorWindowOverride === undefined
      ? resolvePriorUsageWindow(input.filters.startDate, input.filters.endDate)
      : priorWindowOverride;
  if (!priorWindow) {
    return undefined;
  }
  const priorSqlWindow: UsageSqlWindow = {
    organizationId: window.organizationId,
    start: new Date(priorWindow.startDate),
    // Same closed-to-half-open conversion as the current window: the prior
    // period's bounds come from the same comparison arithmetic, which is only
    // whole on a CLOSED interval.
    end: toExclusiveEnd(priorWindow.endDate),
  };
  // THE PRIOR WINDOW TAKES THE SAME FACETS. Reading it unfiltered would compare a
  // filtered current period against an unfiltered baseline and report the
  // difference as a period-over-period change, which is the same "filtered view,
  // unfiltered number" defect the facet tuple exists to close — here it would
  // also invert the sign of the delta on any narrowing filter.
  //
  // ISS-10753: every facet is now a plain SQL predicate with no window
  // dependence, so `facets` itself is reused unchanged — there is no longer a
  // D13 cohort to re-resolve per window.
  const [priorTotals, priorCost, priorMergedPr] = await Promise.all([
    readUsageTotals(priorSqlWindow, facets),
    readCostSplit(priorSqlWindow, facets),
    readMergedPrLoc(priorSqlWindow, facets),
  ]);
  const { currentTotals, currentCost, currentMergedPrCount } = current;
  return foldUsageComparison({
    priorWindow,
    current: {
      totalSessions: currentTotals.sessionCount,
      totalTokens:
        currentTotals.inputTokens +
        currentTotals.outputTokens +
        currentTotals.cacheReadTokens +
        currentTotals.cacheWriteTokens,
      meteredEstimatedCost: currentCost.meteredEstimatedCost ?? 0,
      apiEstimatedCost: currentCost.apiEstimatedCost,
      totalEstimatedCost: currentCost.totalEstimatedCost,
      mergedPrCount: currentMergedPrCount,
    },
    prior: toPriorUsageFigures(priorTotals, priorCost),
    priorMergedPrCount: priorMergedPr.mergedPrCount,
  });
}

/**
 * The freshness card's row shape.
 *
 * Every field here is non-nullable on both sides, which was worth establishing
 * rather than defending against: `compute_targets.user_id`, `machine_name` and
 * `last_seen_at` are all NOT NULL, so the statement inner-joins `users` and
 * TypedSQL infers the columns as non-null. An earlier draft left-joined and then
 * coalesced a missing machine name to `""` and a missing timestamp to the epoch
 * — two fabricated values standing in for rows that cannot exist.
 */
function toLastSyncTargetField(
  target: Awaited<ReturnType<typeof readLastSyncTargets>>[number]
): AgentSessionLastSyncTarget {
  return {
    computeTargetId: target.id,
    machineName: target.machineName,
    isOnline: target.isOnline,
    lastSeenAt: target.lastSeenAt,
    lastAgentSessionSyncAt: target.lastAgentSessionSyncAt,
    lastAgentSessionSyncAttemptAt: target.lastAgentSessionSyncAttemptAt,
    owner: toBasicUser(target.user),
  };
}

/**
 * The change-presence and pull-request ids the LIVE where-builders recognise,
 * read off the canonical const objects rather than restated here.
 */
const CHANGE_PRESENCE_IDS: ReadonlySet<string> = new Set(
  Object.values(SessionChangePresenceId)
);
const PR_ASSOCIATION_IDS: ReadonlySet<string> = new Set(
  Object.values(SessionPrAssociationId)
);

/**
 * Drops facet ids the live builder does not recognise, so both paths answer the
 * same question.
 *
 * `buildChangePresenceWhere`/`buildPrAssociationWhere` skip an unrecognised id
 * and return `null` — NO filter — when nothing recognisable survives, which is
 * the contract `validators.ts` states for these two facets ("Unknown ids are
 * harmless"). The statements spell the same facet as
 * `cardinality($n) = 0 OR (<known arms>)`, so an unknown-only selection is
 * nonempty with no arm that can match and returns NO ROWS. Passing the raw
 * selection through made a `changePresence=future` read compare a populated
 * live page against an empty candidate (whitlockk on #8670).
 */
function retainKnownFacetIds(
  selected: readonly string[] | undefined,
  known: ReadonlySet<string>
): string[] {
  if (!selected) {
    return [];
  }
  return selected.filter((id) => known.has(id));
}
