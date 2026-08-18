import { MICRO_CENTS_PER_USD } from "@repo/lib/branches/activity-attribution";
import type {
  BoundedBranchEvidenceRows,
  BranchActivitySegmentRow,
} from "./branch-analytics-phase-evidence.js";
import { BRANCH_ANALYTICS_ACTIVITY_SEGMENT_MAX_ROWS } from "./branch-analytics-phase-evidence.js";
import {
  activeWriteLinkSql,
  BRANCH_LINKED_SESSION_SUBQUERY,
  type BranchKeyRow,
} from "./branch-reads.js";
import type { DesktopPrisma } from "./prisma-client.js";

export const BranchMetricOutsideEventSide = {
  Before: "before",
  After: "after",
} as const;

export type BranchMetricOutsideEventSide =
  (typeof BranchMetricOutsideEventSide)[keyof typeof BranchMetricOutsideEventSide];

/** Canonical retained span for a Branch metric event read. */
export type BranchMetricEventProvenanceBounds = {
  /** Omitted for All, whose retained population has no lower bound. */
  startIso?: string;
  /** Inclusive raw-read upper bound; summarized `After` rows are strictly later. */
  endIso: string;
};

/** Clone-safe request for the reader-pooled Branch metric evidence operation. */
export type BranchMetricEventEvidenceRequest = {
  bounds: BranchMetricEventProvenanceBounds;
  branchKeys?: readonly BranchKeyRow[];
};

/** Compact evidence for canonical events outside the raw metric-event span. */
export type BranchMetricOutsideEventProvenanceRow = {
  segmentId: string;
  sessionId: string;
  phase: string;
  startMs: number;
  endMs: number;
  confidence: number;
  side: BranchMetricOutsideEventSide;
  representativeOccurredAt: string;
  sourceEventCount: number;
  validCostEventCount: number;
  positiveCostEventCount: number;
  invalidCostValuePresent: boolean;
  costMicroCents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokenCountsInvalid: boolean;
};

/** One snapshot of the admitted phase segments and their outside-span evidence. */
export type BranchMetricEventEvidenceRead = {
  activitySegments: BoundedBranchEvidenceRows<BranchActivitySegmentRow>;
  outsideProvenance: BranchMetricOutsideEventProvenanceRow[];
};

/** Clone-safe heavy-read facade exposed by the Desktop database host. */
export type BranchMetricEventEvidenceMethods = {
  readBranchMetricEventEvidence(
    request: BranchMetricEventEvidenceRequest
  ): Promise<BranchMetricEventEvidenceRead>;
};

/** Build the reader-pooled, clone-safe Branch metric evidence operation. */
export function createBranchMetricEventEvidenceMethods(
  prisma: DesktopPrisma
): BranchMetricEventEvidenceMethods {
  return {
    readBranchMetricEventEvidence: (request) =>
      readBranchMetricEventEvidence(prisma, request),
  };
}

/**
 * Read the deterministic admitted segment population and compact outside-span
 * event evidence in one SQLite statement on one reader-pool snapshot.
 */
