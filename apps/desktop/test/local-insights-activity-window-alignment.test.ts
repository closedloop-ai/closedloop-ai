import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import { test } from "vitest";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

/**
 * ISS-10604 and ISS-10541 — the desktop half of the operator's 2026-09-17
 * ruling: the dashboard's session count, its cost, and the day series under
 * them bound on the Sessions list's last-activity basis rather than disclosing
 * the difference.
 *
 * `STRADDLER` is the whole case. It began four months before the seven-day
 * window and was last active inside it, so it is "active in this window" and is
 * not "started in this window" — the row that put 1,290 on the Sessions page
 * and 1,399 on the Dashboard for what a reader took to be one period.
 *
 * Each case used to be stated twice, once per basis, while
 * `sessions-analytics-activity-window` was default-off. ISS-10541 retired that
 * cohort, so `computeLocalInsights` takes no basis argument and these are the
 * only answers the read has. Handing `resolveRange` the started-at field again
 * fails them back to 1 session, $10, 20 tokens and an empty 06-18 column.
 *
 * TZ is pinned at module evaluation, before any Date is read, because
 * `localDay()` buckets in the process's local zone — the day keys asserted below
 * would otherwise mean something different on a CI box than on a laptop.
 */
process.env.TZ = "UTC";

/** Sunday 2026-06-21, so the seven-day window opens on 2026-06-14. */
const NOW = new Date("2026-06-21T12:00:00.000Z");
/** Comfortably inside the window on both bases. */
const INSIDE = "2026-06-17T09:00:00.000Z";
/** Before the window opens — the straddler's start, and OUTSIDE's whole life. */
const BEFORE = "2026-02-02T09:00:00.000Z";
/** The straddler's last activity: inside the window, on its own day. */
const STRADDLER_LAST_ACTIVITY = "2026-06-18T09:00:00.000Z";
/**
 * The `last_activity_at` NOT NULL default (migration 0005) — "activity not
 * computed yet". Written as a literal, not imported from the module that
 * declares it, so renaming or re-valuing that sentinel reddens here.
 */
const SESSION_EPOCH = "1970-01-01T00:00:00.000Z";

test("ISS-10541: the Sessions KPI counts the straddling session", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-align-kpi-");
  try {
    await seedCorpus(db);

    const aligned = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      InsightsPeriod.Week,
      NOW
    );

    // Two: INSIDE and STRADDLER. The retired started-at basis reported 1, which
    // is the divergence ISS-10541 was filed for, and a read that lost its window
    // would report 3 because OUTSIDE is seeded.
    assert.equal(sessionsKpi(aligned), 2);
  } finally {
    await teardown(prisma, db, dir);
  }
});

test("ISS-10541: the Sessions day series moves with the KPI above it", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-align-day-");
  try {
    await seedCorpus(db);

    const aligned = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      InsightsPeriod.Week,
      NOW
    );

    // The straddler buckets on its LAST-ACTIVITY day, 06-18. Bucketing it on
    // its start day would place it four months outside this chart's own axis:
    // the KPI would count a session the sparkline beneath it cannot draw, which
    // is a tile disagreeing with its own chart. 06-17 is the positive sibling —
    // a series that drew nothing at all would satisfy neither line.
    assert.equal(sessionsOnDay(aligned, "2026-06-18"), 1);
    assert.equal(sessionsOnDay(aligned, "2026-06-17"), 1);
    // A day that IS on the axis and must be empty. `2026-02-02` was asserted
    // here and could not fail: the axis is `eachDay(trendStart, elapsedEnd)` =
    // 06-15..06-21, so February is never a point and `sessionsOnDay` returns
    // `undefined` under every basis. 06-16 is inside the axis and holds nothing,
    // so a read that bucketed its rows onto one day, or lost its window, fills
    // it.
    assert.equal(sessionsOnDay(aligned, "2026-06-16"), 0);
  } finally {
    await teardown(prisma, db, dir);
  }
});

test("ISS-10541: the cost KPI prices the same cohort the session count covers", async () => {
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-align-cost-"
  );
  try {
    await seedCorpus(db);

    const aligned = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      InsightsPeriod.Week,
      NOW
    );

    // $14: INSIDE's $10 plus the straddler's $4, and NOT OUTSIDE's $7 — the
    // started-at basis reported $10 beside a count of 2, and a read that lost
    // its window would report $21.
    assert.equal(costKpi(aligned), 14);
  } finally {
    await teardown(prisma, db, dir);
  }
});

test("ISS-10541: the all-time read counts a start-less row, because the Sessions list does", async () => {
  // `last_activity_at` is NOT NULL with an epoch DEFAULT, so a session with no
  // start and no events sits at epoch — and for an all-time window `startIso` IS
  // epoch, so this basis admits it.
  //
  // It must. `buildListCursorFilterClause` applies no epoch guard either, so
  // excluding it here would make the dashboard drop a row the Sessions list
  // counts — re-opening the split the ruling closed. This case exists so a
  // later "fix" that filters the sentinel has to confront that, instead of
  // quietly re-splitting the two surfaces.
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-align-null-aligned-"
  );
  try {
    await seedCorpus(db);
    await db.query(
      "INSERT INTO sessions (id, status, started_at, last_activity_at) VALUES ($1, $2, NULL, $3)",
      ["no-start", "completed", SESSION_EPOCH]
    );

    const allTime = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      InsightsPeriod.All,
      NOW
    );

    assert.equal(sessionsKpi(allTime), 4);
  } finally {
    await teardown(prisma, db, dir);
  }
});

