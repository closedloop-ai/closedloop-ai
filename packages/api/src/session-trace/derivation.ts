import {
  SessionTraceCorrectionSourceKind as ContractSessionTraceCorrectionKind,
  SessionTracePhaseSourceType as ContractSessionTracePhaseSourceType,
  SessionTraceThrottleSourceType as ContractSessionTraceThrottleSourceType,
  type PhaseIterations,
  type PhaseLoopback,
  type SessionMarker,
  type SessionPhase,
  type SessionPR,
  type SessionThrottle,
  type SessionTraceCorrectionSource,
  type SessionTracePhaseSource,
  type SessionTraceThrottleSource,
} from "../types/agent-session.ts";
import { PullRequestState } from "../types/document.ts";

export const SessionTracePhaseSourceType = ContractSessionTracePhaseSourceType;
export const SessionTraceThrottleSourceType =
  ContractSessionTraceThrottleSourceType;
export const SessionTraceCorrectionKind = ContractSessionTraceCorrectionKind;

export const SessionPrLifecycleStatus = {
  Merged: "merged",
  Closed: "closed",
  Open: "open",
  Unknown: "unknown",
} as const;
export type SessionPrLifecycleStatus =
  (typeof SessionPrLifecycleStatus)[keyof typeof SessionPrLifecycleStatus];

export const AutonomyLabel = {
  Unknown: "Unknown",
  Manual: "Manual",
  Mixed: "Mixed",
  Agentic: "Agentic",
} as const;
export type AutonomyLabel = (typeof AutonomyLabel)[keyof typeof AutonomyLabel];

export const SESSION_TRACE_SOURCE_LIMITS = {
  phaseSources: 100,
  throttleSources: 100,
  correctionSources: 100,
  sourceText: 300,
  aggregatePayloadBytes: 64_000,
} as const;

const AUTONOMY_LONG_STRETCH_MS = 5 * 60 * 1000;
const AUTONOMY_AGENTIC_MEDIAN_MS = 15 * 60 * 1000;
const AUTONOMY_PROMPT_BURST_MS = 90 * 1000;
const AUTONOMY_LIGHT_STEERING_PER_HOUR = 2;
const AUTONOMY_HEAVY_STEERING_PER_HOUR = 20;
const TITLEIZE_SPLIT_PATTERN = /[-_\s]+/;

type AutonomyInput = {
  promptTimestamps: readonly string[];
  activityTimestamps: readonly string[];
};

type TracePresentationInput = {
  startedAt: string;
  updatedAt: string;
  endedAt?: string | null;
  promptTimestamps: readonly string[];
  activityTimestamps: readonly string[];
  phaseSources?: readonly SessionTracePhaseSource[] | null;
  throttleSources?: readonly SessionTraceThrottleSource[] | null;
  correctionSources?: readonly SessionTraceCorrectionSource[] | null;
};

/**
 * Convert numeric autonomy into the canonical user-facing bucket. The score
 * remains nullable in transport; labels are derived at render/projection time.
 */
export function getAutonomyLabel(
  score: number | null | undefined
): AutonomyLabel {
  if (score == null) {
    return AutonomyLabel.Unknown;
  }
  if (score < 35) {
    return AutonomyLabel.Manual;
  }
  if (score < 70) {
    return AutonomyLabel.Mixed;
  }
  return AutonomyLabel.Agentic;
}

/**
 * Reuse the workflow prompt-episode formula without inspecting prompt text.
 * Returns null autonomy when timestamps are insufficient for a durable score.
 */
