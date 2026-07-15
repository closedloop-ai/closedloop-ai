/**
 * @file activity-segment-classifier.ts
 * @description FEA-2269 (PRD-488): the versioned, PURE, deterministic
 * session-activity classifier. FEA-2267 shipped a STUB body here (one `other`
 * active segment per span) so the hard cross-cutting guarantees — complete
 * tiling, exact spend reconciliation, byte-identical determinism, version-bump
 * backfill — could be frozen against a classifier too simple to be wrong.
 *
 * This feature replaces ONLY the classification body: it consumes FEA-2268's
 * abstract, harness-blind evidence TIMELINE (`buildEvidenceTimeline`), partitions
 * each active span into contiguous typed windows via windowing + hysteresis, and
 * labels each window with a taxonomy-v1 phase + confidence + evidence-layer
 * provenance (`activity-scoring.ts`). The store contract is INHERITED UNCHANGED:
 * the segment record shape, deterministic sha256 IDs, the complete-tiling
 * invariant, the per-turn spend join, the first-class `idle` kind, and the
 * version-bump backfill all still belong to FEA-2267 — this module only produces
 * the classification, expressed as a tiling of `[startMs, endMs)`.
 *
 * Mirrors `artifact-ref-extractor.ts`: a single versioned module producing
 * deterministic sha256 row IDs, where bumping the version triggers a full
 * historical re-derive via the backfill pass.
 */
import { createHash } from "node:crypto";
import type { SessionTracePhaseSource } from "@repo/api/src/types/agent-session";
import { buildEvidenceTimeline } from "../evidence/build-session-evidence.js";
import {
  type EvidenceUnit,
  emptyCategoryMix,
  ToolCategory,
} from "../evidence/evidence-model.js";
import type { Harness, NormalizedSession } from "../types.js";
import {
  type ActivityCategoryCounts,
  scoreWindow,
} from "./activity-scoring.js";
import { ACTIVITY_PHASE, type ActivityPhase } from "./activity-taxonomy.js";

// Bumping this triggers a full historical re-derive via
// activity-segment-backfill.ts (mirrors EXTRACTOR_VERSION). Per AGENTS.md
// §Idempotent Re-Processing, any change to deterministic segment-producing
// logic increments this FROM ITS VALUE AT HEAD (monotonic — never a hard-coded
// target integer). Because `phase` is stored as TEXT, a taxonomy change is a
// version bump + re-derive, NOT a schema migration (Q-001).
//
// v2 (FEA-2269): the stub's single-`other`-per-span body is replaced by the real
// structural classifier (windowing + hysteresis + layered declared→structural
// scoring over the FEA-2268 evidence timeline), and ACTIVITY_PHASE gains the
// active-work labels. Every historical session is re-tiled on next boot.
export const ACTIVITY_CLASSIFIER_VERSION = 2;

/**
 * Inactivity gap (ms) at/above which an `idle` segment is opened between two
 * consecutive turn timestamps. SSOT default ratified in PLN-1196 §4 (Q-005):
 * 600_000 ms / 10 min. A named, calibratable constant owned by this feature
 * (tuned per cohort by FEA-2266); idle is its own first-class kind so the tiling
 * stays complete without attributing idle time to active phases.
 */
export const ACTIVITY_IDLE_GAP_MS = 600_000;

// A run's phase is only re-opened when a differing pattern PERSISTS across this
// many ticks (the Schmitt-trigger dwell). A lone off-pattern turn inside a
// sustained burst is absorbed, not split. Provisional (Q-003 tuning surface),
// versioned by ACTIVITY_CLASSIFIER_VERSION.
const HYSTERESIS_DWELL_TICKS = 2;

/**
 * The in-memory shape the classifier emits and `persistActivitySegments`
 * consumes. `id`, `session_id`, and `observed_at` are stamped at persist time
 * (mirroring how `ArtifactRefRecord` omits the DB `id`).
 */
