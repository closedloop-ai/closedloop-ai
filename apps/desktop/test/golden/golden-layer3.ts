/**
 * FEA-2649 Layer 3 golden runner — shared harness.
 *
 * Layer 2 (golden-layer2.ts) proved the WRITE PATH: the seeded store equals
 * the frozen dossiers. This layer proves the READ PATH: every aggregation
 * query — dashboard-queries.ts, local-insights.ts, branch-reads.ts,
 * read-stores.ts, session-count.ts, session-trace.ts — computes the right
 * numbers from that proven store, tested IN PLACE (no relocation).
 *
 * Seed: the Layer 2 shared-DB recipe — db.importer.importSession(<dossier
 * normalized.json>, harness) for all importable dossiers into ONE
 * openTestDb whose injected clock is REFERENCE_NOW_ISO (max ISO timestamp in
 * the corpus inputs + 1h; a pure function of the corpus). Frozen Layer 2
 * snapshots are NOT loaded as data.
 *
 * Two-source assertion model per fact:
 *   1. FIDELITY (HARD): query output == an independent JS recomputation from
 *      the raw store tables (golden-layer3-derive.ts). Window edges, local-TZ
 *      bucketing, grouping, dedup gates, medians, top-N folding are all
 *      re-derived — a red is an aggregation bug (or a registered L2 storage
 *      divergence surfacing at this layer).
 *   2. ORACLE (signed): headline rollups == packages/golden-sessions/
 *      corpus-expectations.yaml (PROPOSED until signed per
 *      packages/golden-sessions/AGENTS.md). reference_now in that file must
 *      equal the recomputed corpus clock — any corpus intake forces a
 *      re-derivation + re-signing.
 *
 * Divergence resolution order for a red: golden-divergences.ts (L1,
 * inherited parser bugs — decomposed per dossier), golden-layer2-divergences
 * (L2, storage), golden-layer3-divergences.ts (L3, aggregation; `agg.*`
 * keys, corpus- or session-scoped). Uncovered reds fail with a
 * PROPOSED-entry instruction block. Registered entries that STOP reproducing
 * fail loudly (promote the key).
 *
 * Honors packages/golden-sessions/AGENTS.md: strictly READ-ONLY over the
 * corpus; the yaml is read, never written, by tests.
 *
 * Hermeticity: one temp-dir SQLite per process seeded once; the paired
 * UTC / America/Chicago test files run the SAME suite — TZ-invariant facts
 * must agree byte-for-byte, day/hour-bucketed facts assert against their own
 * tz_dependent.{utc,chicago} section of the yaml.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { median } from "@repo/api/src/utils/math";
import {
  InsightsPeriod,
  InsightsSection,
  lifespanHistogram,
  ttmHistogram,
} from "@closedloop-ai/loops-api/insights";
import { parse as parseYaml } from "yaml";
import {
  type BranchKeyRow,
  readBranchTokenAggregateRows,
  readBranchTokenAggregateRowsForBranch,
  readDistinctBranchKeyRows,
  readLocalBranchLinkRows,
  readLocalBranchLinkRowsForBranch,
  readLocalBranchPrRows,
} from "../../src/main/database/branch-reads.js";
import { eachDay } from "../../src/main/database/local-insights-range.js";
import { countSqliteSessions } from "../../src/main/database/session-count.js";
import { buildTraceTimelineRows } from "../../src/main/database/session-trace.js";
import { openTestDb } from "../agent-db-test-utils.js";
import {
  projectTokenAnalyticsByModelRows,
  sortTokenAnalyticsByModelRowsByModel,
  tokenAnalyticsByModelRow,
} from "../fixtures/analytics-golden.js";
import { findDivergence } from "./golden-divergences.js";
import type { CorpusYaml } from "./golden-layer3-corpus-schema.js";
import {
  activeWriteLinks,
  agentSuccessRateTwin,
  allocateRoundedUsdValues,
  captureLayer3Rows,
  compareStrings,
  countBy,
  createdArtifactIdSet,
  deliveryPrArtifacts,
  deriveAutonomyByDay,
  deriveAvgDepth,
  deriveAvgDurationSec,
  deriveBranchTokenAggregates,
  deriveCooccurrence,
  deriveDashboardPrArtifactIds,
  deriveHeatmapCells,
  deriveLocRows,
  deriveMergeRateTwin,
  derivePacks,
  deriveSessionDetail,
  deriveSessionPageSet,
  deriveSkills,
  deriveSpendByModel,
  deriveTtmLatencies,
  deriveUsageTotalsInWindow,
  deriveWindowCost,
  hasFullPriorPeriodTwin,
  inWindow,
  isFailedAgentStatus,
  isSubagentRow,
  isSuccessAgentStatus,
  type L3Rows,
  loadCorpus,
  localDayOf,
  num,
  prArtifactsInWindow,
  type RangeTwin,
  rangeTwin,
  roundUsd,
  seedCorpus,
  tokenEventsInWindow,
  windowSessionIdSet,
  windowSessions,
} from "./golden-layer3-derive.js";
import { deriveKloc, deriveMedianPrSize } from "./golden-layer3-derive-loc.js";
import {
  LAYER3_KNOWN_DIVERGENCES,
  scopeSessionId,
} from "./golden-layer3-divergences.js";
import {
  asCountMap,
  assertNoFailures,
  assertNonIncreasing,
  checkFact,
  firedL3,
  l3Key,
  nullableNum,
} from "./golden-layer3-facts.js";
import { assertSignedCorpusGuards } from "./golden-layer3-signed-guards.js";

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

const CORPUS_YAML_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/golden-sessions/corpus-expectations.yaml"
);
const PERIODS = [
  InsightsPeriod.Week,
  InsightsPeriod.Month,
  InsightsPeriod.Quarter,
  InsightsPeriod.All,
] as const;
const WORKFLOW_TOOL_INVOCATION_EVENT_TYPE = "PreToolUse";
const IS_CHICAGO = process.env.TZ === "America/Chicago";

// ── Shared fixture (seeded once per process) ─────────────────────────────────

type Fixture = {
  db: TestDb;
  rows: L3Rows;
  refIso: string;
  refDate: Date;
  yaml: CorpusYaml;
  dir: string;
};

let fixture: Fixture | null = null;

async function setupFixture(): Promise<Fixture> {
  const corpus = loadCorpus();
  const dir = mkdtempSync(join(tmpdir(), "golden-l3-"));
  const db = await openTestDb(dir, { now: () => corpus.referenceNowIso });
  await seedCorpus(db, corpus);
  const rows = await captureLayer3Rows(db);
  const yaml = parseYaml(readFileSync(CORPUS_YAML_PATH, "utf8")) as CorpusYaml;
  return {
    db,
    rows,
    refIso: corpus.referenceNowIso,
    refDate: new Date(corpus.referenceNowIso),
    yaml,
    dir,
  };
}

function fx(): Fixture {
  if (!fixture) {
    throw new Error("layer 3 fixture not initialized — before() did not run");
  }
  return fixture;
}

// ── Insights section helpers (one per chart/kpi cluster so no test closure
//    exceeds the cognitive-complexity budget) ─────────────────────────────────

type InsightsOut = Awaited<
  ReturnType<Fixture["db"]["dashboard"]["getInsights"]>
>;

type InsightCtx = {
  failures: string[];
  rows: L3Rows;
  range: RangeTwin;
  win: CorpusYaml["windows"][string];
  period: (typeof PERIODS)[number];
  out: InsightsOut;
};

function kpiOf(out: InsightsOut, key: string) {
  return out.kpis.find((k) => k.key === key);
}

function checkDeliveryKpis(ctx: InsightCtx): void {
  const { failures, rows, range, win, period, out } = ctx;
  const kpi = (key: string) => kpiOf(out, key);
  const captured = prArtifactsInWindow(
    rows,
    range.startIso,
    range.endIso
  ).length;
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.merged`,
    kpi("merged")?.value,
    captured
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.merged_vs_signed`,
    kpi("merged")?.value,
    win.pr_captured
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.mergedCount`,
    kpi("mergedCount")?.value,
    0
  );
  const latencies = deriveTtmLatencies(rows, range.startIso, range.endIso);
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.ttm`,
    kpi("ttm")?.value,
    median(latencies) ?? 0
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.ttm_vs_signed`,
    kpi("ttm")?.value,
    win.ttm_median_ms ?? 0
  );
  const locRows = deriveLocRows(rows, range.startIso, range.endIso);
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.kloc`,
    kpi("kloc")?.value,
    deriveKloc(locRows)
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.pr_size`,
    kpi("pr-size")?.value,
    deriveMedianPrSize(locRows)
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.pr_size_vs_signed`,
    kpi("pr-size")?.value,
    win.median_pr_size
  );
  const cost = deriveWindowCost(rows, range.startIso, range.endIso);
  const costActual = kpi("cost")?.value;
  const costMatches =
    typeof costActual === "number"
      ? Math.abs(costActual - cost) < 1e-6
      : costActual;
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.cost`,
    costMatches,
    true,
    `query=${String(costActual)} derived=${cost}`
  );
  const costRounded =
    typeof costActual === "number" ? roundUsd(costActual) : costActual;
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.cost_vs_signed`,
    costRounded,
    roundUsd(win.cost_usd_store)
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.merge_rate`,
    kpi("merge-rate")?.value,
    // FEA-3217: null on an empty decided cohort (—), NOT a fabricated 0% —
    // via the same shared SSOT the query now routes through.
    deriveMergeRateTwin(rows, range.startIso, range.endIso)
  );
}

function checkDeliveryDeltaSuppression(ctx: InsightCtx): void {
  const { failures, rows, range, win, period, out } = ctx;
  const kpi = (key: string) => kpiOf(out, key);
  // Delta suppression (FEA-2210): deltas only with a full prior period.
  const hasPrior =
    period !== InsightsPeriod.All &&
    hasFullPriorPeriodTwin(rows, range.priorStartIso);
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.kpis.has_full_prior_vs_signed`,
    hasPrior,
    win.has_full_prior_period
  );
  if (!hasPrior) {
    checkFact(
      failures,
      "corpus",
      `agg.insights.delivery.${period}.kpis.deltas_suppressed`,
      [
        kpi("merged")?.deltaPct ?? null,
        kpi("kloc")?.deltaPct ?? null,
        kpi("cost")?.deltaPct ?? null,
      ],
      [null, null, null],
      "no full prior period → all period-over-period deltas must be null"
    );
  }
}

function derivePrTrendPoints(
  rows: L3Rows,
  range: RangeTwin
): { date: string; values: Record<string, number> }[] {
  const days = eachDay(range.trendStartIso, range.endIso);
  const createdIds = createdArtifactIdSet(rows);
  const trendByDay = new Map<string, { total: number; agent: number }>();
  for (const a of prArtifactsInWindow(
    rows,
    range.trendStartIso,
    range.endIso
  )) {
    const ts = a.observed_at ?? a.created_at;
    if (ts === null) {
      continue;
    }
    const day = localDayOf(ts);
    const t = trendByDay.get(day) ?? { total: 0, agent: 0 };
    t.total += 1;
    if (createdIds.has(a.id)) {
      t.agent += 1;
    }
    trendByDay.set(day, t);
  }
  return days.map((date) => {
    const t = trendByDay.get(date);
    const total = t?.total ?? 0;
    const agent = t?.agent ?? 0;
    return { date, values: { agent, manual: total - agent, merged: total } };
  });
}

function checkDeliveryCharts(ctx: InsightCtx): void {
  const { failures, rows, range, period, out } = ctx;
  if (!("prTrend" in out.charts)) {
    failures.push(
      `agg.insights.delivery.${period}.charts: not a delivery response`
    );
    return;
  }
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.charts.pr_trend`,
    out.charts.prTrend.points,
    derivePrTrendPoints(rows, range)
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.charts.pr_trend_series_decl`,
    out.charts.prTrend.series.map((s) => s.key),
    ["agent", "manual"],
    "the merged total key must stay UNDECLARED (FEA-2486)"
  );
  // Histograms over the independently derived latencies (binning helper is
  // shared presentation code from @closedloop-ai/loops-api).
  const latencies = deriveTtmLatencies(rows, range.startIso, range.endIso);
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.charts.ttm_histogram`,
    out.charts.meanTimeToMerge,
    ttmHistogram(latencies)
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.charts.lifespan_histogram`,
    out.charts.branchLifespan,
    lifespanHistogram(latencies)
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.delivery.${period}.charts.pr_by_repo`,
    out.charts.prByRepo,
    [],
    "no merged pr_state in the import-only store (yaml BASIS note)"
  );
}

function checkUtilizationKpis(ctx: InsightCtx): void {
  const { failures, rows, range, win, period, out } = ctx;
  const kpi = (key: string) => kpiOf(out, key);
  const inWin = windowSessions(rows, range.startIso, range.endIso);
  const winIds = new Set(inWin.map((s) => s.id));
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.kpis.sessions`,
    kpi("sessions")?.value,
    inWin.length
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.kpis.sessions_vs_signed`,
    kpi("sessions")?.value,
    win.sessions
  );
  let runtimeMs = 0;
  for (const s of inWin) {
    if (
      s.started_at !== null &&
      s.ended_at !== null &&
      s.ended_at > s.started_at
    ) {
      runtimeMs +=
        (Date.parse(s.ended_at) / 1000 - Date.parse(s.started_at) / 1000) *
        1000;
    }
  }
  const runtimeActual = kpi("runtime")?.value;
  const runtimeMatches =
    typeof runtimeActual === "number"
      ? Math.abs(runtimeActual - runtimeMs) < 1
      : runtimeActual;
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.kpis.runtime`,
    runtimeMatches,
    true,
    `query=${String(runtimeActual)} derived=${runtimeMs}`
  );
  const events = rows.events.filter((e) => winIds.has(e.session_id)).length;
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.kpis.events`,
    kpi("events")?.value,
    events
  );
  // Review backlog (all-time, NULL pr_state = open); ISS-5764 gate applied.
  const backlog = deliveryPrArtifacts(rows).filter(
    (a) =>
      (a.observed_at ?? a.created_at) !== null &&
      (a.pr_state === null || a.pr_state.toLowerCase() === "open")
  ).length;
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.kpis.backlog`,
    kpi("backlog")?.value,
    backlog
  );
}

function checkUtilizationCharts(ctx: InsightCtx): void {
  const { failures, rows, range, period, out } = ctx;
  if (!("eventActivity" in out.charts)) {
    failures.push(
      `agg.insights.utilization.${period}.charts: not a utilization response`
    );
    return;
  }
  const inWin = windowSessions(rows, range.startIso, range.endIso);
  const days = eachDay(range.trendStartIso, range.endIso);
  // eventActivity: sessions per day over the trend window (gap-filled).
  const perDay = countBy(
    rows.sessions.filter((s) =>
      inWindow(s.started_at, range.trendStartIso, range.endIso)
    ),
    (s) => (s.started_at === null ? null : localDayOf(s.started_at))
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.charts.event_activity`,
    out.charts.eventActivity.points,
    days.map((date) => ({ date, values: { sessions: perDay.get(date) ?? 0 } }))
  );
  // `eventVolume`, `activityHeatmap`, and `sessionsByStatus` are OPTIONAL on the
  // shared wire contract (older cloud peers omit them), but the desktop-local
  // backend computes all three on every response — so an absent one here is a
  // regression to report by name, not a chart to skip.
  const { activityHeatmap, eventVolume, sessionsByStatus } = out.charts;
  if (!(activityHeatmap && eventVolume && sessionsByStatus)) {
    failures.push(
      `agg.insights.utilization.${period}.charts: local response omitted ` +
        `event_volume=${eventVolume === undefined} ` +
        `activity_heatmap=${activityHeatmap === undefined} ` +
        `sessions_by_status=${sessionsByStatus === undefined}`
    );
    return;
  }
  // eventVolume: events per day scoped by EVENT time (FEA-3091).
  const volume = countBy(
    rows.events.filter((e) =>
      inWindow(e.created_at, range.trendStartIso, range.endIso)
    ),
    (e) => (e.created_at === null ? null : localDayOf(e.created_at))
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.charts.event_volume`,
    eventVolume.points,
    days.map((date) => ({ date, values: { events: volume.get(date) ?? 0 } }))
  );
  // Heatmap: capped trend window; per-turn split from session_turn_bucket.
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.charts.heatmap_cells`,
    activityHeatmap.cells,
    deriveHeatmapCells(rows, range.trendStartIso, range.endIso)
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.charts.heatmap_days_axis`,
    activityHeatmap.days,
    days
  );
  // sessionsByStatus (typed groupBy) as a multiset.
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.charts.sessions_by_status`,
    asCountMap(sessionsByStatus.map((b) => ({ key: b.key, count: b.value }))),
    Object.fromEntries(countBy(inWin, (s) => s.status))
  );
}

function checkEventsByTypeTop12(ctx: InsightCtx): void {
  const { failures, rows, range, period, out } = ctx;
  if (!("eventsByType" in out.charts)) {
    return;
  }
  // Same key, now as a value: `in` proves the response is the utilization
  // shape, but the property is optional on it, so the value still has to be
  // checked before it can be read.
  const { eventsByType } = out.charts;
  if (!eventsByType) {
    // The desktop-local backend always computes this chart, so an omission is a
    // regression to report by name — not a chart to skip. Returning silently
    // would drop the whole top-12 fact set (cardinality, ordering, per-key
    // counts, floor) while leaving the sweep green.
    failures.push(
      `agg.insights.utilization.${period}.charts: local response omitted events_by_type`
    );
    return;
  }
  const winIds = windowSessionIdSet(rows, range.startIso, range.endIso);
  // eventsByType: top 12 — multiset + ordering contract (ties have no
  // declared order).
  const typeCounts = [
    ...countBy(
      rows.events.filter((e) => winIds.has(e.session_id)),
      (e) => e.event_type
    ).entries(),
  ].sort((a, b) => b[1] - a[1]);
  const top12Floor = typeCounts[Math.min(11, typeCounts.length - 1)]?.[1] ?? 0;
  // Cardinality: exactly min(12, distinct types) rows — no vacuous empties.
  checkFact(
    failures,
    "corpus",
    `agg.insights.utilization.${period}.charts.events_by_type_count`,
    eventsByType.length,
    Math.min(12, typeCounts.length)
  );
  assertNonIncreasing(
    failures,
    `agg.insights.utilization.${period}.charts.events_by_type_order`,
    eventsByType.map((b) => b.value)
  );
  for (const b of eventsByType) {
    const expectedCount = typeCounts.find(([k]) => k === b.key)?.[1];
    if (expectedCount !== b.value) {
      failures.push(
        `agg.insights.utilization.${period}.charts.events_by_type: ${b.key} count ${b.value} != derived ${String(expectedCount)}`
      );
    }
    if (b.value < top12Floor) {
      failures.push(
        `agg.insights.utilization.${period}.charts.events_by_type: ${b.key} (${b.value}) below the top-12 floor ${top12Floor}`
      );
    }
  }
}

function checkAgentsKpis(ctx: InsightCtx): void {
  const { failures, rows, range, win, period, out } = ctx;
  const kpi = (key: string) => kpiOf(out, key);
  const totals = deriveUsageTotalsInWindow(rows, range.startIso, range.endIso);
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.tokens`,
    kpi("tokens")?.value,
    totals.tokens
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.tokens_vs_signed`,
    kpi("tokens")?.value,
    win.usage_totals.tokens
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.input`,
    kpi("input-tokens")?.value,
    totals.input
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.output`,
    kpi("output-tokens")?.value,
    totals.output
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.cache`,
    kpi("cache-tokens")?.value,
    totals.cacheRead + totals.cacheWrite
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.models`,
    kpi("models")?.value,
    totals.models
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.models_vs_signed`,
    kpi("models")?.value,
    win.usage_totals.models_in_use
  );
  const winIds = windowSessionIdSet(rows, range.startIso, range.endIso);
  const toolRuns = rows.events.filter(
    (e) => e.tool_name !== null && winIds.has(e.session_id)
  ).length;
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.tool_runs`,
    kpi("tool-runs")?.value,
    toolRuns
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.kpis.tool_runs_vs_signed`,
    kpi("tool-runs")?.value,
    win.tool_events
  );
}

function checkAgentsSpendCharts(ctx: InsightCtx): void {
  const { failures, rows, range, win, period, out } = ctx;
  if (!("modelBreakdown" in out.charts)) {
    failures.push(
      `agg.insights.agents.${period}.charts: not an agents response`
    );
    return;
  }
  const byModelAsc = (a: { key: string }, b: { key: string }) =>
    a.key < b.key ? -1 : 1;
  // modelBreakdown: USD spend per model, cost-desc, cents-rounded.
  const spend = deriveSpendByModel(rows, range.startIso, range.endIso);
  const cost = deriveWindowCost(rows, range.startIso, range.endIso);
  const expectedBreakdownValues = allocateRoundedUsdValues(
    Object.fromEntries(spend),
    cost
  );
  const expectedBreakdown = [...spend.keys()].map((model) => ({
    key: model,
    label: model,
    value: expectedBreakdownValues[model] ?? 0,
  }));
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.charts.model_breakdown`,
    // Sort both sides by model for a stable comparison (SQL orders by cost
    // desc with no tiebreak).
    [...out.charts.modelBreakdown].sort(byModelAsc),
    expectedBreakdown.sort(byModelAsc)
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.charts.model_breakdown_vs_signed`,
    Object.fromEntries(out.charts.modelBreakdown.map((b) => [b.key, b.value])),
    allocateRoundedUsdValues(win.per_model_spend_usd, win.cost_usd_store)
  );
  // Conservation: per-model spend sums to the Delivery cost KPI.
  const spendSum = [...spend.values()].reduce((s, v) => s + v, 0);
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.conservation.spend_sums_to_cost`,
    Math.abs(spendSum - cost) < 1e-6,
    true,
    `Σ per-model=${spendSum} vs window cost=${cost}`
  );
  // tokenDistribution parts. Optional on the shared wire contract, always
  // computed by the desktop-local backend — absence is a regression, so it is
  // reported rather than skipped.
  const { tokenDistribution } = out.charts;
  if (!tokenDistribution) {
    failures.push(
      `agg.insights.agents.${period}.charts: local response omitted token_distribution`
    );
    return;
  }
  const totals = deriveUsageTotalsInWindow(rows, range.startIso, range.endIso);
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.charts.token_distribution`,
    tokenDistribution.map((b) => [b.key, b.value]),
    [
      ["input", totals.input],
      ["output", totals.output],
      ["cache-read", totals.cacheRead],
      ["cache-write", totals.cacheWrite],
    ]
  );
}

function deriveModelUsagePoints(
  rows: L3Rows,
  range: RangeTwin,
  days: string[]
): { date: string; values: Record<string, number> }[] {
  // top-6 models by spend + "other", per local day of session start.
  const winSessionsList = windowSessions(
    rows,
    range.trendStartIso,
    range.endIso
  );
  const trendIds = new Set(winSessionsList.map((s) => s.id));
  const sessionDay = new Map<string, string>();
  for (const s of winSessionsList) {
    if (s.started_at !== null) {
      sessionDay.set(s.id, localDayOf(s.started_at));
    }
  }
  const spendByDayModel = new Map<string, Map<string, number>>();
  const totalByModel = new Map<string, number>();
  for (const t of rows.tokenUsage) {
    if (t.model === null || !trendIds.has(t.session_id)) {
      continue;
    }
    const day = sessionDay.get(t.session_id);
    if (day === undefined) {
      continue;
    }
    const perModel = spendByDayModel.get(day) ?? new Map<string, number>();
    perModel.set(
      t.model,
      (perModel.get(t.model) ?? 0) + num(t.cost_usd_estimated)
    );
    spendByDayModel.set(day, perModel);
    totalByModel.set(
      t.model,
      (totalByModel.get(t.model) ?? 0) + num(t.cost_usd_estimated)
    );
  }
  const topSet = new Set(
    [...totalByModel.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([m]) => m)
  );
  return days.map((date) => {
    const perModel = spendByDayModel.get(date);
    const values: Record<string, number> = {};
    if (perModel) {
      for (const [model, v] of perModel) {
        const key = topSet.has(model) ? model : "other";
        values[key] = (values[key] ?? 0) + v;
      }
      return { date, values: allocateRoundedUsdValues(values) };
    }
    return { date, values };
  });
}

function checkAgentsTimeSeries(ctx: InsightCtx): void {
  const { failures, rows, range, period, out } = ctx;
  if (!("autonomyTrend" in out.charts)) {
    return;
  }
  // `in` proves this is the agents shape; the property itself is optional on
  // that shape, so the value still has to be checked before it can be read.
  const { autonomyTrend } = out.charts;
  const days = eachDay(range.trendStartIso, range.endIso);
  // model_usage_over_time does not depend on autonomy_trend, so it is checked
  // BEFORE that guard: one omitted chart must not silently drop a second,
  // unrelated fact along with it.
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.charts.model_usage_over_time`,
    out.charts.modelUsageOverTime.points,
    deriveModelUsagePoints(rows, range, days)
  );
  if (!autonomyTrend) {
    // Always emitted by the desktop-local backend — report the omission by name
    // rather than skipping the assertion and staying green.
    failures.push(
      `agg.insights.agents.${period}.charts: local response omitted autonomy_trend`
    );
    return;
  }
  // autonomyTrend: gap-filled daily autonomy index from session_turn_bucket.
  const autonomy = deriveAutonomyByDay(rows, range.trendStartIso, range.endIso);
  const autonomyByDay = new Map(
    autonomy.map((p) => [p.day, p.total > 0 ? (100 * p.agent) / p.total : 0])
  );
  checkFact(
    failures,
    "corpus",
    `agg.insights.agents.${period}.charts.autonomy_trend`,
    autonomyTrend.points,
    days.map((date) => ({
      date,
      values: { autonomy: autonomyByDay.get(date) ?? null },
    }))
  );
}

type WorkflowOut = Awaited<
  ReturnType<Fixture["db"]["dashboard"]["getWorkflowData"]>
>;

function checkWorkflowEffectiveness(
  failures: string[],
  rows: L3Rows,
  out: WorkflowOut
): void {
  // effectiveness mirrors subagentTypes ROW FOR ROW — cardinality first so an
  // empty effectiveness array cannot pass vacuously.
  checkFact(
    failures,
    "corpus",
    "agg.workflow.effectiveness_count",
    out.effectiveness.length,
    out.orchestration.subagentTypes.length
  );
  for (const e of out.effectiveness) {
    const row = out.orchestration.subagentTypes.find(
      (r) => r.subagentType === e.subagentType
    );
    if (
      !row ||
      e.total !== row.count ||
      e.completed !== row.completed ||
      e.errors !== row.errors
    ) {
      failures.push(
        `agg.workflow.effectiveness: ${e.subagentType} disagrees with orchestration.subagentTypes`
      );
    }
    const rate = agentSuccessRateTwin(e.completed, e.errors);
    if (e.successRate !== rate) {
      failures.push(
        `agg.workflow.effectiveness: ${e.subagentType} successRate ${e.successRate} != ${rate}`
      );
    }
  }
  // outcomes = sessions by status.
  checkFact(
    failures,
    "corpus",
    "agg.workflow.outcomes",
    asCountMap(
      out.orchestration.outcomes.map((r) => ({ key: r.status, count: r.count }))
    ),
    Object.fromEntries(countBy(rows.sessions, (s) => s.status))
  );
  // edges: parent→child type pairs.
  checkFact(
    failures,
    "corpus",
    "agg.workflow.edges",
    asCountMap(
      out.orchestration.edges.map((e) => ({
        key: `${e.source}→${e.target}`,
        count: e.weight,
      }))
    ),
    Object.fromEntries(deriveAgentEdgeCounts(rows))
  );
}

function deriveAgentEdgeCounts(rows: L3Rows): Map<string, number> {
  const byId = new Map(rows.agents.map((a) => [a.id, a]));
  const typeOf = (
    a: { subagent_type: string | null; type: string | null },
    fallback: string
  ) => a.subagent_type ?? a.type ?? fallback;
  const edgeCounts = new Map<string, number>();
  for (const c of rows.agents) {
    if (c.parent_agent_id === null) {
      continue;
    }
    const p = byId.get(c.parent_agent_id);
    if (!p) {
      continue;
    }
    const key = `${typeOf(p, "main")}→${typeOf(c, "unknown")}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  return edgeCounts;
}

function deriveToolTransitions(
  rows: L3Rows,
  refIso: string
): Map<string, number> {
  // LEAD() twin: pairs per session ordered by (created_at, id) over the last
  // 7 days anchored to the injected clock. Workflow tool flow tracks invocation
  // rows so completion rows cannot double-count tools that emit both hooks.
  const cutoff7 = new Date(Date.parse(refIso) - 7 * 86_400_000).toISOString();
  const recent = rows.events
    .filter(
      (e) =>
        e.tool_name !== null &&
        e.event_type === WORKFLOW_TOOL_INVOCATION_EVENT_TYPE &&
        e.created_at !== null &&
        e.created_at > cutoff7
    )
    .sort((a, b) => {
      if (a.session_id !== b.session_id) {
        return compareStrings(a.session_id, b.session_id);
      }
      if (a.created_at !== b.created_at) {
        return compareStrings(a.created_at ?? "", b.created_at ?? "");
      }
      return compareStrings(a.id, b.id);
    });
  const transitions = new Map<string, number>();
  for (let i = 0; i + 1 < recent.length; i++) {
    if (recent[i].session_id !== recent[i + 1].session_id) {
      continue;
    }
    const key = `${recent[i].tool_name}→${recent[i + 1].tool_name}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }
  return transitions;
}

function checkWorkflowToolFlow(
  failures: string[],
  rows: L3Rows,
  out: WorkflowOut,
  refIso: string
): void {
  const transitions = deriveToolTransitions(rows, refIso);
  // Cardinality first: an empty/truncated result must not pass vacuously.
  checkFact(
    failures,
    "corpus",
    "agg.workflow.tool_transitions_count",
    out.toolFlow.transitions.length,
    Math.min(30, transitions.size)
  );
  for (const t of out.toolFlow.transitions) {
    const expected = transitions.get(`${t.source}→${t.target}`);
    if (expected !== t.value) {
      failures.push(
        `agg.workflow.tool_transitions: ${t.source}→${t.target} value ${t.value} != derived ${String(expected)}`
      );
    }
  }
  assertNonIncreasing(
    failures,
    "agg.workflow.tool_transitions_order",
    out.toolFlow.transitions.map((t) => t.value)
  );
  // topFlow: null iff no transitions; else it carries the max derived value.
  const maxTransition = Math.max(0, ...transitions.values());
  if (out.stats.topFlow === null) {
    checkFact(
      failures,
      "corpus",
      "agg.workflow.top_flow_null",
      transitions.size,
      0
    );
  } else {
    checkFact(
      failures,
      "corpus",
      "agg.workflow.top_flow_value",
      out.stats.topFlow.count,
      maxTransition
    );
    const pairValue = transitions.get(
      `${out.stats.topFlow.source}→${out.stats.topFlow.target}`
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.top_flow_pair",
      pairValue,
      maxTransition
    );
  }
  // toolCounts: -30d invocation window, top 20 — per-key equality plus
  // cardinality.
  const cutoff30 = new Date(Date.parse(refIso) - 30 * 86_400_000).toISOString();
  const toolCounts = countBy(
    rows.events.filter(
      (e) =>
        e.tool_name !== null &&
        e.event_type === WORKFLOW_TOOL_INVOCATION_EVENT_TYPE &&
        e.created_at !== null &&
        e.created_at > cutoff30
    ),
    (e) => e.tool_name
  );
  checkFact(
    failures,
    "corpus",
    "agg.workflow.tool_counts_count",
    out.toolFlow.toolCounts.length,
    Math.min(20, toolCounts.size)
  );
  for (const r of out.toolFlow.toolCounts) {
    const expected = toolCounts.get(r.toolName);
    if (expected !== r.count) {
      failures.push(
        `agg.workflow.tool_counts: ${r.toolName} count ${r.count} != derived ${String(expected)}`
      );
    }
  }
  // cooccurrence: unordered agent-type pairs weighted by distinct sessions.
  const cooccurrence = deriveCooccurrence(rows);
  checkFact(
    failures,
    "corpus",
    "agg.workflow.cooccurrence_count",
    out.cooccurrence.length,
    Math.min(30, cooccurrence.size)
  );
  for (const c of out.cooccurrence) {
    const expected = cooccurrence.get(`${c.source}→${c.target}`);
    if (expected !== c.weight) {
      failures.push(
        `agg.workflow.cooccurrence: ${c.source}→${c.target} weight ${c.weight} != derived ${String(expected)}`
      );
    }
  }
}

// ── Oracle decomposition helpers ─────────────────────────────────────────────

type TokenFieldTotals = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
};

function deriveStoreTokensByModel(rows: L3Rows): Map<string, TokenFieldTotals> {
  const store = new Map<string, TokenFieldTotals>();
  for (const t of rows.tokenUsage) {
    if (t.model === null) {
      continue;
    }
    const m = store.get(t.model) ?? {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    };
    m.input += num(t.input_tokens);
    m.output += num(t.output_tokens);
    m.cache_read += num(t.cache_read_tokens);
    m.cache_write += num(t.cache_write_tokens);
    store.set(t.model, m);
  }
  return store;
}

const INPUT_FIELD_MAP = {
  input: "input",
  output: "output",
  cache_read: "cacheRead",
  cache_write: "cacheWrite",
} as const;

/** A corpus-level store-vs-oracle token delta must decompose into per-dossier
 * input-vs-oracle deltas, each covered by an L1 registry entry, with zero
 * unexplained residue. */
