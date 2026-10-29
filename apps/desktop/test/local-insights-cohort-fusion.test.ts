/**
 * @file local-insights-cohort-fusion.test.ts
 * @description ISS-6824 — three local-Insights reads that duplicated a scan
 * their own section already performed now ride on the surviving pass, and the
 * numbers they produce are unchanged. (The third, the Delivery prior-window
 * baseline, was retired by ISS-12902: the Captured PRs KPI is unknown, so there
 * is no baseline count to fuse.)
 *
 * The two:
 *  - Agents "Tool runs": was its own `COUNT(*)` over events⋈sessions; now the
 *    `SUM(COUNT(*)) OVER ()` window total on the `toolUsage` breakdown.
 *  - Utilization "Events": was a correlated `COUNT(*)` subquery inside the
 *    sessions `totals` statement; now the same window total on `eventsByType`.
 *
 * WHAT MAKES THESE ASSERTIONS NON-VACUOUS. Both window totals sit on a
 * statement that ends in `LIMIT`, so the tempting wrong implementation — sum the
 * rows the query returned — is right on a small store and wrong on every real
 * one. Each fixture therefore seeds MORE distinct groups than the limit keeps
 * (22 tools against `LIMIT 20`, 14 event types against `LIMIT 12`) and asserts
 * both that the KPI equals the whole population AND that it is strictly greater
 * than the displayed rows sum to. A fixture with one group per cohort would pass
 * either way. The event-type fixture additionally carries an EMPTY-STRING type,
 * which `GROUP BY` keeps as its own bucket and the limit can discard.
 * (`events.event_type` is `NOT NULL` in the shipped DDL, so a NULL bucket is not
 * reachable from this boundary; `tool_name` is nullable and both its NULL and
 * empty-string rows are seeded — they must stay OUT of the tool total, which is
 * what `toolInvocationPredicate` says and what the retired COUNT did.)
 *
 * Own file rather than an addition to `local-insights-contract.test.ts`, which
 * is in the shrink-only grandfather list in `biome.jsonc`.
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  InsightsPeriod,
  InsightsSection,
  KpiDeltaBasis,
} from "@closedloop-ai/loops-api/insights";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterAll, test } from "vitest";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import type { CapturedStatement } from "../src/main/database/prisma-statement-observers.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

// Same timezone pin as the sibling Insights suites: the SQL buckets by
// process-local day, so a fixed non-UTC zone keeps the conversion exercised.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Chicago";

afterAll(() => {
  // Restore EXACTLY: assigning `undefined` would leave the string "undefined".
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
/**
 * EXACTLY the current window's lower bound for `NOW` at `InsightsPeriod.Month`
 * — UTC midnight opening the 30th-from-last UTC day (ISS-10583; it was
 * `NOW - 30d` while the window was a rolling instant). The current window is
 * `BETWEEN start AND end` (closed), so a PR observed at this instant belongs to
 * the CURRENT window; the prior window is half-open and closes one ELAPSED span
 * after its own start, so this instant is in neither both nor the prior one.
 * Post-fusion the prior projection is the SOLE source of the captured-PR delta
 * baseline, so that bound is load-bearing and worth a row.
 */
const WINDOW_LOWER_BOUND = "2026-05-24T00:00:00.000Z";

const IN_SESSION = "fusion-in";
const OUT_SESSION = "fusion-out";
const REPO = "org/repo";

/** Production's `toolUsage` cap — more tools than this are seeded on purpose. */
const TOOL_USAGE_LIMIT = 20;
/** Production's `eventsByType` cap — more types than this are seeded. */
const EVENTS_BY_TYPE_LIMIT = 12;

/**
 * The two tables whose duplicated passes this change removed, matched by BARE
 * TABLE NAME.
 *
 * The acceptance criterion is "execute fewer SQLite operations and scan fewer
 * raw rows", and the assertion for it is a COUNT OF PASSES, deliberately not a
 * text fingerprint of the retired statement. A fingerprint keyed on
 * `JOIN sessions es` or `SELECT COUNT(*) AS n FROM events` goes green the moment
 * someone reintroduces the same duplicate pass under a different alias or line
 * wrap — which is exactly the shape a well-meaning future refactor takes, and
 * the value assertions above cannot catch it because a re-added duplicate
 * produces the identical number. The bare table name is alias- and
 * format-agnostic (`FROM artifacts a` contains `FROM artifacts`), so only
 * genuinely adding or removing a pass moves it.
 *
 * Each caller enumerates the statements its number covers. If a legitimately NEW
 * read of one of these tables lands later, raise the count there and name the
 * statement — do not delete the assertion.
 */
