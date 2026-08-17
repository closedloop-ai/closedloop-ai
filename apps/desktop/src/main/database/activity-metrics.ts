/**
 * @file activity-metrics.ts
 * @description FEA-2273 (PRD-488 FR-12, PLN-1205): the THIN in-product adapter
 * that emits per-session activity-attribution metrics on live ingested data. It
 * is the production counterpart of FEA-2266's offline harness and reuses that
 * feature's metric module (`../telemetry/attribution-metrics.js`) UNCHANGED for
 * all coverage/confidence math and every cohort band cut-point — this file adds
 * NO second copy of any formula or threshold.
 *
 * What this adapter DOES own (and only this):
 *  1. a cohort-derivation helper that maps the already-materialized
 *     `session_analytics` row + the session's identity onto the shared
 *     {@link SessionCohort} using the module's `autonomyBandFor` /
 *     `sessionLengthBandFor` (the autonomy-index is the session-level TURN-count
 *     proxy the module's doc sanctions the caller to supply);
 *  2. a live read that feeds this session's `session_activity_segments` +
 *     `token_events` into the module and persists ONE `session_activity_metrics`
 *     row (INSERT OR REPLACE — idempotent);
 *  3. a set-based boot backfill for sessions that have segments but no metrics row.
 *
 * Coverage is computed by the module in exact micro-cents; the confidence
 * distribution bins each segment's attributed spend with the module's
 * `confidenceBucketFor`. Live ground-truth calibration is impossible (no hand
 * labels), so — exactly per PRD-488's split — the live surface emits Coverage +
 * the reported-confidence distribution (the FR-12 production half) and leaves
 * truth-calibration to FEA-2266 offline.
 */
import type { Harness } from "../collectors/types.js";
import { microCentsToUsd, usdToMicroCents } from "../cost/cost-math.js";
import {
  ACTIVITY_STATE_VALUES,
  ActivityState,
  attributeSegmentSpendUsd,
  autonomyBandFor,
  type ClassifiedSegment,
  COVERAGE_EXCLUDED_STATES,
  ConfidenceBucket,
  type CoverageSession,
  computeCoverage,
  confidenceBucketFor,
  isConfident,
  type SessionCohort,
  type SpendSegmentSpan,
  sessionLengthBandFor,
  sessionTotalSpendUsd,
  type TokenSpendEvent,
} from "../telemetry/attribution-metrics.js";
import type { Prisma } from "./generated/client.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** The `session_analytics` fields the cohort derivation reads (already rolled up). */
export type CohortAnalyticsInput = {
  harness: string | null;
  humanTurns: number;
  agentTurns: number;
  runtimeMs: number | null;
};

/** The `sessions` identity fields that decide the ClosedLoop-user axis. */
export type CohortIdentityInput = {
  userId: string | null;
  organizationId: string | null;
};

/** Fast membership set so an unexpected `phase` string can be handled explicitly. */
const ACTIVITY_STATE_SET: ReadonlySet<string> = new Set(ACTIVITY_STATE_VALUES);

/**
 * The session-level autonomy INDEX proxy (0 manual → 100 agentic), derived from
 * the rollup's human/agent turn counts. The module owns the BAND cut-points
 * (`AUTONOMY_BAND_CUTPOINTS` / `autonomyBandFor`); this only produces the index
 * the module's doc explicitly says the caller supplies from the rollup's turn
 * counts. A turn-less session (no classified turns) maps to 0 → human_steered.
 */
export function autonomyIndexFromTurns(
  humanTurns: number,
  agentTurns: number
): number {
  const total = humanTurns + agentTurns;
  if (total <= 0) {
    return 0;
  }
  return (agentTurns / total) * 100;
}

/**
 * Map a session's materialized rollup + identity onto the shared cohort tags.
 * Pure and exported so the boundary bucketing is table-driven unit-testable. All
 * band boundaries come from the FEA-2266 module — none are redeclared here.
 */
export function deriveCohorts(
  analytics: CohortAnalyticsInput,
  identity: CohortIdentityInput
): SessionCohort {
  return {
    harness: (analytics.harness as Harness | null) ?? null,
    autonomyBand: autonomyBandFor(
      autonomyIndexFromTurns(analytics.humanTurns, analytics.agentTurns)
    ),
    closedloopUser: isClosedloopUser(identity),
    lengthBand: sessionLengthBandFor(analytics.runtimeMs ?? 0),
  };
}

