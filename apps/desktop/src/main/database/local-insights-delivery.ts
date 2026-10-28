/**
 * Desktop-local Delivery Insights section.
 *
 * Split out of `local-insights.ts` — which was over the file-size ceiling and
 * shrink-only — rather than grown into it, the same seam
 * `local-insights-spend.ts`, `local-insights-loc.ts` and `local-insights-series.ts`
 * already use: this module owns ONE Insights section, its aggregate reads
 * and the KPI/chart derivation over them.
 */

import type { DeliveryInsightsResponse } from "@closedloop-ai/loops-api/insights";
import {
  COST_KPI_SUB,
  comparableKpi,
  KpiFormat,
  kpi,
  lifespanHistogram,
  pctDelta,
  ttmHistogram,
} from "@closedloop-ai/loops-api/insights";
import { MERGED_LOC_LABEL } from "@repo/api/src/types/insights-loc-terminology-flag";
import { median } from "@repo/api/src/utils/math";
import {
  createdArtifactLinksSubquery,
  localDay,
  numberOrZero as num,
} from "./db-helpers.js";
import {
  capturedLocKpis,
  unsizedCapturedPrLocTotals,
} from "./local-insights-loc.js";
import type { Range } from "./local-insights-range.js";
import { prSplitSeries } from "./local-insights-series.js";
import { buildDeliveryTileAvailability } from "./local-insights-tiles.js";
import {
  currentWindowCostSql,
  priorWindowCostSql,
} from "./local-insights-window-sql.js";
import {
  excludeNonDeliveryOnlyArtifacts,
  resolveNonDeliveryOnlyArtifactIds,
} from "./non-delivery-artifacts.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * The Delivery section of local Insights for `range`.
 *
 * ISS-5938: each aggregate is dispatched through `prisma.read` — the round-robin
 * pool of `query_only` reader connections — not the writer-bound `prisma.client`.
 * `prisma.client` is documented for light reads co-located with writes; these are
 * full-corpus aggregates that are neither, and on the writer they serialized
 * against the write queue, so an Insights load during first-launch backfill or
 * live import delayed the importer and vice versa. Dispatching each read
 * SEPARATELY (rather than holding one reader for the whole section) is what buys
 * the `Promise.all` real concurrency: the pool fans them across connections,
 * where a single connection would self-serialize on the adapter's per-connection
 * mutex exactly as the writer did.
 *
 * Deliberately NOT wrapped in one `read((r) => r.$transaction(...))`, which the
 * issue floated as a way to give the fan-out one committed snapshot. That would
 * hold one of the two pooled readers (`DEFAULT_READER_POOL_SIZE`) for the whole
 * section, and the pool is load-bearing for other surfaces: `read()` dispatches
 * strict round-robin with no availability check, the bounded-read lane's ceiling
 * is deliberately tied to the pool size, and a concurrent reader `$transaction`
 * that lands on the pinned slot fails outright at `TRANSACTION_MAX_WAIT_MS`
 * rather than queueing. A held read-mark also blocks every form of WAL reclaim —
 * passive autocheckpoint, the throttled TRUNCATE, and the frame-ceiling backstop
 * — for its duration, which is the FEA-3132 runaway-`-wal` mode. The snapshot
 * would also be a NEW guarantee rather than a restored one: before ISS-5938
 * these reads were ten independent implicit transactions on the writer, and on
 * the pool they still are, so per-read dispatch leaves the guarantee CLASS
 * exactly as it was — never snapshot-consistent, intra-section skew always
 * possible. The WINDOW is wider, though: the reads used to share the writer's
 * single connection and its per-connection mutex, so a commit could not land
 * while one of them held it, whereas the writer now commits on a fully
 * independent connection throughout the fan-out. Same class, more opportunity
 * to hit it — do not read this line as evidence that intra-section skew is no
 * likelier than before.
 *
 * The cost this DOES carry: nine aggregates land on a two-slot pool (the eight
 * below plus the ISS-5936 gate resolve that precedes them), so a pooled
 * read from another surface (the Sessions page's usage aggregates) can queue
 * behind roughly half of them instead of behind nothing — on the writer these
 * reads occupied no reader slot at all. It is bounded rather than open-ended:
 * only ONE section computes at a time (the insights cache single-flights at
 * concurrency 1, and the db-host routes `dashboard.getInsights` through the
 * width-1 exclusive lane), so the pool never sees more than one section's
 * fan-out. Bounding the fan-out further would trade Insights latency for
 * Sessions latency, which is not worth doing without a measurement.
 */
export async function computeDelivery(
  prisma: DesktopPrisma,
  range: Range
): Promise<DeliveryInsightsResponse> {
  // Every delivery read aggregates `artifacts` on `COALESCE(observed_at,
  // created_at)` (a two-column coalesce with no typed-where form), or uses a
  // strftime day-bucket / ROW_NUMBER window / SUM — none has a clean typed
  // delegate, so they stay raw (`$queryRawUnsafe` is re-exposed on the pooled
  // reader for exactly this).
  //
  // ISS-5936: the delivery-population gate is resolved ONCE here and rendered
  // into the statements below that need it, instead of each embedding the same
  // whole-table `session_artifact_links` aggregate.
  // ISS-5938: it resolves on the reader pool like every other read in this
  // section — its contract is typed on `DesktopPrismaReader` precisely so both
  // dispatch paths are accepted. It is deliberately awaited BEFORE the fan-out
  // rather than joined into it: those statements need its result to build
  // their own SQL text, so it is a genuine dependency, not a lost parallel slot.
  const nonDeliveryOnlyIds = await prisma.read((reader) =>
    resolveNonDeliveryOnlyArtifactIds(reader)
  );
  const [current, trend, latencyRows, costRow, priorCostRow, earliestRow] =
    await Promise.all([
      prisma.read((reader) =>
        reader.$queryRawUnsafe<{ n: bigint }[]>(
          // `n` backs the captured-PR coverage counts; the `merged` KPI itself is
          // unknown (ISS-12902). The merged/decided/size counts that
          // once sat beside it read `artifacts.pr_state` and line counts, which the
          // desktop store no longer holds (ISS-12709), so they are absent below.
          `SELECT COUNT(*) AS n
         FROM artifacts
         WHERE kind = 'pull_request'
           -- FEA-3585: a reviewed-ONLY PR (examined via a gh pr review command,
           -- never authored/worked) is not this corpus's delivery — exclude it so
           -- it can't inflate captured/merged/merge-rate.
           AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", nonDeliveryOnlyIds)}
           AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2`,
          range.startIso,
          range.endIso
        )
      ),
      prisma.read((reader) =>
        reader.$queryRawUnsafe<{ day: string; n: bigint; agent_n: bigint }[]>(
          // FEA-2486: agent_n counts PRs with session PR-creation evidence
          // (relation 'created' from a pr-create tool output). DISTINCT collapses
          // multi-session created links so one PR can never fan out to >1.
          `SELECT ${localDay("COALESCE(observed_at, created_at)")} AS day,
                COUNT(*) AS n,
                SUM(CASE WHEN cl.artifact_id IS NOT NULL THEN 1 ELSE 0 END) AS agent_n
         FROM artifacts
         LEFT JOIN ${createdArtifactLinksSubquery()} cl
           ON cl.artifact_id = artifacts.id
         WHERE kind = 'pull_request'
           AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", nonDeliveryOnlyIds)}
           AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2
         GROUP BY day`,
          range.trendStartIso,
          range.elapsedEndIso
        )
      ),
      prisma.read((reader) =>
        reader.$queryRawUnsafe<{ latency_ms: number }[]>(
          // FEA-1899: a PR artifact can link to multiple sessions (created +
          // referenced), so DISTINCT ON (a.id) collapses to ONE latency row per PR —
          // matching the old single-session-per-PR-row behavior. We prefer the
          // session that CREATED the PR (relation='created'), then the earliest, so
          // sessions that merely referenced a PR URL don't skew the percentile.
          // SQLite has no DISTINCT ON: a windowed ROW_NUMBER over the same
          // (PARTITION BY a.id ORDER BY <created-first, earliest-start>) tiebreak
          // keeps exactly one row per PR artifact (rn = 1), matching Postgres.
          `SELECT latency_ms FROM (
           SELECT latency_ms,
             ROW_NUMBER() OVER (
               PARTITION BY artifact_id
               ORDER BY created_rank, started_at ASC
             ) AS rn
           FROM (
             SELECT a.id AS artifact_id,
               (unixepoch(COALESCE(a.observed_at, a.created_at), 'subsec')
                 - unixepoch(s.started_at, 'subsec')) * 1000 AS latency_ms,
               CASE WHEN sal.relation = 'created' THEN 0 ELSE 1 END AS created_rank,
               s.started_at AS started_at
             FROM artifacts a
             JOIN session_artifact_links sal ON sal.artifact_id = a.id
             JOIN sessions s ON s.id = sal.session_id
             WHERE a.kind = 'pull_request'
               -- FEA-3585: a reviewed-only PR is not a delivered PR — its
               -- artifact→session-start delta is not a real time-to-merge and
               -- must not enter the latency percentile.
               AND ${excludeNonDeliveryOnlyArtifacts("a.id", nonDeliveryOnlyIds)}
               AND s.started_at IS NOT NULL
               AND COALESCE(a.observed_at, a.created_at) BETWEEN $1 AND $2
               -- ISS-5427: compare the two stored columns as INSTANTS, not bytes.
               -- Both sides are TEXT, so a bare >= was a byte comparison, and that
               -- is only chronologically correct while both spellings match — and
               -- they no longer do. artifacts.observed_at is now written canonical
               -- UTC 'Z' at the point of derivation (write-core-pull-requests.ts),
               -- while sessions.started_at is still stored VERBATIM from the
               -- harness by write-core.ts's new-row INSERT. The boot heal
               -- re-spells that column, but only for the rows present when it
               -- ran, so a session imported since is still carrying whatever the
               -- harness handed over. sessions.ended_at is not healed at all.
               -- An EAST-of-UTC offset form carries LARGER wall-clock digits than
               -- the same instant in UTC (15:00:00+05:00 is 10:00:00Z), so a
               -- canonical observed_at that is genuinely LATER sorted byte-wise
               -- BEFORE the session start: the row was dropped from the ttm
               -- percentile outright, and — because this predicate runs BEFORE the
               -- FEA-1899 ROW_NUMBER window below — its loss could also hand
               -- rn = 1 to a merely-referencing session instead of the creating
               -- one. unixepoch(..., 'subsec') is exactly the expression latency_ms
               -- already applies to both operands, so the gate now states
               -- precisely latency_ms >= 0 (the same rule the JS-side filter uses)
               -- and is immune to either column's spelling. A fixed-width
               -- canonical GLOB guard would not work here: sessions.started_at has
               -- no canonical-form guarantee to guard on.
               AND unixepoch(COALESCE(a.observed_at, a.created_at), 'subsec')
                   >= unixepoch(s.started_at, 'subsec')
           ) ranked
         ) one_per_pr
         WHERE rn = 1`,
          range.startIso,
          range.endIso
        )
      ),
      // FEA-2346 / ISS-4994: total ESTIMATED COST over the window (subscription-
      // inclusive — not "spend"; see COST_KPI_SUB), from token_usage ⋈ sessions.
      //
      // ISS-10541: the same TABLE as the Agents model charts, and no longer the
      // same WINDOW. This KPI is one of the three reads ISS-10604's ruling aligns,
      // so it bounds on `range.dateWindowField` (last activity); the Agents
      // section is named among the reads the ruling leaves alone and bounds on
      // session start (`local-insights-agents.ts`). A session that started before
      // the window and was last active inside it therefore prices INTO this total
      // and OUT of `modelBreakdown`, so the model parts do not conserve to this
      // number for such a straddler. That is the ruling's own consequence and it
      // is identical on web and desktop — it is NOT the "cannot drift" guarantee
      // this comment used to claim (#7678 review, tamsinb).
      prisma.read((reader) => {
        const cost = currentWindowCostSql(
          range.dateWindowField,
          range.sessionsWindow
        );
        return reader.$queryRawUnsafe<{ cost: number }[]>(
          cost.sql,
          ...cost.params
        );
      }),
      // FEA-2346: prior-window cost, so the Cost / KLOC / PR-size KPIs show a
      // real period-over-period delta instead of "unknown".
      prisma.read((reader) =>
        reader.$queryRawUnsafe<{ cost: number }[]>(
          // ISS-10604: the prior window reads the SAME column as the current one
          // above. A delta whose two operands are counted on different bases is
          // not a period-over-period comparison at all.
          priorWindowCostSql(range.dateWindowField),
          range.priorStartIso,
          range.priorEndIso
        )
      ),
      // FEA-2210: earliest relevant record across the tables that feed the delta
      // KPIs. Since ISS-12902 `cost` is the only delta left here reading it, and
      // the artifacts branch stays because the cloud gates ITS cost delta on the
      // same two tables: `earliestRecord` in
      // `apps/api/app/insights/service/period.ts` is one
      // `minDate(sessionStartedAt, mergedAt)` feeding every cloud delta,
      // Delivery's cost among them. Drop the branch and the two producers
      // disagree about when a cost comparison appears for identical history.
      // Powers the uniform "full prior period" rule — a period-over-period
      // delta is only shown when local history reaches back to (or before) the
      // prior window's start; otherwise it is hidden rather than reported as a
      // misleading +100% off an empty prior window.
      prisma.read((reader) =>
        reader.$queryRawUnsafe<{ earliest: string | null }[]>(
          // FEA-3585: exclude reviewed-only PRs — they are not captured delivery, so
          // they must not move the earliest-record boundary that gates the same
          // delivery delta KPIs (which now also exclude them above).
          `SELECT MIN(ts) AS earliest FROM (
           SELECT MIN(COALESCE(observed_at, created_at)) AS ts
             FROM artifacts WHERE kind = 'pull_request'
               AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", nonDeliveryOnlyIds)}
           UNION ALL
           SELECT MIN(started_at) AS ts
             FROM session_analytics WHERE started_at IS NOT NULL
         )`
        )
      ),
    ]);

  const captured = num(current[0]?.n);
  const latencies = latencyRows
    .map((row) => num(row.latency_ms))
    .filter((value) => value >= 0);
  const trendByDay = new Map(
    trend.map((row) => [
      row.day,
      { total: num(row.n), agent: num(row.agent_n) },
    ])
  );
  const totalCost = num(costRow[0]?.cost);
  const priorCost = num(priorCostRow[0]?.cost);
  // FEA-2210: uniform calendar rule — only surface a period-over-period delta
  // when the local DB holds a FULL prior period to compare against (earliest
  // relevant record on or before the prior window's start). For the "all" range
  // priorStartIso is the epoch, so this is naturally false (no comparison), and
  // a brand-new install with no history is likewise not comparable. When not
  // comparable the delta is null, which the dashboard renders as a hidden chip
  // rather than a misleading +100%.
  const earliestRecordIso = earliestRow[0]?.earliest ?? null;
  const hasFullPriorPeriod =
    earliestRecordIso !== null && earliestRecordIso <= range.priorStartIso;
  const reportDelta = (current: number, prior: number): number | null =>
    hasFullPriorPeriod ? pctDelta(current, prior) : null;

  // No captured PR has a known size, so there is no figure to compare and both
  // size deltas stay null.
  const { kloc, loc, prsWithoutLoc, prsScanned, prSize } = capturedLocKpis(
    unsizedCapturedPrLocTotals(captured),
    { klocDeltaPct: null, prSizeDeltaPct: null }
  );

  return {
    kpis: [
      // ISS-12902 (operator ruling): the captured-PR count is not a merged-PR
      // figure and PR state is not stored locally (ISS-12709), so it is unknown.
      kpi(
        "merged",
        "Captured PRs",
        null,
        KpiFormat.Number,
        "PRs found in local sessions"
      ),
      // Internal and response-only. PR state is no longer stored locally
      // (ISS-12709), so the store cannot tell how many merged.
      kpi(
        "mergedCount",
        "Merged PRs",
        null,
        KpiFormat.Number,
        "PRs merged in range",
        true
      ),
      kpi(
        "ttm",
        "Median time to PR",
        median(latencies) ?? 0,
        KpiFormat.Duration,
        "session start → PR"
      ),
      kloc,
      loc,
      prsWithoutLoc,
      prsScanned,
      kpi(
        "mergedKloc",
        "KLOC merged",
        null,
        KpiFormat.Number,
        "thousand lines landed",
        true
      ),
      kpi(
        "mergedLoc",
        MERGED_LOC_LABEL,
        null,
        KpiFormat.Number,
        "lines landed",
        true
      ),
      comparableKpi(
        "cost",
        "Cost",
        totalCost,
        KpiFormat.Currency,
        COST_KPI_SUB,
        reportDelta(totalCost, priorCost)
      ),
      kpi(
        "merge-rate",
        "Merge rate",
        null,
        KpiFormat.Percent,
        "of decided PRs (merged or closed)"
      ),
      prSize,
    ],
    // FEA-3455: mark the tiles the local DB can't source from real GitHub
    // distributions Unavailable — mirroring cloud's personal-scope
    // `buildDeliveryTileAvailability`, since desktop is always personal scope.
    // The local store carries no CI-checks signal, so `checkStatus` is
    // Unavailable (and omitted below) rather than fabricated as a single
    // "Captured locally" bar.
    tileAvailability: buildDeliveryTileAvailability({
      hasDecidedPrCohort: false,
      hasTtmEvidence: latencies.length > 0,
    }),
    charts: {
      prTrend: prSplitSeries(trendByDay, range),
      prByRepo: [],
      meanTimeToMerge: ttmHistogram(latencies),
      prByState: [],
      branchLifespan: lifespanHistogram(latencies),
      // FEA-3455: `checkStatus` intentionally omitted (no local CI signal) —
      // its tile is marked Unavailable above, matching cloud's personal scope.
      // Local Insights has no account-scoped repository-default authority.
      // Omit the distribution rather than publish a static-name approximation.
      branchesWithoutPr: [],
    },
  };
}
