import {
  ListQueryExecution,
  ListQuerySource,
} from "@repo/api/src/types/list-query-observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRequestListQueryLogFields,
  recordRequestListQuerySource,
  runWithRequestSpanAttribution,
} from "@/lib/observability/request-span-attribution";

const READ_STOP_PATTERN = /stop after strategy selection/;

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const withDb = Object.assign(mocks.read, { tx: mocks.transaction });
  return { ...actual, withDb };
});

import { resolveSessionListPage } from "./list-page-fetch";

describe("PRD-721 AC-5 / DT-FS-14 API list execution observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockRejectedValue(new Error("stop after strategy selection"));
    mocks.transaction.mockRejectedValue(
      new Error("stop after strategy selection")
    );
  });

  it.each([
    {
      displayValueSorted: false,
      expected: ListQueryExecution.DatabasePage,
    },
    {
      displayValueSorted: true,
      expected: ListQueryExecution.DisplayValueFallback,
    },
  ])("records $expected before the production read", async (testCase) => {
    let fields: Record<string, string | number> = {};

    await runWithRequestSpanAttribution(async () => {
      recordRequestListQuerySource(ListQuerySource.Legacy);
      await expect(
        resolveSessionListPage({
          displayValueSorted: testCase.displayValueSorted,
          organizationId: "org-1",
          where: {},
          idleWhere: null,
          orderBy: [],
          offset: 0,
          limit: 20,
          filters: {},
        })
      ).rejects.toThrow(READ_STOP_PATTERN);
      fields = getRequestListQueryLogFields();
    });

    expect(fields).toMatchObject({
      list_query_source: ListQuerySource.Legacy,
      list_query_execution: testCase.expected,
    });
  });
});
