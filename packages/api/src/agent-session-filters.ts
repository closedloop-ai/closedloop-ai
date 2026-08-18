/**
 * Canonical, runtime-agnostic filter contracts for the Agent Sessions list —
 * the single source of truth shared by every surface that filters sessions:
 *   • the shared Sessions filter menu (@repo/app/agents/lib/session-filter-adapter),
 *   • the cloud query builder (apps/api/app/agent-sessions/service.ts), and
 *   • the desktop local source (apps/desktop/src/main/shared-agent-sessions-api.ts).
 *
 * Keeping the cost-bucket bounds and the quality/change/PR predicates here (pure
 * data + pure matchers, no React/Prisma) guarantees the web cloud path and the
 * desktop local path classify a session identically — the Repository/Status
 * facets set the precedent that a filter's meaning lives in one place, not per
 * surface. The autonomy-tier half of that contract lives beside this file in
 * `./session-autonomy-tiers.ts` (FEA-3781), on the same terms.
 *
 * Harness and model need no contract here: their options are data-derived from
 * the usage summary (byHarness/byModel) and the filter is a plain membership
 * test on the session's `harness`/`model` value.
 */

import { isSubscriptionBillingMode } from "./types/billing-mode.ts";
import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  SESSION_STATUS,
} from "./types/session-status.ts";

export type SessionCostBucketId =
  | "under_1"
  | "from_1_to_10"
  | "from_10_to_50"
  | "from_50";

/**
 * A cost threshold bucket (USD), compared on the DISPLAYED (2dp-rounded) value.
 * `maxCost` is the INCLUSIVE upper bound: a session whose displayed cost is
 * exactly `$maxCost.00` falls into THIS bucket, not the next one up (FEA-4293,
 * Mike's decision). `minCost` is the exclusive lower bound for every bucket
 * except the first, whose `minCost` of 0 is inclusive so a $0 known cost still
 * buckets. A null `maxCost` means no upper bound. Adjacent buckets therefore
 * partition the displayed 2dp grid with no gap and no overlap: `(minCost,
 * maxCost]`, with `[0, maxCost]` for the first. Selecting several buckets ORs
 * them, so the coarse ranges compose into the "high-cost sessions" slice users
 * need.
 *
 * The first bucket is "≤ $1" (inclusive), so a row the Cost cell renders as
 * exactly `$1.00` is IN it — the displayed boundary and the bucket boundary are
 * the same value (FEA-4293). The label reads "≤ $1" to match.
 */
export type SessionCostBucket = {
  id: SessionCostBucketId;
  label: string;
  minCost: number;
  maxCost: number | null;
};

export const SESSION_COST_BUCKETS: readonly SessionCostBucket[] = [
  { id: "under_1", label: "≤ $1", minCost: 0, maxCost: 1 },
  { id: "from_1_to_10", label: "$1 to $10", minCost: 1, maxCost: 10 },
  { id: "from_10_to_50", label: "$10 to $50", minCost: 10, maxCost: 50 },
  { id: "from_50", label: "$50+", minCost: 50, maxCost: null },
];

const SESSION_COST_BUCKET_BY_ID = new Map<string, SessionCostBucket>(
  SESSION_COST_BUCKETS.map((bucket) => [bucket.id, bucket])
);

/** Look up a cost bucket by id (undefined for unknown ids). */
export function getSessionCostBucket(
  id: string
): SessionCostBucket | undefined {
  return SESSION_COST_BUCKET_BY_ID.get(id);
}

/**
 * The number of decimal places the Sessions Cost cell displays. The cell renders
 * a currency figure at fixed 2dp (`formatCost` →
 * `toLocaleString(..., { maximumFractionDigits: 2 })`), so a raw sub-dollar cost
 * like `0.996` shows as `$1.00`. The cost-bucket filter must bucket on THAT same
 * displayed value, not the raw column, so the "≤ $1" cohort's boundary matches
 * the displayed figure — a raw `0.996` that shows `$1.00` is IN "≤ $1" (FEA-4293,
 * inclusive boundary), and a raw `1.006` that shows `$1.01` is out.
 */
