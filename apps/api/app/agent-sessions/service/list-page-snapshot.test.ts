import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import {
  getRequestListQueryLogFields,
  runWithRequestSpanAttribution,
} from "@/lib/observability/request-span-attribution";
import type { AgentSessionListQuery } from "../validators";
import {
  findDbPaginatedPage,
  findDisplayValueSortedPage,
  SESSION_LIST_SNAPSHOT_TX_TIMEOUT_MS,
} from "./list-page-fetch";
import { buildAgentSessionOrderBy } from "./query-builder";
import { SESSION_COST_SORT_BY } from "./session-sort-rules";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

/**
 * ISS-6892 (codex review, thread PRRT_kwDOQ4gDpM6Zt1cX): a Sessions list page
 * and its `total` must be ONE observation of ONE population.
 *
 * `withDb` is not transactional — each statement takes its own READ COMMITTED
 * snapshot — so the sorted paths, which read `count(where)` and THEN stream the
 * ranked page across many keyset chunks, could describe two different database
 * states when a session was inserted, deleted, or updated between them. Against
 * a real Postgres that reproduces as a short page under a `total` still
 * advertising the old count, and as rows served that the advertised `total`
 * never counted.
 *
 * The fix opens the whole read — count, every chunk, the per-chunk reconciled
 * cost aggregate, and the hydrate — inside ONE `RepeatableRead` interactive
 * transaction. These tests assert exactly that wiring, because it is the part a
 * mocked `withDb` can prove: the transaction is opened, it is opened at
 * `RepeatableRead`, and NO read escapes it. Reverting any path to a bare
 * `withDb` fails here — `openedTransactions` drops to 0 for that path and its
 * reads record as `outside-tx`.
 */

const ORG_ID = "org-1";

/**
 * Wrap the harness's `withDb`/`withDb.tx` mocks so every read records whether
 * it ran INSIDE an open transaction, and every transaction records the options
 * it was opened with.
 */
function instrumentSnapshot() {
  const readSites: string[] = [];
  const openedTransactions: (
    | { isolationLevel?: string; timeout?: number }
    | undefined
  )[] = [];
  let depth = 0;

  mocks.withDb.tx.mockImplementation(
    async (
      callback: () => unknown,
      options?: { isolationLevel?: string; timeout?: number }
    ) => {
      openedTransactions.push(options);
      depth += 1;
      try {
        return await callback();
      } finally {
        depth -= 1;
      }
    }
  );
  const dbClient = mocks.withDb.getMockImplementation();
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) => {
    readSites.push(depth > 0 ? "in-tx" : "outside-tx");
    return dbClient?.(callback);
  });

  return { readSites, openedTransactions };
}

function buildRow(index: number) {
  return {
    artifactId: `sess-${String(index).padStart(4, "0")}`,
    sessionStartedAt: new Date("2026-05-20T17:00:00.000Z"),
    sessionEndedAt: null,
    awaitingInputSince: null,
    lastActivityAt: new Date("2026-05-20T18:00:00.000Z"),
    updatedAt: new Date("2026-05-20T18:00:00.000Z"),
    sessionUpdatedAt: new Date("2026-05-20T18:00:00.000Z"),
    estimatedCost: index,
    inputTokens: 10,
    outputTokens: 10,
    turns: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolUseCount: 1,
    billingMode: null,
    artifact: { status: "active", organizationId: ORG_ID },
    user: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  };
}

const POPULATION = Array.from({ length: 3 }, (_unused, index) =>
  buildRow(index)
);

