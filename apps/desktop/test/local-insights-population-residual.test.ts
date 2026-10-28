/**
 * @file local-insights-population-residual.test.ts
 * @description ISS-9842 — the two capped category breakdowns carry the
 * population they are a prefix of, on every bucket, so the donut that draws
 * them can divide by the whole rather than by the rows that survived the LIMIT.
 *
 * `local-insights-cohort-fusion.test.ts` already pins that the KPI beside each
 * chart equals the whole population and not the displayed rows' sum. This file
 * pins the OTHER field the same window now feeds — `charts.*[i].population` —
 * and the ratio a wedge is drawn with. Kept separate because that suite is
 * 599 lines and asserts a different contract on a different field.
 *
 * Each fixture seeds MORE distinct groups than the LIMIT keeps (25 tools
 * against `LIMIT 20`, 15 event types against `LIMIT 12`), so the counterfactual
 * — divide the top wedge by the returned rows' sum — is a different number
 * from the population ratio, and a mapper that dropped the window columns
 * again would go red on every bucket.
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type {
  AgentsInsightsResponse,
  CategoryBucket,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterAll, test } from "vitest";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = ORIGINAL_TZ;
});

const NOW = new Date("2026-06-22T00:00:00.000Z");
/** Inside the 30-day window. */
const IN_WINDOW = "2026-06-20T10:00:00.000Z";
/** Outside every window this suite queries. */
const OUT_OF_WINDOW = "2025-01-05T10:00:00.000Z";

const IN_SESSION = "population-in";
const OUT_SESSION = "population-out";

/** Production's `toolUsage` cap — more tools than this are seeded on purpose. */
const TOOL_USAGE_LIMIT = 20;
/** Production's `eventsByType` cap — more types than this are seeded. */
const EVENTS_BY_TYPE_LIMIT = 12;

/** `tool i` gets `TOOL_RUN_BASE - i` runs: strictly descending, no boundary tie. */
const TOOL_COUNT = 25;
const TOOL_RUN_BASE = 40;
const toolRuns = (index: number) => TOOL_RUN_BASE - index;
const toolName = (index: number) => `tool-${String(index).padStart(2, "0")}`;

/**
 * `type i` gets `EVENT_TYPE_BASE - i` events; the LAST index is the
 * EMPTY-STRING type, which `GROUP BY` keeps as its own bucket, the LIMIT
 * discards, and the population must still count.
 */
const EVENT_TYPE_COUNT = 15;
const EVENT_TYPE_BASE = 30;
const EMPTY_EVENT_TYPE_INDEX = EVENT_TYPE_COUNT - 1;
const eventTypeRuns = (index: number) => EVENT_TYPE_BASE - index;
const eventTypeName = (index: number) =>
  index === EMPTY_EVENT_TYPE_INDEX
    ? ""
    : `type-${String(index).padStart(2, "0")}`;

type Db = Awaited<ReturnType<typeof openInsightsDb>>["db"];

function sumOf(count: number, runsAt: (index: number) => number): number {
  return Array.from({ length: count }, (_, i) => runsAt(i)).reduce(
    (sum, runs) => sum + runs,
    0
  );
}

function kpiValue(
  response: { kpis: readonly { key: string; value: number | null }[] },
  key: string
): number | null | undefined {
  return response.kpis.find((entry) => entry.key === key)?.value;
}

/** The population each bucket carries, in display order, for one deepEqual. */
function populationsOf(
  buckets: readonly CategoryBucket[]
): (CategoryBucket["population"] | undefined)[] {
  return buckets.map((bucket) => bucket.population);
}

async function seedSession(
  db: Db,
  id: string,
  startedAt: string
): Promise<void> {
  await db.query(
    "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $3)",
    [id, SESSION_STATUS.INACTIVE, startedAt]
  );
  await db.query(
    `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
     VALUES ($1, $2, 0, 0)`,
    [id, startedAt]
  );
}

