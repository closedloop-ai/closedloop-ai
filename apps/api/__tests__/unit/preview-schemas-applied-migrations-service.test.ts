/**
 * ISS-11782/ISS-11783: the read behind `/preview-schemas/applied-migrations`.
 * `withDb` is mocked; the assertions read the statement and the row mapping,
 * which decide whether a failed migration reads as applied.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb } = vi.hoisted(() => ({ mockWithDb: vi.fn() }));

vi.mock("@repo/database", () => ({
  withDb: mockWithDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

import { appliedMigrationsService } from "@/app/preview-schemas/applied-migrations/service";
import { readSqlText } from "./preview-schemas-mocks";

const WRITE_STATEMENT = /\b(DELETE|DROP|UPDATE|INSERT|TRUNCATE|ALTER)\b/i;

function answerOnce(rows: unknown[]) {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  mockWithDb.mockImplementationOnce((fn: (db: unknown) => unknown) =>
    fn({ $queryRaw: queryRaw })
  );
  return queryRaw;
}

describe("appliedMigrationsService.list", () => {
  beforeEach(() => {
    mockWithDb.mockReset();
  });

  it("reads the public schema's _prisma_migrations and nothing else", async () => {
    const queryRaw = answerOnce([]);

    await appliedMigrationsService.list();

    const [query] = queryRaw.mock.calls[0] ?? [];
    const sql = readSqlText(query);
    expect(sql).toContain('"public"."_prisma_migrations"');
    expect(sql).not.toMatch(WRITE_STATEMENT);
  });

  it("keeps a failed and a rolled-back row distinguishable from an applied one", async () => {
    answerOnce([
      {
        migration_name: "20260930150000_applied",
        finished_at: new Date("2026-09-30T19:07:26.000Z"),
        rolled_back_at: null,
      },
      {
        migration_name: "20260930150001_failed",
        finished_at: null,
        rolled_back_at: null,
      },
      {
        migration_name: "20260930150002_rolled_back",
        finished_at: "2026-09-30T19:08:00.000Z",
        rolled_back_at: new Date("2026-09-30T19:09:00.000Z"),
      },
    ]);

    expect(await appliedMigrationsService.list()).toEqual([
      {
        name: "20260930150000_applied",
        finishedAt: "2026-09-30T19:07:26.000Z",
        rolledBackAt: null,
      },
      { name: "20260930150001_failed", finishedAt: null, rolledBackAt: null },
      {
        name: "20260930150002_rolled_back",
        finishedAt: "2026-09-30T19:08:00.000Z",
        rolledBackAt: "2026-09-30T19:09:00.000Z",
      },
    ]);
  });
});