export function deriveAutonomyAndSteering(input: AutonomyInput): {
  autonomy: number | null;
  steeringEpisodes: number | null;
} {
  const promptTimes = sortedFiniteTimes(input.promptTimestamps);
  const activityTimes = sortedFiniteTimes(input.activityTimestamps);
  if (promptTimes.length === 0 || activityTimes.length === 0) {
    return { autonomy: null, steeringEpisodes: null };
  }

  const episodes = groupPromptEpisodes(promptTimes);
  const steeringEpisodes = Math.max(0, episodes.length - 1);
  const firstActivity = activityTimes[0]!;
  const lastActivity = activityTimes.at(-1)!;
  if (lastActivity <= firstActivity) {
    return { autonomy: null, steeringEpisodes };
  }

  const stretches: number[] = [];
  for (let index = 0; index < episodes.length; index++) {
    const current = episodes[index]!;
    const next = episodes[index + 1];
    const stretchStart = Math.max(current.end, firstActivity);
    const stretchEnd = Math.min(next?.start ?? lastActivity, lastActivity);
    if (stretchEnd > stretchStart) {
      stretches.push(stretchEnd - stretchStart);
    }
  }
  if (stretches.length === 0) {
    return { autonomy: null, steeringEpisodes };
  }

  const medianStretch = median(stretches);
  const totalStretch = stretches.reduce((sum, value) => sum + value, 0);
  const longStretchShare =
    totalStretch > 0
      ? stretches
          .filter((value) => value >= AUTONOMY_LONG_STRETCH_MS)
          .reduce((sum, value) => sum + value, 0) / totalStretch
      : 0;
  const hours = Math.max((lastActivity - firstActivity) / 3_600_000, 1 / 60);
  const steeringPerHour = steeringEpisodes / hours;

  const medianScore = clamp01(medianStretch / AUTONOMY_AGENTIC_MEDIAN_MS);
  const longStretchScore = clamp01(longStretchShare);
  const steeringScore =
    1 -
    clamp01(
      (steeringPerHour - AUTONOMY_LIGHT_STEERING_PER_HOUR) /
        (AUTONOMY_HEAVY_STEERING_PER_HOUR - AUTONOMY_LIGHT_STEERING_PER_HOUR)
    );
  return {
    autonomy: Math.round(
      clamp01(
        medianScore * 0.45 + longStretchScore * 0.35 + steeringScore * 0.2
      ) * 100
    ),
    steeringEpisodes,
  };
}

/**
 * Derive compact Session Trace presentation fields from normalized safe source
 * records. Raw source arrays stay on sync/detail contracts only.
 */
export function deriveSessionTracePresentation(input: TracePresentationInput): {
  autonomy: number | null;
  steeringEpisodes: number | null;
  phases: SessionPhase[];
  phaseIterations: PhaseIterations;
  phaseLoopbacks: PhaseLoopback[];
  throttles: SessionThrottle[];
  correctionMarkers: SessionMarker[];
} {
  const autonomy = deriveAutonomyAndSteering({
    promptTimestamps: input.promptTimestamps,
    activityTimestamps: input.activityTimestamps,
  });
  const phases = derivePhases(input.phaseSources ?? []);
  return {
    ...autonomy,
    phases: phases.phases,
    phaseIterations: phases.phaseIterations,
    phaseLoopbacks: phases.phaseLoopbacks,
    throttles: deriveThrottles(input),
    correctionMarkers: deriveCorrectionMarkers(input),
  };
}

/** Map authoritative PR fields to the Session Trace lifecycle status. */
export function derivePrLifecycleStatus(input: {
  prState?: string | null;
  closedAt?: string | Date | null;
  mergedAt?: string | Date | null;
}): SessionPrLifecycleStatus {
  if (input.mergedAt || input.prState === PullRequestState.Merged) {
    return SessionPrLifecycleStatus.Merged;
  }
  if (input.closedAt || input.prState === PullRequestState.Closed) {
    return SessionPrLifecycleStatus.Closed;
  }
  if (input.prState === PullRequestState.Open) {
    return SessionPrLifecycleStatus.Open;
  }
  return SessionPrLifecycleStatus.Unknown;
}

export function sessionPrWithLifecycle(input: {
  num: number | string;
  title?: string | null;
  status?: string | null;
  prState?: string | null;
  closedAt?: string | Date | null;
  mergedAt?: string | Date | null;
}): SessionPR {
  return {
    num: input.num,
    title: input.title?.trim() || `PR #${input.num}`,
    status:
      input.status ??
      derivePrLifecycleStatus({
        prState: input.prState,
        closedAt: input.closedAt,
        mergedAt: input.mergedAt,
      }),
  };
}