function checkOracleTokenDelta(
  failures: string[],
  corpus: ReturnType<typeof loadCorpus>,
  model: string,
  field: keyof TokenFieldTotals,
  delta: number
): void {
  if (delta === 0) {
    return;
  }
  let covered = 0;
  for (const { d, input } of corpus.inputs) {
    // `tokensByModel` is `Record<string, NormalizedTokenCounts>`, whose
    // `cacheWriteTtl` member is an object — so it is NOT a
    // `Record<string, number>`. Read the real type; `INPUT_FIELD_MAP` already
    // maps every oracle field to one of its four numeric counters.
    const inputTokens = input.tokensByModel ?? {};
    const inputVal = num(inputTokens[model]?.[INPUT_FIELD_MAP[field]]);
    const oracleVal = num(
      (
        d.expectations.tokens_by_model?.[model] as
          | Record<string, number>
          | undefined
      )?.[field]
    );
    const dossierDelta = inputVal - oracleVal;
    if (dossierDelta === 0) {
      continue;
    }
    const entry = findDivergence(
      d.sessionId,
      `tokens_by_model[${model}].${field}`
    );
    if (!entry) {
      failures.push(
        `agg.oracle.tokens_by_model[${model}].${field}: dossier ${d.sessionId} ` +
          `contributes an UNREGISTERED delta of ${dossierDelta} (input ${inputVal} vs oracle ${oracleVal})`
      );
      continue;
    }
    covered += dossierDelta;
  }
  if (covered !== delta) {
    failures.push(
      `agg.oracle.tokens_by_model[${model}].${field}: registered per-dossier deltas sum to ${covered} ` +
        `but the corpus-level store-vs-oracle delta is ${delta} — unexplained residue`
    );
  }
}