export type ActivitySegmentRecord = {
  phase: ActivityPhase;
  /** epoch-ms, inclusive lower bound. */
  startMs: number;
  /** epoch-ms, exclusive upper bound — half-open [startMs, endMs). */
  endMs: number;
  confidence: number;
  /**
   * The ranked evidence layers (`declared`/`structural`) that fed the label,
   * persisted to the `Json` `evidence_layers` column. Empty for `idle` and for
   * evidence-free `other` spans; populated by the scorer otherwise. `declared`
   * presence is the segment's inferred-vs-declared provenance signal (FR-7).
   */
  evidenceLayers: string[];
  version: number;
  workItemRef?: string | null;
};

/**
 * Deterministic row id: sha256(sessionId|startMs|version)[:16], mirroring
 * `artifactLinkId`. Under a complete, non-overlapping tiling `start_ms` is
 * unique per session+version, so it is a sufficient natural key; the version
 * component separates re-derivations across classifier versions.
 */
export function activitySegmentId(
  sessionId: string,
  startMs: number,
  version: number
): string {
  return createHash("sha256")
    .update(`${sessionId}|${startMs}|${version}`)
    .digest("hex")
    .slice(0, 16);
}

type SessionBoundsMs = { startMs: number; endMs: number };

/**
 * Derive the deterministic outer span [startMs, endMs) of a session, enclosing
 * BOTH the declared start/end and the earliest/latest turn timestamp so no
 * token_event can fall outside the tiling (the complete-tiling invariant). Pure:
 * reads only NormalizedSession fields, never the wall clock. Returns null when
 * no finite timestamp exists at all — the caller then persists nothing,
 * consistent with the importer already skipping `startedAt`-less sessions.
 *
 * `endMs` is one ms PAST the latest observed/declared timestamp. The `+1`
 * guarantees `endMs` strictly exceeds every turn timestamp, so (a) the final
 * active segment always has positive width — even when the last turn lands
 * exactly on the declared session end after an idle gap (no zero-width row), and
 * (b) no turn ever sits on the exclusive upper bound, so the half-open spend
 * join captures every turn without relying on a boundary special case (the
 * last-segment-inclusive arm of {@link segmentIndexForMs} is then belt-and-
 * suspenders).
 */
export function deriveSessionBoundsMs(
  session: NormalizedSession
): SessionBoundsMs | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const consider = (iso: string | null | undefined): void => {
    if (!iso) {
      return;
    }
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) {
      min = ms < min ? ms : min;
      max = ms > max ? ms : max;
    }
  };
  consider(session.startedAt);
  consider(session.endedAt);
  for (const record of session.tokenSeries ?? []) {
    consider(record.timestamp);
  }
  if (!Number.isFinite(min)) {
    return null;
  }
  const startMs = min;
  const endMs = max + 1;
  return { startMs, endMs };
}

/**
 * Classify a normalized session into a complete, non-overlapping, contiguous
 * tiling of [startMs, endMs). The session's active time (spans between idle gaps
 * ≥ ACTIVITY_IDLE_GAP_MS, derived from TURN timestamps) is partitioned into
 * typed windows by scoring the FEA-2268 evidence timeline with windowing +
 * hysteresis; inter-turn idle gaps stay first-class `idle` segments.
 *
 * `harness` selects the FEA-2268 adapter that maps this session's concrete tool
 * names to abstract categories (the ONLY vendor-aware step; the classifier core
 * is harness-blind). `tracePhaseSources` are the optional DB-derived declared
 * phase boundaries; omitted, the declared layer still draws on slash commands and
 * per-tool skill/MCP signals.
 *
 * Determinism: reads only `NormalizedSession` + `harness` + the version constant
 * — no `Date.now()`, no randomness; the evidence timeline is totally ordered and
 * every tie-break (argmax taxonomy order, tick grouping) is explicit — so
 * identical input yields a byte-identical ordered record array (and identical
 * hashed IDs).
 */
