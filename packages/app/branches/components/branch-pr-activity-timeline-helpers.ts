import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
} from "@repo/api/src/types/branch-trace";
import {
  formatCompact,
  formatCostPrecise,
} from "@repo/app/shared/lib/format-utils";
import type { ReactNode } from "react";
import type { BranchActorColorDomain } from "../lib/branch-actor-domain";
import {
  MAX_TIMELINE_DAYS,
  type TimelineColumn,
  type TimelineSegment,
  type TimelineSessionIdentity,
} from "../lib/branch-session-buckets";
import { formatClock } from "../lib/branch-timeline-range";
import type { PreferredBranchLoc } from "../lib/preferred-branch-loc";

const MIN_BAR_PERCENT = 8;

/** Token split rows rendered in each timeline hover card. */
export const TIMELINE_TOKEN_PARTS = [
  { key: "input", label: "Input", color: "var(--chart-2)" },
  { key: "output", label: "Output", color: "var(--chart-3)" },
  { key: "cache", label: "Cache read", color: "var(--muted-foreground)" },
] as const;

export type TimelineLegendEntry = {
  key: string;
  owner: string | null;
  total: number;
};

export type BranchPrActivityTimelineProps = {
  detail: BranchPageDetail;
  traceState?: BranchTraceState | null;
  isLoading?: boolean;
  actorDomain?: BranchActorColorDomain;
  activeHourStart?: string | null;
  activeFraction?: number | null;
  onScrubHour?: (hourStart: string) => void;
  loc?: PreferredBranchLoc;
  children?: ReactNode;
  className?: string;
};

/** Restricts timeline derivations to Sessions whose trace evidence loaded. */
export function detailForLoadedTimelineSessions(
  detail: BranchPageDetail,
  traceState?: BranchTraceState | null
): BranchPageDetail {
  if (!traceState) {
    return detail;
  }
  const loaded = new Set(
    traceState.sessions.flatMap((session) =>
      session.state === BranchTraceSessionHydrationState.Loaded
        ? [session.identity.artifactId]
        : []
    )
  );
  const sessions = detail.sessions.filter((session) =>
    loaded.has(session.sessionId)
  );
  const distinct = new Map(
    sessions.map((session) => [session.sessionId, session])
  );
  const loadedCost = [...distinct.values()].reduce(
    (sum, session) =>
      sum +
      (session.evenSplitCostUsd ??
        (session.estimatedCostUsd == null
          ? 0
          : session.estimatedCostUsd / Math.max(1, session.branchCount ?? 1))),
    0
  );
  return {
    ...detail,
    estimatedCostUsd: loadedCost,
    ...(detail.attributedCostUsd === undefined
      ? {}
      : {
          attributedCostUsd: resolveLoadedAttributedCost(
            detail.attributedCostUsd,
            loadedCost
          ),
        }),
    sessions,
  };
}

/** Adds the approved incomplete marker or unavailable claim to a derived value. */
export function formatTimelineEvidenceValue(
  value: string,
  traceEvidence: TimelineTraceEvidence,
  localEvidence?: { incomplete?: boolean; unavailable?: boolean }
): string {
  const claim = TRACE_EVIDENCE_CLAIM[traceEvidence];
  if (claim.unavailable || localEvidence?.unavailable) {
    return "Unavailable";
  }
  return (claim.incomplete || localEvidence?.incomplete) && value !== "—"
    ? `${value}*`
    : value;
}

/**
 * Explains loaded Session activity omitted from the rendered timeline, and the
 * other reason the headline cost can be a fallback.
 *
 * Every `*` this component renders must resolve to a sentence here — that is the
 * marker's whole contract. ISS-5951 added a second fallback reason (a Branch
 * with no attributed total of its own), so it gets its own sentence rather than
 * an unexplained asterisk. The wongk review added the third: aggregate trace
 * incompleteness marks figures from inside `formatTimelineEvidenceValue`, and
 * that marker had no sentence at all, so it shipped as a glyph a reader could
 * not resolve.
 */
