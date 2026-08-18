/**
 * @file derivation.ts
 * @description Session Trace PRESENTATION derivation: phases and their
 * loopbacks, throttle spans, correction markers, PR lifecycle status, and the
 * marker-label clamp the cloud schema requires. Autonomy scoring lives beside
 * this in `./autonomy.ts` (FEA-3781) — `deriveSessionTracePresentation` composes
 * it, but it is a separate concern with its own consumers and version stamp.
 */

import {
  SessionPrLifecycleStatus as ContractSessionPrLifecycleStatus,
  type SessionPrLifecycleStatus as ContractSessionPrLifecycleStatusType,
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
} from "@repo/api/src/types/agent-session";
import { PullRequestState } from "@repo/api/src/types/document";
import { clampPercent } from "@repo/api/src/utils/math";
// Extensionless on purpose. `@repo/lib` is consumed as SOURCE (no dist), and
// this module is in `apps/api`'s Turbopack graph via the desktop-sync route —
// a `./autonomy.js` specifier resolves literally there and fails the Vercel
// build, even though tsc and vitest both accept it.
import { deriveAutonomyAndSteering } from "./autonomy";

export const SessionTracePhaseSourceType = ContractSessionTracePhaseSourceType;
export const SessionTraceThrottleSourceType =
  ContractSessionTraceThrottleSourceType;
export const SessionTraceCorrectionKind = ContractSessionTraceCorrectionKind;
export const SessionPrLifecycleStatus = ContractSessionPrLifecycleStatus;
export type SessionPrLifecycleStatus = ContractSessionPrLifecycleStatusType;

export const SESSION_TRACE_SOURCE_LIMITS = {
  phaseSources: 100,
  throttleSources: 100,
  correctionSources: 100,
  markers: 500,
  // Per-marker `label` cap. Mirrors the cloud's `sessionMarkerSchema.label`
  // `.max()` — an over-long label fails zod (`session_invalid`) and rejects the
  // whole sync batch, so the desktop must clamp at build time (FEA-2986).
  markerLabel: 300,
  sourceText: 300,
  aggregatePayloadBytes: 64_000,
} as const;

/**
 * Clamp a session-marker `label` to the cloud's `sessionMarkerSchema.label`
 * cap. Marker labels are sourced from free text (tool names, summaries, commit
 * and PR titles) that can exceed the cap; an unclamped label fails cloud zod
 * validation and — because the batch is parsed as one unit — drops up to 200
 * sessions (FEA-2986). Mirrors `sourceTextFromMetadata`'s slice on trace
 * sources; both are bounded by `SESSION_TRACE_SOURCE_LIMITS`.
 *
 * `.trim()` first because the cloud schema is `z.string().trim().min(1).max()`
 * — zod trims before measuring length, so slicing raw text could ship 300
 * leading-whitespace chars that the cloud trims down (or to empty), disagreeing
 * with this clamp. Trimming here keeps the desktop's length accounting
 * identical to the cloud's.
 */
export function clampMarkerLabel(label: string): string {
  return label.trim().slice(0, SESSION_TRACE_SOURCE_LIMITS.markerLabel);
}

/**
 * Resolve the END anchor (epoch ms) for a session/subagent duration from the
 * "genuine activity = latest event" principle (FEA-3427 / FEA-3451).
 *
 * `endedAt` is authoritative whenever it is present. For a subagent that is the
 * framework's genuine completion instant; for a session it is written once, at
 * the terminal-state transition, as the max event timestamp then known — see
 * `session-maintenance.ts` (`ended_at = last_activity_at`, FEA-3580) and the
 * cloud reaper (`stale-session-reaper-service.ts`, ISS-4586). Both derive it
 * from the events themselves, never from a sweep clock.
 *
 * ISS-5182 removed the `preferActivityOverEnded` escape hatch that let observed
 * activity outrank `endedAt`. FEA-3594 added it as defense-in-depth back when
 * the sweeper DID stamp `ended_at` with wall-clock time; FEA-3266/FEA-3580 then
 * fixed the sweepers, leaving the flag guarding a defect that no longer exists
 * — while introducing a worse one. `last_activity_at` keeps being recomputed at
 * ingest after a session goes terminal, so preferring it re-measured a finished
 * session to a timestamp days past its own end (ISS-5131: a 31h session
 * reported as 170h). A terminal session's end is frozen; nothing observed later
 * may move it. A later event that post-dates `endedAt` is a parser or status
 * defect to REPORT, not an anchor to adopt.
 *
 * Activity timestamps still answer for a session with no `endedAt` at all (the
 * still-running case), and `updatedAt` is the last resort when neither exists.
 * Shared SSOT so the desktop `resolveTraceEndMs` and the projection
 * `resolveAgentEndMs` cannot drift.
 */
