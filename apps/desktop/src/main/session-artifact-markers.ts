import type { SessionMarker } from "./agent-session-sync-contract.js";
import { parseIsoMs, roundNumber } from "./session-marker-utils.js";

export type ArtifactMarkerLinkRow = {
  target_kind: string;
  relation: string | null;
  repo_full_name: string | null;
  pr_number: number | null;
  sha: string | null;
  title: string | null;
  link_observed_at: string | null;
  artifact_committed_at: string | null;
  artifact_observed_at: string | null;
  artifact_last_seen_at: string | null;
};

export type ArtifactMarkerTimelineRow = {
  createdAt: string;
};

export type BuildArtifactSessionMarkersInput = {
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
  links: readonly ArtifactMarkerLinkRow[];
  timelineRows: readonly ArtifactMarkerTimelineRow[];
};

type ArtifactMarkerCandidate = SessionMarker & {
  identity: string;
  timestampMs: number;
};

/**
 * Derives commit/PR timeline markers from canonical local artifact links.
 * Relation and identity gates live here so projection SQL can stay broad and
 * older rows fail closed when required marker fields are missing.
 */
export function buildArtifactSessionMarkers(
  input: BuildArtifactSessionMarkersInput
): SessionMarker[] {
  const sessionStartMs = parseIsoMs(input.startedAt);
  const sessionEndMs = parseIsoMs(input.endedAt ?? input.updatedAt);
  const timelineMs = input.timelineRows.map((row) => parseIsoMs(row.createdAt));
  const candidates = new Map<string, ArtifactMarkerCandidate>();

  for (const link of input.links) {
    const candidate =
      link.target_kind === "commit"
        ? commitMarkerCandidate(link, sessionStartMs, sessionEndMs, timelineMs)
        : prMarkerCandidate(link, sessionStartMs, sessionEndMs, timelineMs);
    if (!candidate) {
      continue;
    }
    const existing = candidates.get(candidate.identity);
    if (!existing || candidate.timestampMs < existing.timestampMs) {
      candidates.set(candidate.identity, candidate);
    }
  }

  return [...candidates.values()]
    .sort((left, right) => {
      const byTime = left.timestampMs - right.timestampMs;
      return byTime === 0
        ? left.identity.localeCompare(right.identity)
        : byTime;
    })
    .map(
      ({ identity: _identity, timestampMs: _timestampMs, ...marker }) => marker
    );
}

/**
 * Preserves trace/correction markers, drops artifact markers that are
 * equivalent to trace markers, and returns one timeline-ordered marker list for
 * renderers that derive active state by scanning marker order.
 */
export function mergeSessionMarkers(
  traceMarkers: readonly SessionMarker[],
  artifactMarkers: readonly SessionMarker[]
): SessionMarker[] {
  const seenTraceKeys = new Set(traceMarkers.map(markerDisplayIdentity));
  return [
    ...traceMarkers.map((marker, index) => ({
      marker,
      sourceOrder: 0,
      originalIndex: index,
    })),
    ...artifactMarkers
      .filter(
        (marker) =>
          !(
            seenTraceKeys.has(markerDisplayIdentity(marker)) ||
            hasTraceMarkerAtSameTimelineAnchor(marker, traceMarkers)
          )
      )
      .map((marker, index) => ({
        marker,
        sourceOrder: 1,
        originalIndex: index,
      })),
  ]
    .sort((left, right) => {
      const byTimeline =
        markerTimelineOrder(left.marker) - markerTimelineOrder(right.marker);
      if (byTimeline !== 0) {
        return byTimeline;
      }
      const byTimestamp =
        markerTimestampOrder(left.marker) - markerTimestampOrder(right.marker);
      if (byTimestamp !== 0) {
        return byTimestamp;
      }
      const bySource = left.sourceOrder - right.sourceOrder;
      return bySource === 0
        ? left.originalIndex - right.originalIndex
        : bySource;
    })
    .map((entry) => entry.marker);
}

