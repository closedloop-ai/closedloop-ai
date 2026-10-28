/**
 * ISS-10721 — the canonical, Zod-free contract for a session's activity-metrics
 * rollup: the autonomy band, the spend split by attribution confidence, and the
 * segment coverage counts.
 *
 * Single source of truth for three vocabularies that existed only inside
 * `apps/desktop` before this module. `attribution-metrics.ts` (desktop main) and
 * the cloud rollup now read the band members and cut-points from HERE, so the
 * local rollup and its cloud twin cannot classify the same autonomy index into
 * different bands.
 *
 * Zod-free on purpose, mirroring the `session-status.ts` /
 * `transcript-disposition-constants.ts` split: the Sessions surfaces that render
 * a band label or a confidence tier are `"use client"` modules, and pulling a
 * mixed helper for three string constants would drag `zod` into their bundle.
 * The Zod boundary schema for the same shape lives beside the ingest validator.
 *
 * UNKNOWN IS NOT ZERO. Every numeric field of {@link SessionActivityMetricsRead}
 * is nullable and `null` is the ONLY representation of "not computed". A session
 * whose rollup has never run reads `null` across the board, never `0` coverage
 * and never a `human_steered` band — the bottom band and a zero spend are real
 * measurements and must not be fabricated from an absent row.
 */

/**
 * Autonomy bands, derived from a session's autonomy index (0 manual → 100
 * agentic). Members and spelling are the desktop rollup's, which has written
 * `session_activity_metrics.autonomy_band` since PLN-1196; this module took
 * ownership of them rather than restating them, so the stored values are
 * unchanged and no backfill is implied.
 */
export const AutonomyBand = {
  HumanSteered: "human_steered",
  Mixed: "mixed",
  Agentic: "agentic",
} as const;
export type AutonomyBand = (typeof AutonomyBand)[keyof typeof AutonomyBand];

/**
 * PROVISIONAL autonomy-index band boundaries (Q-003) — the ONLY place they may
 * be edited. They bucket an index in [0, 100]; the band code is agnostic to HOW
 * that index is produced.
 *  human_steered = [0, humanSteeredMaxExclusive)
 *  mixed         = [humanSteeredMaxExclusive, agenticMinInclusive)
 *  agentic       = [agenticMinInclusive, 100]
 */
export const AUTONOMY_BAND_CUTPOINTS = {
  humanSteeredMaxExclusive: 34,
  agenticMinInclusive: 67,
} as const;

/**
 * The confidence tiers the spend split is bucketed into, matching the desktop
 * attribution module's `ConfidenceBucket` members one for one. A session's
 * spend is partitioned across exactly these three tiers, which is the honest
 * alternative to one blended total that hides how much of a cost figure is a
 * guess.
 */