test("ISS-10541: the Agents section keeps session start, as its cloud twin does", async () => {
  // ISS-10604 pointed this section at the range's field so the Agents tokens and
  // the Agents spend stayed one cohort. That only ever applied on the flag-ON
  // path, and the key was never created in PostHog. Making it the default would
  // have forked the shells: cloud's `token-queries.ts` and `agents-spend.ts` are
  // on `session_started_at`, and ISS-10604's recorded scope names AGENTS-SPEND
  // among the reads its ruling left alone. So the basis here is the analytics
  // one, on both shells, and this case is what catches a drift back.
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-align-agents-"
  );
  try {
    await seedCorpus(db);

    const aligned = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Week,
      NOW
    );

    // 20: INSIDE alone, the only session that STARTED in the window. Pointing
    // this section back at `range.dateWindowField` reads 40 (the straddler
    // joins); losing the window entirely reads 60 (OUTSIDE joins too).
    assert.equal(tokensKpi(aligned), 20);
  } finally {
    await teardown(prisma, db, dir);
  }
});

test("ISS-10541: the model series buckets on the same column its section windows on", async () => {
  // The $ breakdown and the $-over-time series are two halves of ONE chart, so
  // they must share a column whichever column that is. This section is on
  // session start (see the case above), so the straddler is outside it and the
  // series draws only INSIDE.
  const { dir, db, prisma } = await openInsightsDb(
    "local-insights-align-model-series-"
  );
  try {
    await seedCorpus(db);

    const aligned = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      InsightsPeriod.Week,
      NOW
    );

    // INSIDE's $10 on its own day, and nothing on the straddler's last-activity
    // day: the positive sibling is what stops a series that drew nothing from
    // satisfying the zero.
    assert.equal(modelSpendOnDay(aligned, "2026-06-17"), 10);
    assert.equal(modelSpendOnDay(aligned, "2026-06-18"), 0);
  } finally {
    await teardown(prisma, db, dir);
  }
});

async function seedCorpus(
  db: Awaited<ReturnType<typeof openInsightsDb>>["db"]
) {
  const rows: [string, string, string, string, number][] = [
    // id, started_at, last_activity_at, model, cost
    ["inside", INSIDE, INSIDE, "claude-sonnet-4-5", 10],
    ["straddler", BEFORE, STRADDLER_LAST_ACTIVITY, "claude-sonnet-4-5", 4],
    // OUTSIDE the seven-day window on BOTH bases. It is the window-loss
    // detector: every absolute number below is one a read that dropped its date
    // predicate could not produce. The halves this file lost when the cohort
    // was retired carried that property by asserting two bases; it needs a row
    // outside the window, not a second column.
    ["outside", BEFORE, BEFORE, "claude-sonnet-4-5", 7],
  ];
  for (const [id, startedAt, lastActivityAt, model, cost] of rows) {
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $5)",
      [id, "completed", startedAt, lastActivityAt, lastActivityAt]
    );
    await db.query(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, 10, 10, 0, 0, $3)`,
      [id, model, cost]
    );
  }
}

async function teardown(
  prisma: Awaited<ReturnType<typeof openInsightsDb>>["prisma"],
  db: Awaited<ReturnType<typeof openInsightsDb>>["db"],
  dir: string
) {
  await prisma.disconnect();
  await db.close();
  await rm(dir, { recursive: true, force: true });
}

function sessionsKpi(response: { kpis: { key: string; value: unknown }[] }) {
  return response.kpis.find((stat) => stat.key === "sessions")?.value;
}

function costKpi(response: { kpis: { key: string; value: unknown }[] }) {
  return response.kpis.find((stat) => stat.key === "cost")?.value;
}

function tokensKpi(response: { kpis: { key: string; value: unknown }[] }) {
  return response.kpis.find((stat) => stat.key === "tokens")?.value;
}

function modelSpendOnDay(
  response: {
    charts: {
      modelUsageOverTime: {
        points: { date: string; values: Record<string, number | null> }[];
      };
    };
  },
  day: string
) {
  const point = response.charts.modelUsageOverTime.points.find(
    (candidate) => candidate.date === day
  );
  return Object.values(point?.values ?? {}).reduce<number>(
    (total, value) => total + (value ?? 0),
    0
  );
}

function sessionsOnDay(
  response: {
    charts: {
      eventActivity: {
        points: { date: string; values: Record<string, number | null> }[];
      };
    };
  },
  day: string
) {
  return response.charts.eventActivity.points.find(
    (point) => point.date === day
  )?.values.sessions;
}
