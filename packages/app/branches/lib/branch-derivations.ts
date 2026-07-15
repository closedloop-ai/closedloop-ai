import {
  type BranchPageDetail,
  BranchPhase,
  type BranchSession,
  type BranchUsageActorBucket,
  type BranchUsageHourBucket,
  type BranchUsagePhaseStack,
  type BranchUsageSummary,
  BranchViewerScope,
  type MergedTraceItem,
} from "@repo/api/src/types/branch";
import { median } from "@repo/api/src/utils/math";
import { computeTokenCost } from "@closedloop-ai/loops-api/genai-cost";

/**
 * Pure, surface-agnostic Branches derivations (PLN-983 / Epic A — A3).
 *
 * Every function runs identically in the desktop main-process projector and any
 * renderer composition: NO electron / window / DB / `apps/*` imports. Token cost
 * is delegated to `computeTokenCost` (genai-cost, FEA-1718) — pricing is NEVER
 * reimplemented. Functions degrade to `null` on missing inputs (never throw,
 * never coerce a missing value to 0).
 *
 * A3 owns the EXACT contract signatures here, implemented (not stubbed),
 * including `buildVsReworkSplit` and `activeIdleSpans`. Epic D ADDS only
 * non-contract helpers (partitionBuildVsRework, reconcilePhaseSegments,
 * leadTimeWaterfallSegments, PhaseAggregate) and CONSUMES the functions below.
 */

export type BranchTokenRow = {
  sessionId: string;
  owner: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** ISO truncated to the hour; when absent, derived from `timestamp`. */
  hourStart?: string | null;
  phase?: BranchPhase | null;
  billingMode?: "subscription" | "api" | null;
  /** For historical pricing. Also the fallback source for `hourStart`. */
  timestamp?: Date;
};

// SSOT pair: keep in sync with `MERGED_TRACE_IDLE_THRESHOLD_MS` in
// `apps/desktop/src/main/shared-branches-api.ts` — the desktop main synthesizes
// the trace's idle markers at this same gap, and this re-derivation must agree.
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

type TokenCounts = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp?: Date;
};

function emptyCounts(model: string, timestamp?: Date): TokenCounts {
  return { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, timestamp };
}

function addRow(counts: TokenCounts, row: BranchTokenRow): void {
  counts.input += row.inputTokens;
  counts.output += row.outputTokens;
  counts.cacheRead += row.cacheReadTokens;
  counts.cacheWrite += row.cacheWriteTokens;
}

function priceCounts(counts: TokenCounts): number | null {
  const result = computeTokenCost({
    model: counts.model,
    inputTokens: counts.input,
    outputTokens: counts.output,
    cacheReadTokens: counts.cacheRead,
    cacheWriteTokens: counts.cacheWrite,
    timestamp: counts.timestamp,
  });
  return result.priced ? result.costUsd : null;
}

/**
 * Sum the USD cost of `rows`, grouping by `(keyOf(row), model)` and pricing each
 * group once via `computeTokenCost`. Priced groups are summed; UNPRICED models
 * (reason !== null) are dropped. Returns `null` when no group prices — never 0.
 * Mirrors the per-`(slug, model)`-then-SUM + unpriced-drop pattern in
 * `sqlite.ts` `getArtifactSessionUsage` (FEA-1834).
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
      const cost = priceCounts(counts);
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
 * Net LOC per dollar. `null` when LOC is null, cost is null, or cost is 0 (never
 * divide-by-zero, never coerce a missing value to 0).
 */
export function locPerDollar(args: {
  netLoc: number | null;
  totalCostUsd: number | null;
}): number | null {
  const { netLoc, totalCostUsd } = args;
  if (netLoc == null || totalCostUsd == null || totalCostUsd === 0) {
    return null;
  }
  return netLoc / totalCostUsd;
}

/**
 * 30-day trailing LOC-per-dollar baseline: sum the window's net LOC and cost,
 * then divide. `null` when no entry carries LOC, or the summed cost is null/0.
 */
export function locPerDollarBaseline30d(
  rowsWindow: { netLoc: number | null; totalCostUsd: number | null }[]
): number | null {
  let netLocSum = 0;
  let costSum = 0;
  let hasNetLoc = false;
  let hasCost = false;
  for (const entry of rowsWindow) {
    if (entry.netLoc != null) {
      netLocSum += entry.netLoc;
      hasNetLoc = true;
    }
    if (entry.totalCostUsd != null) {
      costSum += entry.totalCostUsd;
      hasCost = true;
    }
  }
  return locPerDollar({
    netLoc: hasNetLoc ? netLocSum : null,
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
    const cost = priceCounts(counts);
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
    (row) => row.billingMode === "subscription"
  );
  const apiRows = rows.filter((row) => row.billingMode === "api");
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
    hourBuckets: perHourPerActorBuckets(rows, { timeZone: options?.timeZone }),
    phaseStacks: buildPhaseStacks(rows),
    byActor: rollupActors(rows),
  };
}