// ── Branch-reads helpers ─────────────────────────────────────────────────────

const DEFAULT_BRANCHES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "develop",
  "dev",
  "trunk",
]);

type BranchLinkRowLite = {
  sessionId: string;
  repoFullName: string | null;
  branchName: string;
};
type BranchAggRowLite = {
  repoFullName: string | null;
  branchName: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdEstimated: number | null;
};

function branchAggComparable(r: BranchAggRowLite): Record<string, unknown> {
  return {
    key: `${r.repoFullName ?? ""}#${r.branchName}#${r.model ?? ""}`,
    input: r.inputTokens,
    output: r.outputTokens,
    cacheRead: r.cacheReadTokens,
    cacheWrite: r.cacheWriteTokens,
    cost: r.costUsdEstimated === null ? null : roundUsd(r.costUsdEstimated),
  };
}

function checkBranchKeyFacts(
  failures: string[],
  rows: L3Rows,
  yaml: CorpusYaml,
  keyRows: BranchKeyRow[],
  linkRows: BranchLinkRowLite[]
): void {
  // Distinct push-qualified branch keys (display gate, incl. default-branch
  // exclusion applied by the mapper — derive the pre-exclusion key set from
  // the raw gates and compare on the post-exclusion intersection).
  const writeLinksDerived = activeWriteLinks(rows);
  const expectedKeys = new Set(
    writeLinksDerived
      .filter(
        (w) =>
          !DEFAULT_BRANCHES.has((w.artifact.branch_name ?? "").toLowerCase())
      )
      .map(
        (w) =>
          `${w.artifact.repo_full_name ?? ""}#${w.artifact.branch_name ?? ""}`
      )
  );
  const actualLinkKeys = new Set(
    linkRows.map((r) => `${r.repoFullName ?? ""}#${r.branchName}`)
  );
  checkFact(
    failures,
    "corpus",
    "agg.branches.link_row_keys",
    [...actualLinkKeys].sort(),
    [...expectedKeys].sort()
  );
  checkFact(
    failures,
    "corpus",
    "agg.branches.active_write_links_vs_signed",
    writeLinksDerived.length,
    yaml.branches.active_write_links
  );
  // keyRows (typed distinct) must cover exactly the same non-default keys.
  const actualKeySet = new Set(
    keyRows
      .filter((k) => !DEFAULT_BRANCHES.has((k.branchName ?? "").toLowerCase()))
      .map((k) => `${k.repoFullName ?? ""}#${k.branchName ?? ""}`)
  );
  checkFact(
    failures,
    "corpus",
    "agg.branches.distinct_keys",
    [...actualKeySet].sort(),
    [...expectedKeys].sort()
  );
}