function commitMarkerCandidate(
  link: ArtifactMarkerLinkRow,
  sessionStartMs: number,
  sessionEndMs: number,
  timelineMs: readonly number[]
): ArtifactMarkerCandidate | null {
  const sha = normalizedText(link.sha);
  if (link.relation !== "created" || !sha) {
    return null;
  }
  const timestamp = firstValidTimestamp([
    link.link_observed_at,
    link.artifact_committed_at,
    link.artifact_last_seen_at,
  ]);
  if (!timestamp) {
    return null;
  }
  return buildCandidate({
    kind: "commit",
    identity: `commit:${normalizedText(link.repo_full_name) ?? ""}:${sha}`,
    label: normalizedText(link.title) ?? shortSha(sha),
    timestamp,
    sessionStartMs,
    sessionEndMs,
    timelineMs,
  });
}

function prMarkerCandidate(
  link: ArtifactMarkerLinkRow,
  sessionStartMs: number,
  sessionEndMs: number,
  timelineMs: readonly number[]
): ArtifactMarkerCandidate | null {
  if (
    link.target_kind !== "pull_request" ||
    !(link.relation === "created" || link.relation === "workspace") ||
    !normalizedText(link.repo_full_name) ||
    link.pr_number == null
  ) {
    return null;
  }
  const timestamp = firstValidTimestamp([
    link.link_observed_at,
    link.artifact_observed_at,
    link.artifact_last_seen_at,
  ]);
  if (!timestamp) {
    return null;
  }
  const title = normalizedText(link.title);
  return buildCandidate({
    kind: "pr",
    identity: `pr:${link.repo_full_name}#${link.pr_number}`,
    label: title
      ? `PR #${link.pr_number} opened: ${title}`
      : `PR #${link.pr_number} opened`,
    timestamp,
    sessionStartMs,
    sessionEndMs,
    timelineMs,
  });
}

function buildCandidate(input: {
  kind: "commit" | "pr";
  identity: string;
  label: string;
  timestamp: { value: string; ms: number };
  sessionStartMs: number;
  sessionEndMs: number;
  timelineMs: readonly number[];
}): ArtifactMarkerCandidate {
  const durationMs =
    Number.isFinite(input.sessionStartMs) &&
    Number.isFinite(input.sessionEndMs) &&
    input.sessionEndMs >= input.sessionStartMs
      ? Math.max(1, input.sessionEndMs - input.sessionStartMs)
      : 1;
  const x = Number.isFinite(input.sessionStartMs)
    ? ((input.timestamp.ms - input.sessionStartMs) / durationMs) * 100
    : 0;
  return {
    kind: input.kind,
    identity: input.identity,
    timestampMs: input.timestamp.ms,
    x: roundNumber(Math.max(0, Math.min(100, x))),
    t: input.timestamp.value,
    label: input.label,
    tl: nearestTimelineIndex(input.timestamp.ms, input.timelineMs),
  };
}

function firstValidTimestamp(
  values: readonly (string | null | undefined)[]
): { value: string; ms: number } | null {
  for (const value of values) {
    const ms = parseIsoMs(value);
    if (Number.isFinite(ms)) {
      return { value: value as string, ms };
    }
  }
  return null;
}

function nearestTimelineIndex(
  markerMs: number,
  timelineMs: readonly number[]
): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  timelineMs.forEach((rowMs, index) => {
    if (!Number.isFinite(rowMs)) {
      return;
    }
    const distance = Math.abs(rowMs - markerMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function markerDisplayIdentity(marker: SessionMarker): string {
  return `${marker.kind}:${marker.label}`;
}

function hasTraceMarkerAtSameTimelineAnchor(
  marker: SessionMarker,
  traceMarkers: readonly SessionMarker[]
): boolean {
  return (
    isArtifactMarkerKind(marker.kind) &&
    traceMarkers.some(
      (traceMarker) =>
        traceMarker.kind === marker.kind && traceMarker.tl === marker.tl
    )
  );
}

function isArtifactMarkerKind(
  kind: SessionMarker["kind"]
): kind is "commit" | "pr" {
  return kind === "commit" || kind === "pr";
}

function markerTimelineOrder(marker: SessionMarker): number {
  return typeof marker.tl === "number" && Number.isFinite(marker.tl)
    ? marker.tl
    : Number.POSITIVE_INFINITY;
}

function markerTimestampOrder(marker: SessionMarker): number {
  const ms = parseIsoMs(marker.t);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function normalizedText(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
