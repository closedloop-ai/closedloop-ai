import type { SyncedSessionActivityMetrics } from "@repo/api/src/types/session-activity-metrics";
import {
  MAX_ROLLUP_COUNT,
  MAX_TIER_SPEND_USD,
} from "@repo/api/src/types/session-activity-metrics-normalize";
import type { SyncedSessionLoadOptions } from "../agent-sync/agent-session-sync-source.js";
import type {
  SqliteArtifactLinkRow,
  SqlitePullRequestLifecycleRow,
  SqlitePullRequestRow,
  SqliteSessionAnalyticsRow,
} from "./db-row-types.js";
import { CANONICAL_PR_OPENED_AT_SQL } from "./pr-opened-at-rank-sql.js";
import { priorityColumnSql } from "./priority-upload-marker.js";
import type { DesktopPrismaReader } from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

/**
 * The per-session batched SQL reads the sync source draws on, plus the wire
 * mapping for the one table that had no cloud twin before ISS-10721.
 *
 * Extracted from `sync-source.ts` so that file carries the payload assembly and
 * not the projections. Every read here takes a batch of session ids and is
 * keyed so it returns rows for exactly that batch; `session_activity_metrics`
 * and `session_analytics` are keyed on `session_id` as a primary key, so those
 * two yield at most one row per id.
 *
 * ISS-10721 — the `session_activity_metrics` rollup on its way to the cloud.
 *
 * The local columns are NOT NULL with `0` defaults, for reasons that predate the
 * cloud table: a row exists only once the rollup has run, so locally a zero is
 * always a measured zero. That stops being true the moment the value crosses to
 * a nullable cloud column, so {@link mapSyncedSessionActivityMetrics} is where
 * the local shape's "`0` because unmeasured is impossible here" meets the wire's
 * "absent means unmeasured" — a field whose stored value is not a usable
 * measurement is OMITTED from the payload rather than sent as a zero the cloud
 * would store as fact.
 */
/** One `session_activity_metrics` row as the sync read selects it. */
export type SqliteSessionActivityMetricsRow = {
  session_id: string;
  autonomy_band: string | null;
  coverage: number | null;
  spend_low_conf_usd: number | null;
  spend_medium_conf_usd: number | null;
  spend_high_conf_usd: number | null;
  segment_count: number | null;
  covered_segment_count: number | null;
  version: number | null;
  metric_version: number | null;
};

/**
 * Load the rollup rows for a batch of session ids. `session_id` is the table's
 * primary key, so this yields at most one row per id.
 */
export function readActivityMetrics(
  reader: DesktopPrismaReader,
  ids: string[]
): Promise<SqliteSessionActivityMetricsRow[]> {
  return selectRowsByIds<SqliteSessionActivityMetricsRow>(
    reader,
    `
      SELECT
        session_id,
        autonomy_band,
        coverage,
        spend_low_conf_usd,
        spend_medium_conf_usd,
        spend_high_conf_usd,
        segment_count,
        covered_segment_count,
        version,
        metric_version
      FROM session_activity_metrics
      WHERE session_id IN (__IDS__)
    `,
    ids
  );
}

/** Index the rollup rows by session id, once per batch. */
export function indexActivityMetrics(
  rows: readonly SqliteSessionActivityMetricsRow[] | undefined
): ReadonlyMap<string, SqliteSessionActivityMetricsRow> {
  return new Map((rows ?? []).map((row) => [row.session_id, row]));
}

/**
 * The `activityMetrics` field one assembled session contributes to its payload:
 * the mapped rollup, or an explicit `null` RETRACTION when this session holds no
 * usable rollup locally.
 *
 * `null` rather than omission, which is the opposite of every sibling section on
 * this payload, and the asymmetry is the point (ISS-10721 review, whitlockk). Those
 * sections are append-or-replace sets whose absence genuinely means "this part
 * carries none of them". This table is a PURE FUNCTION of the session's current
 * segments: `upsertActivityMetricsRollup` DELETES the row when a re-tile drops a
 * session to zero segments, and {@link syncedChildRowFingerprint} counts the row
 * so that delete requeues the session. Omitting the key there would hand the
 * cloud "leave it alone" for a rollup the producer has retracted, and the cloud
 * would keep publishing a band, a coverage and a spend split for a tiling that
 * no longer exists, with no later sync able to say otherwise. A cloud build that
 * predates the retraction arm reads this `null` as it reads an absent key today,
 * so the widened vocabulary is safe against skew in both directions.
 */