const DISPLAYED_COST_FRACTION_DIGITS = 2;

/**
 * The 2dp currency formatter the Sessions Cost cell renders through
 * (`formatCost` → `toLocaleString("en-US", { …FractionDigits: 2 })`). Deriving
 * the rounded value from THIS formatter — not from `Math.round(cost * 100)` — is
 * what makes {@link roundDisplayedCost} agree with the display at half-cent
 * boundaries: `Intl.NumberFormat` rounds the true decimal (half-away-from-zero /
 * `halfExpand`), whereas `cost * 100` first incurs binary-float error, so e.g.
 * `9.995 * 100 === 999.4999999999999` rounds DOWN to `9.99` while the cell shows
 * `$10.00` (FEA-4294 codex P2). `useGrouping: false` keeps the output a bare
 * `Number(...)`-parseable numeral (no thousands separators).
 */
const DISPLAYED_COST_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: DISPLAYED_COST_FRACTION_DIGITS,
  maximumFractionDigits: DISPLAYED_COST_FRACTION_DIGITS,
  useGrouping: false,
});

/**
 * FEA-4293: round a raw estimated cost to the SAME 2dp the Sessions Cost cell
 * displays, so the cost-bucket boundary agrees with the rendered figure. A row
 * whose raw cost rounds to `$1.00` IS in "≤ $1" (it displays `$1.00`, the
 * inclusive top of the first bucket); a row that rounds to `$1.01` is not.
 * Rounds through the display formatter itself
 * (half away from zero on the true decimal — costs are non-negative, so half-up),
 * so it matches the currency display exactly at the half-cent boundary this
 * reconciles (`0.995 → 1.00`, `9.995 → 10.00`) instead of drifting on binary
 * float error (FEA-4294). Kept in the filter SSOT so the cloud reconciled path
 * and the desktop matcher bucket on the identical displayed value.
 */
export function roundDisplayedCost(cost: number): number {
  return Number(DISPLAYED_COST_FORMATTER.format(cost));
}

/**
 * Half of the displayed-cost unit (0.005 at 2dp) — the largest amount a raw cost
 * can sit ABOVE a whole-cent threshold and still round DOWN to it, and the amount
 * it can sit BELOW and still round UP. `roundDisplayedCost(x) >= t` iff
 * `x >= t - HALF_DISPLAYED_COST_UNIT`, so a SQL `gte`/`lt` predicate on the RAW
 * `estimatedCost` column reproduces the rounded-bucket boundary by shifting each
 * bound down by this amount (the cloud DB path can't round inside Prisma).
 */
const HALF_DISPLAYED_COST_UNIT = 0.5 / 10 ** DISPLAYED_COST_FRACTION_DIGITS;

/**
 * The raw-column bounds a SQL predicate must use so that `estimatedCost >= gte`
 * (and, when finite, `< lt`) selects exactly the rows whose DISPLAYED cost falls
 * in this bucket — `(minCost, maxCost]` displayed, with `[0, maxCost]` for the
 * first bucket (FEA-4293, Mike's `≤ $1` decision). The bucket's upper bound is
 * INCLUSIVE of the displayed value, so a raw value that displays exactly
 * `$maxCost.00` must be IN this bucket, and a raw value that displays exactly
 * `$minCost.00` must be OUT of it (it belongs to the bucket below).
 *
 * Translated to the raw column: a raw value within `HALF_DISPLAYED_COST_UNIT`
 * below a cent boundary rounds UP to it, so
 *   - the inclusive upper `displayed <= maxCost` is `raw < maxCost + HALF` (a
 *     raw `1.004` displays `$1.00` and is in; a raw `1.005` displays `$1.01` and
 *     is out), and
 *   - the exclusive lower `displayed > minCost` is `raw >= minCost + HALF` (a raw
 *     `1.0` displays `$1.00` and is OUT of `from_1_to_10`), except the first
 *     bucket's inclusive `displayed >= 0` lower stays `raw >= -HALF`.
 * So `under_1` ([0,1] displayed) becomes raw `[-0.005, 1.005)`: a raw `1.0`
 * (displays `$1.00`) is INCLUDED and a raw `1.005` (displays `$1.01`) excluded.
 * `lt` is null for an open-ended bucket. The cloud reconciled path and the
 * desktop matcher round in memory via {@link matchesCostBucket} instead; this is
 * the DB twin that keeps them aligned.
 */
