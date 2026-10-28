import { rm } from "node:fs/promises";
import {
  InsightsPeriod,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import {
  PARITY_ELAPSED_END_ISO,
  PARITY_FUTURE_LAST_ACTIVITY_ISO,
  PARITY_NEXT_UTC_DAY_NOW_ISO,
  PARITY_NEXT_UTC_DAY_WINDOW,
  PARITY_NOW_ISO,
  PARITY_PRIOR_WINDOW,
  PARITY_WINDOW_BY_DAYS,
  PARITY_WINDOW_DAYS,
} from "@closedloop-ai/loops-api/test-fixtures/stable-utc-window-parity";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  type DashboardDateRange,
  INSIGHTS_DASHBOARD_TIMEZONE_MODE,
  RANGE_TO_PERIOD,
} from "@repo/app/insights/lib/dashboard-range";
import { getStableDateWindowForRange } from "@repo/app/shared/lib/format-utils";
import { describe, expect, it } from "vitest";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { resolveRange } from "../src/main/database/local-insights-range.js";
import { buildListCursorFilterClause } from "../src/main/database/session-aggregate-filters.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

/**
 * ISS-10583 — the desktop half of the cross-surface window parity pair. Its
 * cloud twin is `apps/api/app/insights/service/period-sessions-window-parity.test.ts`,
 * and both assert the SAME shared table, so a change to one resolver cannot be
 * made green by editing the expectation sitting beside it.
 *
 * This half carries the Sessions helper as well, because it is the shell that
 * can see both: `apps/api` does not depend on `@repo/app`.
 */
const NOW = new Date(PARITY_NOW_ISO);

const RANGE_BY_DAYS: Record<number, DashboardDateRange> = {
  7: "7d",
  30: "30d",
  90: "90d",
};