export function resolveActivityEndMs(input: {
  endedAt: string | null | undefined;
  updatedAt: string | null | undefined;
  activityTimestamps: Iterable<string>;
}): number {
  let lastActivityMs = Number.NaN;
  for (const value of input.activityTimestamps) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && !(lastActivityMs >= ms)) {
      lastActivityMs = ms;
    }
  }
  // The `endedAt` leg is taken only when the value actually PARSES. A present
  // but unparseable `ended_at` would otherwise return `NaN` as the anchor, and
  // `NaN` is not "no end" downstream — it makes `buildTraceDurationFields` skip
  // `wallClock` and `buildTraceActivityFields` return `{}`, so `wallClock`,
  // `span`, `activityBuckets`, and `markers` are all OMITTED from the sync
  // payload. The cloud patch preserves omitted trace fields, so a row that had
  // already synced the pre-ISS-5182 inflated value would keep it, and no
  // reimport would ever clear it. Non-canonical stored timestamps are real here
  // — that is what the FEA-3743/ISS-5330 boot format heal exists for, and that
  // heal is best-effort and catch-isolated. Falling through to the activity and
  // `updatedAt` legs yields a finite anchor instead of a silent omission; it is
  // the same both-operands-must-parse rule `laterParsedEnd`
  // (`write-core-terminal-end.ts`) already applies to this column.
  const endedAtMs = input.endedAt ? Date.parse(input.endedAt) : Number.NaN;
  if (Number.isFinite(endedAtMs)) {
    return endedAtMs;
  }
  if (Number.isFinite(lastActivityMs)) {
    return lastActivityMs;
  }
  const updatedAtMs = input.updatedAt
    ? Date.parse(input.updatedAt)
    : Number.NaN;
  return Number.isFinite(updatedAtMs) ? updatedAtMs : Number.NaN;
}

const SESSION_TERMINATING_COMMANDS = /^\/(?:exit|quit)(?=\s|$)/i;

export function isSessionTerminatingLabel(label: string): boolean {
  return SESSION_TERMINATING_COMMANDS.test(label);
}

const TITLEIZE_SPLIT_PATTERN = /[-_\s]+/;

type TracePresentationInput = {
  startedAt: string;
  updatedAt: string;
  endedAt?: string | null;
  // FEA-3427: corrected wall-clock END anchor (epoch ms). When supplied it wins
  // over `endedAt ?? updatedAt` for all marker/throttle positioning, so the
  // correction/throttle `x`/`x0` coordinates land on the same short activity
  // span the activity buckets render against — not the days-long re-sync-bumped
  // `updated_at` window. Callers that don't correct the anchor omit it.
  endMs?: number;
  promptTimestamps: readonly string[];
  /** FEA-3781: agent activity ONLY — see `AutonomyInput` in `./autonomy.ts`. */
  agentActivityTimestamps: readonly string[];
  phaseSources?: readonly SessionTracePhaseSource[] | null;
  throttleSources?: readonly SessionTraceThrottleSource[] | null;
  correctionSources?: readonly SessionTraceCorrectionSource[] | null;
  // FEA-2870: forwarded to the autonomy deriver so a headless session scores 100.
  headless?: boolean;
};

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
    agentActivityTimestamps: input.agentActivityTimestamps,
    headless: input.headless,
    // FEA-3781: an un-ended session is still in flight, so an unmeasurable score
    // stays unknown rather than reading as a hard 0 mid-turn.
    sessionEnded: input.endedAt != null,
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

// FEA-3427: prefer the caller-corrected wall-clock end anchor (last real
// activity) over the mutable `endedAt ?? updatedAt` so marker/throttle
// coordinates align with the corrected activity span.
function resolvePresentationEndMs(input: TracePresentationInput): number {
  if (input.endMs !== undefined && Number.isFinite(input.endMs)) {
    return input.endMs;
  }
  return Date.parse(input.endedAt ?? input.updatedAt);
}

function deriveThrottles(input: TracePresentationInput): SessionThrottle[] {
  const startMs = Date.parse(input.startedAt);
  const endMs = resolvePresentationEndMs(input);
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
  const endMs = resolvePresentationEndMs(input);
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
        // Third synced marker-label sink (alongside buildTraceMarkers and
        // buildCandidate): clamp so a long correction label can't fail the
        // cloud cap and reject the batch. Today `source.label` is already
        // bounded to `sourceText` (300) upstream, but routing it through the
        // shared helper makes the invariant explicit, not coincidental on
        // `sourceText === markerLabel` (FEA-2986).
        label: clampMarkerLabel(source.label?.trim() || titleize(source.kind)),
        tl: index,
      },
    ];
  });
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