export function costBucketRawBounds(bucket: SessionCostBucket): {
  gte: number;
  lt: number | null;
} {
  return {
    // The first bucket's lower bound (minCost 0) is inclusive of $0.00; every
    // other bucket's lower bound is exclusive (its boundary $minCost.00 belongs
    // to the bucket below), so shift it UP by half a cent.
    gte:
      bucket.minCost === 0
        ? -HALF_DISPLAYED_COST_UNIT
        : bucket.minCost + HALF_DISPLAYED_COST_UNIT,
    // The upper bound is inclusive of $maxCost.00, so shift it UP by half a cent
    // (a raw value up to just under maxCost+0.005 displays $maxCost.00).
    lt:
      bucket.maxCost === null
        ? null
        : bucket.maxCost + HALF_DISPLAYED_COST_UNIT,
  };
}

/**
 * True when an estimated cost (USD) falls inside the requested bucket, compared
 * on the DISPLAYED (2dp-rounded) value so the filter and the Cost cell agree
 * (FEA-4293). The bucket's upper bound is INCLUSIVE and (except the first
 * bucket) its lower bound is EXCLUSIVE — so a row displayed as exactly `$1.00`
 * is in `under_1` ("≤ $1"), not `from_1_to_10` (Mike's decision). Callers that
 * hold a raw column value pass it directly; the rounding happens here so every
 * surface reconciles identically.
 *
 * NOTE: this is a purely numeric predicate — it says nothing about whether the
 * cost is KNOWN. A session whose cost is unknown (renders "—") has no numeric
 * cost and must be excluded BEFORE this is consulted (FEA-4294); see
 * {@link sessionCostIsNumeric}. Do not feed a placeholder `0` for an unknown cost
 * to this function, or it will wrongly satisfy the "≤ $1" bucket.
 */
export function matchesCostBucket(cost: number, bucketId: string): boolean {
  const bucket = SESSION_COST_BUCKET_BY_ID.get(bucketId);
  if (!bucket) {
    return false;
  }
  const displayed = roundDisplayedCost(cost);
  // Lower bound: inclusive only for the first bucket (minCost 0); exclusive
  // otherwise so a boundary value $minCost.00 belongs to the bucket below.
  const aboveLower =
    bucket.minCost === 0
      ? displayed >= bucket.minCost
      : displayed > bucket.minCost;
  // Upper bound: inclusive so $maxCost.00 is in THIS bucket (FEA-4293).
  const belowUpper = bucket.maxCost === null || displayed <= bucket.maxCost;
  return aboveLower && belowUpper;
}

/**
 * The minimal cost signals every Sessions surface reads to decide whether a
 * session has a KNOWN numeric cost versus an unknown one that renders "—". Kept
 * minimal so the same shape is satisfied by the cloud `SessionDetail` row, the
 * desktop summed session, and the shared list item.
 *
 * ISS-4481: the signal set now carries the OPTIONAL substantive-work counts
 * (turns/tokens/tool-uses) because the display authority `deriveCostAvailability`
 * gates on measurable work BEFORE billing mode — a no-work subscription session
 * renders "—", not "$0.00" (ISS-4418). The numeric-vs-unknown predicate must gate
 * the same way, or the filter and the cell disagree for that row. The counts
 * extend {@link SessionSubstantiveCounts} so a caller passes the same shape it
 * already builds for the Idle badge. They are optional for version-skew: a caller
 * that omits them degrades to the cost-only boundary (no work signal contributes
 * "unknown"), never a crash.
 */
