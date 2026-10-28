import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { GitHubPRState } from "@repo/api/src/types/github";
import { median } from "@repo/api/src/utils/math";
import { earliestSessionStartMs } from "@repo/lib/branches/branch-lead-time-activity";
import { mergedTraceItemEndMs } from "@repo/lib/branches/merged-trace";

/**
 * Pure Branches derivations shared without platform imports.
 *
 * ISS-4794: this module used to price token counts on READ, through the
 * canonical `computeTokenCost` engine, in a branch-usage projection that had no
 * production caller left — `projectBranchUsageSummary` and its `sumPricedCost` /
 * `perHourPerActorBuckets` machinery were reachable only from their own tests.
 * Both facts made it deletable rather than convertible: pricing belongs at WRITE
 * (`estimateTokenCost`, harness-parity, `token-cost-writes.ts`) and reads display
 * the stored figure, and a second engine here could only ever disagree with it.
 * The live branch-usage projection is `apps/desktop/src/main/branch/branch-usage-projection.ts`,
 * which sums the stored per-row cost.
 *
 * Per-activity cost rollup lives in `@repo/lib/branches/activity-rollup`.
 */

// Keep in sync with `MERGED_TRACE_IDLE_THRESHOLD_MS`; desktop main synthesizes
// the trace's idle markers at this same gap, and this re-derivation must agree.
// Both halves of that agreement are now mechanical: the threshold is this
// constant, and the pause it is tested against comes from the builder's own
// `mergedTraceItemEndMs`.
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

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
 * vs idle. A PAUSE >= `idleThresholdMs` (default 120s) — measured from the end of
 * the last item that was still running to the next item's start — is an idle
 * span; shorter pauses, and the runs themselves, are active.
 *
 * ISS-8720: sizing that pause start-to-start counted a `tools` run's own duration
 * as time nothing happened, so this walk and `buildMergedTrace` disagreed about
 * the same pause by the length of the run — on the same Sessions & timeline tab,
 * where the swimlane's bursts sit beside the trace's idle row. Both now read the
 * builder's `mergedTraceItemEndMs`, so there is one definition rather than two
 * that a comment asks to agree.
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
  const stamped = stampedTraceInstants(items);
  const first = stamped[0];
  if (!first) {
    return { activeMs: 0, idleMs: 0, idleSpans: [] };
  }

  let activeMs = 0;
  let idleMs = 0;
  const idleSpans: { startT: string; endT: string; gapMs: number }[] = [];
  // Sweep line: every millisecond before `cursorMs` has been classified exactly
  // once, which is what keeps a run and the pause after it separate instead of
  // merged into one oversized gap.
  let cursorMs = mergedTraceItemEndMs(first.item, first.ms);
  activeMs += cursorMs - first.ms;

  for (let i = 1; i < stamped.length; i += 1) {
    const entry = stamped[i];
    if (entry.ms > cursorMs) {
      const gapMs = entry.ms - cursorMs;
      if (gapMs >= threshold) {
        idleMs += gapMs;
        idleSpans.push({
          startT: new Date(cursorMs).toISOString(),
          endT: entry.t,
          gapMs,
        });
      } else {
        activeMs += gapMs;
      }
      cursorMs = entry.ms;
    }
    const endMs = mergedTraceItemEndMs(entry.item, entry.ms);
    if (endMs > cursorMs) {
      activeMs += endMs - cursorMs;
      cursorMs = endMs;
    }
  }
  return { activeMs, idleMs, idleSpans };
}

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

/**
 * The merged-trace items this split may reason about: everything carrying a real
 * instant, in chronological order, MINUS the synthesized `idle` markers.
 *
 * Those markers are a derivation of this same evidence, not evidence of it —
 * `buildMergedTrace` stamps each one at the pause it describes, so counting them
 * as stamped items would feed this walk its own conclusion.
 */
function stampedTraceInstants(
  items: MergedTraceItem[]
): { item: MergedTraceItem; t: string; ms: number }[] {
  const stamped: { item: MergedTraceItem; t: string; ms: number }[] = [];
  for (const item of items) {
    if (item.type === "idle" || !("t" in item)) {
      continue;
    }
    const ms = Date.parse(item.t);
    if (!Number.isNaN(ms)) {
      stamped.push({ item, t: item.t, ms });
    }
  }
  return stamped.sort((a, b) => a.ms - b.ms);
}