async function readBranchMetricEventEvidence(
  prisma: DesktopPrisma,
  request: BranchMetricEventEvidenceRequest
): Promise<BranchMetricEventEvidenceRead> {
  if (request.branchKeys?.length === 0) {
    return emptyBranchMetricEventEvidenceRead();
  }
  const scope = buildCohortScope(request.branchKeys);
  const rawRows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<EvidenceRawRow[]>(
      `WITH ${scope.requestedBranchesCte}metric_bounds(start_iso, end_iso) AS (
         VALUES (?, ?)
       ), activity_segment_candidates AS (
         SELECT id, session_id, phase, start_ms, end_ms, confidence
         FROM session_activity_segments
         WHERE session_id IN (${scope.sessionSubquery})
         ORDER BY session_id ASC, start_ms ASC, id ASC
         LIMIT ${BRANCH_ANALYTICS_ACTIVITY_SEGMENT_MAX_ROWS + 1}
       ), admitted_activity_segments AS (
         SELECT id, session_id, phase, start_ms, end_ms, confidence
         FROM activity_segment_candidates
         ORDER BY session_id ASC, start_ms ASC, id ASC
         LIMIT ${BRANCH_ANALYTICS_ACTIVITY_SEGMENT_MAX_ROWS}
       ), canonical_outside_events AS (
         SELECT
           te.rowid AS event_row_id,
           te.session_id,
           te.created_at,
           CAST(strftime('%s', te.created_at) AS INTEGER) * 1000 +
             CAST(substr(te.created_at, 21, 3) AS INTEGER) AS occurred_at_ms,
           te.cost_usd_estimated,
           te.input_tokens,
           te.output_tokens,
           te.cache_read_tokens,
           te.cache_write_tokens,
           CASE
             WHEN metric_bounds.start_iso IS NOT NULL
               AND te.created_at < metric_bounds.start_iso
               THEN '${BranchMetricOutsideEventSide.Before}'
             ELSE '${BranchMetricOutsideEventSide.After}'
           END AS event_side
         FROM token_events te
         CROSS JOIN metric_bounds
         WHERE te.session_id IN (
           SELECT DISTINCT session_id FROM admitted_activity_segments
         )
           AND te.created_at GLOB '${CANONICAL_INSTANT_GLOB}'
           AND substr(te.created_at, 12, 2) <= '23'
           AND strftime('%Y-%m-%dT%H:%M:%fZ', te.created_at) IS te.created_at
           AND (
             (metric_bounds.start_iso IS NOT NULL
               AND te.created_at < metric_bounds.start_iso)
             OR te.created_at > metric_bounds.end_iso
           )
       ), mapped_segment_events AS (
         SELECT
           segments.id AS segment_id,
           segments.session_id,
           segments.phase,
           segments.start_ms,
           segments.end_ms,
           segments.confidence,
           events.*
         FROM canonical_outside_events events
         JOIN admitted_activity_segments segments
           ON segments.id = (
             SELECT candidate.id
             FROM admitted_activity_segments candidate
             WHERE candidate.session_id = events.session_id
               AND events.occurred_at_ms >= candidate.start_ms
               AND events.occurred_at_ms < candidate.end_ms
             ORDER BY candidate.start_ms ASC, candidate.id ASC
             LIMIT 1
           )
       ), outside_provenance AS (
         SELECT
           segment_id, session_id, phase, start_ms, end_ms, confidence,
           event_side,
           CASE
             WHEN event_side = '${BranchMetricOutsideEventSide.Before}'
               THEN MAX(created_at)
             ELSE MIN(created_at)
           END AS representative_occurred_at,
           COUNT(*) AS source_event_count,
           SUM(CASE WHEN ${validCostSql("cost_usd_estimated")} THEN 1 ELSE 0 END)
             AS valid_cost_event_count,
           SUM(CASE WHEN ${positiveCostSql("cost_usd_estimated")} THEN 1 ELSE 0 END)
             AS positive_cost_event_count,
           MAX(CASE
             WHEN cost_usd_estimated IS NOT NULL
               AND NOT (${validCostSql("cost_usd_estimated")})
               THEN 1 ELSE 0
           END) AS invalid_cost_value_present,
           CAST(SUM(CASE
             WHEN ${validCostSql("cost_usd_estimated")}
               THEN ROUND(cost_usd_estimated * ${MICRO_CENTS_PER_USD})
             ELSE 0
           END) AS TEXT) AS cost_micro_cents,
           ${summedTokenSql("input_tokens")} AS input_tokens,
           ${summedTokenSql("output_tokens")} AS output_tokens,
           ${summedTokenSql("cache_read_tokens")} AS cache_read_tokens,
           ${summedTokenSql("cache_write_tokens")} AS cache_write_tokens,
           MAX(CASE WHEN
             ${invalidTokenSql("input_tokens")}
             OR ${invalidTokenSql("output_tokens")}
             OR ${invalidTokenSql("cache_read_tokens")}
             OR ${invalidTokenSql("cache_write_tokens")}
             THEN 1 ELSE 0
           END) AS token_counts_invalid
         FROM mapped_segment_events
         GROUP BY
           segment_id, session_id, phase, start_ms, end_ms, confidence, event_side
       )
       SELECT
         'segment' AS row_kind,
         segments.id AS segment_id,
         segments.session_id,
         segments.phase,
         CAST(segments.start_ms AS TEXT) AS start_ms,
         CAST(segments.end_ms AS TEXT) AS end_ms,
         segments.confidence,
         NULL AS event_side,
         NULL AS representative_occurred_at,
         NULL AS source_event_count,
         NULL AS valid_cost_event_count,
         NULL AS positive_cost_event_count,
         NULL AS invalid_cost_value_present,
         NULL AS cost_micro_cents,
         NULL AS input_tokens,
         NULL AS output_tokens,
         NULL AS cache_read_tokens,
         NULL AS cache_write_tokens,
         NULL AS token_counts_invalid,
         (SELECT COUNT(*) FROM activity_segment_candidates) AS candidate_count
       FROM admitted_activity_segments segments
       UNION ALL
       SELECT
         'provenance' AS row_kind,
         segment_id, session_id, phase,
         CAST(start_ms AS TEXT), CAST(end_ms AS TEXT), confidence,
         event_side, representative_occurred_at, source_event_count,
         valid_cost_event_count, positive_cost_event_count,
         invalid_cost_value_present, cost_micro_cents, input_tokens,
         output_tokens, cache_read_tokens, cache_write_tokens,
         token_counts_invalid, NULL AS candidate_count
       FROM outside_provenance
       ORDER BY session_id ASC, start_ms ASC, segment_id ASC, row_kind DESC, event_side ASC`,
      ...scope.parameters,
      request.bounds.startIso ?? null,
      request.bounds.endIso
    )
  );
  return mapEvidenceRows(rawRows);
}

