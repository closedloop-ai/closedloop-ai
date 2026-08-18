/**
 * FEA-2650 Layer 4 — chart semantic contracts.
 *
 * TWO-DB DESIGN:
 *   1. CORPUS DB: all 21 non-null golden dossiers imported via the same shared-DB
 *      recipe as L2 (golden-layer2.ts:1960), queried with the L4 corpus clock.
 *      Asserts timezone lockstep (SQL bucket keys == JS formatLocalDayKey), KPI
 *      total TZ-invariance, query-shape contracts (gap-filled zero points, cells
 *      sorted, cells[].day ⊆ days[], empty-window structural validity), corpus-wide
 *      conservation sweeps, and freezes render-aggregates to a fixture consumed by
 *      the packages/app vitest lane.
 *   2. SYNTHETIC EDGE DB: purpose-built sessions at DST and cross-midnight instants,
 *      queried at three injected nows under BOTH TZ pins (via the paired entrypoint
 *      files). Asserts HARDCODED per-TZ bucket key expectations and autonomy ratio
 *      semantics. The expected keys are human-derived oracle literals.
 *
 * L3 BOUNDARY: corpus-expectations.yaml and point-by-point aggregation numbers
 * belong to FEA-2649. The Layer 3 dual-TZ suites prove the query outputs against
 * that signed oracle; this suite consumes those proven aggregates and adds the
 * render/display contracts without duplicating the Layer 3 assertions.
 *
 * DIVERGENCE REGISTRY: golden-layer4-divergences.ts, `render.*` key namespace.
 * Same three-way self-guard as L1/L2: stops-reproducing fails, third-value
 * fails, unexercised-entry fails.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import type { NormalizedSession } from "../../src/main/collectors/types.js";
import { formatLocalDayKey } from "../../src/main/database/db-helpers.js";
import {
  excludeNonDeliveryOnlyArtifacts,
  resolveNonDeliveryOnlyArtifactIds,
} from "../../src/main/database/non-delivery-artifacts.js";
import { openTestDb } from "../agent-db-test-utils.js";
import { makeSession } from "../normalized-session-test-utils.js";
import { discoverDossiers } from "./golden-corpus.js";
import { type Layer2Input, loadLayer2Input } from "./golden-layer2-input.js";
import { assertRenderAggregatesFreeze } from "./golden-layer4-authority-support.js";
import { LAYER4_KNOWN_DIVERGENCES } from "./golden-layer4-divergences.js";
import {
  assertCompleteSyntheticCellMap,
  assertHeatmapCells,
  assertTzLockstepHeatmap,
  buildExpectedCellMap,
  type HeatmapExpectation,
} from "./golden-layer4-heatmap-support.js";

const WRITE_SNAPSHOTS = process.env.GOLDEN_L4_WRITE_SNAPSHOTS === "1";
const TICKET_ID = /^(?:FEA|ISS)-\d+$/;

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/app/insights/__tests__/fixtures/golden-render-aggregates.json"
);

// ── Session IDs ──────────────────────────────────────────────────────────────

const CROSS_MIDNIGHT_SESSION_ID = "golden-l4-edge-cross-midnight";
const DST_SPRING_SESSION_ID = "golden-l4-edge-dst-spring";
const DST_FALL_SESSION_ID = "golden-l4-edge-dst-fall";
const AUTONOMY_AGENT_SESSION_ID = "golden-l4-edge-autonomy";
const AUTONOMY_HUMAN_SESSION_ID = "golden-l4-edge-human-only";
const AUTONOMY_MIXED_SESSION_ID = "golden-l4-edge-mixed";

/** Sentinel sessionId for corpus-wide divergence entries (not tied to a single
 * dossier). Mirrors L2's ALWAYS_PRESENT_FIXTURE_IDS pattern — the sweep treats
 * entries with this sessionId as always-present regardless of corpus content. */
const CORPUS_SENTINEL = "golden-l4-corpus";

// ── Edge expectations type ────────────────────────────────────────────────────

type AutonomyExpectation = {
  agentOnlyDay: string;
  agentOnlyValue: number;
  humanOnlyDay: string;
  humanOnlyValue: number;
  mixedDay: string;
  mixedValue: number;
  noActivityDay: string;
  noActivityValue: number | null;
};

type EdgeExpectations = {
  tz: string;
  crossMidnight: HeatmapExpectation;
  dstSpring: HeatmapExpectation[];
  dstFall: HeatmapExpectation[];
  autonomy: AutonomyExpectation;
  springWindowCells: HeatmapExpectation[];
  juneWindowCells: HeatmapExpectation[];
  fallWindowCells: HeatmapExpectation[];
};

type NamedSeries = {
  name: string;
  series:
    | { points: Array<{ date: string; values: Record<string, number | null> }> }
    | undefined;
};

// ── Assertion helpers ─────────────────────────────────────────────────────────

function assertAutonomyDay(
  label: string,
  points: Array<{ date: string; values: Record<string, number | null> }>,
  day: string,
  expected: number | null,
  failures: string[]
): void {
  const point = points.find((p) => p.date === day);
  if (!point) {
    failures.push(`autonomy: ${label} day ${day} not in trend`);
  } else if (point.values.autonomy !== expected) {
    failures.push(
      `autonomy: ${label} day expected ${expected}, got ${point.values.autonomy}`
    );
  }
}