export function formatTimelineCompletenessDisclosure(
  nonBucketableSessions: readonly TimelineSessionIdentity[],
  truncatedSessions: readonly TimelineSessionIdentity[],
  fallbackReasons: TimelineFallbackReasons = {}
): string | null {
  const parts: string[] = [];
  if (nonBucketableSessions.length > 0) {
    const labels = nonBucketableSessions.map(timelineSessionLabel).join(", ");
    parts.push(`Timing is unavailable for ${labels}.`);
  }
  if (truncatedSessions.length > 0) {
    const labels = truncatedSessions.map(timelineSessionLabel).join(", ");
    parts.push(
      `The ${MAX_TIMELINE_DAYS}-day timeline limit omits later activity for ${labels}.`
    );
  }
  if (parts.length > 0) {
    parts.push(
      "Cost and duration include only rendered activity with timing data."
    );
  }
  if (fallbackReasons.incompleteTraceEvidence) {
    parts.push(INCOMPLETE_TRACE_EVIDENCE_DISCLOSURE);
  }
  if (fallbackReasons.unpricedBranch) {
    parts.push(UNPRICED_BRANCH_COST_DISCLOSURE);
  }
  if (parts.length === 0) {
    return null;
  }
  return `* ${parts.join(" ")}`;
}

/** Resolves why linked Sessions cannot produce activity bars. */
export function resolveTimelineNoBarsMessage({
  columnCount,
  sourceSessionCount,
  sessionCount,
  traceCompleteness,
}: {
  columnCount: number;
  sourceSessionCount?: number;
  sessionCount: number;
  traceCompleteness?: BranchTraceCompletenessState;
}): string | null {
  if (
    sessionCount === 0 &&
    (sourceSessionCount ?? 0) > 0 &&
    traceCompleteness === BranchTraceCompletenessState.Unavailable
  ) {
    return "Session timing is unavailable, so spend can't be charted by hour.";
  }
  const sessionLabel = `${sessionCount} session${sessionCount === 1 ? "" : "s"}`;
  if (columnCount === 0) {
    return `${sessionLabel} ran on this branch, but their timing has no measurable duration, so spend can't be charted by hour.`;
  }
  return null;
}

/** Height for one sqrt-scaled timeline cost bar. */
export function timelineBarHeightPercent(
  column: TimelineColumn,
  maxTotal: number
): number {
  if (column.isGap) {
    return 0;
  }
  if (column.total <= 0 || maxTotal <= 0) {
    return MIN_BAR_PERCENT;
  }
  return Math.max(
    MIN_BAR_PERCENT,
    Math.round((Math.sqrt(column.total) / Math.sqrt(maxTotal)) * 100)
  );
}

function resolveLoadedAttributedCost(
  attributedCostUsd: number | null,
  loadedCostUsd: number
): number | null {
  if (attributedCostUsd === null) {
    return null;
  }
  return attributedCostUsd === 0 ? 0 : loadedCostUsd;
}

/**
 * Compact token count for a timeline tooltip. Delegates to the shared
 * `formatCompact` so the tier carry is guarded: an hour bucket just under a
 * tier ceiling reads `1M`, never the non-canonical `1000k` a hand-rolled
 * compactor emits. Bucket tokens are apportioned by span fraction, so round to
 * whole tokens first, and keep a dash for an empty split rather than `0`.
 */
export function formatTimelineTokens(value: number): string {
  const rounded = Math.round(value);
  return rounded ? formatCompact(rounded) : "—";
}

/** Accessible description for a cost bar and its actor breakdown. */
export function formatTimelineBarLabel(
  column: TimelineColumn,
  domain: BranchActorColorDomain
): string {
  const when = formatClock(Date.parse(column.hourStart));
  if (column.isGap) {
    return `${when} · idle`;
  }
  const breakdown = column.segments
    .map((segment) => {
      return `${domain.labelFor(segment.owner)} ${formatTimelineSegmentCost(segment)}`;
    })
    .join(" · ");
  return `${when} · ${formatCostPrecise(column.total)} · ${breakdown}`;
}

/** Honest cost presentation for activity whose spend may be incomplete. */
export function formatTimelineSegmentCost(
  segment: Pick<TimelineSegment, "costUnavailable" | "value">
): string {
  if (!segment.costUnavailable) {
    return formatCostPrecise(segment.value);
  }
  return segment.value > 0
    ? `${formatCostPrecise(segment.value)}*`
    : "Unavailable";
}

/** Stable cost-descending legend built from rendered timeline columns. */
export function buildTimelineLegend(
  columns: readonly TimelineColumn[]
): TimelineLegendEntry[] {
  const legendByOwner = new Map<string, TimelineLegendEntry>();
  for (const column of columns) {
    for (const segment of column.segments) {
      const entry = legendByOwner.get(segment.key) ?? {
        key: segment.key,
        owner: segment.owner,
        total: 0,
      };
      entry.total += segment.value;
      legendByOwner.set(segment.key, entry);
    }
  }
  return [...legendByOwner.values()].sort((left, right) => {
    const byCost = right.total - left.total;
    if (byCost !== 0) {
      return byCost;
    }
    return (left.owner ?? "").localeCompare(right.owner ?? "");
  });
}