async function seedEvent(
  db: Db,
  id: string,
  sessionId: string,
  eventType: string,
  toolName: string | null,
  createdAt: string
): Promise<void> {
  await db.query(
    `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, sessionId, eventType, toolName, createdAt]
  );
}

test("ISS-9842: toolUsage buckets carry the whole-population total and category count past LIMIT 20", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-population-tools-"
  );
  try {
    await seedSession(db, IN_SESSION, IN_WINDOW);
    await seedSession(db, OUT_SESSION, OUT_OF_WINDOW);
    for (let tool = 0; tool < TOOL_COUNT; tool++) {
      for (let run = 0; run < toolRuns(tool); run++) {
        await seedEvent(
          db,
          `tool-${tool}-${run}`,
          IN_SESSION,
          "PreToolUse",
          toolName(tool),
          IN_WINDOW
        );
      }
    }
    // Rows the population must NOT count: no tool name, an empty tool name,
    // and a tool run on a session outside the window.
    await seedEvent(db, "ev-null", IN_SESSION, "Stop", null, IN_WINDOW);
    await seedEvent(db, "ev-blank", IN_SESSION, "Stop", "", IN_WINDOW);
    await seedEvent(
      db,
      "ev-out",
      OUT_SESSION,
      "PreToolUse",
      toolName(0),
      OUT_OF_WINDOW
    );

    const agents: AgentsInsightsResponse = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Month,
      NOW
    );
    const displayed = agents.charts.toolUsage ?? [];
    const populationTotal = sumOf(TOOL_COUNT, toolRuns);
    const prefixSum = sumOf(TOOL_USAGE_LIMIT, toolRuns);

    assert.equal(displayed.length, TOOL_USAGE_LIMIT);
    assert.deepEqual(
      populationsOf(displayed),
      displayed.map(() => ({ total: populationTotal, categories: TOOL_COUNT }))
    );
    assert.equal(kpiValue(agents, "tool-runs"), populationTotal);

    // The wedge the ring draws for the busiest tool: its runs over the whole
    // population. The counterfactual — over the rows that survived the LIMIT
    // — is a strictly larger share, which is the overstatement this fixes.
    const top = displayed[0];
    assert.equal(top?.key, toolName(0));
    assert.equal(top?.population?.total, populationTotal);
    assert.ok(prefixSum < populationTotal);
    assert.notEqual(toolRuns(0) / populationTotal, toolRuns(0) / prefixSum);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-9842: eventsByType buckets carry the whole-population total and category count past LIMIT 12", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-population-events-"
  );
  try {
    await seedSession(db, IN_SESSION, IN_WINDOW);
    await seedSession(db, OUT_SESSION, OUT_OF_WINDOW);
    for (let type = 0; type < EVENT_TYPE_COUNT; type++) {
      for (let run = 0; run < eventTypeRuns(type); run++) {
        await seedEvent(
          db,
          `type-${type}-${run}`,
          IN_SESSION,
          eventTypeName(type),
          null,
          IN_WINDOW
        );
      }
    }
    await seedEvent(
      db,
      "ev-out",
      OUT_SESSION,
      eventTypeName(0),
      null,
      OUT_OF_WINDOW
    );

    const utilization: UtilizationInsightsResponse = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      InsightsPeriod.Month,
      NOW
    );
    const displayed = utilization.charts.eventsByType ?? [];
    const populationTotal = sumOf(EVENT_TYPE_COUNT, eventTypeRuns);
    const prefixSum = sumOf(EVENTS_BY_TYPE_LIMIT, eventTypeRuns);

    assert.equal(displayed.length, EVENTS_BY_TYPE_LIMIT);
    // The empty-string type is outside the cut and inside the population.
    assert.ok(!displayed.some((bucket) => bucket.key === ""));
    assert.deepEqual(
      populationsOf(displayed),
      displayed.map(() => ({
        total: populationTotal,
        categories: EVENT_TYPE_COUNT,
      }))
    );
    assert.equal(kpiValue(utilization, "events"), populationTotal);
    assert.ok(prefixSum < populationTotal);
    assert.notEqual(
      eventTypeRuns(0) / populationTotal,
      eventTypeRuns(0) / prefixSum
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-9842: a breakdown with no rows carries no population (nothing to be a prefix of)", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-population-empty-"
  );
  try {
    await seedSession(db, IN_SESSION, IN_WINDOW);
    await seedEvent(db, "ev-null", IN_SESSION, "Stop", null, IN_WINDOW);

    const agents: AgentsInsightsResponse = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Month,
      NOW
    );
    assert.deepEqual(agents.charts.toolUsage, []);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
