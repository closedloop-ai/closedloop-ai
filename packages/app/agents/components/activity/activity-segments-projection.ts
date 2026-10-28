import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";
import { clamp, clamp01 } from "@repo/api/src/utils/math";
import {
  IDLE_PHASE_KEY,
  OTHER_PHASE_KEY,
} from "@repo/lib/sessions/activity-segment-aggregation";
import { ActivitySegmentKind } from "./activity-segment-kind";

/**
 * FEA-3705: shared, surface-agnostic projection of the raw activity-segment
 * tiling (`SyncedActivitySegmentRow[]`, FEA-3568) into a positioned, bounded set
 * of rows the session-detail activity timeline renders. Pure and side-effect
 * free so web and desktop render identical geometry from the same DTO field.
 *
 * The classifier persists half-open spans `[startMs, endMs)` with a free-string
 * `phase`, a confidence in [0, 1], and ranked evidence layers. This projection
 * NEVER re-classifies or re-prices (PLN-1398): it only normalizes/positions the
 * verbatim rows and marks the honest states the AC requires the UI to represent
 * (active, idle, unavailable, empty, malformed).
 *
 * Read-side truncation of the tiling
 * (`AgentSessionDetail.activitySegmentRowsTruncated`) is NOT projected here: its
 * one reader is the Session Timeline legend, which takes the flag straight off
 * the detail (ISS-9858). The only production caller of this projection is
 * `getPhaseTilingSpan`, which reads the span bounds and nothing else.
 */

// `ActivitySegmentKind` — the rendered kind of a projected segment — is declared
// in the dependency-free sibling `./activity-segment-kind`, which is the one
// import site for it. It is NOT re-exported from here: Biome's `noBarrelFile`
// forbids the re-export, and the whole point of the split is that a consumer
// wanting only the vocabulary (an E2E spec, say) must not pull this module's
// `@repo/api` graph in behind it.

/** A single positioned segment ready to render on the timeline. */
export type ProjectedActivitySegment = {
  /** Stable render key (span + phase + index), unique within a projection. */
  key: string;
  /** Verbatim classifier phase label (bounded free string). */
  phase: string;
  kind: ActivitySegmentKind;
  /** Left edge as a percent [0, 100) of the projected span. */
  leftPercent: number;
  /** Width as a percent (0, 100] of the projected span; floored so it is visible. */
  widthPercent: number;
  /** epoch-ms inclusive lower bound (clamped into the projected span). */
  startMs: number;
  /** epoch-ms exclusive upper bound (clamped into the projected span). */
  endMs: number;
  /** Duration in ms (`endMs - startMs`), always > 0. */
  durationMs: number;
  /** Attribution confidence in [0, 1], clamped. */
  confidence: number;
  /** Ranked evidence-layer names that fed the label; empty for idle/evidence-free. */
  evidenceLayers: string[];
  /** Optional artifact ref this span's work was linked to. */
  workItemRef: string | null;
  /** Optional parser-stable local subagent id for delegated spans. */
  subagentId: string | null;
};

export const ActivitySegmentsState = {
  /** At least one renderable segment was projected. */
  Ready: "ready",
  /** The session carries no `activitySegmentRows` (older payload / pre-backfill). */
  Unavailable: "unavailable",
  /** Rows were present but every one was malformed / zero-span (nothing to show). */
  Empty: "empty",
} as const;
export type ActivitySegmentsState =
  (typeof ActivitySegmentsState)[keyof typeof ActivitySegmentsState];

export type ActivitySegmentsProjection = {
  state: ActivitySegmentsState;
  segments: ProjectedActivitySegment[];
  /** Projected span lower bound (epoch-ms); null when nothing renderable. */
  spanStartMs: number | null;
  /** Projected span upper bound (epoch-ms); null when nothing renderable. */
  spanEndMs: number | null;
  /** Count of input rows dropped as malformed (bad bounds / non-finite). */
  malformedCount: number;
};

const EMPTY_PROJECTION: ActivitySegmentsProjection = {
  state: ActivitySegmentsState.Unavailable,
  segments: [],
  spanStartMs: null,
  spanEndMs: null,
  malformedCount: 0,
};

/** Phase labels the classifier uses for genuinely idle (no-billed-work) spans. */
const IDLE_PHASES = new Set<string>([IDLE_PHASE_KEY]);
/**
 * Phase labels that carry no positive attribution — rendered as `unavailable`.
 * `unknown`/`""` are defensive shapes for a malformed row, not taxonomy keys, so
 * they stay literals; only the real `other` bucket resolves through the constant.
 */