export function classifyActivitySegments(
  session: NormalizedSession,
  harness: Harness,
  options?: { tracePhaseSources?: readonly SessionTracePhaseSource[] }
): ActivitySegmentRecord[] {
  const bounds = deriveSessionBoundsMs(session);
  if (!bounds) {
    return [];
  }
  const { startMs, endMs } = bounds;
  const turnMs = sortedUniqueTurnMs(session, startMs, endMs);
  const timeline = buildEvidenceTimeline(session, harness, options);

  const segments: ActivitySegmentRecord[] = [];
  let activeStart = startMs;
  for (let i = 0; i + 1 < turnMs.length; i++) {
    const gap = turnMs[i + 1] - turnMs[i];
    if (gap < ACTIVITY_IDLE_GAP_MS) {
      continue;
    }
    // Close the active run 1ms after its last turn so that turn stays inside the
    // active span (half-open), then tile the dead time as an `idle` segment up to
    // the resuming turn. `activeBreak < turnMs[i + 1]` always holds because the
    // gap exceeds ACTIVITY_IDLE_GAP_MS (≫ 1ms).
    const activeBreak = turnMs[i] + 1;
    appendActiveSegments(segments, timeline, activeStart, activeBreak);
    segments.push(
      makeSegment(ACTIVITY_PHASE.Idle, activeBreak, turnMs[i + 1], 1, [])
    );
    activeStart = turnMs[i + 1];
  }
  appendActiveSegments(segments, timeline, activeStart, endMs);
  return segments;
}

/**
 * Canonical timestamp → segment assignment for per-segment spend attribution.
 * Half-open [startMs, endMs); the LAST segment is treated as inclusive of its
 * upper bound so a turn at exactly the session end (when `endMs` equals the
 * latest turn) is not dropped. Returns the index into `segments` (assumed
 * sorted, contiguous, complete) or -1 when `ms` precedes the first segment.
 * Pure + shared so the reconciliation guard and later read surfaces (FEA-2268)
 * compute spend through ONE boundary rule and cannot drift.
 */
export function segmentIndexForMs(
  segments: readonly Pick<ActivitySegmentRecord, "startMs" | "endMs">[],
  ms: number
): number {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const withinUpper = ms < seg.endMs || (isLast && ms <= seg.endMs);
    if (ms >= seg.startMs && withinUpper) {
      return i;
    }
  }
  return -1;
}

/**
 * Classify one active span [activeStart, activeBreak) into typed sub-segments by
 * windowing + hysteresis over its evidence, appending them contiguously so they
 * tile the span exactly. A span with NO evidence is a single `other` segment
 * (honest: active spend the classifier saw but cannot type), matching the
 * FEA-2267 stub for evidence-free sessions. Boundaries fall on distinct tick
 * timestamps, so every emitted sub-segment has positive width.
 */
function appendActiveSegments(
  segments: ActivitySegmentRecord[],
  timeline: readonly EvidenceUnit[],
  activeStart: number,
  activeBreak: number
): void {
  const ticks = groupTicks(timeline, activeStart, activeBreak);
  if (ticks.length === 0) {
    segments.push(
      makeSegment(ACTIVITY_PHASE.Other, activeStart, activeBreak, 0, [])
    );
    return;
  }
  const runs = windowTicks(ticks);
  for (let j = 0; j < runs.length; j++) {
    const segStart = j === 0 ? activeStart : runs[j].startMs;
    const segEnd = j === runs.length - 1 ? activeBreak : runs[j + 1].startMs;
    const { phase, confidence, layers } = scoreWindow(runs[j].counts);
    segments.push(makeSegment(phase, segStart, segEnd, confidence, layers));
  }
}

/** One distinct-timestamp bucket of evidence within an active span. */
type EvidenceTick = { ms: number; counts: ActivityCategoryCounts };

/** A contiguous run of same-phase ticks, anchored at its first tick's ms. */
type PhaseRun = { startMs: number; counts: ActivityCategoryCounts };

/**
 * Bucket the active span's evidence units by distinct timestamp (a "tick"),
 * summing the abstract-category counts at each ms. Grouping by ms — then sorting
 * — means run boundaries land on distinct timestamps, so no sub-segment can be
 * zero-width, and the ordering is deterministic (never Map-iteration order).
 * Units outside [activeStart, activeBreak) belong to another span and are
 * skipped.
 */