function assertModelUsagePerDaySumConservation(
  points: Array<{ date: string; values: Record<string, number | null> }>,
  expectedDayCosts: Map<string, { rawSum: number }>,
  failures: string[]
): void {
  const dayFailures: string[] = [];
  for (const point of points) {
    // A `null` point value is "no data for this model on this day"; it
    // contributes nothing to the day's spend. (JS already coerced `null` to 0
    // through `+`/`* 100` — this states it instead of relying on the coercion.)
    const chartSum = Object.values(point.values).reduce<number>(
      (s, v) => s + (v ?? 0),
      0
    );
    const chartCents = Object.values(point.values).reduce<number>(
      (sum, value) => sum + usdCents(value ?? 0),
      0
    );
    const expected = expectedDayCosts.get(point.date);
    if (!expected && chartCents === 0) {
      continue;
    }
    if (!expected) {
      dayFailures.push(
        `day ${point.date}: chart sum ${chartSum.toFixed(4)} but no source rows`
      );
      continue;
    }
    const expectedCents = usdCents(expected.rawSum);
    if (chartCents !== expectedCents) {
      dayFailures.push(
        `day ${point.date}: displayed parts=${chartCents}¢ but once-rounded source=${expectedCents}¢ ` +
          `(chart=${chartSum.toFixed(4)}, source=${expected.rawSum.toFixed(4)})`
      );
    }
  }
  if (dayFailures.length > 0) {
    failures.push(
      `TZ lockstep modelUsageOverTime per-day SUM conservation (FEA-3241):\n    ${dayFailures.join("\n    ")}`
    );
  }
}

function assertTzLockstepModelUsage(
  modelOverTime:
    | { points: Array<{ date: string; values: Record<string, number | null> }> }
    | undefined,
  expectedModelDays: Set<string>,
  expectedDayCosts: Map<string, { rawSum: number }>,
  failures: string[]
): void {
  if (!modelOverTime) {
    return;
  }
  const actualModelDays = new Set<string>();
  for (const point of modelOverTime.points) {
    if (Object.values(point.values).some((value) => value !== 0)) {
      actualModelDays.add(point.date);
    }
  }
  if (!isDeepStrictEqual(actualModelDays, expectedModelDays)) {
    failures.push(
      "TZ lockstep modelUsageOverTime: nonzero day keys differ — " +
        `SQL=${JSON.stringify([...actualModelDays].sort())} JS=${JSON.stringify([...expectedModelDays].sort())}`
    );
  }

  // FEA-3241: per-day SUM conservation
  assertModelUsagePerDaySumConservation(
    modelOverTime.points,
    expectedDayCosts,
    failures
  );
}

function deriveModelDayExpectations(
  rows: Array<{ started_at: string; model: string; cost: number }>
): {
  expectedModelDays: Set<string>;
  expectedDayCosts: Map<string, { rawSum: number }>;
} {
  const expectedModelDays = new Set<string>();
  const expectedDayCosts = new Map<string, { rawSum: number }>();
  for (const row of rows) {
    const day = formatLocalDayKey(new Date(row.started_at));
    if (row.cost !== 0) {
      expectedModelDays.add(day);
    }
    const existing = expectedDayCosts.get(day) ?? { rawSum: 0 };
    existing.rawSum += row.cost;
    expectedDayCosts.set(day, existing);
  }
  return { expectedModelDays, expectedDayCosts };
}

function derivePrDayKeys(rows: Array<{ ts: string }>): Set<string> {
  const days = new Set<string>();
  for (const row of rows) {
    if (row.ts) {
      days.add(formatLocalDayKey(new Date(row.ts)));
    }
  }
  return days;
}

function collectNonzeroPrDays(
  points: Array<{ date: string; values: Record<string, number | null> }>
): Set<string> {
  const days = new Set<string>();
  for (const point of points) {
    if ((point.values.merged ?? 0) > 0) {
      days.add(point.date);
    }
  }
  return days;
}

function assertTzLockstepPrTrend(
  actualPrDays: Set<string>,
  expectedPrDays: Set<string>,
  failures: string[]
): void {
  if (!isDeepStrictEqual(actualPrDays, expectedPrDays)) {
    failures.push(
      "TZ lockstep prTrend: nonzero merged day keys differ — " +
        `SQL=${JSON.stringify([...actualPrDays].sort())} JS=${JSON.stringify([...expectedPrDays].sort())}`
    );
  }
}

function assertTokenConservation(
  tokensKpi: { key: string; value: number | string | null } | undefined,
  tokenDist: Array<{ key: string; value: number }>,
  failures: string[]
): void {
  const inputDist = tokenDist.find((b) => b.key === "input")?.value ?? 0;
  const outputDist = tokenDist.find((b) => b.key === "output")?.value ?? 0;
  if (
    tokensKpi &&
    typeof tokensKpi.value === "number" &&
    inputDist + outputDist !== tokensKpi.value
  ) {
    failures.push(
      `conservation tokenDistribution: input(${inputDist}) + output(${outputDist}) != kpi:tokens(${tokensKpi.value})`
    );
  }
}

function isInvalidPointValue(value: unknown): boolean {
  return value !== null && (typeof value !== "number" || Number.isNaN(value));
}

function assertSeriesNoNaN(allSeries: NamedSeries[], failures: string[]): void {
  for (const { name, series } of allSeries) {
    if (!series) {
      continue;
    }
    for (const point of series.points) {
      for (const [key, value] of Object.entries(point.values)) {
        if (isInvalidPointValue(value)) {
          failures.push(
            `query shape: ${name} point ${point.date} key "${key}" is ${value} (expected number or null, not NaN)`
          );
        }
      }
    }
  }
}

