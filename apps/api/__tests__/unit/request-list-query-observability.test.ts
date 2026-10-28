import { ListQueryRefusal } from "@repo/api/src/types/list-query-expression";
import {
  ListQueryExecution,
  ListQuerySource,
} from "@repo/api/src/types/list-query-observability";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordRequestListQueryCounts,
  recordRequestListQueryExecution,
  recordRequestListQueryRefusal,
  recordRequestListQueryScannedCount,
  recordRequestListQuerySource,
  runWithRequestSpanAttribution,
} from "@/lib/observability/request-span-attribution";
import { logRequestCompleted } from "@/lib/route-utils";

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn(async () => undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const REQUEST = new Request("https://api.test/agent-sessions", {
  method: "GET",
});

function emittedFields(): Record<string, unknown> {
  const call = vi
    .mocked(log.info)
    .mock.calls.find(([message]) => message === "request_completed");
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

async function emitRequestCompleted(record: () => void): Promise<void> {
  await runWithRequestSpanAttribution(() => {
    record();
    logRequestCompleted(REQUEST, performance.now(), 200, undefined, undefined);
    return Promise.resolve();
  });
}

describe("PRD-721 AC-5 / DT-FS-14 query observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enriches request_completed with bounded fallback and selectivity facts", async () => {
    await emitRequestCompleted(() => {
      recordRequestListQuerySource(ListQuerySource.Canonical);
      recordRequestListQueryExecution(ListQueryExecution.DisplayValueFallback);
      recordRequestListQueryCounts({ matchedCount: 80, resultCount: 20 });
      recordRequestListQueryScannedCount(80);
    });

    expect(emittedFields()).toMatchObject({
      list_query_source: ListQuerySource.Canonical,
      list_query_execution: ListQueryExecution.DisplayValueFallback,
      list_query_matched_count: 80,
      list_query_result_count: 20,
      list_query_scanned_count: 80,
    });
  });

  it("records a typed refusal without any raw filter value", async () => {
    await emitRequestCompleted(() => {
      recordRequestListQueryRefusal(ListQueryRefusal.UnsupportedOperator);
    });

    const fields = emittedFields();
    expect(fields).toMatchObject({
      list_query_source: ListQuerySource.Canonical,
      list_query_execution: ListQueryExecution.Refused,
      list_query_refusal: ListQueryRefusal.UnsupportedOperator,
    });
    expect(JSON.stringify(fields)).not.toContain("private-filter-value");
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "reports an impossible %s matched count while preserving its valid sibling",
    async (_case, invalidCount) => {
      await emitRequestCompleted(() => {
        recordRequestListQuerySource(ListQuerySource.Legacy);
        recordRequestListQueryExecution(ListQueryExecution.DatabasePage);
        recordRequestListQueryCounts({
          matchedCount: invalidCount,
          resultCount: 3,
        });
      });

      const fields = emittedFields();
      expect(fields).not.toHaveProperty("list_query_matched_count");
      expect(fields).not.toHaveProperty("list_query_scanned_count");
      expect(fields).toHaveProperty("list_query_result_count", 3);
      expect(fields).toHaveProperty(
        "list_query_invalid_count_fields",
        "matched"
      );
    }
  );

  it("reports an impossible returned count while preserving a valid matched count", async () => {
    await emitRequestCompleted(() => {
      recordRequestListQueryExecution(ListQueryExecution.DatabasePage);
      recordRequestListQueryCounts({
        matchedCount: 7,
        resultCount: Number.NaN,
      });
    });

    expect(emittedFields()).toMatchObject({ list_query_matched_count: 7 });
    expect(emittedFields()).not.toHaveProperty("list_query_result_count");
    expect(emittedFields()).toHaveProperty(
      "list_query_invalid_count_fields",
      "result"
    );
  });

  it("emits every valid count without dropping a sibling", async () => {
    await emitRequestCompleted(() => {
      recordRequestListQueryExecution(ListQueryExecution.DatabasePage);
      recordRequestListQueryCounts({ matchedCount: 7, resultCount: 2 });
    });

    expect(emittedFields()).toMatchObject({
      list_query_matched_count: 7,
      list_query_result_count: 2,
    });
  });
});