describe("insights and Sessions resolve one window (ISS-10583)", () => {
  it.each(PARITY_WINDOW_DAYS)(
    "the Sessions surface window for %s days is the shared written-out window",
    (days) => {
      expect(
        getStableDateWindowForRange(
          RANGE_BY_DAYS[days],
          INSIGHTS_DASHBOARD_TIMEZONE_MODE,
          NOW
        )
      ).toEqual(PARITY_WINDOW_BY_DAYS[days]);
    }
  );

  it.each(PARITY_WINDOW_DAYS)(
    "the desktop-local insights window for %s days is the same shared window",
    (days) => {
      const resolved = resolveRange(RANGE_TO_PERIOD[RANGE_BY_DAYS[days]], NOW);
      expect({
        startDate: resolved.startIso,
        endDate: resolved.endIso,
      }).toEqual(PARITY_WINDOW_BY_DAYS[days]);
    }
  );

  it("the all-time insights window opens at the epoch and closes with the same UTC day", () => {
    const resolved = resolveRange(RANGE_TO_PERIOD.all, NOW);
    expect(resolved.startIso).toBe("1970-01-01T00:00:00.000Z");
    expect(resolved.endIso).toBe(PARITY_WINDOW_BY_DAYS[7].endDate);
  });

  it("the Sessions helper declines to bound the all-time range at all", () => {
    // Deliberately NOT the insights answer, and the difference is not a
    // divergence: an absent bound and an epoch bound admit the same rows, and
    // the list surface omits the filter rather than sending a 56-year window.
    expect(
      getStableDateWindowForRange("all", INSIGHTS_DASHBOARD_TIMEZONE_MODE, NOW)
    ).toEqual({});
  });

  it.each(["7d", "30d", "90d", "all"] as const)(
    "the insights Sessions-list window for %s is the Sessions helper's own window (ISS-12263)",
    (range) => {
      expect(resolveRange(RANGE_TO_PERIOD[range], NOW).sessionsWindow).toEqual(
        getStableDateWindowForRange(
          range,
          INSIGHTS_DASHBOARD_TIMEZONE_MODE,
          NOW
        )
      );
    }
  );

  it("the all-time Sessions KPI, status donut and cost count a session last active after today ends, as the list does (ISS-12263)", async () => {
    const { dir, db, prisma } = await openInsightsDb(
      "insights-sessions-window-parity-future-"
    );
    try {
      await seedSession(db, "inside", PARITY_WINDOW_BY_DAYS[7].startDate, 10);
      await seedSession(db, "future", PARITY_FUTURE_LAST_ACTIVITY_ISO, 4);
      const resolved = resolveRange(InsightsPeriod.All, NOW);
      // Past the bound every other all-time read keeps.
      expect(PARITY_FUTURE_LAST_ACTIVITY_ISO > resolved.endIso).toBe(true);

      const listWindow = getStableDateWindowForRange(
        "all",
        INSIGHTS_DASHBOARD_TIMEZONE_MODE,
        NOW
      );
      const list = buildListCursorFilterClause({
        startDate: optionalDate(listWindow.startDate),
        endDate: optionalDate(listWindow.endDate),
      });
      const listCount = (
        await db.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sessions s ${list.clause}`,
          list.params
        )
      ).rows[0]?.n;
      const utilization = await computeLocalInsights(
        prisma,
        InsightsSection.Utilization,
        InsightsPeriod.All,
        NOW
      );
      const delivery = await computeLocalInsights(
        prisma,
        InsightsSection.Delivery,
        InsightsPeriod.All,
        NOW
      );
      const agents = await computeLocalInsights(
        prisma,
        InsightsSection.Agents,
        InsightsPeriod.All,
        NOW
      );

      expect(Number(listCount)).toBe(2);
      expect(kpiValue(utilization.kpis, "sessions")).toBe(2);
      expect(
        (utilization.charts.sessionsByStatus ?? []).reduce(
          (total, bucket) => total + bucket.value,
          0
        )
      ).toBe(2);
      expect(kpiValue(delivery.kpis, "cost")).toBe(14);
      // Tokens stay on session start, bounded at today's end: the future
      // session's 20 tokens are not counted.
      expect(kpiValue(agents.kpis, "tokens")).toBe(20);
    } finally {
      await prisma.disconnect();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the window has only elapsed as far as the real clock", () => {
    // `endIso` is ahead of `now` by design — a stable bound cannot also be the
    // clock. The day axis and the prior window read this instead, so a reader
    // east of UTC gets no trailing empty column and no clock-driven delta.
    const resolved = resolveRange(RANGE_TO_PERIOD["7d"], NOW);
    expect(resolved.elapsedEndIso).toBe(PARITY_ELAPSED_END_ISO);
    expect(resolved.endIso).toBe(PARITY_WINDOW_BY_DAYS[7].endDate);
  });

  it("the prior window opens one full period back and closes after the elapsed span", () => {
    const resolved = resolveRange(RANGE_TO_PERIOD["7d"], NOW);
    expect({
      startDate: resolved.priorStartIso,
      endDate: resolved.priorEndIso,
    }).toEqual(PARITY_PRIOR_WINDOW);
  });

  it("at exactly UTC midnight the prior window is the narrowest the product shows", () => {
    const resolved = resolveRange(
      RANGE_TO_PERIOD["7d"],
      new Date("2026-09-17T00:00:00.000Z")
    );
    expect(resolved.elapsedEndIso).toBe("2026-09-17T00:00:00.000Z");
    expect(resolved.priorStartIso).toBe("2026-09-04T00:00:00.000Z");
    expect(resolved.priorEndIso).toBe("2026-09-10T00:00:00.000Z");
  });

  it("the window does not move through the UTC day", () => {
    const justAfterMidnight = resolveRange(
      RANGE_TO_PERIOD["7d"],
      new Date("2026-09-17T00:00:00.001Z")
    );
    const justBeforeMidnight = resolveRange(
      RANGE_TO_PERIOD["7d"],
      new Date("2026-09-17T23:59:59.998Z")
    );
    expect(justAfterMidnight.startIso).toBe(justBeforeMidnight.startIso);
    expect(justAfterMidnight.endIso).toBe(justBeforeMidnight.endIso);
    // The positive twin of that equality: crossing INTO the next UTC day does
    // move it, so the assertion above is pinning stability rather than a bound
    // that ignores `now` altogether.
    const nextUtcDay = resolveRange(
      RANGE_TO_PERIOD["7d"],
      new Date(PARITY_NEXT_UTC_DAY_NOW_ISO)
    );
    expect({
      startDate: nextUtcDay.startIso,
      endDate: nextUtcDay.endIso,
    }).toEqual(PARITY_NEXT_UTC_DAY_WINDOW);
  });
});

async function seedSession(
  db: Awaited<ReturnType<typeof openInsightsDb>>["db"],
  id: string,
  atIso: string,
  cost: number
) {
  await db.query(
    "INSERT INTO sessions (id, status, started_at, ended_at, last_activity_at) VALUES ($1, $2, $3, $4, $5)",
    [id, SESSION_STATUS.INACTIVE, atIso, atIso, atIso]
  );
  await db.query(
    `INSERT INTO token_usage
       (session_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd_estimated)
     VALUES ($1, 'claude-sonnet-4-5', 10, 10, 0, 0, $2)`,
    [id, cost]
  );
}

function kpiValue(kpis: { key: string; value: unknown }[], key: string) {
  return kpis.find((stat) => stat.key === key)?.value;
}

function optionalDate(iso: string | undefined): Date | undefined {
  return iso === undefined ? undefined : new Date(iso);
}
