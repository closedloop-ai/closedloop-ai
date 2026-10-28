import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  KpiStat,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  InsightsSection,
  KpiFormat,
  kpi,
} from "@closedloop-ai/loops-api/insights";
import { labelize } from "@repo/api/src/utils/string";
import {
  sessionDateWindowNotNullSql,
  sessionDateWindowTsExpr,
} from "../agent-sync/session-date-window.js";
import {
  type DayCount,
  localDay,
  localHour,
  numberOrZero as num,
} from "./db-helpers.js";
import { computeAgents } from "./local-insights-agents.js";
import { computeDelivery } from "./local-insights-delivery.js";
import { windowPopulationField } from "./local-insights-population.js";
import { eachDay, type Range, resolveRange } from "./local-insights-range.js";
import { gapFilledSeries } from "./local-insights-series.js";
import { buildUtilizationTileAvailability } from "./local-insights-tiles.js";
import { sessionsWindowSql } from "./local-insights-window-sql.js";
import {
  excludeNonDeliveryOnlyArtifacts,
  resolveNonDeliveryOnlyArtifactIds,
} from "./non-delivery-artifacts.js";
import type { DesktopPrisma } from "./prisma-client.js";

/*
 * ISS-5938: every RAW aggregate in this module is dispatched through
 * `prisma.read` — the round-robin pool of `query_only` reader connections —
 * rather than the writer-bound `prisma.client`, so a dashboard load no longer
 * serializes against the write queue that owns sync durability (and no longer
 * delays the first-launch backfill or a live import). Each read is dispatched
 * SEPARATELY so the pool can genuinely fan the `Promise.all` groups out across
 * connections; see `local-insights-delivery.ts` for why they are deliberately
 * not gathered into one reader `$transaction`.
 *
 * The TYPED delegate reads (`agent.groupBy`, `session.groupBy`) deliberately
 * STAY on `prisma.client` — FEA-2211 (see session-count.ts): the libSQL
 * community adapter zeroes a model-delegate aggregate on the `query_only`
 * reader connections in PACKAGED builds while behaving correctly in the clean
 * test env, so moving one to the pool would pass every test and empty the chart
 * in production. Same split, and same reason, as the sibling
 * `dashboard-queries.ts` module note. Converting them to raw `GROUP BY` on the
 * pool is the eventual fix FEA-2211 itself points at; until then this is
 * residual, not a settled boundary.
 */

// --- Human/Agent TURN attribution (activity heatmap + autonomy trend) ---------
//
// Both charts share this ruling. The activity heatmap is computed below in
// `computeUtilization`; the autonomy trend is in `local-insights-agents.ts`,
// which points back here rather than restating any of it.
//
// PM ruling 2026-07-10 (FEA-2641 Fix 4): the heatmap and autonomy trend chart
// conversational TURNS attributed by their OWN role, not event density gated
// by the per-session `is_human` flag. Session-level splitting painted a
// steered session's entire autonomous stretch as Human — one overnight /build
// run the user typed two prompts into showed as 24/7 Human activity. Per-turn
// attribution gives each series its literal meaning: a Human cell is an hour
// the human actually typed; everything the agent did — including a human
// session's autonomous overnight stretches and spawned-subagent work — paints
// Agent at the hours it actually ran.
//
// Source: sessions.metadata $.messages (role + timestamp per parsed message),
// the same transcript-first source that feeds the is_human rollup.
// role:"human" is already evidence-exact at parse time (FEA-2641: wake-up
// re-injections, stdout echoes, and teammate messages are excluded; FEA-3124
// ruling 2026-07-16: typed slash commands including /exit//quit DO count —
// the mechanical human record; all five harness parsers emit these messages).
// `session_analytics.is_human` remains the ingest-time SESSION classification
// (see upsertSessionAnalyticsRollupBatch in session-analytics-rollup.ts) but no longer
// feeds these two charts.
//
// Headless kickoffs are NOT human: a role:"human" turn in a session launched
// programmatically — cron-scheduled code reviews, fleet/workflow agents,
// scripted `claude -p` / `codex exec` runs — was not typed at a keyboard, so
// it counts as an Agent turn. Two harness-stamped vocabularies identify
// headless launches (census over the local corpus, 2026-07-10):
//   - Claude entrypoint: "sdk-cli" (headless SDK path; 990 sessions) vs
//     "cli" (interactive; 141) — nothing else in the wild.
//   - Codex session_meta.originator (stored as the entrypoint since
//     DATA_REVISION 13): "codex_exec" / "claude-codex-exec" (scripted; 1,092
//     rollouts) vs "codex-tui" / "codex_cli_rs" / "codex_vscode"
//     (interactive; 455) — no interactive value contains "exec".
// ISS-7260: this module hand-writes NO such predicate, and the census above is
// the evidence behind one, not a restatement of it. The rule is
// `isHeadlessSession` (@repo/lib session-trace/headless) — an `sdk-` PREFIX or an
// `exec` TOKEN or `permissionMode = bypassPermissions` — which the ingest-time
// `session_turn_bucket` writer applies once and this module then only GROUPs BY.
// Read the predicate there; the sentence this replaces said `LIKE 'sdk%'`, which
// is a DIFFERENT rule (`sdkfoo` matches it and does not match `sdk-`) and had
// drifted from the code it claimed to describe. The check is positive-evidence
// only: an absent entrypoint, "cli", tui/vscode values, or a legacy harness
// fallback (e.g. plain "codex") stays interactive, so genuine typed prompts
// are never demoted by missing data.
//
// JSON guards mirror the rollup SQL (session-analytics-rollup.ts): the json_each argument
// is NULLed via nested CASE unless metadata is valid JSON whose $.messages is
// an array (json_each over NULL yields no rows), and json_extract is gated
// behind `m.type = 'object'` — CASE, not AND, because CASE evaluation order
// is a language guarantee while AND terms may be reordered — so malformed
// metadata or a primitive array element can never raise "malformed JSON" and
// abort the query. A turn timestamp outside the rendered day axis simply
// doesn't match a column. FEA-3059: this turn source is scanned per bounded
// session-id batch (turnsByRoleForIds + forEachTurnsChunk below), not over the
// whole window at once, so json_each never materializes the full corpus.