const UNAVAILABLE_PHASES = new Set<string>([OTHER_PHASE_KEY, "unknown", ""]);

/**
 * Project the raw `activitySegmentRows` for a session into positioned segments.
 *
 * `rows` is the verbatim DTO field. Passing `undefined`/`null` (an older desktop
 * build or a pre-backfill session) yields the `unavailable` state so the surface
 * degrades to an honest fallback rather than fabricating a timeline. A non-empty
 * array whose every entry is malformed (non-finite bounds, `endMs <= startMs`)
 * yields `empty` — distinct from `unavailable`, because the data DID arrive.
 */
export function projectActivitySegments(
  rows: readonly SyncedActivitySegmentRow[] | null | undefined
): ActivitySegmentsProjection {
  if (!Array.isArray(rows) || rows.length === 0) {
    return EMPTY_PROJECTION;
  }

  const valid: NormalizedRow[] = [];
  let malformedCount = 0;
  for (const row of rows) {
    const normalized = normalizeRow(row);
    if (normalized) {
      valid.push(normalized);
    } else {
      malformedCount += 1;
    }
  }

  if (valid.length === 0) {
    return {
      ...EMPTY_PROJECTION,
      state: ActivitySegmentsState.Empty,
      malformedCount,
    };
  }

  const spanStartMs = Math.min(...valid.map((row) => row.startMs));
  const spanEndMs = Math.max(...valid.map((row) => row.endMs));
  // Half-open spans over a single instant would divide by zero; a 1ms floor
  // mirrors the activity-bucket producer so every segment still gets a visible,
  // in-range slice instead of collapsing to width 0.
  const spanMs = Math.max(1, spanEndMs - spanStartMs);

  const segments = valid.map((row, index): ProjectedActivitySegment => {
    const leftPercent = ((row.startMs - spanStartMs) / spanMs) * 100;
    // Floor width so a sub-percent span is still visible; clamp so a floored
    // width can never overflow the track past its left edge.
    const rawWidth = (row.durationMs / spanMs) * 100;
    const widthPercent = clamp(rawWidth, 0.75, 100 - leftPercent);
    return {
      key: `${row.startMs}-${row.endMs}-${row.phase}-${index}`,
      phase: row.phase,
      kind: classifySegmentKind(row),
      leftPercent,
      widthPercent,
      startMs: row.startMs,
      endMs: row.endMs,
      durationMs: row.durationMs,
      confidence: row.confidence,
      evidenceLayers: row.evidenceLayers,
      workItemRef: row.workItemRef,
      subagentId: row.subagentId,
    };
  });

  return {
    state: ActivitySegmentsState.Ready,
    segments,
    spanStartMs,
    spanEndMs,
    malformedCount,
  };
}

type NormalizedRow = {
  phase: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  confidence: number;
  evidenceLayers: string[];
  workItemRef: string | null;
  subagentId: string | null;
};

/**
 * Coerce a raw wire row to a renderable shape, or return null when it is
 * malformed. A malformed row is one with non-finite bounds or a non-positive
 * duration (`endMs <= startMs`) — a corrupt/degenerate span the UI must not
 * position (it would render as a zero-width or negative-width slice).
 */
function normalizeRow(row: SyncedActivitySegmentRow): NormalizedRow | null {
  const startMs = Number(row.startMs);
  const endMs = Number(row.endMs);
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs <= startMs
  ) {
    return null;
  }
  const evidenceLayers = Array.isArray(row.evidenceLayers)
    ? row.evidenceLayers.filter(
        (layer): layer is string => typeof layer === "string"
      )
    : [];
  return {
    phase: typeof row.phase === "string" ? row.phase : "",
    startMs,
    endMs,
    durationMs: endMs - startMs,
    confidence: clampConfidence(row.confidence),
    evidenceLayers,
    workItemRef: row.workItemRef ?? null,
    subagentId: row.subagentId ?? null,
  };
}

function classifySegmentKind(row: NormalizedRow): ActivitySegmentKind {
  const phase = row.phase.trim().toLowerCase();
  if (IDLE_PHASES.has(phase)) {
    return ActivitySegmentKind.Idle;
  }
  // An `other`/unknown/blank span with no supporting evidence is not honest to
  // paint as active work — surface it distinctly.
  if (UNAVAILABLE_PHASES.has(phase) && row.evidenceLayers.length === 0) {
    return ActivitySegmentKind.Unavailable;
  }
  return ActivitySegmentKind.Active;
}

function clampConfidence(value: unknown): number {
  const num = Number(value);
  return clamp01(Number.isFinite(num) ? num : 0);
}