/** Names the second fallback reason, so its `*` is never an orphan glyph. */
const UNPRICED_BRANCH_COST_DISCLOSURE =
  "This branch has no attributed cost of its own, so the total shown is the spend charted above.";

/** Names the third: figures derived from evidence that only partly arrived. */
const INCOMPLETE_TRACE_EVIDENCE_DISCLOSURE =
  "Some Session trace evidence could not be loaded, so these figures cover only the evidence that loaded.";

/** Why a rendered figure is a fallback, decided once by the predicate below. */
export type TimelineFallbackReasons = {
  /** The Branch carries no attributed total of its own. */
  unpricedBranch?: boolean;
  /** Aggregate trace evidence arrived only in part. */
  incompleteTraceEvidence?: boolean;
};

/**
 * The timeline headline cost, whether to mark it incomplete, and why.
 *
 * ISS-5951: these were two expressions. The VALUE fell back to the chartable
 * subtotal when `timingIncomplete || authoritativeCostUsd == null`; the MARKER
 * was decided separately, so the second of those two reasons rendered a fallback
 * figure with nothing saying it was one. Deciding all of it here is what stops
 * them drifting again — a caller cannot pair one with the other's answer,
 * because it asks once and gets one answer.
 *
 * `discloseFallbackReasons` is the ISS-4779 gate, and it is an INPUT rather
 * than a caller-side branch on the result: the rule for what counts as an
 * incomplete cost stays owned here, so the gate cannot become the second source
 * of truth this predicate exists to remove. With it off this predicate is the
 * shipped behavior exactly — `incomplete` is the historical `timingIncomplete`,
 * and `value` is the historical
 * `timingIncomplete || authoritativeCostUsd == null ? chartableCostUsd : authoritativeCostUsd`.
 *
 * That is why `sourceCostUnpriced` is gated inside `unpriced` rather than
 * OR-ed in unconditionally. It is a NEW reason to prefer the chartable subtotal,
 * and a new reason changes which NUMBER renders, not just whether a `*` appears:
 * a legacy Branch whose loaded trace rewrites its absent total to a real figure
 * while nothing charted is priced read `$0.00` before this change and would read
 * "Unavailable" after it. Leaking that onto the closed gate is precisely the
 * end-user-perceivable change the closed-by-default policy exists to hold back.
 *
 * wongk review — the three states where the two still disagreed:
 *
 * `sourceCostUnpriced` is carried SEPARATELY rather than inferred from
 * `authoritativeCostUsd`, because a loaded trace rewrites a legacy Branch's null
 * total to the loaded-Session subtotal before this call. Inferring absence from
 * the figure therefore read a normal settled number and dropped the marker while
 * the Branch still had no total of its own.
 *
 * `traceEvidenceIncomplete` joins the predicate because
 * `formatTimelineEvidenceValue` marks a figure from aggregate trace
 * incompleteness on its own. Left out, that marker rendered with no
 * `aria-describedby` and no sentence to point at.
 *
 * The unpriced reason additionally requires a non-null chartable figure: its
 * sentence claims the total shown IS the charted spend, which describes nothing
 * when no cost resolved at either end and the figure reads "Unavailable".
 *
 * shafty023 review — the fourth state. `traceEvidence` replaced a
 * `traceEvidenceIncomplete` boolean because that boolean answered `false` for
 * BOTH a confirmed-complete trace and a trace that never arrived, and the second
 * of those has no evidence to be complete. Missing evidence now short-circuits
 * every marker and fallback reason: with no boundary evidence there is no
 * defensible figure for a `*` to qualify, so the caller renders "Unavailable"
 * instead of marking a number nobody can stand behind.
 */
export type TimelineCostEvidence = {
  /** The figure to render; `null` when no cost resolved at all. */
  value: number | null;
  /**
   * No completeness evidence reached the timeline at all, so nothing derived
   * across the trace boundary is defensible and the figures read "Unavailable".
   *
   * Deliberately its own field. It is NOT `value === null` (a cost that was
   * looked for and genuinely did not resolve) and it is NOT a true `0` (a
   * Branch that really spent nothing) — collapsing absent evidence into either
   * of those is what let a legacy Branch render a confident `$5.00`.
   */
  evidenceMissing: boolean;
  /** Mark the figure, describe it, and disclose why. */
  incomplete: boolean;
  /** The fallback reason is an absent Branch total, not partial timing. */
  unpricedBranchFallback: boolean;
  /** The figure covers only the Session evidence that loaded. */
  incompleteTraceEvidence: boolean;
};