function assertConservationPrTrend(
  prTrend: {
    points: Array<{ date: string; values: Record<string, number | null> }>;
  },
  failures: string[]
): void {
  for (const point of prTrend.points) {
    const agent = point.values.agent ?? 0;
    const manual = point.values.manual ?? 0;
    const merged = point.values.merged ?? 0;
    if (agent + manual !== merged) {
      failures.push(
        `conservation prTrend: day ${point.date} agent(${agent}) + manual(${manual}) != merged(${merged})`
      );
    }
  }
}

function assertConservationModelBreakdown(
  costKpi: { key: string; value: number | string | null } | undefined,
  modelBreakdown: Array<{ value: number }>,
  failures: string[]
): void {
  if (!costKpi || typeof costKpi.value !== "number") {
    return;
  }
  const breakdownCents = modelBreakdown.reduce(
    (sum, bucket) => sum + usdCents(bucket.value),
    0
  );
  const totalCents = usdCents(costKpi.value);
  if (breakdownCents !== totalCents) {
    failures.push(
      `conservation modelBreakdown: displayed parts=${breakdownCents}¢ ` +
        `but once-rounded kpi:cost=${totalCents}¢ (raw ${costKpi.value})`
    );
  }
}

function walkForNaN(value: unknown, path: string, failures: string[]): void {
  if (typeof value === "number" && Number.isNaN(value)) {
    failures.push(`NaN found at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkForNaN(value[i], `${path}[${i}]`, failures);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      walkForNaN(v, `${path}.${k}`, failures);
    }
  }
}

type KpiInvariantScalars = {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  capturedPrs: number;
};

function assertKpiTzInvariance(
  responses: {
    agents: AgentsInsightsResponse;
    utilization: UtilizationInsightsResponse;
    delivery: DeliveryInsightsResponse;
  },
  src: KpiInvariantScalars,
  failures: string[]
): void {
  const { agents, utilization, delivery } = responses;

  // Layer 3 signed owner: windows["90"].sessions.
  const sessionsKpi = utilization.kpis.find((k) => k.key === "sessions");
  if (sessionsKpi?.value !== src.sessions) {
    failures.push(
      `kpi:sessions TZ-invariance: got ${sessionsKpi?.value}, expected ${src.sessions}`
    );
  }

  // Layer 3 signed owner: windows["90"].usage_totals.input.
  const inputTokensKpi = agents.kpis.find((k) => k.key === "input-tokens");
  if (
    typeof inputTokensKpi?.value !== "number" ||
    inputTokensKpi.value !== src.inputTokens
  ) {
    failures.push(
      `kpi:input-tokens TZ-invariance: got ${inputTokensKpi?.value}, expected ${src.inputTokens}`
    );
  }

  // Layer 3 signed owner: windows["90"].usage_totals.output.
  const outputTokensKpi = agents.kpis.find((k) => k.key === "output-tokens");
  if (
    typeof outputTokensKpi?.value !== "number" ||
    outputTokensKpi.value !== src.outputTokens
  ) {
    failures.push(
      `kpi:output-tokens TZ-invariance: got ${outputTokensKpi?.value}, expected ${src.outputTokens}`
    );
  }

  // Layer 3 signed owner: windows["90"].cost_usd_store.
  const costKpi = delivery.kpis.find((k) => k.key === "cost");
  if (typeof costKpi?.value === "number") {
    const costDiff = Math.abs(costKpi.value - src.cost);
    if (costDiff > 0.005) {
      failures.push(
        `kpi:cost TZ-invariance: got ${costKpi.value}, expected ${src.cost} (diff ${costDiff.toFixed(6)})`
      );
    }
  } else {
    failures.push(
      `kpi:cost TZ-invariance: value is ${costKpi?.value}, expected number`
    );
  }

  // Layer 3 signed owner: windows["90"].pr_captured.
  const mergedKpi = delivery.kpis.find((k) => k.key === "merged");
  if (mergedKpi?.value !== src.capturedPrs) {
    failures.push(
      `kpi:merged TZ-invariance: got ${mergedKpi?.value}, expected ${src.capturedPrs}`
    );
  }
}

function assertEmptyWindowShape(
  emptyAgents: AgentsInsightsResponse,
  emptyUtilization: UtilizationInsightsResponse,
  emptyDelivery: DeliveryInsightsResponse,
  failures: string[]
): void {
  const allEmptyKpis = [
    ...emptyAgents.kpis,
    ...emptyUtilization.kpis,
    ...emptyDelivery.kpis,
  ];
  for (const k of allEmptyKpis) {
    if (
      k.value !== null &&
      (typeof k.value !== "number" || Number.isNaN(k.value))
    ) {
      failures.push(
        `empty-window kpi ${k.key}: value is ${k.value} (expected number or null, not NaN)`
      );
    }
  }

  const emptySeries: NamedSeries[] = [
    {
      name: "empty.autonomyTrend",
      series: emptyAgents.charts.autonomyTrend,
    },
    { name: "empty.prTrend", series: emptyDelivery.charts.prTrend },
    {
      name: "empty.eventActivity",
      series: emptyUtilization.charts.eventActivity,
    },
  ];
  for (const { name, series } of emptySeries) {
    if (!series) {
      continue;
    }
    if (series.points.length === 0) {
      failures.push(
        `${name}: gap-filled series should have at least one point even on empty window`
      );
      continue;
    }
    for (const point of series.points) {
      for (const [key, value] of Object.entries(point.values)) {
        if (isInvalidPointValue(value)) {
          failures.push(
            `${name}: point ${point.date} key "${key}" is ${value}`
          );
        }
      }
    }
  }

  walkForNaN(emptyAgents, "emptyAgents", failures);
  walkForNaN(emptyUtilization, "emptyUtilization", failures);
  walkForNaN(emptyDelivery, "emptyDelivery", failures);
}

// ── Divergence tracking ───────────────────────────────────────────────────────

const firedLayer4Divergences = new Set<string>();

// ── Suite registration ────────────────────────────────────────────────────────

export function registerGoldenLayer4Suite(opts: {
  tz: string;
  edgeExpectations: EdgeExpectations;
}): void {
  const { tz, edgeExpectations } = opts;

  if (WRITE_SNAPSHOTS && tz !== "UTC") {
    throw new Error(
      "GOLDEN_L4_WRITE_SNAPSHOTS=1 is only permitted under TZ=UTC — the UTC " +
        "and America/Chicago suites run as concurrent child processes and must " +
        "never race the same fixture file. Regenerate via the UTC suite only."
    );
  }

  const period = InsightsPeriod.Quarter;

  // ── CORPUS DB ─────────────────────────────────────────────────────────────

  test("layer4 divergence registry is well-formed", () => {
    const seen = new Set<string>();
    for (const d of LAYER4_KNOWN_DIVERGENCES) {
      assert.match(
        d.ticket,
        TICKET_ID,
        `L4 divergence ${d.sessionId}:${d.key} must cite a FEA ticket`
      );
      const dup = `${d.sessionId} ${d.key}`;
      assert.ok(!seen.has(dup), `duplicate L4 divergence entry ${dup}`);
      seen.add(dup);
      assert.ok(
        d.key.startsWith("render."),
        `L4 divergence ${dup} must use the render.* key namespace`
      );
    }
  });

  test("layer4 corpus: seed, TZ lockstep, conservation, query shape, and render-aggregates freeze", {
    timeout: 600_000,
  }, async () => {
    const dossiers = discoverDossiers();
    const nonNull = dossiers.filter((d) => d.normalized !== null);
    assert.ok(
      nonNull.length >= 21,
      `expected at least 21 non-null dossiers, got ${nonNull.length}`
    );

    const inputs: Array<{ d: (typeof nonNull)[0] } & Layer2Input> = nonNull.map(
      (d) => ({ d, ...loadLayer2Input(d) })
    );
    const corpusNow =
      inputs
        .map((i) => i.nowD)
        .sort()
        .at(-1) ?? "2026-07-01T00:00:00.000Z";
    const corpusNowDate = new Date(corpusNow);

    const dir = mkdtempSync(`${tmpdir()}/golden-l4-corpus-`);
    const db = await openTestDb(dir, { now: () => corpusNow });
    const failures: string[] = [];

    try {
      // Seed all non-null dossiers
      for (const { d, input, harness } of inputs) {
        const result = await db.importer.importSession(input, harness);
        assert.ok(
          !(result.skipped || result.failed) && result.incomplete !== true,
          `${d.sessionId}: corpus import failed/skipped/partial`
        );
      }

      // Query all three sections at InsightsPeriod.Quarter
      const [agents, utilization, delivery] = await Promise.all([
        db.dashboard.getInsights(
          InsightsSection.Agents,
          period,
          corpusNowDate
        ) as Promise<AgentsInsightsResponse>,
        db.dashboard.getInsights(
          InsightsSection.Utilization,
          period,
          corpusNowDate
        ) as Promise<UtilizationInsightsResponse>,
        db.dashboard.getInsights(
          InsightsSection.Delivery,
          period,
          corpusNowDate
        ) as Promise<DeliveryInsightsResponse>,
      ]);

      // ── TZ LOCKSTEP: SQL bucket keys == JS formatLocalDayKey(instant) ──

      // (a) Heatmap: read every session_turn_bucket row whose parent session
      // falls in the query window, derive (day, hour, kind)→count in JS from
      // the same UTC instants using formatLocalDayKey + Date.getHours under
      // the pinned process TZ, and deep-equal against the activityHeatmap cells.
      const windowStart = new Date(
        corpusNowDate.getTime() - 90 * 86_400_000
      ).toISOString();
      const turnBuckets = await db.prisma.client.$queryRawUnsafe<
        { ts: string; turn_kind: string; turn_count: number | bigint }[]
      >(
        `SELECT b.ts, b.turn_kind, b.turn_count
         FROM session_turn_bucket b
         JOIN sessions s ON s.id = b.session_id
         WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN $1 AND $2`,
        windowStart,
        corpusNow
      );

      const expectedCellMap = buildExpectedCellMap(turnBuckets);
      assertTzLockstepHeatmap(
        utilization.charts.activityHeatmap,
        expectedCellMap,
        failures
      );

      // (b) Model spend: for each token_usage row, derive the expected local
      // day from sessions.started_at via formatLocalDayKey; assert the set of
      // day keys with nonzero values in modelUsageOverTime matches AND per-day
      // displayed cents conserve exactly to the once-rounded source total.
      const tokenUsageRows = await db.prisma.client.$queryRawUnsafe<
        { started_at: string; model: string; cost: number }[]
      >(
        `SELECT s.started_at, t.model, COALESCE(SUM(t.cost_usd_estimated), 0) AS cost
         FROM token_usage t
         JOIN sessions s ON s.id = t.session_id
         WHERE s.started_at BETWEEN $1 AND $2 AND t.model IS NOT NULL
         GROUP BY s.started_at, t.model`,
        windowStart,
        corpusNow
      );
      const { expectedModelDays, expectedDayCosts } =
        deriveModelDayExpectations(tokenUsageRows);
      assertTzLockstepModelUsage(
        agents.charts.modelUsageOverTime,
        expectedModelDays,
        expectedDayCosts,
        failures
      );

      // (c) prTrend: derive expected nonzero-merged day keys from PR artifact
      // COALESCE(observed_at, created_at) via formatLocalDayKey.
      // ISS-5936: one gate resolve, rendered into both statements below.
      const gateIds = await resolveNonDeliveryOnlyArtifactIds(db.prisma.client);
      const prDays = await db.prisma.client.$queryRawUnsafe<{ ts: string }[]>(
        `SELECT COALESCE(observed_at, created_at) AS ts
         FROM artifacts
         WHERE kind = 'pull_request'
           -- ISS-5764: the same delivery population the prTrend chart draws
           -- from — a prose-mention-only PR is not part of it.
           AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", gateIds)}
           AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2`,
        windowStart,
        corpusNow
      );
      const expectedPrDays = derivePrDayKeys(prDays);
      assertTzLockstepPrTrend(
        collectNonzeroPrDays(delivery.charts.prTrend.points),
        expectedPrDays,
        failures
      );

      // KPI totals: TZ-invariant source-derived scalars. These SQL queries
      // use the UTC window directly (no localDay bucketing) so their results
      // are identical regardless of process TZ. Asserting KPI values match
      // these in BOTH TZ suites proves TZ-invariance.
      const [
        expectedSessionCount,
        expectedTokens,
        expectedCost,
        expectedCapturedPrs,
      ] = await Promise.all([
        db.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT COUNT(*) AS n FROM sessions
           WHERE started_at IS NOT NULL AND started_at BETWEEN $1 AND $2`,
          windowStart,
          corpusNow
        ),
        db.prisma.client.$queryRawUnsafe<
          { input_tokens: bigint; output_tokens: bigint }[]
        >(
          `SELECT COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(t.output_tokens), 0) AS output_tokens
           FROM token_usage t
           JOIN sessions s ON s.id = t.session_id
           WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN $1 AND $2
             AND t.model IS NOT NULL`,
          windowStart,
          corpusNow
        ),
        db.prisma.client.$queryRawUnsafe<{ cost: number }[]>(
          `SELECT COALESCE(SUM(t.cost_usd_estimated), 0) AS cost
           FROM token_usage t
           JOIN sessions s ON s.id = t.session_id
           WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN $1 AND $2`,
          windowStart,
          corpusNow
        ),
        db.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
          // FEA-3585: the delivery "Captured PRs" KPI (key "merged") excludes
          // reviewed-ONLY PRs from the delivery population, so this TZ-invariance
          // owner must apply the SAME exclusion to compare like-for-like — else a
          // reviewed-only PR makes this raw count over-report vs the KPI. Reuses
          // the production gate (non-delivery-artifacts) so the two cannot drift.
          `SELECT COUNT(*) AS n FROM artifacts
           WHERE kind = 'pull_request'
             AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", gateIds)}
             AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2`,
          windowStart,
          corpusNow
        ),
      ]);

      assertKpiTzInvariance(
        {
          agents,
          utilization,
          delivery,
        },
        {
          sessions: Number(expectedSessionCount[0]?.n ?? 0n),
          inputTokens: Number(expectedTokens[0]?.input_tokens ?? 0n),
          outputTokens: Number(expectedTokens[0]?.output_tokens ?? 0n),
          cost: Number(expectedCost[0]?.cost ?? 0),
          capturedPrs: Number(expectedCapturedPrs[0]?.n ?? 0n),
        },
        failures
      );

      // ── QUERY-SHAPE: gap-filled series, no NaN ──────────────────────────

      assertSeriesNoNaN(
        [
          { name: "autonomyTrend", series: agents.charts.autonomyTrend },
          { name: "toolRunsOverTime", series: agents.charts.toolRunsOverTime },
          {
            name: "modelUsageOverTime",
            series: agents.charts.modelUsageOverTime,
          },
          { name: "eventActivity", series: utilization.charts.eventActivity },
          { name: "eventVolume", series: utilization.charts.eventVolume },
          { name: "prTrend", series: delivery.charts.prTrend },
          { name: "klocTrend", series: delivery.charts.klocTrend },
        ],
        failures
      );

      // ── CORPUS-WIDE CONSERVATION SWEEP ──────────────────────────────────

      // prTrend: agent + manual == merged per point
      // (unit owner: local-insights-contract.test.ts:1271)
      assertConservationPrTrend(delivery.charts.prTrend, failures);

      // Σ displayed modelBreakdown cents must equal the once-rounded cost KPI.
      assertConservationModelBreakdown(
        delivery.kpis.find((k) => k.key === "cost"),
        agents.charts.modelBreakdown ?? [],
        failures
      );

      const [expectedToolUsageRows, expectedToolSummary] = await Promise.all([
        db.prisma.client.$queryRawUnsafe<
          { toolName: string; n: number | bigint }[]
        >(
          `SELECT e.tool_name AS toolName, COUNT(*) AS n
           FROM events e
           JOIN sessions s ON s.id = e.session_id
           -- ISS-5493: the oracle restates production's tool-invocation
           -- definition (NOT NULL and non-empty) independently, rather than
           -- importing toolInvocationPredicate — an oracle that shares the
           -- helper could not catch that helper being wrong.
           WHERE e.tool_name IS NOT NULL AND e.tool_name <> ''
             AND s.started_at IS NOT NULL
             AND s.started_at BETWEEN $1 AND $2
           GROUP BY e.tool_name
           ORDER BY n DESC, e.tool_name ASC
           LIMIT 20`,
          windowStart,
          corpusNow
        ),
        db.prisma.client.$queryRawUnsafe<
          { total: number | bigint; distinctTools: number | bigint }[]
        >(
          `SELECT COUNT(*) AS total,
                  COUNT(DISTINCT e.tool_name) AS distinctTools
           FROM events e
           JOIN sessions s ON s.id = e.session_id
           WHERE e.tool_name IS NOT NULL AND e.tool_name <> ''
             AND s.started_at IS NOT NULL
             AND s.started_at BETWEEN $1 AND $2`,
          windowStart,
          corpusNow
        ),
      ]);
      assertToolUsageTop20Contract(
        agents,
        expectedToolUsageRows,
        expectedToolSummary[0],
        failures
      );

      // tokenDistribution: input + output == kpi:tokens. EXACT.
      // kpi:tokens = COALESCE(SUM(t.input_tokens + t.output_tokens), 0)
      // (local-insights.ts:169); tokenDistribution lists input, output,
      // cache-read, cache-write as four separate buckets (line 393-397).
      // The tokens KPI counts input+output ONLY; cache is excluded. So the
      // conservation is: dist.input + dist.output == kpi:tokens.
      assertTokenConservation(
        agents.kpis.find((k) => k.key === "tokens"),
        agents.charts.tokenDistribution ?? [],
        failures
      );

      const snapshot = {
        generatedBy: "FEA-2650-golden-layer4",
        sourceNow: corpusNow,
        sections: { agents, utilization, delivery },
      };

      assertRenderAggregatesFreeze(
        snapshot,
        tz,
        FIXTURE_PATH,
        WRITE_SNAPSHOTS,
        failures,
        firedLayer4Divergences
      );
      for (const entry of LAYER4_KNOWN_DIVERGENCES) {
        if (tz !== "UTC" || entry.sessionId !== CORPUS_SENTINEL) {
          continue;
        }
        assert.ok(
          firedLayer4Divergences.has(`${entry.sessionId} ${entry.key}`),
          `L4 divergence ${entry.sessionId}:${entry.key} (${entry.ticket}) never fired — ` +
            "stale key path or the query stopped producing it; remove or fix the entry"
        );
      }

      // ── EMPTY-WINDOW QUERY SHAPE ────────────────────────────────────────

      // A now far in the future: Quarter = 90 days, so window is [now-90d, now].
      // 200+ days past corpusNow puts no sessions in range.
      const farFutureNow = new Date(
        new Date(corpusNow).getTime() + 250 * 86_400_000
      );
      const [emptyAgents, emptyUtilization, emptyDelivery] = await Promise.all([
        db.dashboard.getInsights(
          InsightsSection.Agents,
          period,
          farFutureNow
        ) as Promise<AgentsInsightsResponse>,
        db.dashboard.getInsights(
          InsightsSection.Utilization,
          period,
          farFutureNow
        ) as Promise<UtilizationInsightsResponse>,
        db.dashboard.getInsights(
          InsightsSection.Delivery,
          period,
          farFutureNow
        ) as Promise<DeliveryInsightsResponse>,
      ]);

      assertEmptyWindowShape(
        emptyAgents,
        emptyUtilization,
        emptyDelivery,
        failures
      );
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }

    assert.ok(
      failures.length === 0,
      `corpus suite: ${failures.length} failure(s):\n  - ${failures.join("\n  - ")}`
    );
  });

  // ── SYNTHETIC EDGE DB ───────────────────────────────────────────────────────

  test("layer4 synthetic edge: TZ bucketing + autonomy semantics", {
    timeout: 300_000,
  }, async () => {
    const dir = mkdtempSync(`${tmpdir()}/golden-l4-edge-`);
    const failures: string[] = [];

    // Cross-midnight session: 2026-06-20T09:00Z start, messages at 10:00Z (human) and 06-21T03:00Z (assistant)
    const crossMidnightSession = makeSession({
      sessionId: CROSS_MIDNIGHT_SESSION_ID,
      entrypoint: "claude",
      startedAt: "2026-06-20T09:00:00.000Z",
      endedAt: "2026-06-21T04:00:00.000Z",
      userMessages: 1,
      assistantMessages: 1,
      messages: [
        { role: "human", timestamp: "2026-06-20T10:00:00.000Z", text: "hello" },
        {
          role: "assistant",
          timestamp: "2026-06-21T03:00:00.000Z",
          text: "hi",
        },
      ],
      // FEA-3597: agent turn buckets derive from `tokenSeries`, not from
      // assistant `messages`, so every synthetic fixture below seeds a token
      // round-trip at the SAME instant as its assistant message. Without this
      // the edge suite would silently lose all agent cells and stop testing the
      // cross-midnight/DST bucketing it exists to pin.
      tokenSeries: agentRoundTripsAt("2026-06-21T03:00:00.000Z"),
    });

    // DST spring-forward session: 2026-03-08T07:00Z start
    const dstSpringSession = makeSession({
      sessionId: DST_SPRING_SESSION_ID,
      entrypoint: "claude",
      startedAt: "2026-03-08T07:00:00.000Z",
      endedAt: "2026-03-08T09:00:00.000Z",
      userMessages: 0,
      assistantMessages: 2,
      messages: [
        { role: "assistant", timestamp: "2026-03-08T07:30:00.000Z", text: "a" },
        { role: "assistant", timestamp: "2026-03-08T08:30:00.000Z", text: "b" },
      ],
      tokenSeries: agentRoundTripsAt(
        "2026-03-08T07:30:00.000Z",
        "2026-03-08T08:30:00.000Z"
      ),
    });

    // DST fall-back session: 2026-11-01T06:00Z start
    const dstFallSession = makeSession({
      sessionId: DST_FALL_SESSION_ID,
      entrypoint: "claude",
      startedAt: "2026-11-01T06:00:00.000Z",
      endedAt: "2026-11-01T08:00:00.000Z",
      userMessages: 0,
      assistantMessages: 2,
      messages: [
        { role: "assistant", timestamp: "2026-11-01T06:30:00.000Z", text: "c" },
        { role: "assistant", timestamp: "2026-11-01T07:30:00.000Z", text: "d" },
      ],
      tokenSeries: agentRoundTripsAt(
        "2026-11-01T06:30:00.000Z",
        "2026-11-01T07:30:00.000Z"
      ),
    });

    // Autonomy: agent-only day (2026-06-18)
    const autonomyAgentSession = makeSession({
      sessionId: AUTONOMY_AGENT_SESSION_ID,
      entrypoint: "claude",
      startedAt: "2026-06-18T08:00:00.000Z",
      endedAt: "2026-06-18T20:00:00.000Z",
      userMessages: 0,
      assistantMessages: 3,
      messages: [
        {
          role: "assistant",
          timestamp: "2026-06-18T09:00:00.000Z",
          text: "a1",
        },
        {
          role: "assistant",
          timestamp: "2026-06-18T10:00:00.000Z",
          text: "a2",
        },
        {
          role: "assistant",
          timestamp: "2026-06-18T11:00:00.000Z",
          text: "a3",
        },
      ],
      tokensByModel: {
        "claude-sonnet-4-5": {
          input: 500,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      tokenSeries: agentRoundTripsAt(
        "2026-06-18T09:00:00.000Z",
        "2026-06-18T10:00:00.000Z",
        "2026-06-18T11:00:00.000Z"
      ),
    });

    // Autonomy: human-only day (2026-06-17)
    const autonomyHumanSession = makeSession({
      sessionId: AUTONOMY_HUMAN_SESSION_ID,
      entrypoint: "claude",
      startedAt: "2026-06-17T08:00:00.000Z",
      endedAt: "2026-06-17T20:00:00.000Z",
      userMessages: 3,
      assistantMessages: 0,
      messages: [
        { role: "human", timestamp: "2026-06-17T09:00:00.000Z", text: "h1" },
        { role: "human", timestamp: "2026-06-17T10:00:00.000Z", text: "h2" },
        { role: "human", timestamp: "2026-06-17T11:00:00.000Z", text: "h3" },
      ],
    });

    // Autonomy: mixed day (2026-06-19) — 1 human + 3 assistant = 75% autonomy
    const autonomyMixedSession = makeSession({
      sessionId: AUTONOMY_MIXED_SESSION_ID,
      entrypoint: "claude",
      startedAt: "2026-06-19T08:00:00.000Z",
      endedAt: "2026-06-19T20:00:00.000Z",
      userMessages: 1,
      assistantMessages: 3,
      messages: [
        { role: "human", timestamp: "2026-06-19T09:00:00.000Z", text: "m1" },
        {
          role: "assistant",
          timestamp: "2026-06-19T10:00:00.000Z",
          text: "m2",
        },
        {
          role: "assistant",
          timestamp: "2026-06-19T11:00:00.000Z",
          text: "m3",
        },
        {
          role: "assistant",
          timestamp: "2026-06-19T12:00:00.000Z",
          text: "m4",
        },
      ],
      tokenSeries: agentRoundTripsAt(
        "2026-06-19T10:00:00.000Z",
        "2026-06-19T11:00:00.000Z",
        "2026-06-19T12:00:00.000Z"
      ),
    });

    const allSessions = [
      crossMidnightSession,
      dstSpringSession,
      dstFallSession,
      autonomyAgentSession,
      autonomyHumanSession,
      autonomyMixedSession,
    ];

    // Seed clock: after all instants
    const seedNow = "2026-11-15T13:00:00.000Z";
    const db = await openTestDb(dir, { now: () => seedNow });

    try {
      for (const session of allSessions) {
        session.fileModifiedAt = null;
        const result = await db.importer.importSession(session, "claude");
        assert.ok(
          !(result.skipped || result.failed) && result.incomplete !== true,
          `${session.sessionId}: edge import failed`
        );
      }

      // Three query windows:
      // 1. Spring DST: now = 2026-03-15T12:00Z, window [2025-12-15T12:00Z..2026-03-15T12:00Z]
      // 2. Cross-midnight + autonomy: now = 2026-06-25T12:00Z, window [2026-03-27T12:00Z..2026-06-25T12:00Z]
      // 3. Fall DST: now = 2026-11-15T12:00Z, window [2026-08-17T12:00Z..2026-11-15T12:00Z]

      const springNow = new Date("2026-03-15T12:00:00.000Z");
      const juneNow = new Date("2026-06-25T12:00:00.000Z");
      const fallNow = new Date("2026-11-15T12:00:00.000Z");

      // Query spring window for heatmap
      const springUtil = (await db.dashboard.getInsights(
        InsightsSection.Utilization,
        period,
        springNow
      )) as UtilizationInsightsResponse;

      // Query June window for cross-midnight + autonomy
      const juneUtil = (await db.dashboard.getInsights(
        InsightsSection.Utilization,
        period,
        juneNow
      )) as UtilizationInsightsResponse;
      const juneAgents = (await db.dashboard.getInsights(
        InsightsSection.Agents,
        period,
        juneNow
      )) as AgentsInsightsResponse;

      // Query fall window for heatmap
      const fallUtil = (await db.dashboard.getInsights(
        InsightsSection.Utilization,
        period,
        fallNow
      )) as UtilizationInsightsResponse;

      // ── HEATMAP BUCKETING assertions ─────────────────────────────────────

      const juneCells = juneUtil.charts.activityHeatmap?.cells ?? [];
      assertHeatmapCells(
        "cross-midnight",
        juneCells,
        [edgeExpectations.crossMidnight],
        failures
      );

      const springCells = springUtil.charts.activityHeatmap?.cells ?? [];
      assertHeatmapCells(
        "DST spring",
        springCells,
        edgeExpectations.dstSpring,
        failures
      );

      const fallCells = fallUtil.charts.activityHeatmap?.cells ?? [];
      assertHeatmapCells(
        "DST fall",
        fallCells,
        edgeExpectations.dstFall,
        failures
      );

      assertCompleteSyntheticCellMap(
        "spring window",
        springCells,
        edgeExpectations.springWindowCells,
        failures
      );
      assertCompleteSyntheticCellMap(
        "june window",
        juneCells,
        edgeExpectations.juneWindowCells,
        failures
      );
      assertCompleteSyntheticCellMap(
        "fall window",
        fallCells,
        edgeExpectations.fallWindowCells,
        failures
      );

      // ── AUTONOMY assertions (June window) ──────────────────────────────

      const autonomy = juneAgents.charts.autonomyTrend;
      assert.ok(autonomy, "autonomyTrend missing from agents response");

      assertAutonomyDay(
        "agent-only",
        autonomy.points,
        edgeExpectations.autonomy.agentOnlyDay,
        edgeExpectations.autonomy.agentOnlyValue,
        failures
      );
      assertAutonomyDay(
        "human-only",
        autonomy.points,
        edgeExpectations.autonomy.humanOnlyDay,
        edgeExpectations.autonomy.humanOnlyValue,
        failures
      );
      assertAutonomyDay(
        "mixed",
        autonomy.points,
        edgeExpectations.autonomy.mixedDay,
        edgeExpectations.autonomy.mixedValue,
        failures
      );

      assertAutonomyDay(
        "no-activity",
        autonomy.points,
        edgeExpectations.autonomy.noActivityDay,
        edgeExpectations.autonomy.noActivityValue,
        failures
      );
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }

    assert.ok(
      failures.length === 0,
      `edge suite: ${failures.length} failure(s):\n  - ${failures.join("\n  - ")}`
    );
  });
}

function assertToolUsageTop20Contract(
  agents: AgentsInsightsResponse,
  sourceRows: Array<{ toolName: string; n: number | bigint }>,
  sourceSummary:
    | { total: number | bigint; distinctTools: number | bigint }
    | undefined,
  failures: string[]
): void {
  const actual = agents.charts.toolUsage ?? [];
  const expected = sourceRows.map((row) => ({
    key: row.toolName,
    label: row.toolName,
    value: Number(row.n),
  }));
  if (!isDeepStrictEqual(actual, expected)) {
    failures.push(
      `toolUsage top-20 contract: response=${JSON.stringify(actual)} source=${JSON.stringify(expected)}`
    );
  }

  const total = Number(sourceSummary?.total ?? 0);
  const distinctTools = Number(sourceSummary?.distinctTools ?? 0);
  const displayedTotal = actual.reduce((sum, row) => sum + row.value, 0);
  const kpiTotal = agents.kpis.find((kpi) => kpi.key === "tool-runs")?.value;
  const seriesTotal =
    agents.charts.toolRunsOverTime?.points.reduce(
      (sum, point) => sum + (point.values["tool-runs"] ?? 0),
      0
    ) ?? 0;

  if (kpiTotal !== total || seriesTotal !== total) {
    failures.push(
      `tool runs total contract: source=${total}, kpi=${String(kpiTotal)}, series=${seriesTotal}`
    );
  }
  if (actual.length > 20) {
    failures.push(
      `toolUsage contains ${actual.length} rows; production cap is 20`
    );
  }

  const omittedRuns = total - displayedTotal;
  if (distinctTools > 20 && omittedRuns <= 0) {
    failures.push(
      `toolUsage top-20 contract: ${distinctTools} distinct tools require a positive omitted tail, got ${omittedRuns}`
    );
  }
  if (distinctTools <= 20 && omittedRuns !== 0) {
    failures.push(
      `toolUsage conservation: ${distinctTools} distinct tools fit within the cap but ${omittedRuns} runs are missing`
    );
  }
}

function usdCents(value: number): number {
  return Math.round(value * 100);
}

/**
 * Build one parent-attributed token round-trip per instant (FEA-3597).
 *
 * Agent turn buckets derive from `tokenSeries` entries attributable to the
 * PARENT — `subagentId` absent — so the synthetic edge fixtures seed a
 * round-trip alongside each assistant message they want to see bucketed. The
 * counts are deliberately uniform and small: these fixtures test TZ/DST bucket
 * placement, not token math, and the aggregates they assert are cell counts.
 */
function agentRoundTripsAt(
  ...timestamps: string[]
): NonNullable<NormalizedSession["tokenSeries"]> {
  return timestamps.map((timestamp) => ({
    timestamp,
    model: "claude-sonnet-4-5",
    input: 500,
    output: 200,
    cacheRead: 0,
    cacheWrite: 0,
  }));
}