const EVENTS_TABLE = "FROM events";
const ARTIFACTS_TABLE = "FROM artifacts";

type Db = Awaited<ReturnType<typeof openInsightsDb>>["db"];

async function seedSession(
  db: Db,
  id: string,
  startedAt: string
): Promise<void> {
  await db.query(
    "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $3, $3)",
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

/**
 * `tool i` gets `TOOL_RUN_BASE - i` invocations, so the top-20 cut is
 * deterministic (strictly descending counts, no tie for the boundary) and the
 * two omitted tools carry a known, positive tail.
 */
const TOOL_COUNT = 22;
const TOOL_RUN_BASE = 40;
const toolRuns = (index: number) => TOOL_RUN_BASE - index;
const toolName = (index: number) => `tool-${String(index).padStart(2, "0")}`;

/**
 * `type i` gets `EVENT_TYPE_BASE - i` events; the LAST index is the
 * EMPTY-STRING type, so it carries the smallest count and the `LIMIT 12`
 * discards it. It is the bucket a "sum the returned rows" total would silently
 * drop, which is why it must be outside the cut rather than inside it.
 */
const EVENT_TYPE_COUNT = 14;
const EVENT_TYPE_BASE = 30;
const EMPTY_EVENT_TYPE_INDEX = EVENT_TYPE_COUNT - 1;
const eventTypeRuns = (index: number) => EVENT_TYPE_BASE - index;
const eventTypeName = (index: number) =>
  index === EMPTY_EVENT_TYPE_INDEX
    ? ""
    : `type-${String(index).padStart(2, "0")}`;

type SeededPr = {
  id: string;
  observedAt: string;
  /** `[relation, method]` per link. */
  links: readonly (readonly [string, string])[];
};

async function seedPr(db: Db, pr: SeededPr, index: number): Promise<void> {
  await db.query(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, observed_at,
        created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, $5, $5)`,
    [pr.id, `pr:${REPO}:${index}`, REPO, index, pr.observedAt]
  );
  for (const [relation, method] of pr.links) {
    await db.query(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, '{}', 1, $6, $6)`,
      [
        `sal:${pr.id}:${relation}`,
        IN_SESSION,
        pr.id,
        relation,
        method,
        pr.observedAt,
      ]
    );
  }
}

const AUTHORED_LINK = [
  ArtifactRefRelation.Created,
  ArtifactRefMethod.PrCreateOutput,
] as const;

/** Current window: captured PRs, one of them on the window's lower bound. */
const CURRENT_PRS: readonly SeededPr[] = [
  {
    id: "cur-a",
    observedAt: IN_WINDOW,
    links: [AUTHORED_LINK],
  },
  {
    id: "cur-b",
    observedAt: IN_WINDOW,
    links: [AUTHORED_LINK],
  },
  {
    id: "cur-c",
    observedAt: IN_WINDOW,
    links: [AUTHORED_LINK],
  },
  {
    id: "cur-d",
    observedAt: IN_WINDOW,
    links: [],
  },
  {
    id: "cur-boundary",
    observedAt: WINDOW_LOWER_BOUND,
    links: [AUTHORED_LINK],
  },
];

/** Every current-window PR counts, including the one on the window's lower bound. */
const EXPECTED_CURRENT_CAPTURED = CURRENT_PRS.length;
function kpiValue(
  response: { kpis: readonly { key: string; value: number | null }[] },
  key: string
): number | null | undefined {
  return response.kpis.find((entry) => entry.key === key)?.value;
}

function countPassesOver(
  statements: readonly CapturedStatement[],
  table: string
): number {
  return statements.filter((statement) => statement.sql.includes(table)).length;
}