export function resolveTimelineCostEvidence({
  authoritativeCostUsd,
  sourceCostUnpriced,
  chartableCostUsd,
  timingIncomplete,
  traceEvidence,
  discloseFallbackReasons = false,
}: {
  authoritativeCostUsd: number | null;
  sourceCostUnpriced: boolean;
  chartableCostUsd: number | null;
  timingIncomplete: boolean;
  traceEvidence: TimelineTraceEvidence;
  discloseFallbackReasons?: boolean;
}): TimelineCostEvidence {
  const unpriced =
    authoritativeCostUsd === null ||
    (sourceCostUnpriced && discloseFallbackReasons);
  const usesChartableFallback = timingIncomplete || unpriced;
  const value = usesChartableFallback ? chartableCostUsd : authoritativeCostUsd;
  if (
    traceEvidence === TimelineTraceEvidence.Missing &&
    discloseFallbackReasons
  ) {
    return {
      value,
      evidenceMissing: true,
      incomplete: false,
      unpricedBranchFallback: false,
      incompleteTraceEvidence: false,
    };
  }
  const unpricedBranchFallback =
    unpriced && discloseFallbackReasons && chartableCostUsd !== null;
  const incompleteTraceEvidence =
    traceEvidence === TimelineTraceEvidence.Incomplete &&
    discloseFallbackReasons;
  return {
    value,
    evidenceMissing: false,
    incomplete:
      timingIncomplete || unpricedBranchFallback || incompleteTraceEvidence,
    unpricedBranchFallback,
    incompleteTraceEvidence,
  };
}

/**
 * The trace boundary's evidence for the timeline's derived figures.
 *
 * The first three members REUSE `BranchTraceCompletenessState`'s own values
 * rather than re-declaring them, so a value read straight off
 * `aggregateCompleteness.state` is already one of these. `Missing` is the fourth
 * state that contract cannot express: no `traceState` reached this component at
 * all, so the boundary produced no completeness evidence in either direction.
 *
 * shafty023 review: absent evidence used to be read as `!== Incomplete`, which
 * is the same answer a CONFIRMED-complete trace gives. `BranchSessionsTimelineTab`
 * passes `traceQuery.data ?? null`, and `NormalizedBranchTracePage` reserves that
 * null for legacy/failed responses with unknown membership — so a real, common
 * production window rendered as if the evidence had come back clean.
 */
export const TimelineTraceEvidence = {
  Complete: BranchTraceCompletenessState.Complete,
  Incomplete: BranchTraceCompletenessState.Incomplete,
  Unavailable: BranchTraceCompletenessState.Unavailable,
  Missing: "missing",
} as const;
export type TimelineTraceEvidence =
  (typeof TimelineTraceEvidence)[keyof typeof TimelineTraceEvidence];

/**
 * What each boundary state claims about a figure derived across it.
 *
 * A `Record` over the whole union rather than the two `if`s this replaced: those
 * named two members and let the other two fall through to an unmarked figure, so
 * a fifth state would have rendered as confidently as a confirmed-complete
 * trace — the exact collapse `Missing` was added to undo. Adding a member now
 * fails `tsc` here until someone says what it claims.
 *
 * `Missing` claims nothing of its own: the caller already resolves absent
 * evidence to `evidenceMissing` and passes it in as `localEvidence.unavailable`,
 * so restating it here would be the second source of truth ISS-5951 removed.
 */
const TRACE_EVIDENCE_CLAIM: Record<
  TimelineTraceEvidence,
  { incomplete: boolean; unavailable: boolean }
> = {
  [TimelineTraceEvidence.Complete]: { incomplete: false, unavailable: false },
  [TimelineTraceEvidence.Incomplete]: { incomplete: true, unavailable: false },
  [TimelineTraceEvidence.Unavailable]: { incomplete: false, unavailable: true },
  [TimelineTraceEvidence.Missing]: { incomplete: false, unavailable: false },
};

/** Reads the trace boundary, keeping absent evidence distinct from complete. */
export function resolveTimelineTraceEvidence(
  traceState?: BranchTraceState | null
): TimelineTraceEvidence {
  if (!traceState) {
    return TimelineTraceEvidence.Missing;
  }
  return traceState.aggregateCompleteness.state;
}

function timelineSessionLabel(session: TimelineSessionIdentity): string {
  for (const candidate of [
    session.slug,
    session.name,
    session.navigableRef,
    session.sessionId,
  ]) {
    const label = candidate?.trim();
    if (label) {
      return label;
    }
  }
  return session.sessionId;
}