export const SpendConfidenceTier = {
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;
export type SpendConfidenceTier =
  (typeof SpendConfidenceTier)[keyof typeof SpendConfidenceTier];

/**
 * Membership table for {@link AutonomyBand}, written out per member.
 *
 * The narrowing set below is DERIVED from this record rather than from
 * `Object.values(AutonomyBand)`: a set built from the values compiles fine when
 * a fourth band is added, and the new member then falls through
 * {@link asAutonomyBand} to `null` — reading as "unmeasured" for a band that was
 * measured. Keyed on the union, a missing entry fails `tsc` here instead.
 */
const AUTONOMY_BAND_MEMBERSHIP: Record<AutonomyBand, true> = {
  [AutonomyBand.HumanSteered]: true,
  [AutonomyBand.Mixed]: true,
  [AutonomyBand.Agentic]: true,
};

const AUTONOMY_BAND_VALUES: ReadonlySet<string> = new Set(
  Object.keys(AUTONOMY_BAND_MEMBERSHIP)
);

/**
 * A session's activity-metrics rollup as a reader sees it.
 *
 * Every field is nullable and `null` means UNKNOWN — see the module note. The
 * three spend figures are a partition of the attributed spend, so they are all
 * present or all absent; a reader that sums them gets the attributed total and
 * must not present that as the session's whole cost (out-of-segment spend
 * belongs to no confidence tier and is deliberately not carried here).
 */
export type SessionActivityMetricsRead = {
  /** `null` when no rollup has classified this session. Never the bottom band. */
  autonomyBand: AutonomyBand | null;
  /** Share of segments that are confidently attributed, in [0, 1]. */
  coverage: number | null;
  spendLowConfUsd: number | null;
  spendMediumConfUsd: number | null;
  spendHighConfUsd: number | null;
  /** Total classified segments. `null` when unmeasured — never a measured `0`. */
  segmentCount: number | null;
  /** Segments at or above the confident threshold. `<= segmentCount`. */
  coveredSegmentCount: number | null;
  /**
   * The producer's classifier / metric versions, so a reader can tell a stale
   * rollup from a current one without re-deriving it. `null` when the producer
   * reported neither — which is also what a rollup predating the versions reads
   * as, and is why staleness is never ASSERTED from a missing version.
   */
  classifierVersion: number | null;
  metricVersion: number | null;
};

/**
 * The same rollup as it rides the desktop -> cloud sync wire.
 *
 * Every key is optional and nullable because this crosses a version-skewed
 * boundary: a desktop build that computes only part of the rollup omits the
 * rest, and an omitted key must stay omitted rather than becoming a `null` the
 * server would have to re-interpret. `autonomyBand` is a plain `string` on the
 * wire, not the union — an unrecognized member from a newer producer degrades
 * to unknown at the read instead of rejecting the whole session.
 */
export type SyncedSessionActivityMetrics = {
  autonomyBand?: string | null;
  coverage?: number | null;
  spendLowConfUsd?: number | null;
  spendMediumConfUsd?: number | null;
  spendHighConfUsd?: number | null;
  segmentCount?: number | null;
  coveredSegmentCount?: number | null;
  classifierVersion?: number | null;
  metricVersion?: number | null;
};

/**
 * A rollup with nothing measured. Written out per key so that adding a field to
 * {@link SessionActivityMetricsRead} fails `tsc` here rather than shipping a
 * key that is `undefined` at runtime and reads as absent-from-the-response.
 */
export const UNKNOWN_SESSION_ACTIVITY_METRICS: SessionActivityMetricsRead = {
  autonomyBand: null,
  coverage: null,
  spendLowConfUsd: null,
  spendMediumConfUsd: null,
  spendHighConfUsd: null,
  segmentCount: null,
  coveredSegmentCount: null,
  classifierVersion: null,
  metricVersion: null,
};

/** Map an autonomy index (0..100) to its band using the shared cut-points. */
export function autonomyBandFor(autonomyIndex: number): AutonomyBand {
  if (autonomyIndex < AUTONOMY_BAND_CUTPOINTS.humanSteeredMaxExclusive) {
    return AutonomyBand.HumanSteered;
  }
  if (autonomyIndex < AUTONOMY_BAND_CUTPOINTS.agenticMinInclusive) {
    return AutonomyBand.Mixed;
  }
  return AutonomyBand.Agentic;
}

/** Narrow an unconstrained stored/wire `autonomy_band` to a member, else null. */
export function asAutonomyBand(value: string | null): AutonomyBand | null {
  if (value === null) {
    return null;
  }
  return AUTONOMY_BAND_VALUES.has(value) ? (value as AutonomyBand) : null;
}

/**
 * ISS-10721 — byte-level completeness of a session's archived transcript
 * evidence, read from the cloud's own archive rows.
 *
 * The desktop's `transcript_sync_state.synced_byte_offset` has a cloud twin in
 * `session_transcript.synced_byte_offset` that no read exposed; this is that
 * exposure. It is the quantitative companion to the categorical
 * `TranscriptDisposition` verdict, not a replacement for it: the verdict says
 * whether the archive is coming, this says how much of it has landed.
 *
 * Both fields are `null` when the session has no transcript row at all —
 * distinct from a genuine `0`, which means rows exist and no byte has been
 * verified yet. `fileCount` is the number of archive rows in the session, so a
 * reader can tell a whole-session figure from a single-file one without a
 * second query; it is the population BOTH byte figures are summed over, because
 * either is published over every row or withheld entirely.
 *
 * ISS-11089 ADDS TWO COUNTS AND CHANGES NEITHER BYTE FIGURE. `observedByteSize`
 * is still withheld unless EVERY one of `fileCount` rows reported a size —
 * marisolashgrove ruled on 2026-09-27, "we should not be changing denominators for
 * anything." Re-basing it on the rows that happen to report would not caveat the
 * figure, it would publish a different measurement under the same name: a
 * `650/650` that reads complete when the truth is `650/unknown`. A partial
 * numerator understates and is honest; a partial denominator overstates
 * completion, and that a caveat cannot repair.
 *
 * `reportingFileCount` is how many rows reported a READABLE size, and it is the
 * EXPLANATION of a withheld `observedByteSize`, not its population. Before
 * ISS-11089 the figure went `null` and said nothing, so a reader could not tell
 * "still uploading" from "one file's size is gone for good".
 * `reportingFileCount < fileCount` is exactly when an operand is missing, and
 * the gap says how many rows are missing it. A row whose stored size is corrupt
 * is not counted as reporting: a value that is not a measurement is not a
 * reported size.
 *
 * `unrecoverableFileCount` is the other half of that answer: how many of
 * `fileCount` files the desktop will NEVER archive, because it terminally
 * skipped them for a HARD reason. It is what makes a withholding readable as
 * permanent rather than in-flight. It counts FILES, never missing operands, and
 * it is `0` for the ordinary session. Being a plain row count it publishes even
 * when both byte figures are withheld — which is the ordinary shape here, since
 * such a file normally never reported a size at all.
 *
 * It does NOT imply a gap between the two byte figures. A file that completed
 * once and was later hard-skipped still carries its `rawByteSize`, so it is
 * counted here AND leaves the denominator whole and published. One write
 * produces both byte columns and sets them equal, so `archivedByteOffset`
 * equals `observedByteSize` whenever both publish — for a session holding such
 * a file exactly as for a healthy one. Read this count, never the byte pair, to
 * learn that a file will never be archived.
 *
 * ISS-11089 (review): BOTH counts are OPTIONAL on the wire. A client newer than
 * the API deployment serving it receives the pre-ISS-11089 three-key object, so
 * a reader must treat an ABSENT count as "this API does not report it" and
 * never as `0` — defaulting either to zero would claim a measured absence of
 * unrecoverable files and a measured full set of reporting rows, which is the
 * withheld-versus-zero collapse this whole disclosure exists to avoid. With both
 * absent, the byte figures read exactly as they did before this change, because
 * this change did not alter them. The API always emits both.
 */
export type TranscriptArchiveProgress = {
  archivedByteOffset: number | null;
  observedByteSize: number | null;
  fileCount: number;
  reportingFileCount?: number;
  unrecoverableFileCount?: number;
};