async function checkBranchPrFacts(
  failures: string[],
  rows: L3Rows,
  yaml: CorpusYaml,
  prisma: Fixture["db"]["prisma"],
  refIso: string
): Promise<void> {
  // PR rows: pull_requests scoped to push-qualified branch sessions.
  const prRows = await readLocalBranchPrRows(prisma);
  // `BranchPrRow` carries no `session_id` — the branch read matches
  // `pull_requests` on the `(repo_full_name, branch_name)` identity
  // `encodeBranchId` keys on, so that plus `pr_number` is the row identity to
  // look the PR back up by. `pr_number` is compared through `nullableNum`, NOT
  // `num`: the read does not filter `pr_number IS NOT NULL`, so an unenriched
  // row can carry a null, and `num` would fold that null into 0 on BOTH sides —
  // making an unknown PR number match a literal PR 0 and vice versa. Null
  // matches only null here, mirroring the read's own `IS NOT DISTINCT FROM`
  // repo match.
  checkFact(
    failures,
    "corpus",
    "agg.branches.pr_rows_subset",
    prRows.every((p) =>
      rows.pullRequests.some(
        (row) =>
          (row.repo_full_name ?? null) === (p.repoFullName ?? null) &&
          row.branch_name === p.branchName &&
          nullableNum(row.pr_number) === p.prNumber
      )
    ),
    true,
    "a branch PR row must exist in pull_requests"
  );
  // FEA-3229 exposure: an injected-clock store can never carry a
  // pull_requests timestamp AFTER the corpus reference clock; wall-clock
  // stamping does.
  const wallclockLeak = rows.pullRequests.some(
    (p) =>
      (p.created_at !== null && p.created_at > refIso) ||
      (p.observed_at !== null && p.observed_at > refIso)
  );
  checkFact(
    failures,
    "corpus",
    "agg.branches.pull_requests_wallclock_leak",
    wallclockLeak,
    false,
    "pull_requests.created_at/observed_at exceed the injected corpus clock"
  );
  checkFact(
    failures,
    "corpus",
    "agg.branches.pull_request_rows_vs_signed",
    rows.pullRequests.length,
    yaml.branches.pull_request_rows
  );
}

function checkBranchAggregateFacts(
  failures: string[],
  rows: L3Rows,
  aggregateRows: BranchAggRowLite[]
): void {
  // Token aggregates: FEA-2032 even split, full row-set fidelity (grouped by
  // repo/branch/model with the session's active-write-pair divisor).
  checkFact(
    failures,
    "corpus",
    "agg.branches.token_aggregates",
    aggregateRows.map(branchAggComparable),
    deriveBranchTokenAggregates(rows).map(branchAggComparable)
  );
}