function derivePhases(sources: readonly SessionTracePhaseSource[]): {
  phases: SessionPhase[];
  phaseIterations: PhaseIterations;
  phaseLoopbacks: PhaseLoopback[];
} {
  const byKey = new Map<string, SessionPhase>();
  const durationMsByKey = new Map<string, number>();
  const phaseIterations: PhaseIterations = {};
  const phaseLoopbacks: PhaseLoopback[] = [];
  const sorted = [...sources].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)
  );
  let previousKey: string | null = null;
  for (const source of sorted) {
    const key = source.phaseKey.trim();
    if (!key) {
      continue;
    }
    phaseIterations[key] = (phaseIterations[key] ?? 0) + 1;
    const existing = byKey.get(key);
    const durationMs = durationBetween(source.startedAt, source.endedAt);
    const cumulativeDurationMs = (durationMsByKey.get(key) ?? 0) + durationMs;
    durationMsByKey.set(key, cumulativeDurationMs);
    byKey.set(key, {
      key,
      label: source.label?.trim() || titleize(key),
      dur: formatDuration(cumulativeDurationMs),
      cost: "$0.00",
      cOut: existing?.cOut ?? 0,
      cCache: existing?.cCache ?? 0,
      cIn: existing?.cIn ?? 0,
    });
    if (previousKey && previousKey !== key && phaseIterations[key]! > 1) {
      phaseLoopbacks.push({
        from: previousKey,
        to: key,
        label: `${titleize(previousKey)} -> ${titleize(key)}`,
        depth: phaseIterations[key]!,
      });
    }
    previousKey = key;
  }
  return { phases: [...byKey.values()], phaseIterations, phaseLoopbacks };
}

function deriveThrottles(input: TracePresentationInput): SessionThrottle[] {
  const startMs = Date.parse(input.startedAt);
  const endMs = Date.parse(input.endedAt ?? input.updatedAt);
  const durationMs = Number.isFinite(endMs - startMs) ? endMs - startMs : 1;
  return (input.throttleSources ?? []).flatMap((source, index) => {
    const observedMs = Date.parse(source.observedAt);
    if (!Number.isFinite(observedMs)) {
      return [];
    }
    const retryMs = source.retryAfterSeconds
      ? observedMs + source.retryAfterSeconds * 1000
      : Date.parse(source.resetAt ?? source.observedAt);
    const throttleEndMs = Number.isFinite(retryMs) ? retryMs : observedMs;
    return [
      {
        x0: clampPercent(((observedMs - startMs) / durationMs) * 100),
        t0: source.observedAt,
        t1: new Date(Math.max(throttleEndMs, observedMs)).toISOString(),
        durMin: Math.max(0, (throttleEndMs - observedMs) / 60_000),
        tl: index,
      },
    ];
  });
}

function deriveCorrectionMarkers(
  input: TracePresentationInput
): SessionMarker[] {
  const startMs = Date.parse(input.startedAt);
  const endMs = Date.parse(input.endedAt ?? input.updatedAt);
  const durationMs = Number.isFinite(endMs - startMs) ? endMs - startMs : 1;
  return (input.correctionSources ?? []).flatMap((source, index) => {
    const observedMs = Date.parse(source.observedAt);
    if (!Number.isFinite(observedMs)) {
      return [];
    }
    return [
      {
        kind: "frust",
        x: clampPercent(((observedMs - startMs) / durationMs) * 100),
        t: source.observedAt,
        label: source.label?.trim() || titleize(source.kind),
        tl: index,
      },
    ];
  });
}

function sortedFiniteTimes(values: readonly string[]): number[] {
  return values
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

function groupPromptEpisodes(times: readonly number[]): {
  start: number;
  end: number;
}[] {
  const episodes: { start: number; end: number }[] = [];
  for (const time of times) {
    const current = episodes.at(-1);
    if (current && time - current.end <= AUTONOMY_PROMPT_BURST_MS) {
      current.end = time;
      continue;
    }
    episodes.push({ start: time, end: time });
  }
  return episodes;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function durationBetween(
  start: string,
  end: string | null | undefined
): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end ?? start);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, endMs - startMs)
    : 0;
}

function formatDuration(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function titleize(value: string): string {
  return value
    .split(TITLEIZE_SPLIT_PATTERN)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
