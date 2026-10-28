/**
 * ISS-7461: unit coverage for the three new `tagService` org-tag reads —
 * `findManyByOrg` (filtered/bounded array), `findPageByOrg` (page + real
 * total, opened as one `RepeatableRead` transaction), and `findByExactName`
 * (the raw-SQL case-insensitive single-row lookup behind the MCP tag tools).
 *
 * Mirrors the mocking style of the sibling `tags-service.test.ts`
 * (`mockWithDbCall`/`getMockWithDb`) and the `Prisma.sql` capture style of
 * `apps/api/app/insights/agents-spend.test.ts` / `search-fts-service.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
    QueryMode: { insensitive: "insensitive" },
    TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" },
  },
}));

// The mutation paths on this service converge GitHub PR labels; mocked here so
// loading `tagService` doesn't reach that module. It has its own suite.
vi.mock("@/lib/github/artifact-tag-label-reconciliation", () => ({
  reconcileLinkedPullRequestLabelsForArtifact: vi.fn(),
  reconcileLinkedPullRequestLabelsForArtifacts: vi.fn(),
}));

import { TAG_LIST_DEFAULT_LIMIT } from "@repo/api/src/types/tag";
import { Prisma } from "@repo/database";
import { tagService } from "@/app/tags/service";
import { escapeSqlLikeLiteral } from "@/lib/sql-like";
import {
  collectSqlValues,
  renderSql,
} from "../support/branches/branch-read-service.test-helpers";
import { getMockWithDb, mockWithDbCall } from "../utils/db-helpers";

const ORG_ID = "org-123";
const LOWER_CALL_PATTERN = /lower\(/g;

function makeTagRow(overrides?: Record<string, unknown>) {
  return {
    id: "tag-1",
    organizationId: ORG_ID,
    name: "Bug",
    color: "red",
    createdById: "user-1",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    ...overrides,
  };
}

describe("tagService — ISS-7461 org list reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findManyByOrg", () => {
    it("passes take/skip, orders by name asc, and org-scopes the where when limit+offset are supplied", async () => {
      const mockDb = { tag: { findMany: vi.fn().mockResolvedValue([]) } };
      mockWithDbCall(mockDb);

      await tagService.findManyByOrg(ORG_ID, { limit: 2, offset: 4 });

      expect(mockDb.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: ORG_ID },
          orderBy: { name: "asc" },
          take: 2,
          skip: 4,
        })
      );
    });

    it("floors `take` at the shared default when a direct caller supplies no limit, so no branch reads unbounded", async () => {
      const mockDb = { tag: { findMany: vi.fn().mockResolvedValue([]) } };
      mockWithDbCall(mockDb);

      // The route cannot produce this call — `search requires limit` rejects it
      // with a 400 — so this pins the service's own floor for a direct caller.
      await tagService.findManyByOrg(ORG_ID, { search: "bug" });

      expect(mockDb.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: TAG_LIST_DEFAULT_LIMIT })
      );
    });

    it("escapes a SQL LIKE special-character search term before it reaches the where clause", async () => {
      const mockDb = { tag: { findMany: vi.fn().mockResolvedValue([]) } };
      mockWithDbCall(mockDb);

      await tagService.findManyByOrg(ORG_ID, { search: "100%_x" });

      expect(mockDb.tag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: ORG_ID,
            name: {
              contains: escapeSqlLikeLiteral("100%_x"),
              mode: "insensitive",
            },
          },
        })
      );
    });
  });

  describe("findPageByOrg", () => {
    /**
     * Wire the pooled `withDb` and the transactional `withDb.tx` to DISTINCT
     * fake clients, mimicking the real `withDb`'s AsyncLocalStorage routing
     * (packages/database/index.ts): while a `withDb.tx()` callback is active,
     * a bare `withDb()` call routes to the SAME tx client rather than the
     * pool. `findPageByOrg`'s inner `findMany`/`count` calls are bare
     * `withDb()` calls (not `tx.tag...`), so this is the only way a read that
     * escaped the transaction's snapshot becomes observable — see
     * `org-population-snapshot.test.ts` for the same shape.
     */
    function installSeparateDbDoubles() {
      const pooled = {
        tag: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
      };
      const tx = {
        tag: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
      };
      const capturedTxOptions: unknown[] = [];
      let activeClient: Record<string, unknown> = pooled;

      getMockWithDb().mockImplementation((callback: (db: unknown) => unknown) =>
        callback(activeClient)
      );
      getMockWithDb().tx = vi
        .fn()
        .mockImplementation(
          async (callback: (db: unknown) => unknown, options?: unknown) => {
            capturedTxOptions.push(options);
            const previous = activeClient;
            activeClient = tx;
            try {
              return await callback(tx);
            } finally {
              activeClient = previous;
            }
          }
        );

      return { pooled, tx, capturedTxOptions };
    }

    it("opens the read at RepeatableRead isolation and runs BOTH the page and the count on the transaction client", async () => {
      const { pooled, tx, capturedTxOptions } = installSeparateDbDoubles();
      tx.tag.findMany.mockResolvedValue([makeTagRow()]);
      tx.tag.count.mockResolvedValue(1);

      await tagService.findPageByOrg(ORG_ID, { limit: 10 });

      expect(capturedTxOptions).toEqual([
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ]);
      expect(tx.tag.findMany).toHaveBeenCalledTimes(1);
      expect(tx.tag.count).toHaveBeenCalledTimes(1);
      expect(pooled.tag.findMany).not.toHaveBeenCalled();
      expect(pooled.tag.count).not.toHaveBeenCalled();
    });

    it("hasMore is true when more tags exist beyond the returned page", async () => {
      const { tx } = installSeparateDbDoubles();
      tx.tag.findMany.mockResolvedValue([
        makeTagRow(),
        makeTagRow({ id: "tag-2" }),
      ]);
      tx.tag.count.mockResolvedValue(5);

      const result = await tagService.findPageByOrg(ORG_ID, {
        limit: 2,
        offset: 0,
      });

      expect(result.hasMore).toBe(true);
    });

    it("hasMore is false when the last page happens to fill exactly (no phantom next page)", async () => {
      const { tx } = installSeparateDbDoubles();
      tx.tag.findMany.mockResolvedValue([
        makeTagRow(),
        makeTagRow({ id: "tag-2" }),
      ]);
      tx.tag.count.mockResolvedValue(4);

      const result = await tagService.findPageByOrg(ORG_ID, {
        limit: 2,
        offset: 2,
      });

      expect(result.hasMore).toBe(false);
    });
  });

  describe("findByExactName", () => {
    it("issues exactly one $queryRaw, case-insensitive on both sides, org-scoped with a ::uuid cast, and returns null on no match", async () => {
      const queryRaw = vi.fn().mockResolvedValue([]);
      mockWithDbCall({ $queryRaw: queryRaw });

      const result = await tagService.findByExactName(ORG_ID, "dsp");

      expect(queryRaw).toHaveBeenCalledTimes(1);
      const sqlArg = queryRaw.mock.calls[0]?.[0];
      const rendered = renderSql(sqlArg);
      expect(rendered).toContain("::uuid");
      expect(rendered.match(LOWER_CALL_PATTERN)).toHaveLength(2);
      expect(collectSqlValues(sqlArg)).toEqual([ORG_ID, "dsp"]);
      expect(result).toBeNull();
    });

    it("returns the projected row when the raw query matches one tag", async () => {
      const row = {
        id: "tag-1",
        organizationId: ORG_ID,
        name: "DSP",
        color: "blue",
        createdById: "user-1",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      };
      const queryRaw = vi.fn().mockResolvedValue([row]);
      mockWithDbCall({ $queryRaw: queryRaw });

      const result = await tagService.findByExactName(ORG_ID, "DSP");

      expect(result).toEqual(row);
    });
  });
});