/** True when a classified segment counts toward covered spend — the module's own
 * predicate pieces (never a local re-definition of the coverage rule). */
function isCoveredSegment(segment: ClassifiedSegment): boolean {
  return (
    isConfident(segment.confidence) &&
    !COVERAGE_EXCLUDED_STATES.has(segment.state)
  );
}

/** A `session_activity_segments` row projected to what the metrics need. */
type SegmentRow = {
  phase: string;
  confidence: number;
  startMs: bigint;
  endMs: bigint;
  version: number;
};

/**
 * Normalize any timestamp (epoch-ms number or ISO string) to a fixed 3-digit-ms
 * UTC ISO string. Segment spans (epoch-ms) and `token_events.created_at` (ISO,
 * possibly a different fractional precision) MUST share one representation before
 * the module's lexical `[startTs, endTs)` containment can align them; normalizing
 * both here makes lexical order match numeric order. An unparseable value falls
 * back to the raw string (it simply won't match any span → counts as gap spend,
 * still in the denominator), so this never throws mid-import.
 */
function toNormalizedIso(value: string | number): string {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    return typeof value === "string" ? value : "";
  }
  return new Date(ms).toISOString();
}

/** All the per-session metric fields (sans the session id) the row persists. */
type ActivityMetricsRow = {
  harness: string | null;
  autonomyBand: string;
  closedloopUser: number;
  lengthBand: string;
  startedDay: string | null;
  coverage: number;
  coveredSpendUsd: number;
  totalSpendUsd: number;
  spendLowConfUsd: number;
  spendMediumConfUsd: number;
  spendHighConfUsd: number;
  segmentCount: number;
  coveredSegmentCount: number;
  version: number;
  updatedAt: string;
};

/**
 * Compute this session's metrics row from its segments + token_events + rollup.
 * Returns null when the session has no segments (nothing to measure) or no
 * analytics rollup (cohorts undecidable) — the caller then writes no row.
 * Deterministic: identical rows in ⇒ identical row out.
 */
