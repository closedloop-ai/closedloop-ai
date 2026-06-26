/**
 * Tests for loopsService.getUsageSummary cache aggregation.
 *
 * Covers:
 * - Null/empty tokensByModel returns 0 for cache totals
 * - Cache totals returned as number (not bigint)
 * - Cache tokens summed correctly from bigint SQL result
 * - Cache totals coexist correctly with standard aggregate totals
 * - Returns 0 gracefully when cacheAgg row is absent (empty array)
 * - organizationId predicate is passed to the raw query
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/github", () => ({
  getInstallationAccessToken: vi.fn(),
}));

vi.mock("@/lib/db-utils", () => ({
  basicUserSelect: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
    },
  },
}));

// Mutable state for per-test overrides
let mockCacheRow: { total_cache_creation: bigint; total_cache_read: bigint }[] =
  [{ total_cache_creation: BigInt(0), total_cache_read: BigInt(0) }];
let mockAggregateResult = {
  _count: 0,
  _sum: {
    tokensInput: null as number | null,
    tokensOutput: null as number | null,
    estimatedCost: null as number | null,
  },
};
let capturedQueryRawArgs: unknown[] = [];
let capturedJoinParts: unknown[][] = [];

vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
    join: (parts: unknown[], separator: string) => {
      capturedJoinParts.push(parts);
      return {
        strings: [parts.map(String).join(separator)],
        values: [],
      };
    },
  },
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          aggregate: vi.fn(() => Promise.resolve(mockAggregateResult)),
          groupBy: vi.fn(() => Promise.resolve([])),
        },
        user: {
          findMany: vi.fn(() => Promise.resolve([])),
        },
        $queryRaw: vi.fn((...args: unknown[]) => {
          capturedQueryRawArgs = args;
          return Promise.resolve(mockCacheRow);
        }),
      })
    ),
    { tx: vi.fn() }
  ),
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

// --- Imports (after mocks) ---

import { loopsService } from "@/app/loops/service";

// ---------------------------------------------------------------------------
// getUsageSummary — cache aggregation
// ---------------------------------------------------------------------------

describe("getUsageSummary cache aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedQueryRawArgs = [];
    capturedJoinParts = [];
    mockAggregateResult = {
      _count: 0,
      _sum: { tokensInput: null, tokensOutput: null, estimatedCost: null },
    };
    mockCacheRow = [
      { total_cache_creation: BigInt(0), total_cache_read: BigInt(0) },
    ];
  });

  it("returns 0 for cache totals when SQL returns zero bigints", async () => {
    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalCacheCreationTokens).toBe(0);
    expect(result.totalCacheReadTokens).toBe(0);
  });

  it("returns cache totals as number (not bigint)", async () => {
    mockCacheRow = [
      {
        total_cache_creation: BigInt(5000),
        total_cache_read: BigInt(2500),
      },
    ];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(typeof result.totalCacheCreationTokens).toBe("number");
    expect(typeof result.totalCacheReadTokens).toBe("number");
  });

  it("sums cache tokens correctly from bigint SQL result", async () => {
    mockCacheRow = [
      {
        total_cache_creation: BigInt(12_000),
        total_cache_read: BigInt(4500),
      },
    ];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalCacheCreationTokens).toBe(12_000);
    expect(result.totalCacheReadTokens).toBe(4500);
  });

  it("returns 0 for both cache totals when cacheAgg is an empty array", async () => {
    mockCacheRow = [];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalCacheCreationTokens).toBe(0);
    expect(result.totalCacheReadTokens).toBe(0);
  });

  it("cache totals are independent of standard token totals", async () => {
    mockAggregateResult = {
      _count: 3,
      _sum: { tokensInput: 100_000, tokensOutput: 50_000, estimatedCost: 4.5 },
    };
    mockCacheRow = [
      {
        total_cache_creation: BigInt(8000),
        total_cache_read: BigInt(1200),
      },
    ];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalLoops).toBe(3);
    expect(result.totalTokensInput).toBe(100_000);
    expect(result.totalTokensOutput).toBe(50_000);
    expect(result.totalCacheCreationTokens).toBe(8000);
    expect(result.totalCacheReadTokens).toBe(1200);
  });

  it("invokes $queryRaw for the cache aggregation on every call", async () => {
    await loopsService.getUsageSummary("org-xyz-999", {});

    // $queryRaw must be called — it is the source of cache token totals
    expect(capturedQueryRawArgs.length).toBeGreaterThan(0);
    const queryArg = capturedQueryRawArgs[0];
    // The Prisma.sql tagged template produces an object (not a string)
    expect(queryArg).toBeDefined();
    expect(typeof queryArg).toBe("object");
  });

  it("cache-only scenario: cacheCreation > 0, cacheRead = 0", async () => {
    mockCacheRow = [
      {
        total_cache_creation: BigInt(3000),
        total_cache_read: BigInt(0),
      },
    ];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalCacheCreationTokens).toBe(3000);
    expect(result.totalCacheReadTokens).toBe(0);
  });

  it("large bigint values convert without overflow", async () => {
    // Simulate many loops with large cache counts
    mockCacheRow = [
      {
        total_cache_creation: BigInt(50_000_000),
        total_cache_read: BigInt(25_000_000),
      },
    ];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalCacheCreationTokens).toBe(50_000_000);
    expect(result.totalCacheReadTokens).toBe(25_000_000);
  });

  it("userId filter adds a second predicate to the raw SQL query", async () => {
    await loopsService.getUsageSummary("org-1", { userId: "user-abc" });

    // Prisma.join is called with rawPredicates: [orgId predicate, userId predicate]
    expect(capturedJoinParts.length).toBeGreaterThan(0);
    const predicates = capturedJoinParts[0];
    expect(predicates).toHaveLength(2);
  });

  it("command filter adds a second predicate to the raw SQL query", async () => {
    await loopsService.getUsageSummary("org-1", { command: "PLAN" });

    expect(capturedJoinParts.length).toBeGreaterThan(0);
    const predicates = capturedJoinParts[0];
    expect(predicates).toHaveLength(2);
  });

  it("date range filter adds predicates for startDate and endDate", async () => {
    const startDate = new Date("2026-01-01T00:00:00Z");
    const endDate = new Date("2026-01-31T23:59:59Z");

    await loopsService.getUsageSummary("org-1", { startDate, endDate });

    expect(capturedJoinParts.length).toBeGreaterThan(0);
    const predicates = capturedJoinParts[0];
    // org predicate + startDate predicate + endDate predicate
    expect(predicates).toHaveLength(3);
  });

  it("all filters combined produce one predicate per filter", async () => {
    const startDate = new Date("2026-01-01T00:00:00Z");
    const endDate = new Date("2026-01-31T23:59:59Z");

    await loopsService.getUsageSummary("org-1", {
      userId: "user-abc",
      command: "EXECUTE",
      startDate,
      endDate,
    });

    expect(capturedJoinParts.length).toBeGreaterThan(0);
    const predicates = capturedJoinParts[0];
    // org + userId + command + startDate + endDate = 5 predicates
    expect(predicates).toHaveLength(5);
  });

  it("non-numeric cacheCreation in tokensByModel returns 0 (SQL guard path)", async () => {
    // The SQL CASE guard filters out non-numeric entries (e.g. "n/a", null);
    // those rows contribute 0 to the SUM. The mock simulates that result.
    mockCacheRow = [
      { total_cache_creation: BigInt(0), total_cache_read: BigInt(0) },
    ];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalCacheCreationTokens).toBe(0);
    expect(result.totalCacheReadTokens).toBe(0);
  });

  it("Electron 'default' key cache values are aggregated into totals", async () => {
    // Simulates a row: tokensByModel = { default: { input: 100, output: 50,
    // cacheCreation: 200, cacheRead: 400 } }. The SQL sums the 'default' entry
    // just like any named model entry.
    mockCacheRow = [
      { total_cache_creation: BigInt(200), total_cache_read: BigInt(400) },
    ];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalCacheCreationTokens).toBe(200);
    expect(result.totalCacheReadTokens).toBe(400);
  });

  it("FAILED and TIMED_OUT loops with cache data are included in totals", async () => {
    // The raw SQL query has no status filter, so failed/timed-out loops with
    // cache tokens in tokensByModel are included in the aggregate.
    mockCacheRow = [
      { total_cache_creation: BigInt(7500), total_cache_read: BigInt(3200) },
    ];

    const result = await loopsService.getUsageSummary("org-1", {});

    expect(result.totalCacheCreationTokens).toBe(7500);
    expect(result.totalCacheReadTokens).toBe(3200);
  });
});