function mapEvidenceRows(
  rows: EvidenceRawRow[]
): BranchMetricEventEvidenceRead {
  const segmentRows = rows.filter((row) => row.row_kind === "segment");
  return {
    activitySegments: {
      rows: segmentRows.map((row) => ({
        sessionId: row.session_id,
        phase: row.phase,
        startMs: Number(row.start_ms),
        endMs: Number(row.end_ms),
        confidence: Number(row.confidence),
      })),
      capped:
        Number(segmentRows.at(0)?.candidate_count ?? 0) >
        BRANCH_ANALYTICS_ACTIVITY_SEGMENT_MAX_ROWS,
    },
    outsideProvenance: rows.filter(isProvenanceRawRow).map(mapOutsideEventRow),
  };
}

function isProvenanceRawRow(row: EvidenceRawRow): row is ProvenanceRawRow {
  return row.row_kind === "provenance";
}

function mapOutsideEventRow(
  row: ProvenanceRawRow
): BranchMetricOutsideEventProvenanceRow {
  const input = nonnegativeAggregate(row.input_tokens);
  const output = nonnegativeAggregate(row.output_tokens);
  const cacheRead = nonnegativeAggregate(row.cache_read_tokens);
  const cacheWrite = nonnegativeAggregate(row.cache_write_tokens);
  const microCents = nonnegativeAggregate(row.cost_micro_cents);
  return {
    segmentId: row.segment_id,
    sessionId: row.session_id,
    phase: row.phase,
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    confidence: Number(row.confidence),
    side:
      row.event_side === BranchMetricOutsideEventSide.Before
        ? BranchMetricOutsideEventSide.Before
        : BranchMetricOutsideEventSide.After,
    representativeOccurredAt: row.representative_occurred_at,
    sourceEventCount: Number(row.source_event_count),
    validCostEventCount: Number(row.valid_cost_event_count),
    positiveCostEventCount: Number(row.positive_cost_event_count),
    invalidCostValuePresent:
      Number(row.invalid_cost_value_present) > 0 || microCents.invalid,
    costMicroCents: microCents.value,
    inputTokens: input.value,
    outputTokens: output.value,
    cacheReadTokens: cacheRead.value,
    cacheWriteTokens: cacheWrite.value,
    tokenCountsInvalid:
      Number(row.token_counts_invalid) > 0 ||
      input.invalid ||
      output.invalid ||
      cacheRead.invalid ||
      cacheWrite.invalid,
  };
}