async function computeActivityMetricsRow(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<ActivityMetricsRow | null> {
  const segments = (await tx.sessionActivitySegment.findMany({
    where: { sessionId },
    select: {
      phase: true,
      confidence: true,
      startMs: true,
      endMs: true,
      version: true,
    },
    orderBy: { startMs: "asc" },
  })) as SegmentRow[];
  if (segments.length === 0) {
    return null;
  }

  const analytics = await tx.sessionAnalytics.findUnique({
    where: { sessionId },
    select: {
      harness: true,
      humanTurns: true,
      agentTurns: true,
      runtimeMs: true,
      startedDay: true,
    },
  });
  if (analytics === null) {
    // A session with segments is always rolled up first (importPhaseDerivedRollups
    // writes session_analytics immediately before this, and the backfill joins on
    // its presence), so this is an anomalous state — skip rather than guess cohorts.
    return null;
  }

  const identity = await tx.session.findUnique({
    where: { id: sessionId },
    select: { userId: true, organizationId: true },
  });

  // Per-turn spend from token_events (raw SQL: the table is Prisma-@@ignore'd).
  // Guard `created_at` with the same ISO GLOB dashboard-queries.ts applies to
  // this table: some legacy/pre-migration rows hold a non-ISO created_at that
  // `toNormalizedIso` cannot parse. Unguarded, such a row would fall back to its
  // raw string, match no segment span, and sink into gapSpend while still
  // counting toward the denominator — artificially depressing this session's
  // coverage (and its cohort's, the exact FR-12 weak-cohort signal). Excluding
  // them keeps unparseable-timestamp spend out of BOTH numerator and denominator,
  // so coverage reflects only time-attributable spend.
  const eventRows = await tx.$queryRawUnsafe<
    { created_at: string; cost_usd_estimated: number | null }[]
  >(
    `SELECT created_at, cost_usd_estimated FROM token_events
     WHERE session_id = $1
       AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
     ORDER BY created_at`,
    sessionId
  );
  const events: TokenSpendEvent[] = eventRows.map((row) => ({
    createdAt: toNormalizedIso(row.created_at),
    costUsd: row.cost_usd_estimated ?? 0,
  }));

  const spans: SpendSegmentSpan[] = segments.map((segment) => ({
    startTs: toNormalizedIso(Number(segment.startMs)),
    endTs: toNormalizedIso(Number(segment.endMs)),
  }));
  const perSegmentSpendUsd = attributeSegmentSpendUsd(events, spans);
  const totalSpendUsd = sessionTotalSpendUsd(events);
  const attributedSpendUsd = perSegmentSpendUsd.reduce((sum, s) => sum + s, 0);
  // Spend in turns covered by NO segment (implicit `other`): counts toward the
  // denominator, never toward coverage. Clamped ≥ 0 against float noise.
  const gapSpendUsd = Math.max(0, totalSpendUsd - attributedSpendUsd);

  // The confidence-tier spend distribution is summed in integer micro-cents —
  // the same exact-aggregate convention the FEA-2266 module uses for the coverage
  // numerator/denominator, so the tiers don't drift on float accumulation. NOTE
  // the three tiers partition only the SEGMENT-ATTRIBUTED spend: they sum to
  // `attributedSpendUsd` (== totalSpendUsd − gapSpendUsd), NOT to totalSpendUsd.
  // Out-of-segment `gapSpendUsd` (implicit `other`) belongs to no confidence
  // bucket by design, so low+medium+high < totalSpendUsd whenever gap spend > 0.
  let spendLowConfMicro = 0;
  let spendMediumConfMicro = 0;
  let spendHighConfMicro = 0;
  let coveredSegmentCount = 0;
  const classified: ClassifiedSegment[] = segments.map((segment, index) => {
    const spendUsd = perSegmentSpendUsd[index];
    const spendMicro = usdToMicroCents(spendUsd);
    const confidence = confidenceBucketFor(segment.confidence);
    if (confidence === ConfidenceBucket.Low) {
      spendLowConfMicro += spendMicro;
    } else if (confidence === ConfidenceBucket.Medium) {
      spendMediumConfMicro += spendMicro;
    } else {
      spendHighConfMicro += spendMicro;
    }
    // An unknown phase (a future taxonomy value not yet mirrored in the module)
    // is treated as `other` — excluded from coverage — so it can never silently
    // inflate the metric. The taxonomy drift guard keeps this branch dead today.
    const state = ACTIVITY_STATE_SET.has(segment.phase)
      ? (segment.phase as ActivityState)
      : ActivityState.Other;
    const item: ClassifiedSegment = { state, confidence, spendUsd };
    if (isCoveredSegment(item)) {
      coveredSegmentCount += 1;
    }
    return item;
  });

  const cohort = deriveCohorts(analytics, {
    userId: identity?.userId ?? null,
    organizationId: identity?.organizationId ?? null,
  });
  const session: CoverageSession = {
    sessionId,
    cohort,
    segments: classified,
    gapSpendUsd,
  };
  // Coverage overall for THIS session — the module owns the covered predicate and
  // the exact micro-cent ratio; per-cohort aggregation happens at read time via a
  // GROUP BY over the persisted rows (harness/autonomy/etc. columns below).
  const { overall } = computeCoverage([session]);

  return {
    harness: cohort.harness ?? null,
    autonomyBand: cohort.autonomyBand,
    closedloopUser: cohort.closedloopUser ? 1 : 0,
    lengthBand: cohort.lengthBand,
    startedDay: analytics.startedDay ?? null,
    coverage: overall.coverage,
    coveredSpendUsd: overall.coveredSpendUsd,
    totalSpendUsd: overall.totalSpendUsd,
    spendLowConfUsd: microCentsToUsd(spendLowConfMicro),
    spendMediumConfUsd: microCentsToUsd(spendMediumConfMicro),
    spendHighConfUsd: microCentsToUsd(spendHighConfMicro),
    segmentCount: segments.length,
    coveredSegmentCount,
    // The segments all share one classifier version (a re-tile replaces them
    // together); MAX is a defensive tie-break if a partial re-derive ever mixed them.
    version: segments.reduce((max, s) => Math.max(max, s.version), 0),
    updatedAt: now,
  };
}

/**
 * FEA-2273: (re)compute and persist ONE session's activity-metrics row, inside
 * the caller's transaction. Idempotent: importing the same session twice yields a
 * byte-identical row. A session with no segments has any stale row removed (so the
 * table stays a pure function of the current segments) and writes nothing new.
 */
export async function upsertActivityMetricsRollup(
  tx: Prisma.TransactionClient,
  sessionId: string,
  now: string
): Promise<void> {
  const row = await computeActivityMetricsRow(tx, sessionId, now);
  if (row === null) {
    // No segments (or no rollup): converge the table by clearing any prior row.
    await tx.sessionActivityMetrics.deleteMany({ where: { sessionId } });
    return;
  }
  await tx.sessionActivityMetrics.upsert({
    where: { sessionId },
    create: { sessionId, ...row },
    update: row,
    select: { sessionId: true },
  });
}

/**
 * Set-based (re)compute for an explicit set of session ids in ONE transaction.
 * Unlike the analytics rollup — a single aggregate SQL statement — the metric
 * math is a pure JS function per session (it runs the FEA-2266 module), so this
 * is a bounded per-session loop, not one giant statement. Mirrors
 * `upsertActivityMetricsRollup` exactly so the import path and the backfill can
 * never drift.
 */
export async function upsertActivityMetricsRollupBatch(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  now: string
): Promise<void> {
  for (const sessionId of sessionIds) {
    await upsertActivityMetricsRollup(tx, sessionId, now);
  }
}

/** Session ids per backfill transaction. Each session's metric read is narrow
 * (its own segments + token_events + one rollup row — no corpus scan), so a plain
 * count bound is sufficient; no metadata-byte budgeting is needed (unlike the
 * json_each analytics rollup). Kept modest so each commit (one fsync) stays cheap. */
export const ACTIVITY_METRICS_BACKFILL_CHUNK = 50;

/**
 * FEA-2273: idempotent boot pass that (re)derives the metrics rollup for any
 * session that has activity segments + an analytics rollup and either no metrics
 * row (installs upgrading past this migration, or sessions imported before the
 * emission wiring existed) OR a STALE one whose stamped version trails the
 * session's current segment version. The version-aware predicate is what keeps
 * the "a classifier bump re-derives" invariant true for the separate re-tile
 * pathway (`backfillActivitySegmentsFromTranscripts`), which re-tiles segments at
 * the new ACTIVITY_CLASSIFIER_VERSION but does not itself refresh metrics: the
 * next boot re-selects those now-behind rows here. Anti-join + JOIN on the two
 * prerequisites, chunked, background — mirrors `backfillSessionAnalytics`. A
 * failed chunk is logged and skipped so one bad session never aborts the sweep;
 * never blocks db open. The JOIN on `session_analytics` keeps a rollup-less
 * session from being re-selected on every boot (it can't produce a row until it
 * has a rollup); once a stale row is refreshed its version matches and it is no
 * longer re-selected (convergent).
 */
export async function backfillActivityMetrics(
  prisma: DesktopPrisma,
  log: (message: string) => void,
  chunkSize: number = ACTIVITY_METRICS_BACKFILL_CHUNK
): Promise<void> {
  const missing = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
    `SELECT seg.session_id AS id
     FROM (
       SELECT session_id, MAX(version) AS version
       FROM session_activity_segments
       GROUP BY session_id
     ) seg
     JOIN session_analytics sa ON sa.session_id = seg.session_id
     LEFT JOIN session_activity_metrics sam ON sam.session_id = seg.session_id
     WHERE sam.session_id IS NULL OR sam.version < seg.version`
  );
  if (missing.length === 0) {
    return;
  }
  const ids = missing.map((row) => row.id);
  const now = new Date().toISOString();
  const size = Math.max(1, Math.floor(chunkSize));
  let done = 0;
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    try {
      await prisma.write((client) =>
        client.$transaction((tx) =>
          upsertActivityMetricsRollupBatch(tx, chunk, now)
        )
      );
      done += chunk.length;
    } catch (error) {
      log(
        `activity-metrics backfill failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  log(`activity-metrics backfill complete: ${done}/${ids.length}`);
}

/**
 * The sole definition of the ClosedLoop-user cohort axis: a session belongs to a
 * ClosedLoop user when either identity column is stamped. Exported because
 * ISS-6168's boot-time owner claim repairs those columns AFTER a metrics row has
 * already been materialized at the current classifier version — which
 * {@link backfillActivityMetrics}'s missing-or-version-stale predicate will never
 * re-select — so the claim re-stamps this flag through this helper rather than
 * re-deriving the rule at the repair site.
 */
export function isClosedloopUser(identity: CohortIdentityInput): boolean {
  return identity.userId != null || identity.organizationId != null;
}