// FEA-3132: the per-turn source that fed the heatmap + autonomy trend is no
// longer computed on the read path. Turns are materialized into
// `session_turn_bucket` at ingest (`rebuildSessionTurnBuckets`, turn-buckets.ts):
// one row per (session, message `$.timestamp`, resolved `turn_kind`), where
// turn_kind pre-resolves the old role+headless predicate. Both reads now GROUP
// BY that indexed table, so a dashboard load never json_each-expands `$.messages`
// again. The former json_each helpers (turnsByRoleForIds / forEachTurnsChunk /
// windowSessionIds / HUMAN_TURN_PREDICATE / AGENT_TURN_PREDICATE / TURNS_SCAN_CHUNK)
// are gone.

type LocalInsightsResponse =
  | DeliveryInsightsResponse
  | UtilizationInsightsResponse
  | AgentsInsightsResponse;

/**
 * Local-database Insights backend for the desktop shell. Computes the same
 * shaped section responses the cloud `apps/api` returns, but against the
 * in-process SQLite database (the user's own data). Desktop is always personal
 * scope and returns the same response shape as the web Insights backend.
 *
 * Timezone contract (FEA-2430): timestamps are STORED as UTC ISO strings; every
 * day/hour bucket this module emits for display converts to the user's LOCAL
 * timezone via localDay()/localHour() in SQL and formatLocalDayKey()/eachDay()
 * in JS — the two sides must stay in lockstep (matching keys) or charts silently
 * drop data. Window BOUNDARIES are UTC, never local; only bucket labels are
 * local. This restores the pre-SQLite-migration behavior
 * (Postgres bucketed AT TIME ZONE; FEA-1459's port made buckets UTC). The
 * desktop main process runs on the user's machine, so 'localtime' == the
 * user's OS timezone, DST handled per-date by the OS tz database.
 *
 * Which UTC instants (ISS-10583): `resolveRange` no longer returns a rolling
 * 168h window ending at `now`. It returns a STABLE UTC DAY window — whole days,
 * so the same selection resolves to the same bounds all day and matches what
 * the Sessions surfaces and the cloud `resolvePeriodRange` resolve. That makes
 * `endIso` run AHEAD of the clock, which is why the range also carries
 * `elapsedEndIso`: the day-axis walk and the prior-window bound stop at the
 * instant the window has actually reached, so no column is drawn for a day that
 * has not happened. Totals deliberately keep the nominal `endIso` — see the
 * note on `resolvePeriodRange` in `apps/api/app/insights/service/period.ts`.
 */
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: typeof InsightsSection.Delivery,
  period: InsightsPeriod,
  now?: Date
): Promise<DeliveryInsightsResponse>;
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: typeof InsightsSection.Utilization,
  period: InsightsPeriod,
  now?: Date
): Promise<UtilizationInsightsResponse>;
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: typeof InsightsSection.Agents,
  period: InsightsPeriod,
  now?: Date
): Promise<AgentsInsightsResponse>;
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: InsightsSection,
  period: InsightsPeriod,
  now?: Date
): Promise<LocalInsightsResponse>;
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: InsightsSection,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<LocalInsightsResponse> {
  const range = resolveRange(period, now);
  if (section === InsightsSection.Agents) {
    return computeAgents(prisma, range);
  }
  if (section === InsightsSection.Utilization) {
    return computeUtilization(prisma, range);
  }
  return computeDelivery(prisma, range);
}

