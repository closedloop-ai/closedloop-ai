"use client";

import type {
  BranchPageDetail,
  BranchSelectedPullRequestDetail,
} from "@repo/api/src/types/branch";
import {
  BRANCH_METRIC_DICTIONARY,
  BranchMetricAvailability,
  BranchMetricId,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
  type BranchVisibleLifecyclePhase as VisiblePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { useMemo } from "react";
import { getActivityPhaseDisplay } from "../lib/activity-taxonomy-display";
import {
  type DisplayableBranchMetricValue,
  displayableBranchMetricValue,
  shippedClampedBranchMetricValue,
} from "../lib/branch-metric-value";
import {
  BRANCH_OUTCOME_BREAKDOWN_TITLE,
  BRANCH_OUTCOME_EVIDENCE_ABSENT,
  BRANCH_OUTCOME_EVIDENCE_CAPPED_FOOTNOTE,
  BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE,
  BRANCH_OUTCOME_IDLE_UNAVAILABLE_FOOTNOTE,
  BRANCH_OUTCOME_IDLE_UNAVAILABLE_SUMMARY,
  branchPullRequestCycleAbsence,
} from "../lib/branch-outcome-copy";
import {
  visibleOutcomeSegments,
  type WaterfallSegment,
} from "../lib/branch-outcome-waterfall-segments";
import { formatBranchDurationMs } from "../lib/format-branch-duration-ms";

export type BranchLeadTimeWaterfallProps = {
  detail: BranchPageDetail;
};

type OutcomeTrack = {
  endLabel: "Closed" | "Merged";
  evidenceCapped: boolean;
  evidenceIncomplete: boolean;
  idleMs: number;
  idlePartial: boolean;
  idleUnavailable: boolean;
  openedPct: number | null;
  outcomeLabel: string;
  outcomePartial: boolean;
  segments: WaterfallSegment[] | null;
  totalMs: number;
};

type OutcomeTrackBase = {
  attribution: NonNullable<BranchPageDetail["phaseAttribution"]>;
  leadTime: DisplayableBranchMetricValue | null;
  metrics: NonNullable<BranchPageDetail["canonicalMetrics"]>;
  openedPct: number | null;
  outcome: DisplayableBranchMetricValue;
  segments: WaterfallSegment[];
};

const DISPLAY_PHASES: readonly VisiblePhase[] = [
  BranchVisibleLifecyclePhase.Build,
  BranchVisibleLifecyclePhase.Review,
  BranchVisibleLifecyclePhase.Rework,
];

/** Selected-cycle Build / Review / Rework / Idle outcome waterfall. */
export function BranchLeadTimeWaterfall({
  detail,
}: BranchLeadTimeWaterfallProps) {
  const honest = useFeatureFlagEnabledOptional(
    BRANCH_DETAIL_METRIC_HONESTY_FEATURE_FLAG_KEY
  );
  const { canonicalMetrics, phaseAttribution, selectedPullRequest } = detail;
  // ISS-7039: the track builders sweep every attributed phase segment on the
  // branch. Query structural sharing keeps `detail` itself stable across a poll
  // that changed nothing, so the render this saves is the one where something
  // ELSE moved — a check, a comment, a timeline row — handing down a new
  // `detail` whose attribution inputs are the identical references. Keying on
  // exactly the three fields the sweep reads is what makes that render free.
  const track = useMemo(
    () =>
      honest
        ? buildHonestOutcomeTrack(
            canonicalMetrics,
            selectedPullRequest,
            phaseAttribution
          )
        : buildShippedOutcomeTrack(
            canonicalMetrics,
            selectedPullRequest,
            phaseAttribution
          ),
    [honest, canonicalMetrics, selectedPullRequest, phaseAttribution]
  );
  const format = honest ? formatBranchDurationMs : formatDurationMs;
  // ISS-6957, the same fix one section down. This waterfall breaks down the
  // SELECTED pull request's cycle, so with no pull request selected the reason
  // there is no track is the pull request, not the evidence — and it is the same
  // reason the two cycle cards above already state. Reading it from the one
  // helper is what stops the section contradicting the cards it decomposes.
  const cycleAbsence = honest
    ? branchPullRequestCycleAbsence(
        detail.associatedPullRequests,
        Boolean(detail.selectedPullRequest)
      )
    : null;

  return (
    <section className="bq-lead">
      <div className="bq-sec-head">
        <span className="bq-sec-title">
          {honest
            ? BRANCH_OUTCOME_BREAKDOWN_TITLE
            : (track?.outcomeLabel ??
              BRANCH_METRIC_DICTIONARY[BranchMetricId.LeadTime].label)}
        </span>
        <span className="bq-sec-count">
          {track
            ? `${format(track.totalMs)}${track.outcomePartial ? "*" : ""} · ${idleSummary(track)}`
            : "—"}
        </span>
      </div>
      {track ? (
        <Waterfall format={format} track={track} />
      ) : (
        <AbsentOutcome reason={cycleAbsence?.detail ?? null} />
      )}
    </section>
  );
}

function Waterfall({
  format,
  track,
}: {
  format: (ms: number) => string;
  track: OutcomeTrack;
}) {
  const phaseDurations = track.segments
    ? phaseDurationTotals(track.segments)
    : null;
  const openedLabelEdge = track.segments
    ? waterfallOpenedLabelEdge(track.openedPct)
    : null;
  return (
    <>
      {track.segments ? (
        <>
          <div className="bq-lead-track-wrap">
            <div className="bq-lead-track">
              {track.segments.map((segment, index) => (
                <span
                  className={
                    segment.type === "idle" ? "bq-lead-gap" : "bq-lead-seg"
                  }
                  // biome-ignore lint/suspicious/noArrayIndexKey: waterfall slices are positional.
                  key={`${segment.type}-${index}`}
                  style={{
                    width: `${(segment.durationMs / track.totalMs) * 100}%`,
                    ...(segment.type === "idle"
                      ? {}
                      : {
                          background: getActivityPhaseDisplay(segment.type)
                            .color,
                        }),
                  }}
                  title={`${phaseLabel(segment.type)} · ${format(segment.durationMs)}`}
                />
              ))}
            </div>
            {track.openedPct === null ? null : (
              <span
                aria-hidden
                className="bq-lead-pr-opened-marker"
                style={{ left: `${track.openedPct}%` }}
              />
            )}
          </div>
          <div
            className="bq-lead-axis"
            data-pr-opened-edge={openedLabelEdge ?? undefined}
          >
            <span className="font-mono">First code pushed</span>
            {track.openedPct === null ? null : (
              <span
                className="bq-lead-pr-opened-label font-mono"
                data-edge={openedLabelEdge ?? undefined}
                style={{ left: `${track.openedPct}%` }}
              >
                PR opened
              </span>
            )}
            <span className="font-mono">{track.endLabel}</span>
          </div>
          <div className="bq-lead-key">
            {DISPLAY_PHASES.map((phase) => (
              <span className="bq-lead-kitem" key={phase}>
                <span
                  className="bq-lead-ksw"
                  style={{ background: getActivityPhaseDisplay(phase).color }}
                />
                {getActivityPhaseDisplay(phase).label}
                <b className="font-mono">
                  {format(phaseDurations?.get(phase) ?? 0)}
                </b>
              </span>
            ))}
            <span className="bq-lead-kitem">
              <span className="bq-lead-ksw idle" />
              Idle / waiting
              <b className="font-mono">
                {track.idleUnavailable ? "Unavailable" : format(track.idleMs)}
              </b>
            </span>
          </div>
        </>
      ) : null}
      {track.evidenceIncomplete ? (
        <p className="bq-lead-foot">
          {track.evidenceCapped
            ? BRANCH_OUTCOME_EVIDENCE_CAPPED_FOOTNOTE
            : BRANCH_OUTCOME_EVIDENCE_INCOMPLETE_FOOTNOTE}
        </p>
      ) : null}
      {track.idleUnavailable ? (
        <p className="bq-lead-foot">
          {BRANCH_OUTCOME_IDLE_UNAVAILABLE_FOOTNOTE}
        </p>
      ) : null}
    </>
  );
}

/**
 * Why there is no waterfall. `reason` is the pull-request reason when the pull
 * request is what is missing; `null` keeps the shipped sentence, which is the
 * honest one once a pull request IS selected and the evidence still is not there.
 */
function AbsentOutcome({ reason }: { reason: string | null }) {
  return (
    <p className="bq-lead-foot">{reason ?? BRANCH_OUTCOME_EVIDENCE_ABSENT}</p>
  );
}

function buildHonestOutcomeTrack(
  metrics: BranchPageDetail["canonicalMetrics"],
  selected: BranchSelectedPullRequestDetail | null | undefined,
  attribution: BranchPhaseAttributionResult | undefined
): OutcomeTrack | null {
  const base = buildOutcomeTrackBase(
    metrics,
    selected,
    attribution,
    displayableBranchMetricValue
  );
  if (!base) {
    return null;
  }
  const idleMetric = displayableBranchMetricValue(base.metrics.idleTimeMs);
  const inferredIdleMs = segmentIdleDurationMs(base.segments);
  const idleUnavailable = !(
    idleMetric &&
    idleMetric.value <= base.outcome.value &&
    idleMetric.value === inferredIdleMs
  );
  return {
    endLabel: base.leadTime ? "Merged" : "Closed",
    evidenceCapped: attributionCoverageCapped(base.attribution),
    evidenceIncomplete:
      base.outcome.partial ||
      base.attribution.coverage.completeness !==
        BranchPhaseAttributionCompleteness.Complete ||
      Boolean(idleMetric?.partial),
    idleMs: idleMetric?.value ?? 0,
    idlePartial: Boolean(idleMetric?.partial),
    idleUnavailable,
    openedPct: base.openedPct,
    outcomeLabel: base.leadTime
      ? BRANCH_METRIC_DICTIONARY[BranchMetricId.LeadTime].label
      : BRANCH_METRIC_DICTIONARY[BranchMetricId.AbandonmentTime].label,
    outcomePartial: base.outcome.partial,
    segments: idleUnavailable ? null : base.segments,
    totalMs: base.outcome.value,
  };
}

function buildShippedOutcomeTrack(
  metrics: BranchPageDetail["canonicalMetrics"],
  selected: BranchSelectedPullRequestDetail | null | undefined,
  attribution: BranchPhaseAttributionResult | undefined
): OutcomeTrack | null {
  const base = buildOutcomeTrackBase(
    metrics,
    selected,
    attribution,
    shippedClampedBranchMetricValue
  );
  if (!base) {
    return null;
  }
  const incomplete =
    base.outcome.partial ||
    base.attribution.coverage.completeness !==
      BranchPhaseAttributionCompleteness.Complete ||
    base.metrics.idleTimeMs.state === BranchMetricAvailability.Partial;
  return {
    endLabel: base.leadTime ? "Merged" : "Closed",
    evidenceCapped: attributionCoverageCapped(base.attribution),
    evidenceIncomplete: incomplete,
    idleMs: segmentIdleDurationMs(base.segments),
    idlePartial: false,
    idleUnavailable: false,
    openedPct: base.openedPct,
    outcomeLabel: base.leadTime
      ? BRANCH_METRIC_DICTIONARY[BranchMetricId.LeadTime].label
      : BRANCH_METRIC_DICTIONARY[BranchMetricId.AbandonmentTime].label,
    outcomePartial: incomplete,
    segments: base.segments,
    totalMs: base.outcome.value,
  };
}

function buildOutcomeTrackBase(
  metrics: BranchPageDetail["canonicalMetrics"],
  selected: BranchSelectedPullRequestDetail | null | undefined,
  attribution: BranchPhaseAttributionResult | undefined,
  metricValue: (
    result: BranchMetricResult<number> | undefined
  ) => DisplayableBranchMetricValue | null
): OutcomeTrackBase | null {
  if (!(metrics && selected && attribution)) {
    return null;
  }
  const leadTime = metricValue(metrics.leadTimeMs);
  const abandonment = metricValue(metrics.abandonmentTimeMs);
  const outcome = leadTime ?? abandonment;
  const terminalAt = selected.mergedAt ?? selected.closedAt;
  if (!(outcome && terminalAt)) {
    return null;
  }
  const endMs = Date.parse(terminalAt);
  const startMs = endMs - outcome.value;
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)
  ) {
    return null;
  }
  const segments = visibleOutcomeSegments(attribution.segments, startMs, endMs);
  if (segments.length === 0) {
    return null;
  }
  const openedMs = selected.openedAt
    ? Date.parse(selected.openedAt)
    : Number.NaN;
  const openedPct =
    Number.isFinite(openedMs) && openedMs >= startMs && openedMs <= endMs
      ? ((openedMs - startMs) / outcome.value) * 100
      : null;
  return {
    attribution,
    leadTime,
    metrics,
    openedPct,
    outcome,
    segments,
  };
}

