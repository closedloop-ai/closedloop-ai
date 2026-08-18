"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionSegment,
  BranchVisibleLifecyclePhase,
  type BranchVisibleLifecyclePhase as VisiblePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { formatDurationMs } from "@repo/app/shared/lib/format-duration-ms";
import { getActivityPhaseDisplay } from "../lib/activity-taxonomy-display";

export type BranchLeadTimeWaterfallProps = {
  detail: BranchPageDetail;
};

type WaterfallSegment = {
  durationMs: number;
  type: VisiblePhase | "idle";
};

type OutcomeTrack = {
  endLabel: "Closed" | "Merged";
  idleMs: number;
  incomplete: boolean;
  openedPct: number | null;
  outcomeLabel: "Abandonment Duration" | "Lead time for change";
  segments: WaterfallSegment[];
  totalMs: number;
};

const PHASE_PRECEDENCE: readonly VisiblePhase[] = [
  BranchVisibleLifecyclePhase.Rework,
  BranchVisibleLifecyclePhase.Review,
  BranchVisibleLifecyclePhase.Build,
];
const DISPLAY_PHASES: readonly VisiblePhase[] = [
  BranchVisibleLifecyclePhase.Build,
  BranchVisibleLifecyclePhase.Review,
  BranchVisibleLifecyclePhase.Rework,
];

/** Selected-cycle Build / Review / Rework / Idle outcome waterfall. */
export function BranchLeadTimeWaterfall({
  detail,
}: BranchLeadTimeWaterfallProps) {
  const track = buildOutcomeTrack(detail);
  const idlePct = track
    ? Math.round((track.idleMs / track.totalMs) * 100)
    : null;

  return (
    <section className="bq-lead">
      <div className="bq-sec-head">
        <span className="bq-sec-title">
          {track?.outcomeLabel ?? "Lead time for change"}
        </span>
        <span className="bq-sec-count">
          {track
            ? `${formatDurationMs(track.totalMs)}${track.incomplete ? "*" : ""} · ${idlePct}% idle`
            : "—"}
        </span>
      </div>
      {track ? <Waterfall track={track} /> : <UnavailableOutcome />}
    </section>
  );
}

function Waterfall({ track }: { track: OutcomeTrack }) {
  const phaseDurations = phaseDurationTotals(track.segments);
  const openedLabelEdge = waterfallOpenedLabelEdge(track.openedPct);
  return (
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
                      background: getActivityPhaseDisplay(segment.type).color,
                    }),
              }}
              title={`${phaseLabel(segment.type)} · ${formatDurationMs(segment.durationMs)}`}
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
              {formatDurationMs(phaseDurations.get(phase) ?? 0)}
            </b>
          </span>
        ))}
        <span className="bq-lead-kitem">
          <span className="bq-lead-ksw idle" />
          Idle / waiting
          <b className="font-mono">{formatDurationMs(track.idleMs)}</b>
        </span>
      </div>
      {track.incomplete ? (
        <p className="bq-lead-foot">
          * Calculated from available selected-cycle evidence.
        </p>
      ) : null}
    </>
  );
}

function UnavailableOutcome() {
  return (
    <p className="bq-lead-foot">
      Selected-cycle outcome evidence is unavailable or not applicable.
    </p>
  );
}

function buildOutcomeTrack(detail: BranchPageDetail): OutcomeTrack | null {
  const metrics = detail.canonicalMetrics;
  const selected = detail.selectedPullRequest;
  const attribution = detail.phaseAttribution;
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
  const idleMs = segments.reduce(
    (sum, segment) =>
      segment.type === "idle" ? sum + segment.durationMs : sum,
    0
  );
  const openedMs = selected.openedAt
    ? Date.parse(selected.openedAt)
    : Number.NaN;
  const openedPct =
    Number.isFinite(openedMs) && openedMs >= startMs && openedMs <= endMs
      ? ((openedMs - startMs) / outcome.value) * 100
      : null;
  return {
    endLabel: leadTime ? "Merged" : "Closed",
    idleMs,
    incomplete:
      outcome.partial ||
      attribution.coverage.completeness !==
        BranchPhaseAttributionCompleteness.Complete ||
      metrics.idleTimeMs.state === BranchMetricAvailability.Partial,
    openedPct,
    outcomeLabel: leadTime ? "Lead time for change" : "Abandonment Duration",
    segments,
    totalMs: outcome.value,
  };
}

function visibleOutcomeSegments(
  source: readonly BranchPhaseAttributionSegment[],
  startMs: number,
  endMs: number
): WaterfallSegment[] {
  const clipped = source.flatMap((segment) => {
    const start = Math.max(startMs, segment.startMs);
    const end = Math.min(endMs, segment.endMs);
    return end > start ? [{ end, phase: segment.phase, start }] : [];
  });
  const boundaries = [
    ...new Set([
      startMs,
      endMs,
      ...clipped.flatMap((segment) => [segment.start, segment.end]),
    ]),
  ].sort((left, right) => left - right);
  const result: WaterfallSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (!(start !== undefined && end !== undefined && end > start)) {
      continue;
    }
    const phase = PHASE_PRECEDENCE.find((candidate) =>
      clipped.some(
        (segment) =>
          segment.phase === candidate &&
          segment.start < end &&
          segment.end > start
      )
    );
    appendSegment(result, phase ?? "idle", end - start);
  }
  return result;
}

function appendSegment(
  target: WaterfallSegment[],
  type: WaterfallSegment["type"],
  durationMs: number
): void {
  const previous = target.at(-1);
  if (previous?.type === type) {
    previous.durationMs += durationMs;
  } else {
    target.push({ durationMs, type });
  }
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

function metricValue(
  result: BranchMetricResult<number>
): { partial: boolean; value: number } | null {
  if (
    (result.state !== BranchMetricAvailability.Complete &&
      result.state !== BranchMetricAvailability.Partial) ||
    result.value === null
  ) {
    return null;
  }
  return {
    partial: result.state === BranchMetricAvailability.Partial,
    value: Math.max(0, result.value),
  };
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