async function computeUtilization(
  prisma: DesktopPrisma,
  range: Range
): Promise<UtilizationInsightsResponse> {
  // ISS-10604: the ONE column this section's session window is measured
  // against, resolved upstream and carried on the range.
  const windowTs = sessionDateWindowTsExpr(range.dateWindowField);
  const windowNotNull = sessionDateWindowNotNullSql(range.dateWindowField);
  const sessionsWindow = sessionsWindowSql(
    range.dateWindowField,
    range.sessionsWindow
  );
  // FILTER aggregate over `sessions` — no typed-delegate form, stays raw.
  //
  // The "Events" KPI deliberately does NOT live here: it rides on the
  // `eventsByType` breakdown below, which already scans that cohort (see there).
  // The `sessions` and `events` figures therefore do not share a statement and
  // can straddle a concurrent commit — invisible, because they count different
  // tables and no rendered figure is derived from both (these reads are
  // separately dispatched and never snapshot-consistent; see the
  // `computeDelivery` header). The pairing a reader COULD see disagree — the
  // events KPI against its own breakdown — is the one held in a single read.
  const totals = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      {
        sessions: bigint;
        runtime_ms: number;
      }[]
    >(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(
                (unixepoch(s.ended_at, 'subsec') - unixepoch(s.started_at, 'subsec')) * 1000
              ) FILTER (
                WHERE s.ended_at IS NOT NULL
                  AND s.ended_at > s.started_at
              ), 0) AS runtime_ms
       FROM sessions s
       WHERE ${sessionsWindow.sql}`,
      ...sessionsWindow.params
    )
  );
  // ISS-10604: the day series is bucketed AND windowed on the same column the
  // KPI above counts on. Splitting them would put a session the KPI counts in a
  // bucket outside the chart's own axis, which is a tile disagreeing with the
  // sparkline directly beneath it.
  const perDay = await prisma.read((reader) =>
    reader.$queryRawUnsafe<DayCount[]>(
      `SELECT ${localDay(windowTs)} AS day, COUNT(*) AS n
       FROM sessions s
       WHERE ${windowNotNull} AND ${windowTs} BETWEEN $1 AND $2
       GROUP BY day`,
      range.trendStartIso,
      range.elapsedEndIso
    )
  );
  // FEA-3091: scope the events-per-day series by the EVENT time
  // (e.created_at), not by the parent session's started_at. The bucket key is
  // localDay(e.created_at), and web's fetchEventVolume filters
  // `e.event_created_at BETWEEN trendStart AND end`, so filtering on the
  // session's start window here counted a different population: a session that
  // began before trendStart but kept emitting events inside the window was
  // counted on web yet fully excluded on desktop, depressing the left edge and
  // diverging the totals. The JOIN to sessions is retained (parity with the
  // sibling event queries — only events tied to a captured session count), but
  // the window predicate now matches the bucket field and the web series.
  const eventsPerDay = await prisma.read((reader) =>
    reader.$queryRawUnsafe<DayCount[]>(
      `SELECT ${localDay("e.created_at")} AS day,
              COUNT(*) AS n
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE e.created_at IS NOT NULL
         AND e.created_at BETWEEN $1 AND $2
       GROUP BY day`,
      range.trendStartIso,
      range.elapsedEndIso
    )
  );
  // `total` is the "Events" KPI AND, since ISS-9842, the denominator the
  // "Events by type" ring divides every slice by; `categories` is how many
  // event-type groups exist, so the ring can say how many types its "Other"
  // slice folds. Both are unpartitioned windows over the GROUPED result, which
  // SQLite evaluates after `GROUP BY` and before `ORDER BY`/`LIMIT`, so they
  // cover EVERY event-type group — including one this `LIMIT 12` discards, and
  // including the EMPTY-STRING `event_type` bucket `GROUP BY` keeps as a group
  // of its own (the column is NOT NULL in the shipped DDL, so there is no NULL
  // bucket to reason about). Summing the twelve
  // RETURNED rows would under-report on any store with more than twelve event
  // types, which every real one has.
  const eventsByType = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      { event_type: string; n: bigint; total: bigint; categories: bigint }[]
    >(
      `SELECT e.event_type AS event_type,
              COUNT(*) AS n,
              SUM(COUNT(*)) OVER () AS total,
              COUNT(*) OVER () AS categories
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE s.started_at IS NOT NULL
         AND s.started_at BETWEEN $1 AND $2
       GROUP BY e.event_type
       ORDER BY n DESC
       LIMIT 12`,
      range.startIso,
      range.endIso
    )
  );
  // Typed: sessions.status is a plain column; the date filter is a column range.
  //
  // ISS-10604: windowed on the SAME column as the `sessions` KPI above, which
  // this chart decomposes. Cloud gets that for free — its status buckets fall
  // out of `fetchSessionRollup`'s own GROUP BY — so leaving desktop on the
  // started-at column would have made a donut that does not sum to the number
  // beside it, and made desktop disagree with web about one org.
  const sessionsByStatus = await prisma.client.session.groupBy({
    by: ["status"],
    // DERIVED from the range, exactly like the KPI above whose total this donut
    // decomposes — not spelled out a second time. ISS-10541 narrowed
    // `range.dateWindowField` to one literal, so the started-at arm this used to
    // carry is unreachable and gone; a literal HERE would still be a second
    // declaration of the window column, and tsc cannot catch it drifting from
    // the KPI's (#7678 review, tamsinb).
    // ISS-12263: the Sessions-list window, so an absent bound (Prisma ignores
    // an `undefined` operator) leaves "all" as unbounded as the KPI above.
    where: {
      [range.dateWindowField]: {
        gte: range.sessionsWindow.startDate,
        lte: range.sessionsWindow.endDate,
      },
    },
    _count: { _all: true },
  });
  // ISS-5936: resolve the delivery-population gate once for the section, the
  // same way computeDelivery does — one gated statement here versus its seven,
  // but one shared resolve-then-render definition of what the gate means.
  // ISS-5938: it resolves on the reader pool with the aggregate it gates, not on
  // the writer — it is a whole-corpus `session_artifact_links` aggregate, exactly
  // the read this section moved off `prisma.client`. Its own contract is typed on
  // `DesktopPrismaReader` so both dispatch paths are accepted.
  const nonDeliveryOnlyIds = await prisma.read((reader) =>
    resolveNonDeliveryOnlyArtifactIds(reader)
  );
  // FEA-2951: the "Review backlog" KPI (kpi:backlog) approximates the shared
  // tile's "Open PRs awaiting review". Desktop stores no PR state or review
  // decision (ISS-12709), so every delivery-population PR counts as open, where
  // web/cloud's `fetchReviewQueue` counts only OPEN PRs with
  // `reviewDecision IS NULL`. FEA-3455: this KPI's tile is Unavailable under
  // personal scope (see the tileAvailability map below), so the value is
  // retained for peers that read it but is not rendered.
  const reviewBacklog = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n
       FROM artifacts
       WHERE kind = 'pull_request'
         -- ISS-5764: a PR this corpus only ever NAMED in prose is not in its
         -- review backlog. Same delivery-population gate the capture/merge
         -- KPIs use.
         AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", nonDeliveryOnlyIds)}
         AND COALESCE(observed_at, created_at) IS NOT NULL`
    )
  );
  // Hour×day TURN density, split into Human vs Agent per turn via
  // TURNS_BY_ROLE_SOURCE (PM ruling 2026-07-10, FEA-2641 Fix 4): each parsed
  // message buckets at its own local hour under its own role, so Human cells
  // appear only at hours with genuine typed prompts and a steered session's
  // autonomous stretches paint Agent. The events corpus no longer feeds this
  // chart.
  // FEA-3059: bounded-scan activity heatmap. Sum per-(day, hour) human/agent
  // turn counts across session-id batches — identical rows to the old
  // single-pass query, but json_each never exceeds TURNS_SCAN_CHUNK sessions.
  // FEA-2210: the heatmap follows the capped trend window (min(period, 90d)),
  // NOT the full selected window (for "all", range.startIso is the epoch, which
  // would render ~20k day-columns and break the grid).
  // FEA-3132: read the pre-materialized `session_turn_bucket` (see the autonomy
  // trend above) instead of json_each-expanding `$.messages` every load.
  const heatmapRows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      { day: string; hour: bigint; human: bigint; agent: bigint }[]
    >(
      `SELECT ${localDay("b.ts")} AS day,
              ${localHour("b.ts")} AS hour,
              SUM(CASE WHEN b.turn_kind = 'human' THEN b.turn_count ELSE 0 END) AS human,
              SUM(CASE WHEN b.turn_kind = 'agent' THEN b.turn_count ELSE 0 END) AS agent
       FROM session_turn_bucket b
       JOIN sessions s ON s.id = b.session_id
       WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN $1 AND $2
       GROUP BY day, hour
       HAVING day IS NOT NULL`,
      range.trendStartIso,
      range.elapsedEndIso
    )
  );
  // Match SQLite's `GROUP BY day, hour` output order (sorted by the group key)
  // so the emitted `cells` array is byte-identical to the prior query — the
  // golden depends on it.
  const heatmap = heatmapRows
    .map((r) => ({
      day: r.day,
      hour: num(r.hour),
      human: num(r.human),
      agent: num(r.agent),
    }))
    .sort((a, b) => {
      if (a.day !== b.day) {
        return a.day < b.day ? -1 : 1;
      }
      return a.hour - b.hour;
    });

  const row = totals[0];
  const reviewBacklogCount = num(reviewBacklog[0]?.n);
  const kpis: KpiStat[] = [
    kpi(
      "sessions",
      "Sessions",
      num(row?.sessions),
      KpiFormat.Number,
      "agent sessions run"
    ),
    kpi(
      "runtime",
      "Agent runtime",
      num(row?.runtime_ms),
      KpiFormat.Duration,
      "hours of agent execution"
    ),
    kpi(
      "backlog",
      "Review backlog",
      reviewBacklogCount,
      KpiFormat.Number,
      "open PRs awaiting review"
    ),
    kpi(
      "events",
      "Events",
      // Carried identically on every `eventsByType` row; absent (no rows at all)
      // means no captured events in range, which reads 0.
      num(eventsByType[0]?.total),
      KpiFormat.Number,
      "captured local events"
    ),
  ];

  const activity = new Map(perDay.map((r) => [r.day, num(r.n)]));
  const eventVolume = new Map(eventsPerDay.map((r) => [r.day, num(r.n)]));
  return {
    kpis,
    // FEA-3455: desktop is always personal scope, so mirror cloud's personal-
    // scope `buildUtilizationTileAvailability({ isOrg: false })` — the review
    // backlog KPI, reviewQueue and reviewerLoad are org-only and Unavailable
    // here. The local store has no per-PR review-decision signal, so those
    // review distributions can't be sourced; `reviewQueue` is emitted empty
    // (below) instead of the fabricated {captured, changes:0, approved:0}
    // placeholder. The `backlog` KPI value is retained as the documented
    // open-PR approximation (FEA-2951) — its tile is Unavailable, so it is not
    // rendered, but the value stays for any peer that reads it.
    tileAvailability: buildUtilizationTileAvailability(),
    charts: {
      eventActivity: gapFilledSeries(activity, range, {
        key: "sessions",
        label: "Sessions",
      }),
      eventVolume: gapFilledSeries(eventVolume, range, {
        key: "events",
        label: "Events",
      }),
      activityHeatmap: {
        // Capped trend window (see the heatmap query above) so the column axis
        // never exceeds 90 days — matches the "Last 90 days (max)" caption.
        days: eachDay(range.trendStartIso, range.elapsedEndIso),
        cells: heatmap.map((r) => ({
          day: r.day,
          hour: num(r.hour),
          human: num(r.human),
          agent: num(r.agent),
        })),
      },
      eventsByType: eventsByType.map((row) => ({
        key: row.event_type,
        label: labelize(row.event_type),
        value: num(row.n),
        ...windowPopulationField(row),
      })),
      // Typed session.groupBy → `_count._all`; sort desc in JS for ORDER BY n DESC.
      sessionsByStatus: [...sessionsByStatus]
        .sort((a, b) => b._count._all - a._count._all)
        .map((g) => ({
          key: g.status,
          label: labelize(g.status),
          value: num(g._count._all),
        })),
      // FEA-3455: no local review-decision signal to source the real cloud
      // distribution (`fetchReviewQueueBuckets` groups by reviewDecision), and
      // the tile is Unavailable under personal scope — so emit empty rather than
      // the fabricated {captured, changes:0, approved:0} placeholder.
      reviewQueue: [],
    },
  };
}