async function checkBranchScopedFacts(
  failures: string[],
  prisma: Fixture["db"]["prisma"],
  keyRows: BranchKeyRow[],
  linkRows: BranchLinkRowLite[],
  aggregateRows: BranchAggRowLite[]
): Promise<void> {
  // Scoped ≡ unscoped: per-branch reads must equal the filtered global read.
  const firstKey = keyRows[0];
  if (!firstKey) {
    return;
  }
  const scopedLinks = await readLocalBranchLinkRowsForBranch(prisma, firstKey);
  const expectedScoped = linkRows.filter(
    (r) =>
      r.branchName === firstKey.branchName &&
      (r.repoFullName ?? null) === (firstKey.repoFullName ?? null)
  );
  checkFact(
    failures,
    "corpus",
    "agg.branches.scoped_equals_filtered_links",
    scopedLinks.map((r) => `${r.sessionId}#${r.branchName}`).sort(),
    expectedScoped.map((r) => `${r.sessionId}#${r.branchName}`).sort()
  );
  const scopedAgg = await readBranchTokenAggregateRowsForBranch(
    prisma,
    firstKey
  );
  const expectedAgg = aggregateRows.filter(
    (r) =>
      r.branchName === firstKey.branchName &&
      (r.repoFullName ?? null) === (firstKey.repoFullName ?? null)
  );
  checkFact(
    failures,
    "corpus",
    "agg.branches.scoped_equals_filtered_aggregates",
    scopedAgg,
    expectedAgg
  );
}

// ── Suite ────────────────────────────────────────────────────────────────────