export type SessionCostSignals = SessionSubstantiveCounts & {
  estimatedCost: number;
  billingMode?: string | null;
};

/**
 * ISS-4418 / ISS-4481: did the session do measurable work? The numeric-vs-unknown
 * boundary and the display authority `deriveCostAvailability` share this gate: a
 * session that never ran (no turns, no tokens, no tool uses) renders "—" for
 * EVERY billing mode, so a positive priced cost OR any substantive signal is
 * required before a subscription $0 or a priced figure counts as a `$` value.
 * Mirrors `sessionDidMeasurableWork` in `@repo/app/agents/lib/cost-availability`
 * (both delegate to the `isSubstantiveSession` SSOT), so Cost display and Cost
 * filter can never disagree on the empty-session boundary.
 */
function sessionCostReflectsWork(signals: SessionCostSignals): boolean {
  if (signals.estimatedCost > 0) {
    return true;
  }
  return isSubstantiveSession(signals);
}

/**
 * FEA-4294 / ISS-4481: whether a session's cost is a KNOWN numeric value (the
 * Cost cell renders a `$` figure) versus unknown (the cell renders "—"). Only a
 * numeric cost may satisfy a numeric cost bucket ("≤ $1", "$1 to $10", …) — a
 * null/blank cost is NOT numeric and must never satisfy a `<`/`>` predicate,
 * exactly as a null timestamp never satisfies a date-window bound.
 *
 * The rule mirrors the display authority `deriveCostAvailability`
 * (`@repo/app/agents/lib/cost-availability`), which the Cost cell uses, INCLUDING
 * its ordering: it gates on measurable work FIRST (ISS-4418), then billing mode.
 * So a cost is known when the session did measurable work (a priced cost, OR any
 * substantive turn/token/tool signal) AND (it was priced `estimatedCost > 0` OR
 * it is billed through a subscription — which still shows a `$` figure at $0). A
 * no-work subscription session is UNKNOWN ("—"), not a fabricated "$0.00"; a
 * worked session with `estimatedCost <= 0` and no subscription is UNKNOWN ("No
 * pricing data for this model"). This SSOT is the one place the numeric-vs-unknown
 * boundary lives so `cost-availability` (display), the cloud query, and the
 * desktop matcher can never drift.
 */
export function sessionCostIsNumeric(signals: SessionCostSignals): boolean {
  if (!sessionCostReflectsWork(signals)) {
    return false;
  }
  if (isSubscriptionBillingMode(signals.billingMode)) {
    return true;
  }
  return signals.estimatedCost > 0;
}

/**
 * ISS-4481: the id of the selectable "Unknown" (missing-cost) cost-filter option.
 * DISTINCT from the numeric {@link SessionCostBucketId}s — it is NOT a range on
 * the cost value; it is the COMPLEMENT of {@link sessionCostIsNumeric}: exactly
 * the rows the Cost cell renders as "—" (unknown / not-computed cost), and only
 * those (never a genuine priced $0.00, which is a subscription session that still
 * shows a `$` figure). Kept off the numeric-bucket vocabulary so `matchesCostBucket`
 * / `costBucketRawBounds` / `getSessionCostBucket` — which only reason about
 * numeric ranges — never see it; the unknown option is matched by
 * {@link matchesUnknownCost} instead.
 */
export const SESSION_UNKNOWN_COST_BUCKET_ID = "unknown" as const;
export type SessionUnknownCostBucketId = typeof SESSION_UNKNOWN_COST_BUCKET_ID;

/**
 * ISS-4481: the full selectable Cost-filter vocabulary — a numeric bucket id OR
 * the Unknown/missing-cost id. This is the option set the Cost facet renders, and
 * it equals the displayed cost states (a `$` figure lands in one numeric bucket;
 * a "—" row is Unknown), so no rendered state is unselectable.
 */
export type SessionCostFilterId =
  | SessionCostBucketId
  | SessionUnknownCostBucketId;