// === Epic D non-contract helpers (added by D; CONSUME the A3 functions above) ===

/**
 * One side of the Build/Rework cost partition: a roll-up of contributing
 * sessions. `costUsd`/`netLoc` are `null` (never 0) when nothing prices / LOC is
 * unavailable, so the panel renders "—" rather than a misleading zero.
 */
export type PhaseAggregate = {
  costUsd: number | null;
  netLoc: number | null;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
};

const EMPTY_PHASE_AGGREGATE: PhaseAggregate = {
  costUsd: null,
  netLoc: null,
  inputTokens: 0,
  outputTokens: 0,
  sessionCount: 0,
};

function aggregateSessions(
  sessions: readonly BranchSession[],
  netLoc: number | null
): PhaseAggregate {
  if (sessions.length === 0) {
    return EMPTY_PHASE_AGGREGATE;
  }
  let costUsd: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const session of sessions) {
    inputTokens += session.inputTokens;
    outputTokens += session.outputTokens;
    if (session.estimatedCostUsd != null) {
      costUsd = (costUsd ?? 0) + session.estimatedCostUsd;
    }
  }
  return {
    costUsd,
    netLoc,
    inputTokens,
    outputTokens,
    sessionCount: sessions.length,
  };
}

/**
 * Partition a branch's contributing sessions into Build vs Rework aggregates —
 * the SINGLE source the cost-to-merge phase bar (D4) consumes, so the panel and
 * the bar never recompute divergently (D3).
 *
 * v1 has no per-session phase signal and no captured PR-creation pivot, so every
 * session attributes to Build and Rework is empty ("No rework yet"); the split
 * lights up when per-session phase / PR-creation capture lands. `netLoc` is the
 * branch-level additions+deletions (null until LOC enrichment) attributed to
 * Build — never split, never coerced to 0.
 */
export function partitionBuildVsRework(detail: BranchPageDetail): {
  build: PhaseAggregate;
  rework: PhaseAggregate;
} {
  const netLoc =
    detail.additions != null && detail.deletions != null
      ? detail.additions + detail.deletions
      : null;
  return {
    build: aggregateSessions(detail.sessions, netLoc),
    rework: EMPTY_PHASE_AGGREGATE,
  };
}

/** A priced phase segment for the cost-to-merge bar (D4). */
export type PhaseSegment = {
  key: "build" | "subagents" | "autoReview" | "humanReview" | "rework";
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
 * Lead time for change as an ordered waterfall, anchored on the FIRST session's
 * start (per the explicit AC — NOT branch creation) through merge. v1 has no
 * captured PR-creation / review boundaries, so it emits one development span;
 * more segments slot in when those timestamps land. When the branch has not
 * merged (`mergedAt == null`, or clock skew), the trailing span is open-ended
 * ("merge unknown") and `totalMs` is null rather than closed at an invented
 * endpoint. `totalMs` is the SINGLE lead-time computation D6's headline card
 * also reads, so both render one number.
 */
export function leadTimeWaterfallSegments(detail: BranchPageDetail): {
  segments: LeadTimeSegment[];
  totalMs: number | null;
  mergeUnknown: boolean;
  multiPr: boolean;
} {
  const multiPr = detail.multiPrWarning;
  const anchorMs = earliestSessionStartMs(detail.sessions);
  const mergedMs = detail.mergedAt ? Date.parse(detail.mergedAt) : Number.NaN;
  const hasMerge = !Number.isNaN(mergedMs);

  if (anchorMs == null) {
    return { segments: [], totalMs: null, mergeUnknown: !hasMerge, multiPr };
  }

  if (hasMerge && mergedMs >= anchorMs) {
    const durationMs = mergedMs - anchorMs;
    return {
      segments: [
        { key: "development", label: "First session → merge", durationMs },
      ],
      totalMs: durationMs,
      mergeUnknown: false,
      multiPr,
    };
  }

  // No merge timestamp (or clock skew) → open-ended trailing span, no total.
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
    multiPr,
  };
}