function groupTicks(
  timeline: readonly EvidenceUnit[],
  activeStart: number,
  activeBreak: number
): EvidenceTick[] {
  const byMs = new Map<number, ActivityCategoryCounts>();
  for (const unit of timeline) {
    if (unit.ms < activeStart || unit.ms >= activeBreak) {
      continue;
    }
    let counts = byMs.get(unit.ms);
    if (!counts) {
      counts = emptyCategoryMix();
      byMs.set(unit.ms, counts);
    }
    counts[unit.category] += 1;
  }
  const ticks: EvidenceTick[] = [];
  for (const [ms, counts] of byMs) {
    ticks.push({ ms, counts });
  }
  ticks.sort((a, b) => a.ms - b.ms);
  return ticks;
}

/**
 * Partition the ticks into contiguous same-phase runs. Each run starts at a tick,
 * takes that tick's dominant phase, and extends over compatible ticks; a differing
 * tick only opens a new run when the shift is SUSTAINED (hysteresis).
 */
function windowTicks(ticks: readonly EvidenceTick[]): PhaseRun[] {
  const runs: PhaseRun[] = [];
  let i = 0;
  while (i < ticks.length) {
    const startMs = ticks[i].ms;
    const counts = { ...ticks[i].counts };
    const phase = scoreWindow(counts).phase;
    i = extendRun(ticks, i + 1, counts, phase);
    runs.push({ startMs, counts });
  }
  return runs;
}

/**
 * Extend the current run from index `from`. A tick whose OWN dominant phase
 * matches the run extends it; a differing tick opens a new run only if the shift
 * is sustained across the dwell — otherwise it is absorbed as a transient without
 * changing the run's phase (a lone off-pattern turn inside a burst never splits
 * it). Mutates `counts`; returns the index of the first tick of the NEXT run.
 */
function extendRun(
  ticks: readonly EvidenceTick[],
  from: number,
  counts: ActivityCategoryCounts,
  phase: ActivityPhase
): number {
  let i = from;
  while (i < ticks.length) {
    const incoming = scoreWindow(ticks[i].counts).phase;
    if (incoming !== phase && sustainedShift(ticks, i, phase)) {
      break;
    }
    addCountsInto(counts, ticks[i].counts);
    i++;
  }
  return i;
}

/**
 * A phase shift is real only if it PERSISTS across the dwell AND resolves to a
 * confident DIFFERENT phase: the combined phase over the next
 * HYSTERESIS_DWELL_TICKS ticks is neither the current run's phase nor `other`.
 * An ambiguous (`other`) lookahead is NOT a shift — a lone off-pattern turn whose
 * local window is a near-tie stays absorbed in the burst, not split out. Fewer
 * than the dwell's worth of ticks left ⇒ transient (no split), so a lone trailing
 * off-pattern tick never opens a one-tick tail segment.
 */
function sustainedShift(
  ticks: readonly EvidenceTick[],
  from: number,
  phase: ActivityPhase
): boolean {
  if (ticks.length - from < HYSTERESIS_DWELL_TICKS) {
    return false;
  }
  const counts = emptyCategoryMix();
  for (let i = from; i < from + HYSTERESIS_DWELL_TICKS; i++) {
    addCountsInto(counts, ticks[i].counts);
  }
  const shifted = scoreWindow(counts).phase;
  return shifted !== phase && shifted !== ACTIVITY_PHASE.Other;
}

function addCountsInto(
  target: ActivityCategoryCounts,
  source: ActivityCategoryCounts
): void {
  for (const category of Object.values(ToolCategory)) {
    target[category] += source[category];
  }
}

function makeSegment(
  phase: ActivityPhase,
  startMs: number,
  endMs: number,
  confidence: number,
  evidenceLayers: string[]
): ActivitySegmentRecord {
  return {
    phase,
    startMs,
    endMs,
    confidence,
    evidenceLayers,
    version: ACTIVITY_CLASSIFIER_VERSION,
  };
}

function sortedUniqueTurnMs(
  session: NormalizedSession,
  startMs: number,
  endMs: number
): number[] {
  const seen = new Set<number>();
  for (const record of session.tokenSeries ?? []) {
    const ms = Date.parse(record.timestamp);
    if (Number.isFinite(ms) && ms >= startMs && ms <= endMs) {
      seen.add(ms);
    }
  }
  return [...seen].sort((a, b) => a - b);
}