function nonnegativeAggregate(value: string): {
  value: number;
  invalid: boolean;
} {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? { value: numeric, invalid: false }
    : { value: 0, invalid: true };
}

/**
 * The read an empty cohort resolves to. Exported so the main-process
 * empty-scope bypass (`branch/branch-empty-scope-reads.ts`) returns the SAME
 * value this worker-side short-circuit does, rather than restating the shape.
 */
export function emptyBranchMetricEventEvidenceRead(): BranchMetricEventEvidenceRead {
  return {
    activitySegments: { rows: [], capped: false },
    outsideProvenance: [],
  };
}

function buildCohortScope(
  branchKeys: readonly BranchKeyRow[] | undefined
): CohortScope {
  if (!branchKeys) {
    return {
      requestedBranchesCte: "",
      sessionSubquery: BRANCH_LINKED_SESSION_SUBQUERY,
      parameters: [],
    };
  }
  const values = branchKeys.map(() => "(?, ?)").join(", ");
  return {
    requestedBranchesCte: `requested_branches(repo_full_name, branch_name) AS (VALUES ${values}),\n     cohort_sessions AS (\n       SELECT DISTINCT sal.session_id\n       FROM session_artifact_links sal\n       JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'\n       JOIN requested_branches rb\n         ON rb.branch_name = a.branch_name\n        AND rb.repo_full_name IS NOT DISTINCT FROM a.repo_full_name\n       WHERE ${activeWriteLinkSql("sal", "a")}\n     ),\n     `,
    sessionSubquery: "SELECT session_id FROM cohort_sessions",
    parameters: branchKeys.flatMap(({ repoFullName, branchName }) => [
      repoFullName,
      branchName,
    ]),
  };
}

function summedTokenSql(column: string): string {
  return `CAST(SUM(CASE WHEN ${validTokenSql(column)} THEN COALESCE(${column}, 0) ELSE 0 END) AS TEXT)`;
}

function invalidTokenSql(column: string): string {
  return `NOT (${validTokenSql(column)})`;
}

function validTokenSql(column: string): string {
  return `(typeof(COALESCE(${column}, 0)) = 'integer' AND COALESCE(${column}, 0) >= 0 AND COALESCE(${column}, 0) <= ${MAX_SAFE_INTEGER})`;
}

function validCostSql(column: string): string {
  return `(${finiteNumericSql(column)} AND ${column} >= 0)`;
}

function positiveCostSql(column: string): string {
  return `(${validCostSql(column)} AND ${column} > 0)`;
}

function finiteNumericSql(column: string): string {
  return `(${column} IS NOT NULL AND typeof(${column}) IN ('integer', 'real') AND ${column} BETWEEN -${MAX_FINITE_REAL} AND ${MAX_FINITE_REAL})`;
}

type CohortScope = {
  requestedBranchesCte: string;
  sessionSubquery: string;
  parameters: (string | null)[];
};

type EvidenceRawRow = SegmentRawRow | ProvenanceRawRow;

type SegmentRawRow = CommonRawRow & {
  row_kind: "segment";
  event_side: null;
  representative_occurred_at: null;
  source_event_count: null;
  valid_cost_event_count: null;
  positive_cost_event_count: null;
  invalid_cost_value_present: null;
  cost_micro_cents: null;
  input_tokens: null;
  output_tokens: null;
  cache_read_tokens: null;
  cache_write_tokens: null;
  token_counts_invalid: null;
  candidate_count: number | bigint;
};

type ProvenanceRawRow = CommonRawRow & {
  row_kind: "provenance";
  event_side: string;
  representative_occurred_at: string;
  source_event_count: number | bigint;
  valid_cost_event_count: number | bigint;
  positive_cost_event_count: number | bigint;
  invalid_cost_value_present: number | bigint;
  cost_micro_cents: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  token_counts_invalid: number | bigint;
  candidate_count: null;
};

type CommonRawRow = {
  segment_id: string;
  session_id: string;
  phase: string;
  start_ms: string;
  end_ms: string;
  confidence: number;
};

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_FINITE_REAL = Number.MAX_VALUE;
const CANONICAL_INSTANT_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";