/**
 * ISS-4481: whether a session's cost is UNKNOWN — the Cost cell renders "—"
 * rather than a `$` figure. This is exactly the complement of
 * {@link sessionCostIsNumeric}, so the "Unknown" filter option and the "—" render
 * share ONE definition: a NON-subscription session with a non-positive cost. A
 * subscription session (which shows a `$` figure even at $0.00) and any priced
 * session are numeric, never unknown. Feeding this the RECONCILED cost (the value
 * the cell actually displays), like the numeric buckets, keeps the filter aligned
 * with the display for legacy rows whose stored rollup diverges from it.
 */
export function matchesUnknownCost(signals: SessionCostSignals): boolean {
  return !sessionCostIsNumeric(signals);
}

/**
 * ISS-4481: does the selected cost-filter set include the Unknown/missing-cost
 * option? Kept here (not re-derived per surface) so the cloud query builder, the
 * cloud reconciled path, and the desktop matcher agree on when "Unknown" is
 * active. A raw filter array may also carry numeric bucket ids and junk; those are
 * ignored here — {@link normalizeCostBucketIds} handles the numeric side.
 */
export function costFilterIncludesUnknown(
  costFilters: readonly string[] | undefined
): boolean {
  return costFilters?.includes(SESSION_UNKNOWN_COST_BUCKET_ID) ?? false;
}

export type SessionCostFilterOption = {
  id: SessionCostFilterId;
  label: string;
};

/**
 * ISS-4481: the fixed Cost facet option set — the numeric buckets plus the
 * selectable Unknown/missing-cost option. The UI renders THIS (not
 * {@link SESSION_COST_BUCKETS} alone) so the option set equals the displayed cost
 * states and no rendered state ("—") is left unselectable. Unknown sits last,
 * after the ascending numeric ranges.
 */
export const SESSION_COST_FILTER_OPTIONS: readonly SessionCostFilterOption[] = [
  ...SESSION_COST_BUCKETS.map(
    (bucket): SessionCostFilterOption => ({
      id: bucket.id,
      label: bucket.label,
    })
  ),
  { id: SESSION_UNKNOWN_COST_BUCKET_ID, label: "Unknown" },
];

/** The full set of selectable Cost-filter ids (every numeric bucket + Unknown). */
const SESSION_COST_FILTER_ID_SET: ReadonlySet<string> = new Set(
  SESSION_COST_FILTER_OPTIONS.map((option) => option.id)
);

/**
 * ISS-4481 (shafty thread): is the selected Cost-filter set EXHAUSTIVE — every
 * displayed cost state (all numeric buckets AND Unknown) selected? An exhaustive
 * selection covers every row, so it is a no-op filter and must be normalized to
 * "no cost filter" BEFORE either surface chooses its bounded reconciled path.
 * Otherwise the cost-sensitive branch truncates the candidate scan (10,000 cloud
 * / 5,000 desktop) and silently drops older sessions for a selection that
 * excludes nothing. Junk/duplicate ids are ignored; the set is exhaustive iff
 * every canonical option id is present at least once.
 */
