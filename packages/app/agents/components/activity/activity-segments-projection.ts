import {
  MAX_SYNCED_ACTIVITY_SEGMENTS,
  type SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
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
 * (active, idle, unavailable, empty, truncated, malformed).
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
  /**
   * FEA-4238: fraction of the projected span [0, 1] covered by `idle` segments.
   * For a mostly-idle session (a long wall-clock span the agent slept through —
   * e.g. a 66h run) this approaches 1, which is exactly when the phase strip
   * paints ~98% empty hatch and reads broken. The session-detail surface uses
   * this to fold the strip behind a disclosure instead of leading with a nearly
   * empty visualization above the trace. Duration-weighted (not a segment count)
   * so a handful of long idle spans dominating a few short active ones is
   * correctly read as mostly idle.
   */
  idleDurationShare: number;
  /**
   * FEA-4238: true when the non-idle (active + unavailable) segments cover so
   * little of the span that the strip is not worth leading with — the derived
   * "hide/disclose when idle dominates" signal. Kept as a projected field (not
   * re-derived in the component) so web and desktop fold on identical data and a
   * single test pins the threshold.
   */
  idleDominant: boolean;
  /** Count of input rows dropped as malformed (bad bounds / non-finite). */
  malformedCount: number;
  /**
   * True when the input row set hit the wire/DB cap
   * (`MAX_SYNCED_ACTIVITY_SEGMENTS`), so earlier spans may be missing. Surfaced
   * so the UI shows an honest "showing first N" affordance rather than implying
   * the tiling is complete.
   */
  truncated: boolean;
};

const EMPTY_PROJECTION: ActivitySegmentsProjection = {
  state: ActivitySegmentsState.Unavailable,
  segments: [],
  spanStartMs: null,
  spanEndMs: null,
  idleDurationShare: 0,
  idleDominant: false,
  malformedCount: 0,
  truncated: false,
};

/**
 * FEA-4238: the non-idle coverage floor below which the phase strip is treated
 * as too empty to lead with. At 5% a session whose active/unattributed work
 * covers less than a twentieth of its wall-clock span (the ~98%-idle 66h case)
 * folds the strip behind a disclosure; a session with even a modest working
 * stretch keeps it inline. Duration-weighted, so it is the share of TIME, not of
 * segment count.
 */
const MIN_NON_IDLE_SHARE = 0.05;

/** Phase labels the classifier uses for genuinely idle (no-billed-work) spans. */
const IDLE_PHASES = new Set([IDLE_PHASE_KEY]);
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
  rows: readonly SyncedActivitySegmentRow[] | null | undefined,
  options?: Readonly<{ rowsTruncated?: boolean | null }>
): ActivitySegmentsProjection {
  if (!Array.isArray(rows) || rows.length === 0) {
    return EMPTY_PROJECTION;
  }

  // Truncation from either the row cap OR the upstream byte-budget signal
  // (`activitySegmentRowsTruncated`, FEA-3779): the desktop can cut the tiling
  // below the row cap on serialized bytes, and the cloud does not re-derive the
  // row count from that, so a start-ordered prefix can be short without hitting
  // MAX_SYNCED_ACTIVITY_SEGMENTS. Honor the explicit flag so a partial prefix is
  // never treated as a complete tiling.
  const truncated =
    rows.length >= MAX_SYNCED_ACTIVITY_SEGMENTS ||
    options?.rowsTruncated === true;
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
      truncated,
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

  // FEA-4238: duration-weighted idle vs non-idle coverage of the projected span,
  // so the surface can fold a mostly-idle strip. Sum idle segment durations
  // against the span (not the segment count) so a few long sleeps outweigh many
  // short active spans. `idleDominant` is the derived "too empty to lead with"
  // flag consumed by the phase strip.
  const idleDurationMs = segments.reduce(
    (sum, segment) =>
      segment.kind === ActivitySegmentKind.Idle
        ? sum + segment.durationMs
        : sum,
    0
  );
  const nonIdleDurationMs = segments.reduce(
    (sum, segment) =>
      segment.kind === ActivitySegmentKind.Idle
        ? sum
        : sum + segment.durationMs,
    0
  );
  const idleDurationShare = clamp01(idleDurationMs / spanMs);
  // Never fold a TRUNCATED tiling as idle-dominant: a byte/row-truncated
  // start-ordered prefix can be all-idle at the front while the dropped tail held
  // the real work, so labeling it "mostly idle" and hiding it would lie about a
  // partial input. A truncated strip stays inline (the honest "later phases
  // truncated" note still surfaces). Only a COMPLETE tiling can fold.
  const idleDominant =
    !truncated && nonIdleDurationMs / spanMs < MIN_NON_IDLE_SHARE;

  return {
    state: ActivitySegmentsState.Ready,
    segments,
    spanStartMs,
    spanEndMs,
    idleDurationShare,
    idleDominant,
    malformedCount,
    truncated,
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
