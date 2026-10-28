import { InsightsScope } from "@repo/api/src/types/insights";
import { withDb } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  flattenRawSql,
  ORG,
} from "@/__tests__/support/insights/service.test-db";
import { fetchModelUsageRows } from "@/app/insights/service/token-queries";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

const USER_ID = "user-1";
const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
const WHITESPACE_RUN = /\s+/g;
const CONTEXT = {
  organizationId: ORG,
  userId: USER_ID,
  scope: InsightsScope.Org,
};

describe("fetchModelUsageRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("orders model usage rows by the emitted day and model keys", async () => {
    const rawQueries: unknown[] = [];
    vi.mocked(withDb).mockImplementation((read) =>
      Promise.resolve(read(recordingDb(rawQueries) as never))
    );

    await fetchModelUsageRows(CONTEXT, WINDOW_START, WINDOW_END);

    const sql = normalizeSql(flattenRawSql(rawQueries[0]).text);
    const groupIndex = sql.indexOf("GROUP BY day, tu.model");
    const orderIndex = sql.indexOf("ORDER BY day, tu.model");

    expect(rawQueries).toHaveLength(1);
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(orderIndex).toBeGreaterThan(groupIndex);
  });
});

function recordingDb(rawQueries: unknown[]): {
  $queryRaw: (sql: unknown) => [];
} {
  return {
    $queryRaw: (sql: unknown) => {
      rawQueries.push(sql);
      return [];
    },
  };
}

function normalizeSql(text: string): string {
  return text.replace(WHITESPACE_RUN, " ").trim();
}