export function isExhaustiveCostFilter(
  costFilters: readonly string[] | undefined
): boolean {
  if (!costFilters || costFilters.length < SESSION_COST_FILTER_ID_SET.size) {
    return false;
  }
  const selected = new Set(costFilters);
  for (const id of SESSION_COST_FILTER_ID_SET) {
    if (!selected.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * The scalar diff-count columns the Sessions surface reads to decide whether a
 * session produced changes. Kept minimal so the same shape is satisfied by the
 * cloud `SessionDetail` row and the desktop `SyncedAgentSession`.
 */
export type SessionChangeCounts = {
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
};

/**
 * Whether a session produced changes, defined against the very columns the
 * Sessions detail row renders (`+linesAdded / -linesRemoved`, plus the
 * files-changed count). A session "has changes" when any of files/lines
 * added/removed is greater than zero; null/0 across all three means "no
 * changes". Keeping this predicate here guarantees the filter and the row agree,
 * and that the cloud query and the desktop matcher classify a session the same
 * way (FEA-2505).
 */
export function sessionHasChanges(counts: SessionChangeCounts): boolean {
  return (
    (counts.filesChanged ?? 0) > 0 ||
    (counts.linesAdded ?? 0) > 0 ||
    (counts.linesRemoved ?? 0) > 0
  );
}

/**
 * The scalar activity signals the Sessions surface reads to decide whether a
 * session did any substantive work. Kept minimal so the same shape is satisfied
 * by the cloud `SessionDetail` row, the desktop `SyncedAgentSession` (after
 * summing token usage / counting tool-use events), and the shared
 * `AgentSessionListItem` the UI renders — one predicate, every surface.
 */
export type SessionSubstantiveCounts = {
  turns?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  toolUseCount?: number | null;
};

/**
 * FEA-3284 SSOT: whether a session did any substantive work, versus being an
 * "idle"/"phantom" row (a 0-turn / 0-token session the desktop live-hook INSERTs
 * on `SessionStart` before any activity — see FEA-3284). A session is
 * **substantive** iff it has at least one turn, OR any token (input + output +
 * cache read + cache write) was consumed, OR at least one tool was used;
 * everything else is **idle**.
 *
 * This is the ONE canonical rule. The cloud query builder mirrors it as the
 * `SESSION_SUBSTANTIVE_WHERE` Prisma predicate
 * (`apps/api/app/agent-sessions/service/query-builder.ts`) and the desktop read
 * calls this exact function on the hydrated session
 * (`apps/desktop/src/main/shared-agent-sessions-api.ts`), so a session buckets
 * as idle vs substantive identically on every surface — the FEA-3149 lockstep
 * contract. Any change to the boundary here MUST be mirrored in both twins (the
 * cross-surface consistency tests enforce it).
 *
 * Null/undefined counts coalesce to 0 (a pre-backfill or event-less row with no
 * signal is idle), so the predicate never depends on a nullable field silently.
 *
 * FEA-3572: the row this predicate classifies as non-substantive is the canonical
 * `IdleConcept.PhantomSession` (concept #1) — the one and only session-level idle
 * concept. See `./types/idle-concepts.ts` for the disambiguated vocabulary that
 * keeps it apart from the three other things "idle" used to mean
 * (activity-timeline gap, stalled run, trace gap), none of which are sessions and
 * none of which this predicate touches.
 */
export function isSubstantiveSession(
  counts: SessionSubstantiveCounts
): boolean {
  const totalTokens =
    (counts.inputTokens ?? 0) +
    (counts.outputTokens ?? 0) +
    (counts.cacheReadTokens ?? 0) +
    (counts.cacheWriteTokens ?? 0);
  return (
    (counts.turns ?? 0) > 0 || totalTokens > 0 || (counts.toolUseCount ?? 0) > 0
  );
}

/**
 * The session-list `quality` filter values (FEA-3284). `substantive` hides idle
 * rows; `idle` shows ONLY the idle rows; `all` shows both. Canonical here so the
 * zod route validator and the desktop query sanitizer agree on the accepted set.
 *
 * FEA-4194: the current web (`apps/app`) and desktop-renderer adapters NO LONGER
 * send `quality` — the Substantive | Idle | All segment control that FEA-4145 had
 * added was an unapproved taxonomy and was reverted, so both adapters now omit
 * the param and every session shows (`all`). The `quality` values below are kept
 * because this is a version-skewed cross-repo/desktop contract: an older Desktop
 * build may still send an explicit `quality`, and the server must keep honoring
 * it. `idle` isolates exactly the canonical `IdleConcept.PhantomSession` rows
 * (the one persisted, counted, session-level "idle"; see `./types/idle-concepts`)
 * that `substantive` hides.
 *
 * FEA-3345: the absent-param default is `all` (fail-open). With no current client
 * sending `quality`, the effective behavior everywhere is `all`; any older client
 * that still sends an explicit `quality:"substantive"`/`"idle"` narrows only its
 * own read. Any ungated caller (dashboards, insights, feeds, telemetry) shows
 * every session, matching pre-FEA-3284 behavior, instead of silently inheriting
 * the filter. Both server seams (`applyQualityFilter`, `sanitizeQuery`) resolve
 * absent `quality` through this constant so there is a single real default.
 */
export const SESSION_QUALITY_VALUES = ["substantive", "idle", "all"] as const;
export type SessionQuality = (typeof SESSION_QUALITY_VALUES)[number];
export const DEFAULT_SESSION_QUALITY: SessionQuality = "all";

/**
 * Whether a session (already classified as substantive or idle by the canonical
 * `isSubstantiveSession` predicate) is visible under the given quality value. The
 * exhaustive `switch` with a `never` default fails typecheck if a fourth
 * `SessionQuality` value is ever added without a visibility rule here, so the SQL
 * query builder and the desktop matcher can never silently disagree on what a
 * value means. Still consumed by the server/desktop paths even though no current
 * client sends `quality` (FEA-4194) — an older Desktop build may still send one.
 */
export function isSessionVisibleForQuality(
  isSubstantive: boolean,
  quality: SessionQuality
): boolean {
  switch (quality) {
    case "substantive":
      return isSubstantive;
    case "idle":
      return !isSubstantive;
    case "all":
      return true;
    default: {
      const exhaustive: never = quality;
      return exhaustive;
    }
  }
}

/**
 * FEA-3345: the single resolver for an absent/optional `quality` filter. Every
 * server seam that reads a validated `quality` (the web `applyQualityFilter` and
 * the `findSessions` idle-count guard) resolves through this one function, so the
 * fail-open default can never be applied inconsistently across them. (The desktop
 * `sanitizeQuery` seam validates a raw, untyped request value first, so it keeps
 * its own enum-guarding resolver.)
 */
export function resolveSessionQuality(
  quality: SessionQuality | null | undefined
): SessionQuality {
  return quality ?? DEFAULT_SESSION_QUALITY;
}

/**
 * Canonical Changes-facet option ids — the single place these values live.
 * The options list, the matcher, and the cloud where-builder
 * (`buildChangePresenceWhere` in the agent-sessions query-builder) all reference
 * these members, so a rename propagates by typecheck instead of drifting a
 * hardcoded literal on one surface (ISS-4548 / closedloop-ai-stage CR).
 */
export const SessionChangePresenceId = {
  HasChanges: "has_changes",
  NoChanges: "no_changes",
} as const;
export type SessionChangePresenceId =
  (typeof SessionChangePresenceId)[keyof typeof SessionChangePresenceId];

export type SessionFilterToggleOption<TId extends string> = {
  id: TId;
  label: string;
};

/**
 * Fixed Changes facet options (FEA-2505). Selecting "Has changes" excludes the
 * empty sessions users skip when reviewing meaningful work; "No changes"
 * isolates the empty ones. Two options compose with the other facets through the
 * same OR-within / AND-across contract as autonomy/cost.
 */
export const SESSION_CHANGE_PRESENCE_OPTIONS: readonly SessionFilterToggleOption<SessionChangePresenceId>[] =
  [
    { id: SessionChangePresenceId.HasChanges, label: "Has changes" },
    { id: SessionChangePresenceId.NoChanges, label: "No changes" },
  ];

/** True when a session's change-presence matches the requested option. */
export function matchesChangePresence(
  hasChanges: boolean,
  optionId: string
): boolean {
  if (optionId === SessionChangePresenceId.HasChanges) {
    return hasChanges;
  }
  if (optionId === SessionChangePresenceId.NoChanges) {
    return !hasChanges;
  }
  return false;
}

/**
 * Canonical Pull-request-facet option ids — the single place these values live,
 * referenced by the options list, the matcher, and the cloud where-builder
 * (`buildPrAssociationWhere`) alike (ISS-4548 / closedloop-ai-stage CR).
 */
export const SessionPrAssociationId = {
  HasPr: "has_pr",
  NoPr: "no_pr",
} as const;
export type SessionPrAssociationId =
  (typeof SessionPrAssociationId)[keyof typeof SessionPrAssociationId];

/**
 * Fixed Pull request facet options (FEA-2505). "Has PR" narrows to sessions with
 * an associated pull request (legacy JSON or the canonical session→PR artifact
 * link); "No PR" is its complement.
 */
export const SESSION_PR_ASSOCIATION_OPTIONS: readonly SessionFilterToggleOption<SessionPrAssociationId>[] =
  [
    { id: SessionPrAssociationId.HasPr, label: "Has PR" },
    { id: SessionPrAssociationId.NoPr, label: "No PR" },
  ];

/** True when a session's pull-request association matches the requested option. */
export function matchesPrAssociation(
  hasPr: boolean,
  optionId: string
): boolean {
  if (optionId === SessionPrAssociationId.HasPr) {
    return hasPr;
  }
  if (optionId === SessionPrAssociationId.NoPr) {
    return !hasPr;
  }
  return false;
}

/**
 * The Status-facet filter-INPUT contract — the only status values a session
 * filter may SEND, in the order every surface offers them. This is deliberately
 * NOT the set a read may RETURN: `stale` and `unknown` are read-time projections,
 * and a spelling this build cannot parse comes back as `unknown`, so a consumer
 * must not assume a returned session's `status` is one of the advertised values.
 *
 * ISS-4586 made `inactive` the terminal-but-not-failed status and retired
 * `completed`/`abandoned`; ISS-4985 then routed a retired REQUEST onto the
 * Inactive predicate so such a filter did not read as "you have no finished
 * sessions".
 *
 * **ISS-5592 removed both.** The predicate no longer widens onto the retired
 * values and a retired REQUEST no longer routes — it falls through to an exact
 * `artifact.status` match and returns nothing. That is correct rather than a
 * regression: the ingest fold makes the spelling unwritable and a production
 * count confirmed the column stores none, so the population it used to reach is
 * empty. The read side is symmetric — such a row would project as `unknown`.
 *
 * ISS-4858 hoisted the set here, beside the other facet contracts, so the
 * surfaces that cannot share a module otherwise agree on one vocabulary: the
 * `list-agent-sessions` MCP tool consumes it directly (its `status` input
 * documents this contract to external agents), and the web Status facet
 * (`@repo/app/agents/lib/session-status-filters`) declares the same vocabulary as
 * its `SessionStatusFacetValue` (ISS-4696), pinned equal to this set — same
 * values, same order — by a consistency guard in that module's tests, so the two
 * declarations cannot drift. `waiting` is the awaiting-input sub-state of active
 * — not a stored status, but a facet value the server projects — so it stays part
 * of the vocabulary.
 *
 * ISS-5366 adds `stale` and `unknown` for the same reason `waiting` is here:
 * they are values the SERVER now projects (`projectDisplayedSessionStatus`
 * applies the display staleness cutoff and the unrecognized-status fold) and
 * therefore values the Status column displays to every user. Retiring the
 * `sessions-honest-unknown-states` gate made those badges unconditional, so a
 * vocabulary without them left a status on screen that no filter could gather.
 * Both have real predicates in `buildStatusFacetPredicate` — Active and Stale
 * PARTITION the old Active population against one cutoff — so sending either
 * returns exactly the rows whose badges say so.
 */
export const SESSION_STATUS_FILTER_VALUES: readonly DisplayedSessionStatus[] = [
  SESSION_STATUS.ACTIVE,
  DISPLAYED_SESSION_STATUS.WAITING,
  SESSION_STATUS.INACTIVE,
  SESSION_STATUS.ERROR,
  DISPLAYED_SESSION_STATUS.STALE,
  DISPLAYED_SESSION_STATUS.UNKNOWN,
];
