/**
 * Desktop-local Delivery Insights section.
 *
 * Split out of `local-insights.ts` — which was over the file-size ceiling and
 * shrink-only — rather than grown into it, the same seam
 * `local-insights-spend.ts`, `local-insights-loc.ts` and `local-insights-series.ts`
 * already use: this module owns ONE Insights section, its eleven aggregate reads
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
import { ssotMergeRateFromCounts } from "@repo/api/src/insights/delivery-kpis/parity";
import { median } from "@repo/api/src/utils/math";
import { PrState } from "../enrichment/types.js";
import {
  createdArtifactLinksSubquery,
  localDay,
  numberOrZero as num,
} from "./db-helpers.js";
import {
  capturedLocKpis,
  capturedPrLocTotals,
  klocByDay,
  priorPrLocTotals,
  roundKloc,
} from "./local-insights-loc.js";
import type { Range } from "./local-insights-range.js";
import { gapFilledSeries, prSplitSeries } from "./local-insights-series.js";
import {
  buildDeliveryTileAvailability,
  mergedStateBuckets,
} from "./local-insights-tiles.js";
import { currentWindowCostSql } from "./local-insights-window-sql.js";
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
 * The cost this DOES carry: eleven aggregates land on a two-slot pool (the ten
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
  // into the seven statements below that need it, instead of each embedding the
  // same whole-table `session_artifact_links` aggregate (7 executions -> 1).
  // ISS-5938: it resolves on the reader pool like every other read in this
  // section — its contract is typed on `DesktopPrismaReader` precisely so both
  // dispatch paths are accepted. It is deliberately awaited BEFORE the fan-out
  // rather than joined into it: the seven statements need its result to build
  // their own SQL text, so it is a genuine dependency, not a lost parallel slot.
  const nonDeliveryOnlyIds = await prisma.read((reader) =>
    resolveNonDeliveryOnlyArtifactIds(reader)
  );
  const [
    current,
    prior,
    trend,
    repoBuckets,
    latencyRows,
    locRows,
    costRow,
    priorCostRow,
    priorLocRows,
    earliestRow,
  ] = await Promise.all([
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        {
          n: bigint;
          merged: bigint;
          decided: bigint;
          merged_authored: bigint;
          merged_authored_loc: bigint;
          merged_authored_sized: bigint;
        }[]
      >(
        // FEA-2038: captured PRs in window + how many are merged, for a real
        // merge rate (replaces a hardcoded 100). FEA-2486: pr_state is written
        // lowercase (PrState, enrichment/types.ts); the previous uppercase
        // 'MERGED' comparison matched zero rows on real stores. LOWER() guards
        // against any legacy row with different casing.
        //
        // FEA-2942: merge rate is taken over DECIDED PRs (merged + closed), not
        // all captured PRs. A still-open PR has not reached a terminal state, so
        // counting it in the denominator conflates "not merged yet" with "won't
        // merge" and understates the rate (a window full of in-flight PRs read as
        // failures). PLN-1535 M5: `decided` does NOT grow as PRs land any more —
        // `artifacts.pr_state` has no writer left (see `enrichment/types.ts`), so
        // these counts are dark on the local surface, not merely stale.
        // `n` (total captured), `merged`, and `decided` all count every captured
        // PR in the window (no created-link gate) — they back the "Captured PRs"
        // KPI, the capture-count charts, and the merge-rate KPI, which
        // intentionally rate the whole captured population.
        //
        // FEA-2995: `merged_authored` is the AUTHORED-only merged count that
        // backs the shared AI-Impact card's "Cost per merged PR" denominator
        // (`mergedCount` KPI below). Unlike `merged`, it inner-gates on the
        // relation='created' links — the SAME created-vs-referenced gate the
        // prByRepo breakdown (FEA-2862) and the trend `agent_n` use — so
        // reference-only PRs (competitor repos scanned via `gh api`, CI `uses:`
        // refs, test fixtures; relation='referenced'/'workspace') are excluded.
        // This matches cloud's denominator (countMergedPrsInRange counts only
        // authored pullRequestDetail rows), keeping cost-per-merged-PR
        // reconciled across surfaces. The created-links subquery is DISTINCT per
        // artifact, so this LEFT JOIN cannot fan out and leaves `n`/`merged`/
        // `decided` unchanged.
        //
        // FEA-2947: `merged_authored_loc` is the SUM of gross lines (added + removed)
        // over the SAME authored-merged PR population as `merged_authored`, backing the
        // shared AI-Impact card's "Tokens per KLOC" denominator (`mergedKloc` KPI
        // below). It mirrors cloud's merged-lines KLOC (service.ts `totalLines` over
        // merged PRs) so the card divides by the same MERGED-lines population on both
        // surfaces — NOT desktop's visible captured-PR `kloc` tile. An un-enriched PR
        // (NULL line counts) folds in as 0 via COALESCE, matching the captured-KLOC
        // sum and cloud (FEA-2159). The DISTINCT created-links join cannot fan out, so
        // this per-PR LOC sum is not double-counted.
        `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN LOWER(pr_state) = '${PrState.Merged}' THEN 1 ELSE 0 END) AS merged,
                  SUM(CASE WHEN LOWER(pr_state) IN ('${PrState.Merged}', '${PrState.Closed}') THEN 1 ELSE 0 END) AS decided,
                  SUM(CASE WHEN LOWER(pr_state) = '${PrState.Merged}' AND cl.artifact_id IS NOT NULL THEN 1 ELSE 0 END) AS merged_authored,
                  SUM(CASE WHEN LOWER(pr_state) = '${PrState.Merged}' AND cl.artifact_id IS NOT NULL
                           THEN COALESCE(lines_added, 0) + COALESCE(lines_removed, 0) ELSE 0 END) AS merged_authored_loc,
                  SUM(CASE WHEN LOWER(pr_state) = '${PrState.Merged}' AND cl.artifact_id IS NOT NULL
                                AND (lines_added IS NOT NULL OR lines_removed IS NOT NULL)
                           THEN 1 ELSE 0 END) AS merged_authored_sized
         FROM artifacts
         LEFT JOIN ${createdArtifactLinksSubquery()} cl
           ON cl.artifact_id = artifacts.id
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
      reader.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n
         FROM artifacts
         WHERE kind = 'pull_request'
           AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", nonDeliveryOnlyIds)}
           AND COALESCE(observed_at, created_at) >= $1
           AND COALESCE(observed_at, created_at) < $2`,
        range.priorStartIso,
        range.startIso
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
        range.endIso
      )
    ),
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ repo: string; n: bigint }[]>(
        // FEA-2862: "Merged PRs by repository" must count only PRs the user
        // actually merged in-session — not reference-only artifacts (competitor
        // repos scanned read-only via `gh api`, CI `uses:` refs, unit-test
        // fixture repos), which land in `artifacts` as relation='referenced'/
        // 'workspace' and skew this breakdown with repos the user never opened a
        // PR against. Gate on BOTH signals the sibling queries already use:
        // (a) authored in-session — inner-join the DISTINCT relation='created'
        // links (same created-vs-referenced distinction as the trend query above
        // and the latency created_rank below), and (b) genuinely merged —
        // LOWER(pr_state)='merged' (same casing guard as the merge-rate KPI), so
        // the chart data matches its title.
        `SELECT COALESCE(a.repo_full_name, 'Unknown') AS repo,
                COUNT(*) AS n
         FROM artifacts a
         JOIN ${createdArtifactLinksSubquery()} cl
           ON cl.artifact_id = a.id
         WHERE a.kind = 'pull_request'
           AND LOWER(a.pr_state) = '${PrState.Merged}'
           AND COALESCE(a.observed_at, a.created_at) BETWEEN $1 AND $2
         GROUP BY repo
         ORDER BY n DESC`,
        range.startIso,
        range.endIso
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
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        { loc: bigint; enriched: bigint; sized: bigint; day: string }[]
      >(
        // FEA-2038: per-PR LOC (lines added + removed) for captured PRs, with the
        // bucket day — powers the "KLOC captured" + "Median PR size" KPIs and the
        // KLOC-over-time trend. FEA-2159: an un-enriched PR (NULL lines_added AND
        // lines_removed — size not yet fetched) folds into KLOC as 0 via COALESCE,
        // which leaves the KLOC total/trend unchanged (0 adds nothing).
        // FEA-2868: `enriched` flags PRs whose size IS known so the median can be
        // taken over enriched PRs ONLY — folding un-enriched PRs in as 0 was
        // dragging the Delivery median toward 0. A row is LOC-enriched only when
        // BOTH line counts are present, matching `isLocEnrichedRow`
        // (branch-analytics-projection.ts) — hence AND, not OR. A genuinely empty
        // enriched PR still has enriched=1 and counts as a real 0.
        //
        // FEA-2949: the Branches-list median in `projectBranchAnalytics`
        // (branch-analytics-projection.ts) now uses this SAME enriched-only rule
        // (it previously 0-padded un-enriched rows per FEA-2159, which disagreed
        // with this dashboard). The two medians therefore MATCH — both exclude
        // un-enriched PRs so "Median PR size" reads the same across surfaces.
        //
        // ISS-5412: `sized` flags a PR that carries ANY line count — the exact
        // population the COALESCE'd `loc` sum above can see. It is deliberately OR
        // where `enriched` is AND: a half-projected row (one count present) still
        // contributes its known side to the KLOC sum, so it IS evidence the sum
        // read, even though its total size is unknown and it stays out of the
        // median. When NOTHING is sized the sum is vacuously 0 and the KLOC KPI
        // must report unknown rather than a fabricated zero (see `klocCaptured`).
        `SELECT COALESCE(lines_added, 0) + COALESCE(lines_removed, 0) AS loc,
                CASE WHEN lines_added IS NOT NULL AND lines_removed IS NOT NULL
                     THEN 1 ELSE 0 END AS enriched,
                CASE WHEN lines_added IS NOT NULL OR lines_removed IS NOT NULL
                     THEN 1 ELSE 0 END AS sized,
                ${localDay("COALESCE(observed_at, created_at)")} AS day
         FROM artifacts
         WHERE kind = 'pull_request'
           -- FEA-3585: reviewed-only PRs are not delivery — keep them out of the
           -- captured-KLOC / median-PR-size population.
           AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", nonDeliveryOnlyIds)}
           AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2`,
        range.startIso,
        range.endIso
      )
    ),
    // FEA-2346 / ISS-4994: total ESTIMATED COST over the window (subscription-
    // inclusive — not "spend"; see COST_KPI_SUB), from token_usage ⋈ sessions,
    // the same source the Agents model charts read so the two cannot drift.
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ cost: number }[]>(
        currentWindowCostSql,
        range.startIso,
        range.endIso
      )
    ),
    // FEA-2346: prior-window cost, so the Cost / KLOC / PR-size KPIs show a
    // real period-over-period delta instead of "unknown".
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ cost: number }[]>(
        `SELECT COALESCE(SUM(t.cost_usd_estimated), 0) AS cost
           FROM token_usage t
           JOIN sessions s ON s.id = t.session_id
           WHERE s.started_at IS NOT NULL
             AND s.started_at >= $1 AND s.started_at < $2`,
        range.priorStartIso,
        range.startIso
      )
    ),
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ loc: bigint; enriched: bigint }[]>(
        // FEA-2159: prior-window per-PR LOC for the PR-size / KLOC period deltas.
        // FEA-2868: carries the same `enriched` flag as the current window (BOTH
        // line counts present — AND, matching isLocEnrichedRow) so the prior median
        // is likewise taken over enriched PRs only — the median delta then compares
        // like with like (both windows exclude unknown-size PRs).
        `SELECT COALESCE(lines_added, 0) + COALESCE(lines_removed, 0) AS loc,
                CASE WHEN lines_added IS NOT NULL AND lines_removed IS NOT NULL
                     THEN 1 ELSE 0 END AS enriched
           FROM artifacts
           WHERE kind = 'pull_request'
             AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", nonDeliveryOnlyIds)}
             AND COALESCE(observed_at, created_at) >= $1
             AND COALESCE(observed_at, created_at) < $2`,
        range.priorStartIso,
        range.startIso
      )
    ),
    // FEA-2210: earliest relevant record across the tables that feed the delta
    // KPIs (captured PRs + per-session cost). Powers the uniform "full prior
    // period" rule — a period-over-period delta is only shown when local
    // history reaches back to (or before) the prior window's start; otherwise
    // it is hidden rather than reported as a misleading +100% off an empty
    // prior window.
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
  const priorCaptured = num(prior[0]?.n);
  // Raw captured merged count (every relation, no created-link gate). Feeds the
  // merge-rate denominator pairing below ONLY — NOT the "mergedCount" KPI, which
  // now emits `authoredMergedCount` (see FEA-2995 note). Named `rawMergedCount`
  // so it isn't mistaken for the KPI of the same key.
  const rawMergedCount = num(current[0]?.merged);
  // FEA-2995: authored-only merged count for the AI-Impact card's
  // "Cost per merged PR" denominator (`mergedCount` KPI). Gated on the
  // created-artifact links so reference-only merged PRs don't inflate the
  // denominator and diverge from cloud. The merge-rate below intentionally
  // stays over the whole captured population (`rawMergedCount`/`decidedCount`).
  const authoredMergedCount = num(current[0]?.merged_authored);
  // FEA-2947: MERGED-lines KLOC over the authored-merged PR population, backing the
  // AI-Impact card's "Tokens per KLOC" denominator (`mergedKloc` KPI). Rounded
  // through the canonical `roundKloc` (local-insights-loc.ts) like the captured
  // `kloc` KPI, so it matches cloud's `round(totalLines/1000, 1)`.
  //
  // ISS-5412: and `null` on the same no-evidence rule as `kloc`. This key is
  // documented as carrying semantics IDENTICAL to cloud's `kloc`, which already
  // returns null there, so leaving a vacuous 0 here would reinstate the exact
  // unavailable-as-real-zero conflation on the surface-agnostic twin of the key
  // being fixed — and hand the AI-Impact card a 0 denominator that reads as a
  // measured "no lines landed" rather than "we cannot size them".
  const klocMerged =
    num(current[0]?.merged_authored_sized) > 0
      ? roundKloc(num(current[0]?.merged_authored_loc) / 1000)
      : null;
  // FEA-2942: denominator = DECIDED PRs (merged + closed), excluding still-open
  // ones.
  const decidedCount = num(current[0]?.decided);
  // FEA-3217: route the merge rate through the shared delivery-KPI SSOT
  // (parity.ts) — the SAME engine cloud's getDelivery uses (FEA-3151) — so both
  // surfaces honor its null-on-empty-cohort contract: 0 decided PRs ⇒ `null`
  // (the shared kpi() card renders "—", "no terminal outcomes yet"), NOT a
  // fabricated `0` that renders "0%" and falsely implies total merge failure.
  // This mirrors `medianPrSize`'s null-on-empty guard below. `ssotMergeRate-
  // FromCounts(merged, closed)` takes the closed-ONLY count, so pass
  // `decidedCount - rawMergedCount`; the SSOT re-derives merged / (merged +
  // closed) scaled ×100 rounded to 0 dp — identical to the prior expression on
  // a non-empty cohort.
  const mergeRate = ssotMergeRateFromCounts(
    rawMergedCount,
    decidedCount - rawMergedCount
  );
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

  // FEA-2038 / FEA-2868 / FEA-2923 / ISS-5412: PR-size, KLOC and LOC-coverage
  // figures over the captured-PR LOC projection. The population rules (sum over
  // ALL captured PRs, median over ENRICHED ones only, `null` KLOC when nothing
  // is sized) live with the derivation in `local-insights-loc.ts`, mirroring the
  // cloud read service's `merged-pr-loc.ts` split.
  const locTotals = capturedPrLocTotals(locRows);
  const { totalLoc, klocCaptured, medianPrSize } = locTotals;
  const priorCost = num(priorCostRow[0]?.cost);
  const { totalLoc: priorTotalLoc, medianPrSize: priorMedianPrSize } =
    priorPrLocTotals(priorLocRows);
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
  // FEA-2868 (thread 1): the PR-size delta additionally requires a non-empty
  // prior ENRICHED population. When the prior window medians to null (no
  // enriched PRs), there is no real baseline — suppress the delta even if
  // hasFullPriorPeriod is true, rather than reporting a spurious +100% off a
  // fabricated 0 prior median.
  const reportPrSizeDelta = (current: number | null): number | null =>
    current === null || priorMedianPrSize === null
      ? null
      : reportDelta(current, priorMedianPrSize);
  // ISS-5412: same rule for the KLOC delta. It compares RAW LINES (see the
  // `kloc` KPI), and `totalLoc` is a vacuous 0 when no captured PR is sized —
  // comparing that 0 against a real prior would report "-100%" under a `—`
  // value. An unknown current has nothing to compare, so suppress the delta.
  const reportKlocDelta = (): number | null =>
    klocCaptured === null ? null : reportDelta(totalLoc, priorTotalLoc);
  // ISS-5414: the four LOC-derived Delivery KPIs (the two visible tiles plus the
  // internal coverage pair their captions quote) are built beside the derivation
  // in `local-insights-loc.ts`; they are spliced into the list below unchanged.
  const { kloc, prsWithoutLoc, prsScanned, prSize } = capturedLocKpis(
    locTotals,
    {
      klocDeltaPct: reportKlocDelta(),
      prSizeDeltaPct: reportPrSizeDelta(medianPrSize),
    }
  );
  // FEA-2944: per-day KLOC buckets for the trend, rounded the same way as the
  // headline KPI (see `klocByDay` in local-insights-loc.ts).
  const klocTrendByDay = klocByDay(locRows);

  return {
    kpis: [
      comparableKpi(
        "merged",
        "Captured PRs",
        captured,
        KpiFormat.Number,
        "PRs found in local sessions",
        reportDelta(captured, priorCaptured)
      ),
      // FEA-2946: surface-agnostic MERGED-PR count the shared AI-Impact card reads
      // as its "Cost per merged PR" denominator. Desktop's visible `merged` tile
      // above deliberately carries CAPTURED PRs (all states), so the card cannot
      // divide by it and stay consistent with cloud, whose `merged` KPI IS the
      // merged count. Both surfaces now expose this dedicated key with identical
      // (merged) semantics. Flagged `internal` (mirrors the delivery-kpis
      // registry's MergedCount entry): response-only, backs no tile, so it
      // renders nothing on its own.
      //
      // FEA-2995: use the AUTHORED-only merged count (`authoredMergedCount`,
      // gated on created-artifact links) rather than the raw captured `merged`,
      // so this denominator counts only genuinely-authored merged PRs — the
      // same population cloud's countMergedPrsInRange counts. Counting every
      // merged `pull_request` artifact (including reference-only PRs) inflated
      // the denominator and understated cost-per-merged-PR versus cloud.
      kpi(
        "mergedCount",
        "Merged PRs",
        authoredMergedCount,
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
      /*
       * FEA-3959 follow-up (wongk): the period-over-period delta is computed in
       * RAW LINES, not rounded KLOC. The ratio is identical either way, but the
       * near-zero-base floor (`NEAR_ZERO_DELTA_BASE`, meant to suppress
       * fractional-COUNT noise) would otherwise trip on a legitimately small
       * KLOC baseline — e.g. a real 900-line (0.9 KLOC) prior would fall under
       * the 0.99 floor and suppress a true +100%. In lines, 900 > 0.99, so the
       * floor only fires for a genuinely near-zero (<1 line) prior. See
       * `reportKlocDelta` above.
       */
      kloc,
      prsWithoutLoc,
      prsScanned,
      // FEA-2947: surface-agnostic MERGED-lines KLOC the shared AI-Impact card reads
      // as its "Tokens per KLOC" denominator. Desktop's visible `kloc` tile above
      // deliberately carries CAPTURED-PR KLOC (all states), so the card cannot divide
      // by it and stay consistent with cloud, whose `kloc` KPI IS merged-lines KLOC.
      // Both surfaces now expose this dedicated key with identical (merged-lines)
      // semantics — computed here over the AUTHORED-merged PR population (the same
      // population as `mergedCount`), mirroring the `mergedCount` reconciliation in
      // FEA-2946. Flagged `internal`: response-only, backs no tile, so it renders
      // nothing on its own.
      kpi(
        "mergedKloc",
        "KLOC merged",
        klocMerged,
        KpiFormat.Number,
        "thousand lines landed",
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
        mergeRate,
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
      hasDecidedPrCohort: decidedCount > 0,
      hasTtmEvidence: latencies.length > 0,
    }),
    charts: {
      prTrend: prSplitSeries(trendByDay, range),
      // ISS-5412: OMIT the KLOC trend when the KPI itself is unknown. Every
      // point would be a gap-filled 0, so the chart would draw a flat line at
      // zero directly under a tile saying "we cannot size any captured PR" —
      // one claiming nothing landed, the other claiming it cannot tell, and the
      // chart is the more believable of the two. Omitting it is what the render
      // reads: `getDeliveryTimeSeries` returns undefined and all three
      // `chart:klocTrend` variants fall back to `ChartEmpty` (tile-content.tsx).
      // NOT gated through `tileAvailability` — `resolveInsightsTileAvailability`
      // only consults that map for GITHUB_TRUTH_TILE_IDS (tiles that need a
      // GitHub data connection), which the KLOC trend is not, so an entry there
      // would be inert.
      ...(klocCaptured === null
        ? {}
        : {
            klocTrend: gapFilledSeries(klocTrendByDay, range, {
              key: "kloc",
              label: "KLOC captured",
            }),
          }),
      prByRepo: repoBuckets.map((row) => ({
        key: row.repo,
        label: row.repo,
        value: num(row.n),
      })),
      meanTimeToMerge: ttmHistogram(latencies),
      // FEA-3455: real PR-state distribution. Mirrors cloud's
      // `mergedStateBuckets` (every fetched row is merged → one MERGED bucket
      // sized by the merged count), over the SAME authored-merged population
      // (`authoredMergedCount`) cloud's `mergedCount` uses (FEA-2995) — replaces
      // the fabricated single "Captured locally" bucket.
      prByState: mergedStateBuckets(authoredMergedCount),
      branchLifespan: lifespanHistogram(latencies),
      // FEA-3455: `checkStatus` intentionally omitted (no local CI signal) —
      // its tile is marked Unavailable above, matching cloud's personal scope.
      // Local Insights has no account-scoped repository-default authority.
      // Omit the distribution rather than publish a static-name approximation.
      branchesWithoutPr: [],
    },
  };
}