export function syncedActivityMetricsField(
  rowsById: ReadonlyMap<string, SqliteSessionActivityMetricsRow>,
  sessionId: string
): { activityMetrics: SyncedSessionActivityMetrics | null } {
  return {
    activityMetrics: mapSyncedSessionActivityMetrics(rowsById.get(sessionId)),
  };
}

/**
 * Map one stored rollup row to the wire shape, or `null` when the row carries
 * no usable measurement at all.
 *
 * Each key is omitted independently, EXCEPT the three spend tiers, which are a
 * partition of the attributed spend: sending two of the three would leave the
 * receiver summing an understated total and reporting every share drawn from it
 * as larger than it is. A partition is published whole or withheld whole.
 */
export function mapSyncedSessionActivityMetrics(
  row: SqliteSessionActivityMetricsRow | undefined
): SyncedSessionActivityMetrics | null {
  if (!row) {
    return null;
  }
  const low = finiteAmount(row.spend_low_conf_usd);
  const medium = finiteAmount(row.spend_medium_conf_usd);
  const high = finiteAmount(row.spend_high_conf_usd);
  const splitIsWhole = low !== null && medium !== null && high !== null;
  const metrics: SyncedSessionActivityMetrics = {
    ...(row.autonomy_band ? { autonomyBand: row.autonomy_band } : {}),
    ...(ratio(row.coverage) === null ? {} : { coverage: ratio(row.coverage) }),
    ...(splitIsWhole
      ? {
          spendLowConfUsd: low,
          spendMediumConfUsd: medium,
          spendHighConfUsd: high,
        }
      : {}),
    ...countField("segmentCount", row.segment_count),
    ...countField("coveredSegmentCount", row.covered_segment_count),
    ...countField("classifierVersion", row.version),
    ...countField("metricVersion", row.metric_version),
  };
  return Object.keys(metrics).length > 0 ? metrics : null;
}

/**
 * `{ [key]: n }` for a whole non-negative count, else `{}` — never a null.
 *
 * Bounded at {@link MAX_ROLLUP_COUNT} because all four destination columns are
 * Postgres `INTEGER`: SQLite stores an `INTEGER` up to 2^63, so a corrupt or
 * runaway local value is representable here and would reach the wire, pass the
 * ingest schema's safe-integer check, and only fail at the write with a `22003`
 * that rolls the whole session transaction back — re-poisoned on every retry.
 * Dropping it here keeps the session syncing without that measure.
 */
function countField<K extends string>(
  key: K,
  value: number | null
): Partial<Record<K, number>> {
  // Deliberately NOT `finiteAmount`: that helper carries the spend column's
  // `Decimal(14, 6)` ceiling, which is two orders of magnitude below this one,
  // so borrowing it would silently bound a count by a money limit and leave the
  // real int4 edge untested.
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_ROLLUP_COUNT
  ) {
    return {};
  }
  return { [key]: value } as Partial<Record<K, number>>;
}

/**
 * A finite, non-negative amount inside the cloud column's `Decimal(14, 6)`, else
 * null. Rejects strings by type.
 *
 * The upper bound is the same argument as {@link countField}'s: a tier above
 * {@link MAX_TIER_SPEND_USD} cannot land, so sending it converts one implausible
 * local number into a rejected batch. Withheld here, and — because the tiers are
 * a partition — it withholds the whole split rather than biasing the two that
 * survive.
 */
function finiteAmount(value: number | null): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_TIER_SPEND_USD
  ) {
    return null;
  }
  return value;
}

/** A finite ratio in [0, 1], else null. */
function ratio(value: number | null): number | null {
  const amount = finiteAmount(value);
  return amount === null || amount > 1 ? null : amount;
}

/**
 * FEA-2730 (G10): load the desktop per-session analytics rollup for a batch of
 * session ids.
 */
export function readSessionAnalyticsRows(
  reader: DesktopPrismaReader,
  ids: string[]
): Promise<SqliteSessionAnalyticsRow[]> {
  return selectRowsByIds<SqliteSessionAnalyticsRow>(
    reader,
    `
      SELECT
        session_id,
        started_at,
        started_day,
        status,
        harness,
        is_human,
        human_turns,
        agent_turns,
        event_count,
        tool_invocations,
        error_events,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        est_cost,
        runtime_ms,
        updated_at
      FROM session_analytics
      WHERE session_id IN (__IDS__)
    `,
    ids
  );
}