export function registerGoldenLayer3Suite(): void {
  before(async () => {
    fixture = await setupFixture();
  });
  after(async () => {
    if (fixture) {
      await fixture.db.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  // ── Group 0: the signed-file guards (golden-layer3-signed-guards.ts) ───────
  test("golden layer3: corpus-expectations.yaml reference_now guard", () => {
    const { yaml, refIso, rows } = fx();
    assertSignedCorpusGuards({ yaml, refIso, rows });
  });

  // ── Group 1: getSummary ────────────────────────────────────────────────────
  test("golden layer3: getSummary", async () => {
    const { db, rows, yaml } = fx();
    const failures: string[] = [];
    const summary = await db.getSummary();
    // ISS-4586: `inactive` is the canonical terminal-not-failed status (mirrors
    // the SSOT `TERMINAL_STATUS_SET` production's activeSessions count uses).
    const terminalSet = new Set([
      "inactive",
      "completed",
      "abandoned",
      "error",
    ]);
    checkFact(
      failures,
      "corpus",
      "agg.summary.total_sessions",
      summary.totalSessions,
      rows.sessions.length
    );
    checkFact(
      failures,
      "corpus",
      "agg.summary.active_sessions",
      summary.activeSessions,
      rows.sessions.filter((s) => !terminalSet.has(s.status)).length
    );
    checkFact(
      failures,
      "corpus",
      "agg.summary.total_agents",
      summary.totalAgents,
      rows.agents.length
    );
    checkFact(
      failures,
      "corpus",
      "agg.summary.total_events",
      summary.totalEvents,
      rows.events.length
    );
    checkFact(
      failures,
      "corpus",
      "agg.summary.event_type_count",
      summary.eventTypeCount,
      new Set(rows.events.map((e) => e.event_type)).size
    );
    let usageTokens = 0;
    for (const t of rows.tokenUsage) {
      usageTokens += num(t.input_tokens) + num(t.output_tokens);
    }
    checkFact(
      failures,
      "corpus",
      "agg.summary.total_tokens",
      summary.totalTokens,
      usageTokens
    );
    // Oracle: signed headline values.
    checkFact(
      failures,
      "corpus",
      "agg.summary.vs_signed",
      {
        totalSessions: summary.totalSessions,
        totalAgents: summary.totalAgents,
        totalEvents: summary.totalEvents,
        eventTypeCount: summary.eventTypeCount,
        totalTokens: summary.totalTokens,
        activeSessions: summary.activeSessions,
      },
      {
        totalSessions: yaml.summary.total_sessions,
        totalAgents: yaml.summary.total_agents,
        totalEvents: yaml.summary.total_events,
        eventTypeCount: yaml.summary.distinct_event_types,
        totalTokens: yaml.summary.total_tokens_usage,
        activeSessions: yaml.summary.active_sessions,
      }
    );
    // recentSessions: top 10 by startedAt desc.
    const expectedRecent = [...rows.sessions]
      .filter((s) => s.started_at !== null)
      .sort((a, b) => (a.started_at! < b.started_at! ? 1 : -1))
      .slice(0, 10)
      .map((s) => s.id);
    checkFact(
      failures,
      "corpus",
      "agg.summary.recent_sessions",
      summary.recentSessions.map((s) => s.id),
      expectedRecent
    );
    assertNoFailures(failures, "getSummary");
  });

  // ── Group 2: getTokenAnalytics (30 local calendar days over token_events) ──
  test("golden layer3: getTokenAnalytics", async () => {
    const { db, rows, refDate, refIso, yaml } = fx();
    const failures: string[] = [];
    const ta = await db.dashboard.getTokenAnalytics(refDate);
    const windowEvents = tokenEventsInWindow(rows, refIso);
    const signedTokenAnalytics =
      yaml.tz_dependent[IS_CHICAGO ? "chicago" : "utc"].token_analytics_30d;

    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const e of windowEvents) {
      totals.input += num(e.input_tokens);
      totals.output += num(e.output_tokens);
      totals.cacheRead += num(e.cache_read_tokens);
      totals.cacheWrite += num(e.cache_write_tokens);
    }
    checkFact(
      failures,
      "corpus",
      "agg.token_analytics.totals",
      {
        input: ta.totalInputTokens,
        output: ta.totalOutputTokens,
        cacheRead: ta.totalCacheReadTokens,
        cacheWrite: ta.totalCacheWriteTokens,
      },
      totals
    );
    checkFact(
      failures,
      "corpus",
      "agg.token_analytics.totals_vs_signed",
      {
        input: ta.totalInputTokens,
        output: ta.totalOutputTokens,
        cacheRead: ta.totalCacheReadTokens,
        cacheWrite: ta.totalCacheWriteTokens,
      },
      {
        input: signedTokenAnalytics.totals.input,
        output: signedTokenAnalytics.totals.output,
        cacheRead: signedTokenAnalytics.totals.cache_read,
        cacheWrite: signedTokenAnalytics.totals.cache_write,
      }
    );

    // byModel — derived from token_events rows.
    const byModel = new Map<
      string,
      { input: number; output: number; sessions: Set<string>; cost: number }
    >();
    for (const e of windowEvents) {
      if (e.model === null) {
        continue;
      }
      const m = byModel.get(e.model) ?? {
        input: 0,
        output: 0,
        sessions: new Set<string>(),
        cost: 0,
      };
      m.input += num(e.input_tokens);
      m.output += num(e.output_tokens);
      m.sessions.add(e.session_id);
      m.cost += num(e.cost_usd_estimated);
      byModel.set(e.model, m);
    }
    const expectedByModel = [...byModel.entries()]
      .map(([model, m]) =>
        tokenAnalyticsByModelRow({
          model,
          inputTokens: m.input,
          outputTokens: m.output,
          sessions: m.sessions.size,
          estimatedCostUsd: roundUsd(m.cost),
        })
      )
      .sort((a, b) => Number(b.estimatedCostUsd) - Number(a.estimatedCostUsd));
    checkFact(
      failures,
      "corpus",
      "agg.token_analytics.by_model",
      // Sort both sides by model for a stable comparison (SQL orders by cost
      // desc with no tiebreak).
      sortTokenAnalyticsByModelRowsByModel(
        projectTokenAnalyticsByModelRows(ta.byModel)
      ),
      sortTokenAnalyticsByModelRowsByModel(expectedByModel)
    );
    const signedByModel = Object.entries(signedTokenAnalytics.by_model).map(
      ([model, m]) =>
        tokenAnalyticsByModelRow({
          model,
          inputTokens: m.input,
          outputTokens: m.output,
          sessions: m.sessions,
          estimatedCostUsd: roundUsd(m.cost_usd_events),
        })
    );
    checkFact(
      failures,
      "corpus",
      "agg.token_analytics.by_model_vs_signed",
      sortTokenAnalyticsByModelRowsByModel(
        projectTokenAnalyticsByModelRows(ta.byModel)
      ),
      sortTokenAnalyticsByModelRowsByModel(signedByModel)
    );

    // byDay — per-TZ local-day buckets; also asserted against the signed
    // per-day cost section for THIS suite's timezone.
    const byDay = new Map<
      string,
      { input: number; output: number; cost: number }
    >();
    for (const e of windowEvents) {
      const day = localDayOf(e.created_at);
      const d = byDay.get(day) ?? { input: 0, output: 0, cost: 0 };
      d.input += num(e.input_tokens);
      d.output += num(e.output_tokens);
      d.cost += num(e.cost_usd_estimated);
      byDay.set(day, d);
    }
    const expectedByDay = [...byDay.entries()]
      .map(([day, d]) => ({
        day,
        inputTokens: d.input,
        outputTokens: d.output,
        estimatedCostUsd: roundUsd(d.cost),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));
    checkFact(
      failures,
      "corpus",
      "agg.token_analytics.by_day",
      ta.byDay,
      expectedByDay
    );
    const signedCosts =
      fx().yaml.tz_dependent[IS_CHICAGO ? "chicago" : "utc"]
        .token_events_cost_per_day_30d;
    checkFact(
      failures,
      "corpus",
      "agg.token_analytics.by_day_cost_vs_signed",
      // `estimatedCostUsd` is optional on the shared TokenAnalytics contract
      // (older peers omit it); the desktop backend always emits it, and the
      // full-row deep-equal directly above already pins that. Coalescing keeps
      // an omission a mismatch against the signed costs rather than a NaN.
      Object.fromEntries(
        ta.byDay.map((d) => [d.day, roundUsd(d.estimatedCostUsd ?? 0)])
      ),
      Object.fromEntries(
        Object.entries(signedCosts).map(([day, v]) => [day, roundUsd(v)])
      )
    );
    assertNoFailures(failures, "getTokenAnalytics");
  });

  // ── Group 2b: cost conservation across the two token stores (FEA-3232) ─────
  test("golden layer3: token_events cost conserves to token_usage cost per session", () => {
    const { rows, yaml } = fx();
    const failures: string[] = [];
    const eventCost = new Map<string, number>();
    for (const e of rows.tokenEvents) {
      eventCost.set(
        e.session_id,
        (eventCost.get(e.session_id) ?? 0) + num(e.cost_usd_estimated)
      );
    }
    const usageCost = new Map<string, number>();
    for (const t of rows.tokenUsage) {
      usageCost.set(
        t.session_id,
        (usageCost.get(t.session_id) ?? 0) + num(t.cost_usd_estimated)
      );
    }
    for (const [sid, usage] of [...usageCost.entries()].sort()) {
      const events = eventCost.get(sid) ?? 0;
      // Signed cross-check first: both figures must match the yaml.
      const signed = yaml.cost_conservation_by_session[sid];
      assert.ok(signed, `${sid}: missing from cost_conservation_by_session`);
      checkFact(
        failures,
        { sessionId: sid },
        "agg.cost_conservation.signed",
        { usage: roundUsd(usage), events: roundUsd(events) },
        {
          usage: roundUsd(signed.token_usage_usd),
          events: roundUsd(signed.token_events_usd),
        }
      );
      // Conservation: Σ per-event costs ≈ the session rollup (cent tolerance).
      // Reds here are the FEA-3232 storage bug surfacing at the aggregation
      // layer — resolved via the L3 registry, ticket-keyed.
      checkFact(
        failures,
        { sessionId: sid },
        "agg.cost_conservation.events_equal_usage",
        Math.abs(usage - events) <= 0.01,
        true,
        `token_usage=$${usage.toFixed(4)} vs Σ token_events=$${events.toFixed(4)}`
      );
    }
    assertNoFailures(failures, "cost conservation");
  });

  // ── Group 3: getInsights × 3 sections × 4 periods ──────────────────────────
  for (const period of PERIODS) {
    test(`golden layer3: insights delivery period=${period}`, async () => {
      const { db, rows, refDate, refIso, yaml } = fx();
      const failures: string[] = [];
      const out = await db.dashboard.getInsights(
        InsightsSection.Delivery,
        period,
        refDate
      );
      const win = yaml.windows[period];
      assert.ok(win, `windows["${period}"] missing from corpus-expectations`);
      const ctx: InsightCtx = {
        failures,
        rows,
        range: rangeTwin(period, refIso),
        win,
        period,
        out,
      };
      checkDeliveryKpis(ctx);
      checkDeliveryDeltaSuppression(ctx);
      checkDeliveryCharts(ctx);
      assertNoFailures(failures, `insights delivery ${period}`);
    });

    test(`golden layer3: insights utilization period=${period}`, async () => {
      const { db, rows, refDate, refIso, yaml } = fx();
      const failures: string[] = [];
      const out = await db.dashboard.getInsights(
        InsightsSection.Utilization,
        period,
        refDate
      );
      const win = yaml.windows[period];
      assert.ok(win, `windows["${period}"] missing from corpus-expectations`);
      const ctx: InsightCtx = {
        failures,
        rows,
        range: rangeTwin(period, refIso),
        win,
        period,
        out,
      };
      checkUtilizationKpis(ctx);
      checkUtilizationCharts(ctx);
      checkEventsByTypeTop12(ctx);
      assertNoFailures(failures, `insights utilization ${period}`);
    });

    test(`golden layer3: insights agents period=${period}`, async () => {
      const { db, rows, refDate, refIso, yaml } = fx();
      const failures: string[] = [];
      const out = await db.dashboard.getInsights(
        InsightsSection.Agents,
        period,
        refDate
      );
      const win = yaml.windows[period];
      assert.ok(win, `windows["${period}"] missing from corpus-expectations`);
      const ctx: InsightCtx = {
        failures,
        rows,
        range: rangeTwin(period, refIso),
        win,
        period,
        out,
      };
      checkAgentsKpis(ctx);
      checkAgentsSpendCharts(ctx);
      checkAgentsTimeSeries(ctx);
      assertNoFailures(failures, `insights agents ${period}`);
    });
  }

  // ── Group 3b: signed per-day sections for THIS timezone ────────────────────
  test("golden layer3: signed tz-dependent day buckets (autonomy, heatmap, sessions/day)", () => {
    const { rows, refIso, yaml } = fx();
    const failures: string[] = [];
    const tz = yaml.tz_dependent[IS_CHICAGO ? "chicago" : "utc"];
    const trend = rangeTwin(InsightsPeriod.Quarter, refIso);
    const autonomy = deriveAutonomyByDay(
      rows,
      trend.trendStartIso,
      trend.endIso
    );
    checkFact(
      failures,
      "corpus",
      "agg.signed.autonomy_by_day",
      Object.fromEntries(
        autonomy.map((p) => [p.day, { agent: p.agent, total: p.total }])
      ),
      Object.fromEntries(
        Object.entries(tz.autonomy_by_day).map(([day, v]) => [
          day,
          { agent: v.agent, total: v.total },
        ])
      )
    );
    const cells = deriveHeatmapCells(rows, trend.trendStartIso, trend.endIso);
    const dayTotals = new Map<string, { human: number; agent: number }>();
    for (const c of cells) {
      const d = dayTotals.get(c.day) ?? { human: 0, agent: 0 };
      d.human += c.human;
      d.agent += c.agent;
      dayTotals.set(c.day, d);
    }
    checkFact(
      failures,
      "corpus",
      "agg.signed.heatmap_day_totals",
      Object.fromEntries(dayTotals),
      tz.heatmap_day_totals
    );
    const perDay = countBy(rows.sessions, (s) =>
      s.started_at === null ? null : localDayOf(s.started_at)
    );
    checkFact(
      failures,
      "corpus",
      "agg.signed.sessions_started_per_day",
      Object.fromEntries(perDay),
      tz.sessions_started_per_day
    );
    // Conservation: heatmap cells sum to the autonomy totals sum (same source).
    const heatSum = [...dayTotals.values()].reduce(
      (s, d) => s + d.human + d.agent,
      0
    );
    const autoSum = autonomy.reduce((s, p) => s + p.total, 0);
    checkFact(
      failures,
      "corpus",
      "agg.signed.heatmap_conserves_to_autonomy",
      heatSum,
      autoSum
    );
    assertNoFailures(failures, "signed tz-dependent day buckets");
  });

  // ── Group 4: getAnalytics ──────────────────────────────────────────────────
  test("golden layer3: getAnalytics", async () => {
    const { db, rows, refDate, refIso } = fx();
    const failures: string[] = [];
    const out = await db.dashboard.getAnalytics(refDate);
    // tokens facet must byte-equal getTokenAnalytics at the same clock.
    const ta = await db.dashboard.getTokenAnalytics(refDate);
    checkFact(failures, "corpus", "agg.analytics.tokens_facet", out.tokens, ta);
    // eventsByType: full tally as multiset + ordering contract.
    const typeCounts = countBy(rows.events, (e) => e.event_type);
    checkFact(
      failures,
      "corpus",
      "agg.analytics.events_by_type",
      asCountMap(
        out.eventsByType.map((r) => ({ key: r.eventType, count: r.count }))
      ),
      Object.fromEntries(typeCounts)
    );
    assertNonIncreasing(
      failures,
      "agg.analytics.events_by_type_order",
      out.eventsByType.map((r) => r.count)
    );
    // dailyEvents: -365d anchored to the injected clock, local-day buckets.
    const cutoff = new Date(
      Date.parse(refIso) - 365 * 86_400_000
    ).toISOString();
    const daily = countBy(
      rows.events.filter((e) => e.created_at !== null && e.created_at > cutoff),
      (e) => localDayOf(e.created_at!)
    );
    checkFact(
      failures,
      "corpus",
      "agg.analytics.daily_events",
      out.dailyEvents.map((r) => [r.date, r.count]),
      [...daily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    );
    // toolUsage: -30d window anchored to the injected clock (the FEA-2649
    // wall-clock fix) — top 20.
    const cutoff30 = new Date(
      Date.parse(refIso) - 30 * 86_400_000
    ).toISOString();
    const toolCounts = countBy(
      rows.events.filter(
        (e) =>
          e.tool_name !== null &&
          e.created_at !== null &&
          e.created_at > cutoff30
      ),
      (e) => e.tool_name
    );
    checkFact(
      failures,
      "corpus",
      "agg.analytics.tool_usage_count",
      out.toolUsage.length,
      Math.min(20, toolCounts.size)
    );
    for (const r of out.toolUsage) {
      const expected = toolCounts.get(r.toolName);
      if (expected !== r.count) {
        failures.push(
          `agg.analytics.tool_usage: ${r.toolName} count ${r.count} != derived ${String(expected)}`
        );
      }
    }
    assertNonIncreasing(
      failures,
      "agg.analytics.tool_usage_order",
      out.toolUsage.map((r) => r.count)
    );
    // statuses/types (typed groupBys) as multisets.
    checkFact(
      failures,
      "corpus",
      "agg.analytics.sessions_by_status",
      asCountMap(
        out.sessionsByStatus.map((r) => ({ key: r.status, count: r.count }))
      ),
      Object.fromEntries(countBy(rows.sessions, (s) => s.status))
    );
    checkFact(
      failures,
      "corpus",
      "agg.analytics.agents_by_status",
      asCountMap(
        out.agentsByStatus.map((r) => ({
          key: r.status ?? "null",
          count: r.count,
        }))
      ),
      Object.fromEntries(countBy(rows.agents, (a) => a.status ?? "null"))
    );
    checkFact(
      failures,
      "corpus",
      "agg.analytics.agents_by_type",
      asCountMap(
        out.agentsByType.map((r) => ({ key: r.type, count: r.count }))
      ),
      Object.fromEntries(countBy(rows.agents, (a) => a.type ?? "unknown"))
    );
    checkFact(
      failures,
      "corpus",
      "agg.analytics.totals",
      {
        sessions: out.totalSessions,
        agents: out.totalAgents,
        events: out.totalEvents,
      },
      {
        sessions: rows.sessions.length,
        agents: rows.agents.length,
        events: rows.events.length,
      }
    );
    assertNoFailures(failures, "getAnalytics");
  });

  // ── Group 5: getWorkflowData ───────────────────────────────────────────────
  test("golden layer3: getWorkflowData", async () => {
    const { db, rows, refDate, refIso, yaml } = fx();
    const failures: string[] = [];
    const out = await db.dashboard.getWorkflowData(refDate);
    const subagents = rows.agents.filter(isSubagentRow);
    const completed = rows.agents.filter((a) =>
      isSuccessAgentStatus(a.status)
    ).length;
    const errors = rows.agents.filter((a) =>
      isFailedAgentStatus(a.status)
    ).length;

    checkFact(
      failures,
      "corpus",
      "agg.workflow.total_sessions",
      out.stats.totalSessions,
      rows.sessions.length
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.total_agents",
      out.stats.totalAgents,
      rows.agents.length
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.total_subagents",
      out.stats.totalSubagents,
      subagents.length
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.avg_subagents",
      out.stats.avgSubagents,
      rows.sessions.length > 0 ? subagents.length / rows.sessions.length : 0
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.success_rate",
      out.stats.successRate,
      agentSuccessRateTwin(completed, errors)
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.success_rate_vs_signed",
      Math.round(out.stats.successRate * 1e6) / 1e6,
      yaml.workflow.success_rate
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.avg_depth",
      out.stats.avgDepth,
      deriveAvgDepth(rows)
    );
    const avgDur = deriveAvgDurationSec(rows);
    checkFact(
      failures,
      "corpus",
      "agg.workflow.avg_duration_sec",
      Math.abs(out.stats.avgDurationSec - avgDur) < 1e-6,
      true,
      `query=${out.stats.avgDurationSec} derived=${avgDur}`
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.main_count",
      out.orchestration.mainCount,
      rows.agents.length - subagents.length
    );
    // subagentTypes: grouped by subagent_type (COALESCE to MAX(type)/'unknown').
    const expectedTypes = countBy(
      subagents,
      (a) => a.subagent_type ?? a.type ?? "unknown"
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.subagent_types",
      asCountMap(
        out.orchestration.subagentTypes.map((r) => ({
          key: r.subagentType,
          count: r.count,
        }))
      ),
      Object.fromEntries(expectedTypes)
    );
    checkFact(
      failures,
      "corpus",
      "agg.workflow.subagent_types_vs_signed",
      asCountMap(
        out.orchestration.subagentTypes.map((r) => ({
          key: r.subagentType,
          count: r.count,
        }))
      ),
      yaml.workflow.subagent_types
    );
    checkWorkflowEffectiveness(failures, rows, out);
    checkWorkflowToolFlow(failures, rows, out, refIso);
    assertNoFailures(failures, "getWorkflowData");
  });

  // ── Group 6: getCoreFeatures ───────────────────────────────────────────────
  test("golden layer3: getCoreFeatures tools/subagents/plans/pullRequests", async () => {
    const { db, rows, yaml } = fx();
    const failures: string[] = [];
    const core = await db.dashboard.getCoreFeatures();
    // tools: exact per-tool counts, distinct sessions, ordering contract.
    const invocations = countBy(
      rows.events.filter((e) => e.tool_name !== null),
      (e) => e.tool_name
    );
    const sessionsPerTool = new Map<string, Set<string>>();
    for (const e of rows.events) {
      if (e.tool_name === null) {
        continue;
      }
      const set = sessionsPerTool.get(e.tool_name) ?? new Set<string>();
      set.add(e.session_id);
      sessionsPerTool.set(e.tool_name, set);
    }
    checkFact(
      failures,
      "corpus",
      "agg.core.tools",
      Object.fromEntries(
        core.tools.map((t) => [
          t.toolName,
          { n: t.invocationCount, s: t.sessionCount },
        ])
      ),
      Object.fromEntries(
        [...invocations.entries()].map(([name, n]) => [
          name,
          { n, s: sessionsPerTool.get(name)?.size ?? 0 },
        ])
      )
    );
    checkFact(
      failures,
      "corpus",
      "agg.core.tools_vs_signed",
      Object.fromEntries(
        core.tools.map((t) => [t.toolName, t.invocationCount])
      ),
      yaml.core_features.tool_counts
    );
    // subagents summary mirrors the workflow grouping.
    const expectedTypes = countBy(
      rows.agents.filter(isSubagentRow),
      (a) => a.subagent_type ?? a.type ?? "unknown"
    );
    checkFact(
      failures,
      "corpus",
      "agg.core.subagents",
      asCountMap(
        core.subagents.map((r) => ({ key: r.subagentType, count: r.total }))
      ),
      Object.fromEntries(expectedTypes)
    );
    // plans: parsed from session metadata $.plans[].
    let expectedPlans = 0;
    for (const s of rows.sessions) {
      if (s.metadata === null) {
        continue;
      }
      try {
        const meta = JSON.parse(s.metadata) as { plans?: unknown };
        if (Array.isArray(meta.plans)) {
          expectedPlans += meta.plans.filter(
            (p) =>
              typeof p === "object" &&
              p !== null &&
              typeof (p as { content?: unknown }).content === "string" &&
              (p as { content: string }).content.length > 0
          ).length;
        }
      } catch {
        // non-JSON metadata contributes no plans
      }
    }
    checkFact(
      failures,
      "corpus",
      "agg.core.plans_count",
      core.plans.length,
      expectedPlans
    );
    // skills + packs: parsed Skill events grouped per (harness, pack, name);
    // packs roll the skills up by packId. Cardinality first (Codex round-1:
    // an empty result must not pass vacuously).
    const expectedSkills = deriveSkills(rows);
    checkFact(
      failures,
      "corpus",
      "agg.core.skills",
      Object.fromEntries(core.skills.map((s) => [s.id, s.invocationCount])),
      Object.fromEntries(
        [...expectedSkills.values()].map((s) => [s.id, s.invocationCount])
      )
    );
    // Corpus-integrity check, NOT a production invariant: getSkills DROPS
    // Skill events whose name cannot be resolved (by design), so the named
    // sum equals the raw toolName='Skill' event count only while every corpus
    // Skill event is nameable. A red here on a future intake means the NEW
    // DOSSIER carries an unnamed Skill event (adjudicate the corpus), not
    // that getSkills lost data.
    checkFact(
      failures,
      "corpus",
      "agg.core.skills_all_named",
      core.skills.reduce((sum, s) => sum + s.invocationCount, 0),
      yaml.core_features.skill_invocation_events,
      "a corpus Skill event did not resolve a name — getSkills excludes it by design; adjudicate the new dossier"
    );
    const expectedPacks = derivePacks(expectedSkills);
    checkFact(
      failures,
      "corpus",
      "agg.core.packs",
      Object.fromEntries(
        core.packs.map((p) => [
          p.id,
          { skills: p.skillCount, calls: p.toolCallCount },
        ])
      ),
      Object.fromEntries(
        [...expectedPacks.values()].map((p) => [
          p.id,
          { skills: p.skillCount, calls: p.toolCallCount },
        ])
      )
    );
    // pullRequests: one row per PR artifact (strongest link wins).
    const prIds = deriveDashboardPrArtifactIds(rows);
    checkFact(
      failures,
      "corpus",
      "agg.core.pull_requests_one_per_artifact",
      new Set(core.pullRequests.map((p) => p.id)).size,
      core.pullRequests.length,
      "duplicate PR artifact rows — the strongest-link dedupe fanned out"
    );
    checkFact(
      failures,
      "corpus",
      "agg.core.pull_requests_count",
      core.pullRequests.length,
      prIds.size
    );
    checkFact(
      failures,
      "corpus",
      "agg.core.pull_requests_vs_signed",
      prIds.size,
      yaml.core_features.pull_request_artifacts
    );
    assertNoFailures(failures, "getCoreFeatures");
  });

  // ── Group 7: sessions store paging / filters / search ──────────────────────
  test("golden layer3: sessions getPage pagination, status filters, search", async () => {
    const { db, rows, yaml } = fx();
    const failures: string[] = [];
    const all = deriveSessionPageSet(rows, {});

    const page1 = await db.sessions.getPage({ limit: 10, offset: 0 });
    checkFact(
      failures,
      "corpus",
      "agg.page.total",
      page1.total,
      rows.sessions.length
    );
    checkFact(
      failures,
      "corpus",
      "agg.page.total_vs_signed",
      page1.total,
      yaml.sessions_page.total
    );
    checkFact(
      failures,
      "corpus",
      "agg.page.first_page_ids",
      page1.sessions.map((s) => s.id),
      all.slice(0, 10).map((s) => s.id)
    );
    const page2 = await db.sessions.getPage({ limit: 10, offset: 10 });
    checkFact(
      failures,
      "corpus",
      "agg.page.second_page_ids",
      page2.sessions.map((s) => s.id),
      all.slice(10, 20).map((s) => s.id)
    );
    const beyond = await db.sessions.getPage({ limit: 10, offset: 1000 });
    checkFact(
      failures,
      "corpus",
      "agg.page.offset_beyond_end",
      beyond.sessions.length,
      0
    );
    checkFact(
      failures,
      "corpus",
      "agg.page.offset_beyond_end_total",
      beyond.total,
      rows.sessions.length
    );

    // Status filters: every corpus session is terminal.
    const completed = await db.sessions.getPage({
      status: "completed",
      limit: 100,
    });
    checkFact(
      failures,
      "corpus",
      "agg.page.status_completed",
      completed.total,
      deriveSessionPageSet(rows, { status: "completed" }).length
    );
    const running = await db.sessions.getPage({
      status: "running",
      limit: 100,
    });
    checkFact(
      failures,
      "corpus",
      "agg.page.status_running",
      running.total,
      yaml.sessions_page.running_filter_matches
    );
    const waiting = await db.sessions.getPage({
      status: "waiting",
      limit: 100,
    });
    checkFact(
      failures,
      "corpus",
      "agg.page.status_waiting",
      waiting.total,
      yaml.sessions_page.waiting
    );
    const allFilter = await db.sessions.getPage({ status: "all", limit: 100 });
    checkFact(
      failures,
      "corpus",
      "agg.page.status_all",
      allFilter.total,
      rows.sessions.length
    );

    // Search probes: q over id/name/cwd/model, derived twin as ground truth.
    for (const q of [
      "claude",
      "gpt",
      "symphony",
      rows.sessions[0]!.id.slice(0, 8),
    ]) {
      const got = await db.sessions.getPage({ q, limit: 100 });
      const expected = deriveSessionPageSet(rows, { q });
      checkFact(
        failures,
        "corpus",
        `agg.page.search.${q}`,
        got.sessions.map((s) => s.id),
        expected.slice(0, 100).map((s) => s.id)
      );
      checkFact(
        failures,
        "corpus",
        `agg.page.search_total.${q}`,
        got.total,
        expected.length
      );
    }
    // LIKE-escape: a literal % in q must not act as a wildcard.
    const pct = await db.sessions.getPage({ q: "100%", limit: 100 });
    checkFact(
      failures,
      "corpus",
      "agg.page.search_escape_pct",
      pct.sessions.map((s) => s.id),
      deriveSessionPageSet(rows, { q: "100%" })
        .map((s) => s.id)
        .slice(0, 100),
      "literal % must be escaped, not treated as a wildcard"
    );
    // Kanban: one page per requested status column, each equal to the
    // corresponding getPage.
    const kanban = await db.sessions.getKanbanPages(
      ["completed", "running", "waiting"],
      50
    );
    checkFact(
      failures,
      "corpus",
      "agg.page.kanban_columns",
      Object.keys(kanban).sort(),
      ["completed", "running", "waiting"]
    );
    for (const status of ["completed", "running", "waiting"]) {
      const expected = deriveSessionPageSet(rows, { status });
      checkFact(
        failures,
        "corpus",
        `agg.page.kanban.${status}`,
        {
          ids: kanban[status]?.sessions.map((s) => s.id) ?? null,
          total: kanban[status]?.total ?? null,
        },
        { ids: expected.slice(0, 50).map((s) => s.id), total: expected.length }
      );
    }
    assertNoFailures(failures, "sessions getPage");
  });

  // ── Group 8: per-dossier details ───────────────────────────────────────────
  test("golden layer3: getDetailsById per dossier (agents/events/tokens/cost)", async () => {
    const { db, rows } = fx();
    const failures: string[] = [];
    for (const s of rows.sessions) {
      const details = await db.sessions.getDetailsById(s.id);
      if (!details) {
        failures.push(`${s.id}: getDetailsById returned undefined`);
        continue;
      }
      const expected = deriveSessionDetail(rows, s.id);
      checkFact(
        failures,
        { sessionId: s.id },
        "agg.details.counts",
        {
          agents: details.agentCount,
          events: details.eventCount,
          tokens: details.totalTokens,
        },
        {
          agents: expected.agentCount,
          events: expected.eventCount,
          tokens: expected.totalTokens,
        }
      );
      const expectedCost = expected.costUsdEstimated;
      const actualCost = details.estimatedCostUsd;
      const costOk =
        (expectedCost === null &&
          (actualCost === undefined || actualCost === 0)) ||
        (expectedCost !== null &&
          typeof actualCost === "number" &&
          Math.abs(actualCost - expectedCost) < 1e-9);
      checkFact(
        failures,
        { sessionId: s.id },
        "agg.details.cost",
        costOk,
        true,
        `estimatedCostUsd=${String(actualCost)} vs sessions.cost_usd_estimated=${String(expectedCost)}`
      );
    }
    assertNoFailures(failures, "getDetailsById");
  });

  // ── Group 9: branch-reads ──────────────────────────────────────────────────
  test("golden layer3: branch-reads link rows, keys, PR rows, token aggregates", async () => {
    const { db, rows, yaml, refIso } = fx();
    const failures: string[] = [];
    const prisma = db.prisma;
    const keyRows = await readDistinctBranchKeyRows(prisma);
    const linkRows = await readLocalBranchLinkRows(prisma);
    checkBranchKeyFacts(failures, rows, yaml, keyRows, linkRows);
    await checkBranchPrFacts(failures, rows, yaml, prisma, refIso);
    const aggregateRows = await readBranchTokenAggregateRows(prisma);
    checkBranchAggregateFacts(failures, rows, aggregateRows);
    await checkBranchScopedFacts(
      failures,
      prisma,
      keyRows,
      linkRows,
      aggregateRows
    );
    assertNoFailures(failures, "branch-reads");
  });

  // ── Group 10: countSqliteSessions ──────────────────────────────────────────
  test("golden layer3: countSqliteSessions bare and with clause", async () => {
    const { db, rows } = fx();
    const bare = await countSqliteSessions(db.prisma.client);
    assert.equal(bare, rows.sessions.length);
    const clause = await countSqliteSessions(
      db.prisma.client,
      "WHERE s.status = $1",
      ["completed"]
    );
    assert.equal(
      clause,
      rows.sessions.filter((s) => s.status === "completed").length
    );
  });

  // ── Group 11: session-trace (pure fns over store rows, 2 dossiers) ─────────
  test("golden layer3: session-trace timeline derivation", () => {
    const { rows } = fx();
    const failures: string[] = [];
    for (const sid of [
      "f7441d99-e443-4e2e-8a24-8f981e1b49ed",
      "019effc3-89fc-7942-abd3-fdfa697da89e",
    ]) {
      const session = rows.sessions.find((s) => s.id === sid);
      if (!session) {
        failures.push(`${sid}: session missing from seeded store`);
        continue;
      }
      const events = rows.events
        .filter((e) => e.session_id === sid)
        .map((e) => ({
          event_type: e.event_type,
          tool_name: e.tool_name,
          created_at: e.created_at ?? "",
          summary: e.summary,
        }));
      let meta: Record<string, unknown> | null = null;
      let expectedMessages = 0;
      try {
        meta = JSON.parse(session.metadata ?? "null") as Record<
          string,
          unknown
        > | null;
        const messages = Array.isArray(meta?.messages) ? meta.messages : [];
        expectedMessages = messages.filter((m) => {
          const rec = m as { role?: unknown; timestamp?: unknown };
          return (
            typeof rec.role === "string" && typeof rec.timestamp === "string"
          );
        }).length;
      } catch {
        failures.push(`${sid}: session metadata is not JSON`);
      }
      const timeline = buildTraceTimelineRows(meta, events as never);
      // Timeline rows must be sorted non-decreasing by createdAt.
      for (let i = 1; i < timeline.length; i++) {
        const a = timeline[i - 1]?.createdAt;
        const b = timeline[i]?.createdAt;
        if (typeof a === "string" && typeof b === "string" && b < a) {
          failures.push(`${sid}: timeline out of order at index ${i}`);
          break;
        }
      }
      // Message rows == metadata messages carrying a role + timestamp (any
      // role: traceMessageEventType maps human/assistant/other explicitly).
      const MESSAGE_TYPES = new Set([
        "UserMessage",
        "AssistantMessage",
        "SystemMessage",
      ]);
      const messageRows = timeline.filter(
        (r) => MESSAGE_TYPES.has(r.eventType) && r.toolName === null
      ).length;
      checkFact(
        failures,
        { sessionId: sid },
        "agg.trace.timeline_message_rows",
        messageRows,
        expectedMessages
      );
      checkFact(
        failures,
        { sessionId: sid },
        "agg.trace.timeline_total_rows",
        timeline.length,
        expectedMessages + events.length
      );
    }
    assertNoFailures(failures, "session-trace");
  });

  // ── Group 12: oracle decomposition (inherited L1 parser bugs) ──────────────
  test("golden layer3: oracle tokens_by_model deltas are all L1-registered", () => {
    const { rows, yaml } = fx();
    const corpus = loadCorpus();
    const failures: string[] = [];
    const store = deriveStoreTokensByModel(rows);
    // The yaml's store view must match the live store exactly.
    checkFact(
      failures,
      "corpus",
      "agg.oracle.store_tokens_by_model_vs_signed",
      Object.fromEntries([...store.entries()].sort()),
      yaml.store_tokens_by_model
    );
    // Every (model, field) where the oracle sum differs from the store sum must
    // decompose into per-dossier deltas each covered by an L1 registry entry.
    for (const [model, oracle] of Object.entries(yaml.oracle.tokens_by_model)) {
      const actual = store.get(model) ?? {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      };
      for (const field of [
        "input",
        "output",
        "cache_read",
        "cache_write",
      ] as const) {
        checkOracleTokenDelta(
          failures,
          corpus,
          model,
          field,
          actual[field] - oracle[field]
        );
      }
    }
    assertNoFailures(failures, "oracle tokens decomposition");
  });

  // ── Group 13: re-aggregation idempotency ───────────────────────────────────
  test("golden layer3: re-aggregation idempotency", async () => {
    const { db, refDate } = fx();
    const failures: string[] = [];
    const runs = async () => ({
      summary: await db.getSummary(),
      tokenAnalytics: await db.dashboard.getTokenAnalytics(refDate),
      delivery: await db.dashboard.getInsights(
        InsightsSection.Delivery,
        InsightsPeriod.Month,
        refDate
      ),
      utilization: await db.dashboard.getInsights(
        InsightsSection.Utilization,
        InsightsPeriod.Month,
        refDate
      ),
      agents: await db.dashboard.getInsights(
        InsightsSection.Agents,
        InsightsPeriod.Month,
        refDate
      ),
      workflow: await db.dashboard.getWorkflowData(refDate),
      core: await db.dashboard.getCoreFeatures(),
    });
    const first = await runs();
    const second = await runs();
    for (const key of Object.keys(first) as (keyof typeof first)[]) {
      if (!isDeepStrictEqual(first[key], second[key])) {
        failures.push(`agg.idempotency.${key}: two identical runs disagree`);
      }
    }
    assertNoFailures(failures, "re-aggregation idempotency");
  });

  // ── Group 14: registry sweep (registered LAST) ─────────────────────────────
  test("every registered layer3 divergence was exercised", () => {
    const { rows } = fx();
    const present = new Set(rows.sessions.map((s) => s.id));
    for (const entry of LAYER3_KNOWN_DIVERGENCES) {
      const sid = scopeSessionId(entry.scope);
      if (sid !== null && !present.has(sid)) {
        continue; // inert entry for a dossier arriving via another PR
      }
      assert.ok(
        firedL3.has(l3Key(entry.scope, entry.key)),
        `L3 divergence ${l3Key(entry.scope, entry.key)} (${entry.ticket}) never fired — ` +
          "stale key path or the aggregation stopped producing it; remove or fix the entry"
      );
    }
  });
}