test("ISS-6824: Agents 'Tool runs' totals every tool group, not the 20 the breakdown keeps", async () => {
  const captured: CapturedStatement[] = [];
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-fusion-tools-",
    (statement) => captured.push(statement)
  );
  try {
    await seedSession(db, IN_SESSION, IN_WINDOW);
    await seedSession(db, OUT_SESSION, OUT_OF_WINDOW);
    let eventId = 0;
    for (let tool = 0; tool < TOOL_COUNT; tool++) {
      for (let run = 0; run < toolRuns(tool); run++) {
        await seedEvent(
          db,
          `ev-${eventId++}`,
          IN_SESSION,
          "PreToolUse",
          toolName(tool),
          IN_WINDOW
        );
      }
    }
    // Excluded by `toolInvocationPredicate`: NULL and empty tool names.
    for (let i = 0; i < 5; i++) {
      await seedEvent(
        db,
        `ev-${eventId++}`,
        IN_SESSION,
        "Stop",
        i % 2 === 0 ? null : "",
        IN_WINDOW
      );
    }
    // Excluded by the window: a real tool run on an out-of-window session.
    for (let i = 0; i < 9; i++) {
      await seedEvent(
        db,
        `ev-${eventId++}`,
        OUT_SESSION,
        "PreToolUse",
        toolName(0),
        OUT_OF_WINDOW
      );
    }

    captured.length = 0;
    const agents: AgentsInsightsResponse = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Month,
      NOW
    );

    const expectedTotal = Array.from({ length: TOOL_COUNT }, (_, i) =>
      toolRuns(i)
    ).reduce((sum, runs) => sum + runs, 0);
    const displayed = agents.charts.toolUsage ?? [];
    const displayedTotal = displayed.reduce((sum, row) => sum + row.value, 0);
    const omittedTail = Array.from(
      { length: TOOL_COUNT - TOOL_USAGE_LIMIT },
      (_, i) => toolRuns(TOOL_USAGE_LIMIT + i)
    ).reduce((sum, runs) => sum + runs, 0);

    assert.equal(displayed.length, TOOL_USAGE_LIMIT);
    assert.equal(kpiValue(agents, "tool-runs"), expectedTotal);
    // The whole point: the KPI is NOT what the displayed rows sum to. The
    // fixture puts two tools outside the cut (TOOL_COUNT > TOOL_USAGE_LIMIT), so
    // `omittedTail` is a real, positive number of runs the chart never shows.
    assert.equal(expectedTotal - displayedTotal, omittedTail);
    // The breakdown itself is unchanged — busiest tool first, real counts.
    assert.deepEqual(
      [displayed[0]?.key, displayed[0]?.value],
      [toolName(0), toolRuns(0)]
    );

    // The Agents section now walks `events` TWICE, not three times: the
    // `toolUsage` breakdown that carries this KPI, and `toolRunsOverTime`.
    assert.equal(countPassesOver(captured, EVENTS_TABLE), 2);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/*
 * The zero-population pair below does NOT re-prove the window total — at zero
 * rows the old per-statement COUNT and the new window total both read 0, so
 * these two pass with and against the change. What they DO pin is the row-SHAPE
 * hazard the change introduced: each KPI moved from a statement that always
 * returns exactly one row (`SELECT COUNT(*) …`) to one that can return NONE
 * (`GROUP BY … LIMIT n`). Drop the optional chaining in `toolUsage[0]?.total` /
 * `eventsByType[0]?.total` and only these two go red; every other test in this
 * file has a row at index 0. That is a narrower claim than the tests above, and
 * it is the whole claim.
 */
test("ISS-6824: Agents 'Tool runs' reads 0, not a throw, when the breakdown returns no rows", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-fusion-tools-empty-"
  );
  try {
    await seedSession(db, IN_SESSION, IN_WINDOW);
    await seedEvent(db, "ev-null", IN_SESSION, "Stop", null, IN_WINDOW);
    await seedEvent(db, "ev-blank", IN_SESSION, "Stop", "", IN_WINDOW);

    const agents: AgentsInsightsResponse = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Month,
      NOW
    );
    assert.deepEqual(agents.charts.toolUsage, []);
    assert.equal(kpiValue(agents, "tool-runs"), 0);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-6824: Utilization 'Events' totals every event-type group, including the empty-string one the limit drops", async () => {
  const captured: CapturedStatement[] = [];
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-fusion-events-",
    (statement) => captured.push(statement)
  );
  try {
    await seedSession(db, IN_SESSION, IN_WINDOW);
    await seedSession(db, OUT_SESSION, OUT_OF_WINDOW);
    let eventId = 0;
    for (let type = 0; type < EVENT_TYPE_COUNT; type++) {
      for (let run = 0; run < eventTypeRuns(type); run++) {
        await seedEvent(
          db,
          `ev-${eventId++}`,
          IN_SESSION,
          eventTypeName(type),
          null,
          IN_WINDOW
        );
      }
    }
    for (let i = 0; i < 11; i++) {
      await seedEvent(
        db,
        `ev-${eventId++}`,
        OUT_SESSION,
        "Stop",
        null,
        OUT_OF_WINDOW
      );
    }

    captured.length = 0;
    const utilization: UtilizationInsightsResponse = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      InsightsPeriod.Month,
      NOW
    );

    const expectedTotal = Array.from({ length: EVENT_TYPE_COUNT }, (_, i) =>
      eventTypeRuns(i)
    ).reduce((sum, runs) => sum + runs, 0);
    const displayed = utilization.charts.eventsByType ?? [];
    const displayedTotal = displayed.reduce((sum, row) => sum + row.value, 0);

    assert.equal(displayed.length, EVENTS_BY_TYPE_LIMIT);
    assert.equal(kpiValue(utilization, "events"), expectedTotal);
    assert.ok(expectedTotal - displayedTotal > 0);
    // The empty-string type is a real GROUP BY bucket the LIMIT discarded, and
    // it is still inside the total.
    assert.ok(
      !displayed.some(
        (row) => row.key === eventTypeName(EMPTY_EVENT_TYPE_INDEX)
      )
    );
    assert.ok(
      expectedTotal - displayedTotal >= eventTypeRuns(EMPTY_EVENT_TYPE_INDEX)
    );
    // Dropping the correlated subquery left the sessions aggregates alone.
    assert.equal(kpiValue(utilization, "sessions"), 1);

    // The Utilization section now walks `events` TWICE, not three times: the
    // `eventsByType` breakdown that carries this KPI, and the per-day event
    // volume series. The sessions `totals` statement no longer touches it.
    assert.equal(countPassesOver(captured, EVENTS_TABLE), 2);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-6824: Utilization 'Events' reads 0, not a throw, when the breakdown returns no rows", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-fusion-events-empty-"
  );
  try {
    await seedSession(db, IN_SESSION, IN_WINDOW);

    const utilization: UtilizationInsightsResponse = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      InsightsPeriod.Month,
      NOW
    );
    assert.deepEqual(utilization.charts.eventsByType, []);
    assert.equal(kpiValue(utilization, "events"), 0);
    assert.equal(kpiValue(utilization, "sessions"), 1);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-12902: Delivery 'Captured PRs' is unknown and no prior-window count is scanned", async () => {
  const captured: CapturedStatement[] = [];
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-fusion-prior-",
    (statement) => captured.push(statement)
  );
  try {
    await seedSession(db, IN_SESSION, IN_WINDOW);
    let index = 0;
    for (const pr of CURRENT_PRS) {
      await seedPr(db, pr, index++);
    }

    captured.length = 0;
    const delivery: DeliveryInsightsResponse = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Month,
      NOW
    );

    // Operator ruling (ISS-12902): the captured-PR count is unknown, with no
    // delta. The gated current-window population is still observable through
    // the coverage count, which is taken of the same rows.
    const capturedKpi = delivery.kpis.find((entry) => entry.key === "merged");
    assert.equal(capturedKpi?.value, null);
    // Review thread (tamsinb): `deltaPct` is the wrong thing to pin here. This
    // fixture seeds no session before the prior window, so `reportDelta` returns
    // null for history reasons and a restored `comparableKpi(…, reportDelta(…))`
    // would keep it null. `deltaBasis` is stamped by the constructor, so it says
    // which one the producer chose whatever history is seeded.
    assert.equal(capturedKpi?.deltaBasis, KpiDeltaBasis.NotComputed);
    assert.equal(
      delivery.kpis.find((entry) => entry.key === "capturedPrsScanned")?.value,
      EXPECTED_CURRENT_CAPTURED
    );

    // The Delivery section walks `artifacts` FOUR times: the current-window
    // aggregate, the day trend, the time-to-PR latency ranking and the
    // earliest-record probe.
    assert.equal(countPassesOver(captured, ARTIFACTS_TABLE), 4);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
