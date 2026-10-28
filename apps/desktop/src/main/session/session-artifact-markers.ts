import { clampMarkerLabel } from "@repo/lib/session-trace/derivation";
import type { SessionMarker } from "../agent-sync/agent-session-sync-contract.js";
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
  // FEA-3329: AUTHORITATIVE PR-opened instant (pull_requests.opened_at). Null
  // unless some earlier release stored one — its enrichment writer was deleted
  // by PLN-1535 (PR #4435). On null the PR marker falls back to the session's
  // corrected activity END, not to the observed timestamps below it; see
  // `prCandidate`.
  pr_opened_at: string | null;
};

export type ArtifactMarkerTimelineRow = {
  createdAt: string;
};

export type BuildArtifactSessionMarkersInput = {
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
  // FEA-3427: corrected wall-clock END anchor (epoch ms). When supplied it wins
  // over `endedAt ?? updatedAt`, so commit/PR marker `x` coordinates land on the
  // same corrected activity span the trace buckets render against instead of the
  // days-long re-sync-bumped `updated_at` window. Omitted → legacy fallback.
  endMs?: number;
  links: readonly ArtifactMarkerLinkRow[];
  timelineRows: readonly ArtifactMarkerTimelineRow[];
};

type ArtifactMarkerCandidate = SessionMarker & {
  identity: string;
  timestampMs: number;
};

export type ArtifactSessionMarkerAccumulator = {
  observeTimelineRow(
    createdAt: string,
    index: number,
    traceMarker?: SessionMarker | null
  ): void;
  observeTraceMarker(marker: SessionMarker): void;
  finish(): SessionMarker[];
};

/**
 * Derives commit/PR timeline markers from canonical local artifact links.
 * Relation and identity gates live here so projection SQL can stay broad and
 * older rows fail closed when required marker fields are missing.
 */
export function buildArtifactSessionMarkers(
  input: BuildArtifactSessionMarkersInput
): SessionMarker[] {
  const accumulator = createArtifactSessionMarkerAccumulator(input);
  input.timelineRows.forEach((row, index) => {
    accumulator.observeTimelineRow(row.createdAt, index);
  });
  return accumulator.finish();
}

/** Incremental artifact-marker builder for a bounded timeline read. */
export function createArtifactSessionMarkerAccumulator(
  input: Omit<BuildArtifactSessionMarkersInput, "timelineRows">
): ArtifactSessionMarkerAccumulator {
  const sessionStartMs = parseIsoMs(input.startedAt);
  const sessionEndMs =
    input.endMs !== undefined && Number.isFinite(input.endMs)
      ? input.endMs
      : parseIsoMs(input.endedAt ?? input.updatedAt);
  const candidates = new Map<string, ArtifactMarkerCandidate>();

  for (const link of input.links) {
    const candidate =
      link.target_kind === "commit"
        ? commitMarkerCandidate(link, sessionStartMs, sessionEndMs)
        : prMarkerCandidate(link, sessionStartMs, sessionEndMs);
    if (!candidate) {
      continue;
    }
    const existing = candidates.get(candidate.identity);
    if (!existing || candidate.timestampMs < existing.timestampMs) {
      candidates.set(candidate.identity, candidate);
    }
  }

  const nearestByIdentity = new Map<
    string,
    { distance: number; index: number }
  >();
  const displaySuppressed = new Set<string>();
  const anchorSuppressed = new Set<string>();
  return {
    observeTimelineRow(createdAt, index, traceMarker) {
      const rowMs = parseIsoMs(createdAt);
      if (!Number.isFinite(rowMs)) {
        return;
      }
      for (const candidate of candidates.values()) {
        const distance = Math.abs(rowMs - candidate.timestampMs);
        const current = nearestByIdentity.get(candidate.identity);
        if (!current || distance < current.distance) {
          nearestByIdentity.set(candidate.identity, { distance, index });
          if (traceMarker?.kind === candidate.kind) {
            anchorSuppressed.add(candidate.identity);
          } else {
            anchorSuppressed.delete(candidate.identity);
          }
        }
      }
    },
    observeTraceMarker(marker) {
      for (const candidate of candidates.values()) {
        if (
          markerDisplayIdentity(marker) === markerDisplayIdentity(candidate)
        ) {
          displaySuppressed.add(candidate.identity);
        }
      }
    },
    finish() {
      return [...candidates.values()]
        .filter(
          (candidate) =>
            !(
              displaySuppressed.has(candidate.identity) ||
              anchorSuppressed.has(candidate.identity)
            )
        )
        .sort((left, right) => {
          const byTime = left.timestampMs - right.timestampMs;
          return byTime === 0
            ? left.identity.localeCompare(right.identity)
            : byTime;
        })
        .map(({ identity, timestampMs: _timestampMs, ...marker }) => ({
          ...marker,
          tl: nearestByIdentity.get(identity)?.index ?? 0,
        }));
    },
  };
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
  sessionEndMs: number
): ArtifactMarkerCandidate | null {
  const sha = normalizedText(link.sha);
  if (link.relation !== "created" || !sha) {
    return null;
  }
  // FEA-3329: the AUTHORITATIVE event-time commit instant (artifacts.committed_at,
  // captured from the transcript `git commit` event) wins over the shared
  // per-import ingest `now` on link_observed_at — otherwise every commit marker
  // bunched at one synthetic timestamp at the end of the timeline. Fall back to
  // the observed timestamps only when committed_at is genuinely absent.
  const timestamp = firstValidTimestamp([
    link.artifact_committed_at,
    link.link_observed_at,
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
  });
}

function prMarkerCandidate(
  link: ArtifactMarkerLinkRow,
  sessionStartMs: number,
  sessionEndMs: number
): ArtifactMarkerCandidate | null {
  if (
    link.target_kind !== "pull_request" ||
    !(link.relation === "created" || link.relation === "workspace") ||
    !normalizedText(link.repo_full_name) ||
    link.pr_number == null
  ) {
    return null;
  }
  // FEA-3329 + FEA-3594: the AUTHORITATIVE PR-opened instant
  // (pull_requests.opened_at) is the only meaningful time. When absent — which is
  // permanent for any PR no release ever stored one for, since PLN-1535 (PR
  // #4435) deleted its writer — fall back to sessionEndMs, the corrected
  // activity-end anchor, rather than import timestamps (link_observed_at etc.)
  // which are meaningless rebuild artifacts.
  const opened = firstValidTimestamp([link.pr_opened_at]);
  const timestamp =
    opened ??
    (Number.isFinite(sessionEndMs)
      ? { value: new Date(sessionEndMs).toISOString(), ms: sessionEndMs }
      : null);
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
  });
}

function buildCandidate(input: {
  kind: "commit" | "pr";
  identity: string;
  label: string;
  timestamp: { value: string; ms: number };
  sessionStartMs: number;
  sessionEndMs: number;
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
    label: clampMarkerLabel(input.label),
    tl: 0,
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