function installPopulation() {
  installDb({
    ...buildAgentSessionDbMock({}),
    sessionDetail: {
      count: vi.fn().mockResolvedValue(POPULATION.length),
      findMany: vi.fn().mockResolvedValue(POPULATION),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  });
}

const BASE_WHERE = { artifact: { is: { organizationId: ORG_ID } } };

describe("ISS-6892 — the sorted list page and its total share one snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installPopulation();
  });

  it("opens the display-value sorted page in ONE RepeatableRead transaction and lets no read escape it", async () => {
    const { readSites, openedTransactions } = instrumentSnapshot();

    await findDisplayValueSortedPage({
      organizationId: ORG_ID,
      where: BASE_WHERE,
      idleWhere: BASE_WHERE,
      offset: 0,
      limit: 2,
      filters: { sortBy: "duration", sortDir: "desc" } as AgentSessionListQuery,
    });

    expect(openedTransactions).toHaveLength(1);
    expect(openedTransactions[0]).toEqual({
      isolationLevel: "RepeatableRead",
      timeout: SESSION_LIST_SNAPSHOT_TX_TIMEOUT_MS,
    });
    // The count, the idle count, the keyset chunk(s), and the hydrate.
    expect(readSites.length).toBeGreaterThan(3);
    expect(readSites).not.toContain("outside-tx");
  });

  it("keeps a DB-native cost page and its total in ONE snapshot", async () => {
    const { readSites, openedTransactions } = instrumentSnapshot();

    await findDbPaginatedPage({
      organizationId: ORG_ID,
      where: BASE_WHERE,
      idleWhere: BASE_WHERE,
      orderBy: buildAgentSessionOrderBy({
        sortBy: SESSION_COST_SORT_BY,
        sortDir: "desc",
      } as AgentSessionListQuery),
      offset: 0,
      limit: 2,
    });

    expect(openedTransactions).toEqual([
      {
        isolationLevel: "RepeatableRead",
        timeout: SESSION_LIST_SNAPSHOT_TX_TIMEOUT_MS,
      },
    ]);
    expect(readSites).toEqual(["in-tx", "in-tx", "in-tx"]);
  });

  it("adds no extra query on the common case — the snapshot only wraps reads that already happened", async () => {
    const withoutSnapshot = instrumentSnapshot();
    await findDisplayValueSortedPage({
      organizationId: ORG_ID,
      where: BASE_WHERE,
      idleWhere: null,
      offset: 0,
      limit: 2,
      filters: { sortBy: "duration", sortDir: "desc" } as AgentSessionListQuery,
    });
    // One count (no idleWhere), one keyset chunk, one hydrate. The transaction
    // itself issues no `withDb` read of its own, so wrapping cost nothing at
    // this layer beyond the BEGIN/COMMIT the driver emits.
    expect(withoutSnapshot.readSites).toEqual(["in-tx", "in-tx", "in-tx"]);
  });

  it("reports the candidates actually scanned for a nonempty fallback page", async () => {
    instrumentSnapshot();

    await runWithRequestSpanAttribution(async () => {
      const page = await findDisplayValueSortedPage({
        organizationId: ORG_ID,
        where: BASE_WHERE,
        idleWhere: null,
        offset: 0,
        limit: 2,
        filters: { sortBy: "user", sortDir: "asc" } as AgentSessionListQuery,
      });

      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(POPULATION.length);
      expect(page.scannedCount).toBe(POPULATION.length);
      expect(getRequestListQueryLogFields()).toMatchObject({
        list_query_scanned_count: POPULATION.length,
      });
    });
  });

  it("reports zero scanned candidates when the requested offset is at the end", async () => {
    const total = 100;
    installDb({
      ...buildAgentSessionDbMock({}),
      sessionDetail: {
        count: vi.fn().mockResolvedValue(total),
        findMany: vi.fn().mockResolvedValue(POPULATION),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    });
    instrumentSnapshot();

    await runWithRequestSpanAttribution(async () => {
      const page = await findDisplayValueSortedPage({
        organizationId: ORG_ID,
        where: BASE_WHERE,
        idleWhere: null,
        offset: total,
        limit: 2,
        filters: { sortBy: "user", sortDir: "asc" } as AgentSessionListQuery,
      });

      expect(page.items).toEqual([]);
      expect(page.total).toBe(total);
      expect(page.scannedCount).toBe(0);
      expect(getRequestListQueryLogFields()).toMatchObject({
        list_query_scanned_count: 0,
      });
    });
  });
});