function phaseDurationTotals(
  segments: readonly WaterfallSegment[]
): Map<VisiblePhase, number> {
  const totals = new Map<VisiblePhase, number>();
  for (const segment of segments) {
    if (segment.type !== "idle") {
      totals.set(
        segment.type,
        (totals.get(segment.type) ?? 0) + segment.durationMs
      );
    }
  }
  return totals;
}

function phaseLabel(type: WaterfallSegment["type"]): string {
  return type === "idle"
    ? "Idle / waiting"
    : getActivityPhaseDisplay(type).label;
}

function segmentIdleDurationMs(segments: readonly WaterfallSegment[]): number {
  return segments.reduce(
    (sum, segment) =>
      segment.type === "idle" ? sum + segment.durationMs : sum,
    0
  );
}

function idleSummary(track: OutcomeTrack): string {
  if (track.idleUnavailable) {
    return BRANCH_OUTCOME_IDLE_UNAVAILABLE_SUMMARY;
  }
  const idlePct = Math.round((track.idleMs / track.totalMs) * 100);
  return `${idlePct}% idle${track.idlePartial ? "*" : ""}`;
}

function waterfallOpenedLabelEdge(
  openedPct: number | null
): "end" | "start" | null {
  if (openedPct === null) {
    return null;
  }
  if (openedPct < 20) {
    return "start";
  }
  return openedPct > 80 ? "end" : null;
}

function attributionCoverageCapped(
  attribution: BranchPhaseAttributionResult
): boolean {
  return (
    attribution.coverage.completeness !==
      BranchPhaseAttributionCompleteness.Complete &&
    attribution.coverage.reason ===
      BranchPhaseAttributionCompletenessReason.CoverageCapped
  );
}