export function readPullRequestRows(
  reader: DesktopPrismaReader,
  ids: string[]
): Promise<SqlitePullRequestRow[]> {
  return selectRowsByIds<SqlitePullRequestRow>(
    reader,
    `
      SELECT session_id, pr_number, repo_full_name, title,
        closed_at, observed_at
      FROM (
        SELECT
          sal.session_id AS session_id,
          a.pr_number AS pr_number,
          a.repo_full_name AS repo_full_name,
          a.title AS title,
          NULL AS closed_at,
          a.last_seen_at AS observed_at,
          ROW_NUMBER() OVER (
            PARTITION BY sal.session_id, a.pr_number, a.repo_full_name
            ORDER BY a.last_seen_at DESC
          ) AS rn
        FROM session_artifact_links sal
        JOIN artifacts a ON a.id = sal.artifact_id
        WHERE sal.session_id IN (__IDS__)
          AND a.kind = 'pull_request'
          AND a.pr_number IS NOT NULL
          AND (sal.relation IN ('created', 'workspace')
               OR sal.method = 'harness_pr_link')
      ) ranked
      WHERE rn = 1
      ORDER BY session_id, pr_number, repo_full_name
    `,
    ids
  );
}

export function readPullRequestLifecycleRows(
  reader: DesktopPrismaReader,
  ids: string[]
): Promise<SqlitePullRequestLifecycleRow[]> {
  return selectRowsByIds<SqlitePullRequestLifecycleRow>(
    reader,
    `
      SELECT
        pr.session_id AS session_id,
        pr.pr_number AS pr_number,
        pr.repo_full_name AS repo_full_name,
        pr.closed_at AS closed_at
      FROM pull_requests pr
      WHERE pr.session_id IN (__IDS__)
        AND pr.pr_number IS NOT NULL
        AND pr.repo_full_name IS NOT NULL
    `,
    ids
  );
}

/**
 * The per-session artifact-link projection: every session→artifact link in the
 * batch, joined to its artifact row and to the PR-opened instant the timeline
 * marker builder needs.
 *
 * ISS-11106 moved it here from `sync-source.ts`, which is grandfathered on the
 * `noExcessiveLinesPerFile` list, for the reason this module's header states —
 * that file assembles the payload and this one owns the projections. The
 * `pr_opened_at` expression is {@link CANONICAL_PR_OPENED_AT_SQL} and correlates
 * on the `artifacts` alias `a` this query establishes.
 */
export function readArtifactLinkRows(
  reader: DesktopPrismaReader,
  ids: string[],
  options?: Pick<SyncedSessionLoadOptions, "priorityProjection"> & {
    /** List projection never consumes monitored activity evidence. */
    omitLinkEvidence?: boolean;
  }
): Promise<SqliteArtifactLinkRow[]> {
  return selectRowsByIds<SqliteArtifactLinkRow>(
    reader,
    `
      SELECT
        sal.id AS link_id,
        sal.session_id,
        a.kind AS target_kind,
        a.slug,
        sal.is_primary,
        sal.method,
        ${options?.omitLinkEvidence ? "NULL" : "sal.evidence"} AS link_evidence,
        a.repo_full_name,
        a.pr_number,
        a.url,
        sal.relation,
        a.sha,
        a.title,
        a.branch_name,
        a.base_ref,
        ${priorityColumnSql("a", options?.priorityProjection)} AS priority,
        sal.observed_at AS link_observed_at,
        a.committed_at AS artifact_committed_at,
        a.observed_at AS artifact_observed_at,
        a.last_seen_at AS artifact_last_seen_at,
        -- FEA-3329: the AUTHORITATIVE PR-opened instant, earliest-first across
        -- every pull_requests row for this (repo, number) so the join stays 1:1
        -- with the link row. NULL whenever no release ever stored one -- the
        -- enrichment lane that wrote the column was deleted by PLN-1535 (PR
        -- #4435), so nothing in this tree fills it in later. On NULL the marker
        -- builder anchors the PR marker on the corrected session activity END,
        -- NOT on the observed timestamps beside it, which it rejects as rebuild
        -- artifacts (session-artifact-markers.ts). ISS-11106: ranked by
        -- instant, not by bytes -- see pr-opened-at-rank-sql.ts.
        ${CANONICAL_PR_OPENED_AT_SQL} AS pr_opened_at
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id
      WHERE sal.session_id IN (__IDS__)
      ORDER BY sal.session_id ASC, sal.created_at ASC

    `,
    ids
  );
}
