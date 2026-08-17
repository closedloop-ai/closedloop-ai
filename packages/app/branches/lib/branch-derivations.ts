import {
  BranchBillingMode,
  type BranchPageDetail,
  BranchPhase,
  type BranchSession,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import {
  aggregateBranchCostCompleteness,
  type BranchUsageActorBucket,
  type BranchUsageHourBucket,
  type BranchUsagePhaseStack,
  type BranchUsageSummary,
} from "@repo/api/src/types/branch-usage";
import { GitHubPRState } from "@repo/api/src/types/github";
import { median } from "@repo/api/src/utils/math";
import {
  addRow,
  type BranchTokenRow,
  branchCostContributions,
  emptyCounts,
  priceCounts,
  type TokenCounts,
} from "./branch-cost-completeness";

export type { BranchTokenRow } from "./branch-cost-completeness";

/**
 * Pure Branches derivations shared without platform imports; token cost delegates
 * to `computeTokenCost`. Usage summaries preserve required numeric compatibility
 * fields while exposing availability through typed completeness.
 * Per-activity cost rollup lives in `@repo/lib/branches/activity-rollup`.
 */

// Keep in sync with `MERGED_TRACE_IDLE_THRESHOLD_MS`; desktop main synthesizes
// the trace's idle markers at this same gap, and this re-derivation must agree.
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

/**
 * Sum priced `(keyOf(row), model)` groups, dropping unpriced models. Returns
 * `null` when no group prices, matching `getArtifactSessionUsage` (FEA-1834).
 */
function sumPricedCost(
  rows: readonly BranchTokenRow[],
  keyOf: (row: BranchTokenRow) => string
): number | null {
  // Group by `keyOf(row)` then `model` with a nested map — no in-band string
  // separator (an earlier NUL-joined composite key rendered this file binary to
  // git). Each `(key, model)` group is priced exactly once.
  const groups = new Map<string, Map<string, TokenCounts>>();
  for (const row of rows) {
    const key = keyOf(row);
    const byModel = groups.get(key) ?? new Map<string, TokenCounts>();
    groups.set(key, byModel);
    const existing = byModel.get(row.model);
    if (existing) {
      addRow(existing, row);
    } else {
      const counts = emptyCounts(row.model, row.timestamp);
      addRow(counts, row);
      byModel.set(row.model, counts);
    }
  }

  let total = 0;
  let anyPriced = false;
  for (const byModel of groups.values()) {
    for (const counts of byModel.values()) {
      const cost = priceCounts(counts).costUsd;
      if (cost != null) {
        total += cost;
        anyPriced = true;
      }
    }
  }
  return anyPriced ? total : null;
}

/** Total cost of `rows` priced per `(sessionId, model)` group. */
export function costPerSession(rows: BranchTokenRow[]): number | null {
  return sumPricedCost(rows, (row) => row.sessionId);
}

/** Total cost of one branch's `rows` priced per `model` group. */
export function costPerBranch(rows: BranchTokenRow[]): number | null {
  return sumPricedCost(rows, () => "branch");
}

/**
 * Total code churn per dollar. `churn` is additions + DELETIONS — removed lines
 * are work delivered, so they ADD to the numerator; this has never been a NET
 * figure despite the old `netLoc` parameter name (the callers have always passed
 * `additions + deletions`). Matches the org-wide Value-per-$ KPI the two
 * analytics producers compute, so the branch card and its baseline are the same
 * metric. `null` when churn is null, cost is null, or cost is 0 (never
 * divide-by-zero, never coerce a missing value to 0).
 */
export function locPerDollar(args: {
  churn: number | null;
  totalCostUsd: number | null;
}): number | null {
  const { churn, totalCostUsd } = args;
  if (churn == null || totalCostUsd == null || totalCostUsd === 0) {
    return null;
  }
  return churn / totalCostUsd;
}

/**
 * 30-day trailing churn-per-dollar baseline: sum the window's churn and cost,
 * then divide. `null` when no entry carries churn, or the summed cost is null/0.
 */
export function locPerDollarBaseline30d(
  rowsWindow: { churn: number | null; totalCostUsd: number | null }[]
): number | null {
  let churnSum = 0;
  let costSum = 0;
  let hasChurn = false;
  let hasCost = false;
  for (const entry of rowsWindow) {
    if (entry.churn != null) {
      churnSum += entry.churn;
      hasChurn = true;
    }
    if (entry.totalCostUsd != null) {
      costSum += entry.totalCostUsd;
      hasCost = true;
    }
  }
  return locPerDollar({
    churn: hasChurn ? churnSum : null,
    totalCostUsd: hasCost ? costSum : null,
  });
}

/**
 * Lead time for change (first commit -> merge), in ms. `null` (GATED) when
 * either timestamp is null/unparseable, or the delta is negative (clock skew).
 */
export function leadTimeForChange(args: {
  firstCommitAt: string | null;
  mergedAt: string | null;
}): number | null {
  const { firstCommitAt, mergedAt } = args;
  if (firstCommitAt == null || mergedAt == null) {
    return null;
  }
  const start = Date.parse(firstCommitAt);
  const end = Date.parse(mergedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  const delta = end - start;
  return delta >= 0 ? delta : null;
}

/**
 * Median PR size (additions + deletions) over MERGED, single-PR branches with
 * both LOC fields populated. Multi-PR branches and rows missing LOC are
 * excluded — mirroring the delivery dashboard, which medians enriched PR LOC and
 * excludes un-enriched PRs (it never folds a missing size in as 0). The branch
 * `additions`/`deletions` are sourced from the merged PR artifact's enrichment
 * upstream (FEA-2159), so a branch whose own artifact is un-enriched still
 * carries its real PR size here. `null` when none qualify.
 */
export function medianPrSize(
  branches: {
    additions: number | null;
    deletions: number | null;
    status: string;
    multiPrWarning: boolean;
  }[]
): number | null {
  const sizes: number[] = [];
  for (const branch of branches) {
    if (
      branch.status !== "merged" ||
      branch.multiPrWarning ||
      branch.additions == null ||
      branch.deletions == null
    ) {
      continue;
    }
    sizes.push(branch.additions + branch.deletions);
  }
  return median(sizes);
}

/**
 * Walk the interleaved merged-trace stream and split wall-clock time into active
 * vs idle. A gap between consecutive timestamped items >= `idleThresholdMs`
 * (default 120s) is an idle span; shorter gaps are active.
 */
export function activeIdleSpans(
  items: MergedTraceItem[],
  options?: { idleThresholdMs?: number }
): {
  activeMs: number;
  idleMs: number;
  idleSpans: { startT: string; endT: string; gapMs: number }[];
} {
  const threshold = options?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const stamped = items
    .map((item) => ("t" in item ? item.t : null))
    .filter((t): t is string => typeof t === "string")
    .map((t) => ({ t, ms: Date.parse(t) }))
    .filter((entry) => !Number.isNaN(entry.ms))
    .sort((a, b) => a.ms - b.ms);

  let activeMs = 0;
  let idleMs = 0;
  const idleSpans: { startT: string; endT: string; gapMs: number }[] = [];
  for (let i = 1; i < stamped.length; i += 1) {
    const prev = stamped[i - 1];
    const curr = stamped[i];
    const gapMs = curr.ms - prev.ms;
    if (gapMs >= threshold) {
      idleMs += gapMs;
      idleSpans.push({ startT: prev.t, endT: curr.t, gapMs });
    } else {
      activeMs += gapMs;
    }
  }
  return { activeMs, idleMs, idleSpans };
}

/**
 * Per-hour-per-actor token + cost buckets (FEA-1834 O(grouped) shape). Rows are
 * grouped by `hourStart` (or `timestamp` truncated to the hour in `timeZone`,
 * default UTC), then by `owner` (null owner -> a single "unattributed" bucket).
 * Cost per actor bucket sums priced `(model)` groups. The `timeZone` option is
 * the one seam a future device-tz switch (openQuestion #5) flips.
 */
export function perHourPerActorBuckets(
  rows: BranchTokenRow[],
  options?: { timeZone?: string }
): BranchUsageHourBucket[] {
  const timeZone = options?.timeZone;
  type ActorAccumulator = {
    owner: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    perModel: Map<string, TokenCounts>;
  };
  const byHour = new Map<string, Map<string | null, ActorAccumulator>>();

  for (const row of rows) {
    const hourStart = resolveHourStart(row, timeZone);
    if (hourStart == null) {
      continue;
    }
    // `null` owner is a first-class Map key (its own "unattributed" bucket) — no
    // sentinel string needed.
    const actors =
      byHour.get(hourStart) ?? new Map<string | null, ActorAccumulator>();
    byHour.set(hourStart, actors);
    const actor =
      actors.get(row.owner) ??
      ({
        owner: row.owner,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        perModel: new Map<string, TokenCounts>(),
      } satisfies ActorAccumulator);
    actors.set(row.owner, actor);
    actor.input += row.inputTokens;
    actor.output += row.outputTokens;
    actor.cacheRead += row.cacheReadTokens;
    actor.cacheWrite += row.cacheWriteTokens;
    const modelCounts =
      actor.perModel.get(row.model) ?? emptyCounts(row.model, row.timestamp);
    addRow(modelCounts, row);
    actor.perModel.set(row.model, modelCounts);
  }

  return [...byHour.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([hourStart, actors]) => ({
      hourStart,
      byActor: [...actors.values()]
        .sort((a, b) => compareOwner(a.owner, b.owner))
        .map((actor) => ({
          owner: actor.owner,
          inputTokens: actor.input,
          outputTokens: actor.output,
          cacheReadTokens: actor.cacheRead,
          cacheWriteTokens: actor.cacheWrite,
          estimatedCostUsd: sumActorModelCost(actor.perModel),
        })),
    }));
}

function sumActorModelCost(perModel: Map<string, TokenCounts>): number {
  let total = 0;
  for (const counts of perModel.values()) {
    const cost = priceCounts(counts).costUsd;
    if (cost != null) {
      total += cost;
    }
  }
  return total;
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareOwner(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a == null) {
    return 1;
  }
  if (b == null) {
    return -1;
  }
  return a < b ? -1 : 1;
}

function resolveHourStart(
  row: BranchTokenRow,
  timeZone: string | undefined
): string | null {
  if (typeof row.hourStart === "string" && row.hourStart.length > 0) {
    return row.hourStart;
  }
  if (
    !(row.timestamp instanceof Date) ||
    Number.isNaN(row.timestamp.getTime())
  ) {
    return null;
  }
  return truncateToHour(row.timestamp, timeZone);
}

/**
 * Hour-bucket key for a timestamp. UTC (default) returns a proper ISO instant
 * with minutes/seconds zeroed; a non-UTC IANA `timeZone` returns the wall-clock
 * hour in that zone (`YYYY-MM-DDTHH:00:00`), which still sorts lexicographically.
 */
function truncateToHour(date: Date, timeZone: string | undefined): string {
  if (!timeZone || timeZone === "UTC") {
    const truncated = new Date(date.getTime());
    truncated.setUTCMinutes(0, 0, 0);
    return truncated.toISOString();
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    // Pin h23 (hours 0–23). `hour12: false` can emit "24" for midnight in some
    // zones; the old "24"->"00" remap zeroed the hour WITHOUT rolling the day
    // forward, mapping midnight to the previous day. h23 removes the edge case at
    // the source so no remap is needed (thadeusb review).
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:00:00`;
}

/** Phases counted as Rework for the 2-state v1 split (review-driven). */
function isReworkPhase(phase: BranchPhase | null): boolean {
  return phase === BranchPhase.Rework || phase === BranchPhase.Review;
}

const PHASE_KEY_ALIASES: Record<string, BranchPhase> = {
  plan: BranchPhase.Plan,
  planning: BranchPhase.Plan,
  implement: BranchPhase.Implement,
  implementation: BranchPhase.Implement,
  coding: BranchPhase.Implement,
  review: BranchPhase.Review,
  reviewing: BranchPhase.Review,
  code_review: BranchPhase.Review,
  rework: BranchPhase.Rework,
  fixing: BranchPhase.Rework,
  rework_after_review: BranchPhase.Rework,
  verify: BranchPhase.Verify,
  verification: BranchPhase.Verify,
  testing: BranchPhase.Verify,
};

/**
 * Map a token/trace row's phase to a canonical `BranchPhase`. Accepts the
 * canonical values and a small set of emitted SessionPhase-key aliases
 * (openQuestion #4); returns `null` for absent or unknown keys.
 */
export function resolveBranchPhase(row: {
  phase?: BranchPhase | string | null;
}): BranchPhase | null {
  const key =
    typeof row.phase === "string" ? row.phase.trim().toLowerCase() : null;
  if (key == null || key.length === 0) {
    return null;
  }
  return PHASE_KEY_ALIASES[key] ?? null;
}

/**
 * 2-state Build vs Rework cost split (v1 — the 5-segment split is deferred until
 * phase capture lands). Rework = Rework + review-driven phases; unknown phases
 * fold into Build. `{ buildPct: null, reworkPct: null }` when no row prices.
 */
export function buildVsReworkSplit(rows: BranchTokenRow[]): {
  buildPct: number | null;
  reworkPct: number | null;
} {
  const reworkRows: BranchTokenRow[] = [];
  const buildRows: BranchTokenRow[] = [];
  for (const row of rows) {
    if (isReworkPhase(resolveBranchPhase(row))) {
      reworkRows.push(row);
    } else {
      buildRows.push(row);
    }
  }
  const reworkCost = sumPricedCost(reworkRows, (row) => row.sessionId);
  const buildCost = sumPricedCost(buildRows, (row) => row.sessionId);
  if (reworkCost == null && buildCost == null) {
    return { buildPct: null, reworkPct: null };
  }
  const build = buildCost ?? 0;
  const rework = reworkCost ?? 0;
  const total = build + rework;
  if (total === 0) {
    return { buildPct: null, reworkPct: null };
  }
  return {
    buildPct: (build / total) * 100,
    reworkPct: (rework / total) * 100,
  };
}

/** Roll all rows up into per-actor totals (null owner -> one null bucket). */
function rollupActors(rows: BranchTokenRow[]): BranchUsageActorBucket[] {
  type Accumulator = {
    owner: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    rows: BranchTokenRow[];
  };
  const byOwner = new Map<string | null, Accumulator>();
  for (const row of rows) {
    const acc =
      byOwner.get(row.owner) ??
      ({
        owner: row.owner,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        rows: [],
      } satisfies Accumulator);
    byOwner.set(row.owner, acc);
    acc.input += row.inputTokens;
    acc.output += row.outputTokens;
    acc.cacheRead += row.cacheReadTokens;
    acc.cacheWrite += row.cacheWriteTokens;
    acc.rows.push(row);
  }
  return [...byOwner.values()]
    .sort((a, b) => compareOwner(a.owner, b.owner))
    .map((acc) => ({
      owner: acc.owner,
      inputTokens: acc.input,
      outputTokens: acc.output,
      cacheReadTokens: acc.cacheRead,
      cacheWriteTokens: acc.cacheWrite,
      estimatedCostUsd: sumPricedCost(acc.rows, (row) => row.sessionId) ?? 0,
    }));
}

/**
 * Phase-stacked cost/tokens, one entry per resolvable `BranchPhase`. Rows whose
 * phase cannot be resolved are excluded (v1-degraded best-effort — most rows
 * carry no phase until phase capture lands).
 */
function buildPhaseStacks(rows: BranchTokenRow[]): BranchUsagePhaseStack[] {
  const byPhase = new Map<BranchPhase, BranchTokenRow[]>();
  for (const row of rows) {
    const phase = resolveBranchPhase(row);
    if (phase == null) {
      continue;
    }
    const group = byPhase.get(phase) ?? [];
    group.push(row);
    byPhase.set(phase, group);
  }
  return [...byPhase.entries()].map(([phase, phaseRows]) => ({
    phase,
    estimatedCostUsd: sumPricedCost(phaseRows, (row) => row.sessionId) ?? 0,
    inputTokens: phaseRows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: phaseRows.reduce((sum, row) => sum + row.outputTokens, 0),
    sessionCount: new Set(phaseRows.map((row) => row.sessionId)).size,
  }));
}

/**
 * Project branch token rows into the canonical `BranchUsageSummary` (A3 owns the
 * usage flesh-out; B1 feeds the rows from SQLite). Pure — runs identically in
 * the desktop main projector and the future REST path. Cost via the shared
 * derivations only; the subscription/api split follows `billingMode` (null
 * billingMode contributes to the total but neither split — v1-degraded).
 */
export function projectBranchUsageSummary(
  rows: BranchTokenRow[],
  options?: { branchCount?: number; timeZone?: string }
): BranchUsageSummary {
  const subscriptionRows = rows.filter(
    (row) => row.billingMode === BranchBillingMode.Subscription
  );
  const apiRows = rows.filter(
    (row) => row.billingMode === BranchBillingMode.Api
  );
  return {
    viewerScope: BranchViewerScope.Self,
    totalBranches: options?.branchCount ?? 0,
    totalInputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    totalOutputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    totalCacheReadTokens: rows.reduce(
      (sum, row) => sum + row.cacheReadTokens,
      0
    ),
    totalCacheWriteTokens: rows.reduce(
      (sum, row) => sum + row.cacheWriteTokens,
      0
    ),
    totalEstimatedCost: costPerBranch(rows) ?? 0,
    subscriptionEstimatedCost:
      sumPricedCost(subscriptionRows, (row) => row.sessionId) ?? 0,
    apiEstimatedCost: sumPricedCost(apiRows, (row) => row.sessionId) ?? 0,
    costCompleteness: aggregateBranchCostCompleteness(
      branchCostContributions(rows)
    ),
    hourBuckets: perHourPerActorBuckets(rows, { timeZone: options?.timeZone }),
    phaseStacks: buildPhaseStacks(rows),
    byActor: rollupActors(rows),
  };
}

// === Epic D non-contract helpers (added by D; CONSUME the A3 functions above) ===
//
// FEA-2276 removed the coarse `partitionBuildVsRework` split (+ its
// `PhaseAggregate`/`aggregateSessions` helpers): the cost-to-merge panel now
// consumes the real per-activity `rollupBranchActivity` in
// `@repo/lib/branches/activity-rollup`. `reconcilePhaseSegments` is retained
// (taxonomy-agnostic) and reused to residualize the new activity segments.

/**
 * A priced phase segment for the cost-to-merge bar. `key` is a free render key
 * (widened from the old build/rework union to the FEA-2269 taxonomy + the
 * `unattributed` residual) — `reconcilePhaseSegments` treats it opaquely.
 */
export type PhaseSegment = {
  key: string;
  label: string;
  costUsd: number;
  firstRow: number | null;
};

/**
 * Residualize `segments` so `sum(costUsd) === totalUsd` WITHOUT inventing
 * attribution: a positive remainder (the branch total exceeds the attributed
 * segments — e.g. unattributed cost) folds into the trailing segment; an
 * over-attribution scales the segments down proportionally. A `null` total (no
 * priced cost) leaves the segments untouched. `SegmentedBar` hides any segment
 * whose share is <= 0 (D4).
 */
export function reconcilePhaseSegments(
  totalUsd: number | null,
  segments: PhaseSegment[]
): PhaseSegment[] {
  if (totalUsd == null || segments.length === 0) {
    return segments;
  }
  const attributed = segments.reduce(
    (sum, segment) => sum + Math.max(0, segment.costUsd),
    0
  );
  const residual = totalUsd - attributed;
  if (Math.abs(residual) < 1e-9) {
    return segments;
  }
  if (residual > 0) {
    const lastIndex = segments.length - 1;
    return segments.map((segment, index) =>
      index === lastIndex
        ? { ...segment, costUsd: segment.costUsd + residual }
        : segment
    );
  }
  const factor = attributed > 0 ? totalUsd / attributed : 0;
  return segments.map((segment) => ({
    ...segment,
    costUsd: Math.max(0, segment.costUsd) * factor,
  }));
}

/** One ordered phase span in the lead-time waterfall (D5). */
export type LeadTimeSegment = {
  key: string;
  label: string;
  durationMs: number | null;
  openEnded?: boolean;
};

function earliestSessionStartMs(
  sessions: readonly BranchSession[]
): number | null {
  let earliest: number | null = null;
  for (const session of sessions) {
    const ms = Date.parse(session.startedAt);
    if (Number.isNaN(ms)) {
      continue;
    }
    if (earliest == null || ms < earliest) {
      earliest = ms;
    }
  }
  return earliest;
}

/**
 * Whether the branch's PR is merged, derived from the SAME signals the Properties
 * panel reads — `prState === MERGED` (canonical GitHub state) or the projected
 * `status === merged` — NOT from the presence of a `mergedAt` timestamp
 * (FEA-4227). A merged PR whose merge instant has not yet been enriched
 * (`mergedAt == null`) still reads as merged here, so the lead-time card/breakdown
 * can no longer contradict the "Merged" chip by claiming the branch "hasn't
 * merged yet". `mergedAt` is a timing DETAIL of a merged branch, never the merge
 * SIGNAL itself.
 */
export function isBranchMerged(detail: {
  prState: BranchPageDetail["prState"];
  status: BranchPageDetail["status"];
}): boolean {
  return (
    detail.prState === GitHubPRState.Merged ||
    detail.status === BranchStatus.Merged
  );
}

/**
 * Lead time for change as an ordered waterfall, anchored on the FIRST session's
 * start (per the explicit AC — NOT branch creation) through merge. v1 has no
 * captured PR-creation / review boundaries, so it emits one development span;
 * more segments slot in when those timestamps land.
 *
 * Merge state is derived from `isBranchMerged` (`prState`/`status`, the same
 * source as the Properties panel), NOT the presence of `mergedAt` (FEA-4227):
 *
 * - Merged WITH a usable `mergedAt` ≥ anchor → a closed span and a finite total.
 *   The finite branch requires `merged` too, so a cloud-hydration overlay that
 *   flips `status`/`prState` back to Open while keeping a stale local `mergedAt`
 *   does NOT show a completed lead time for an open branch (falls through to the
 *   open-ended "in progress" case).
 * - Merged but `mergedAt` is missing/unparseable/clock-skewed → the span is
 *   closed-state (`mergeUnknown: false`, so no "hasn't merged" copy) but the
 *   duration is `null` (`durationUnavailable: true`): we KNOW it merged, we just
 *   can't measure the lead time honestly. Never invent an endpoint.
 * - No session anchor → pending (nothing to measure FROM), even when merged: the
 *   missing anchor — not the merge time — is the real gap, so this stays the
 *   honest "no session activity" pending state, never "merge time hasn't synced".
 * - Not merged → the trailing span is open-ended ("in progress"), `totalMs` null.
 *
 * `totalMs` is the SINGLE lead-time computation D6's headline card also reads, so
 * both render one number.
 */
export function leadTimeWaterfallSegments(detail: BranchPageDetail): {
  segments: LeadTimeSegment[];
  totalMs: number | null;
  mergeUnknown: boolean;
  durationUnavailable: boolean;
  multiPr: boolean;
} {
  const multiPr = detail.multiPrWarning;
  const anchorMs = earliestSessionStartMs(detail.sessions);
  const mergedMs = detail.mergedAt ? Date.parse(detail.mergedAt) : Number.NaN;
  const merged = isBranchMerged(detail);
  const hasUsableMergedAt = !Number.isNaN(mergedMs);

  if (anchorMs == null) {
    // No session anchor: there is nothing to measure lead time FROM, so this is a
    // pending (no-activity) state regardless of merge — `durationUnavailable`
    // (the merged-but-unmeasured signal) stays false so `describeLeadTime`
    // resolves the honest "no session activity captured yet" Pending copy rather
    // than "merge time hasn't synced" (the merge time may be perfectly valid; the
    // missing session anchor is the real gap). Merged branches still read as
    // merged (no "in progress" contradiction); unmerged stay merge-unknown.
    return {
      segments: [],
      totalMs: null,
      mergeUnknown: !merged,
      durationUnavailable: false,
      multiPr,
    };
  }

  if (merged && hasUsableMergedAt && mergedMs >= anchorMs) {
    const durationMs = mergedMs - anchorMs;
    return {
      segments: [
        { key: "development", label: "First session → merge", durationMs },
      ],
      totalMs: durationMs,
      mergeUnknown: false,
      durationUnavailable: false,
      multiPr,
    };
  }

  if (merged) {
    // Merged per prState/status, but the merge instant is missing/unparseable or
    // predates the anchor (clock skew). We KNOW it merged — never claim it hasn't
    // — but can't chart a duration, so emit an unmeasured span (FEA-4227).
    return {
      segments: [
        {
          key: "development",
          label: "First session → merge",
          durationMs: null,
        },
      ],
      totalMs: null,
      mergeUnknown: false,
      durationUnavailable: true,
      multiPr,
    };
  }

  // Not merged → open-ended trailing span, no total.
  return {
    segments: [
      {
        key: "development",
        label: "First session → now",
        durationMs: null,
        openEnded: true,
      },
    ],
    totalMs: null,
    mergeUnknown: true,
    durationUnavailable: false,
    multiPr,
  };
}

/**
 * Lead-time display status shared by the summary card (D6) and the breakdown
 * section (D5) so the metric has ONE consistent empty/in-progress framing and
 * the two surfaces can never drift into "two different things". Both surfaces
 * derive their state from this ONE helper (the card via `leadTimeCardValue`, the
 * section via `emptyMessage`), so the split can never re-open (FEA-3974):
 *
 * - `merged`  — the branch merged AND has a measurable lead time; both surfaces
 *   show the same duration.
 * - `mergedUnavailable` — the branch merged (per `prState`/`status`, the same
 *   source as the Properties panel) but the merge instant is missing/unparseable,
 *   so lead time can't be measured honestly. The card shows the muted "No data"
 *   value (a `null` from `leadTimeCardValue`) and the section OWNS the WHY (merge
 *   time not synced, via `emptyMessage`) — the card does not echo that sentence
 *   (FEA-4229 dedupe), and neither surface ever claims the branch "hasn't merged
 *   yet" (the FEA-4227 self-contradiction bug).
 * - `inProgress` — a contributing session exists but the branch hasn't merged;
 *   the card reads "In progress" and the section frames its empty body the same
 *   way via `emptyMessage`, so the D5 breakdown no longer says "not enough
 *   activity" beside a confident "In progress" card (the FEA-3974 bug).
 * - `pending` — no contributing session at all, so neither surface has an anchor
 *   to measure lead time from. The card shows the muted "No data" value and the
 *   section OWNS the reason via `emptyMessage`; neither invents an "In progress"
 *   state.
 *
 * The split keys off the SAME signals `leadTimeWaterfallSegments` reads (the
 * `isBranchMerged` merge signal, the session anchor, and a usable `mergedAt`), so
 * the card's value and the section's empty framing always describe the same
 * branch situation.
 */
export const LeadTimeDisplayStatus = {
  Merged: "merged",
  MergedUnavailable: "merged-unavailable",
  InProgress: "in-progress",
  Pending: "pending",
} as const;
export type LeadTimeDisplayStatus =
  (typeof LeadTimeDisplayStatus)[keyof typeof LeadTimeDisplayStatus];

export type LeadTimeDisplay = {
  status: LeadTimeDisplayStatus;
  /** Shared empty/context copy; `null` once lead time resolves to a duration. */
  emptyMessage: string | null;
};

const LEAD_TIME_IN_PROGRESS_MESSAGE =
  "The branch hasn't merged yet, so lead time is still accumulating.";
/**
 * Empty-state copy when the branch IS merged but the merge timestamp hasn't been
 * synced, so the lead-time duration can't be measured. Honest about the actual
 * cause (missing merge time — the branch DID merge), so the breakdown never
 * contradicts the "Merged" chip in Properties by claiming it "hasn't merged yet"
 * (FEA-4227). Exported as the SSOT copy the D5 breakdown uses in this state.
 */
export const LEAD_TIME_MERGED_UNAVAILABLE_MESSAGE =
  "This branch merged, but its merge time hasn't synced yet, so lead time is unavailable.";
/**
 * Empty-state copy when no contributing session activity has been captured, so
 * lead time cannot be charted. Kept terse and honest about the actual cause (no
 * captured activity — not "hasn't merged"), matching the rest of this surface's
 * empty copy. Exported as the SSOT fallback the D5 breakdown uses when the
 * shared status resolves without an empty message.
 */
export const LEAD_TIME_PENDING_MESSAGE = "No session activity captured yet.";

/**
 * Whether the lead-time card has NO measurable value (FEA-4236) — both the
 * merged-but-unmeasurable and the no-activity pending states. The card renders
 * these as a muted "No data" glyph, not a bold 2xl em-dash. `InProgress` is NOT
 * unavailable: it carries the real "In progress" value.
 */
export function isLeadTimeValueUnavailable(
  status: LeadTimeDisplayStatus
): boolean {
  return (
    status === LeadTimeDisplayStatus.MergedUnavailable ||
    status === LeadTimeDisplayStatus.Pending
  );
}
/** The card's unmerged-but-active value; mirrored by the section's in-progress framing. */
const LEAD_TIME_IN_PROGRESS_VALUE = "In progress";

export function describeLeadTime(detail: BranchPageDetail): LeadTimeDisplay {
  const { totalMs, mergeUnknown, durationUnavailable } =
    leadTimeWaterfallSegments(detail);
  if (totalMs != null && !mergeUnknown) {
    return { status: LeadTimeDisplayStatus.Merged, emptyMessage: null };
  }
  // Merged (per prState/status) but the merge instant is missing → we KNOW it
  // merged, so never fall through to the "hasn't merged" in-progress copy. Show
  // the honest merged-but-unmeasurable state, consistent with the Properties
  // panel's "Merged" chip (FEA-4227).
  if (durationUnavailable) {
    return {
      status: LeadTimeDisplayStatus.MergedUnavailable,
      emptyMessage: LEAD_TIME_MERGED_UNAVAILABLE_MESSAGE,
    };
  }
  // No session anchor → neither surface can measure lead time (the D6 card has
  // no start, the D5 track has nothing to span). This is the only true "pending"
  // state; a branch WITH a session but no merge is "in progress", matching the
  // card's "In progress" value so the two surfaces never disagree (FEA-3974).
  if (earliestSessionStartMs(detail.sessions) == null) {
    return {
      status: LeadTimeDisplayStatus.Pending,
      emptyMessage: LEAD_TIME_PENDING_MESSAGE,
    };
  }
  return {
    status: LeadTimeDisplayStatus.InProgress,
    emptyMessage: LEAD_TIME_IN_PROGRESS_MESSAGE,
  };
}

/**
 * The D6 card's lead-time value, derived from the SAME `describeLeadTime` status
 * the D5 breakdown reads, so the card and section can never disagree for one
 * branch (FEA-3974). `merged` needs the caller's formatted duration (the lib
 * stays formatter-free); `formatMerged` is applied only in that branch. Returns
 * `null` for the no-data states (merged-but-unmeasurable, no-session pending) so
 * the card renders MetricCard's muted "No data" glyph directly from a nullish
 * value — no dead em-dash literal to keep in sync (FEA-4236). The exhaustive
 * switch fails typecheck if a new `LeadTimeDisplayStatus` is added without a card
 * mapping.
 */
export function leadTimeCardValue(
  status: LeadTimeDisplayStatus,
  formatMerged: () => string
): string | null {
  switch (status) {
    case LeadTimeDisplayStatus.Merged:
      return formatMerged();
    case LeadTimeDisplayStatus.InProgress:
      return LEAD_TIME_IN_PROGRESS_VALUE;
    // Merged but unmeasurable and no-session pending have no measurable duration:
    // the card shows "No data" (nullish value) and the breakdown carries the why.
    case LeadTimeDisplayStatus.MergedUnavailable:
    case LeadTimeDisplayStatus.Pending:
      return null;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
