/**
 * Tests for loopsService.updateTokens monotonic SQL update.
 *
 * Covers:
 * - $executeRaw called with the correct token values
 * - Input-only increase passes correct values
 * - Output-only increase passes correct values
 * - Service always fires SQL (WHERE clause in DB handles stale rejection)
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

let capturedExecuteRawArgs: unknown[] = [];
const executeRawMock = vi.fn((sqlObj: unknown) => {
  capturedExecuteRawArgs.push(sqlObj);
  return Promise.resolve(1);
});

vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
  },
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) =>
      fn({
        $executeRaw: executeRawMock,
      })
    ),
    { tx: vi.fn() }
  ),
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

// --- Imports (after mocks) ---

import { loopsService } from "@/app/loops/service";

// ---------------------------------------------------------------------------
// updateTokens — monotonic SQL update
// ---------------------------------------------------------------------------

describe("loopsService.updateTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExecuteRawArgs = [];
    executeRawMock.mockClear();
  });

  it("calls $executeRaw with the correct token values", async () => {
    await loopsService.updateTokens("loop-1", "org-1", 2000, 800);

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const sqlObj = capturedExecuteRawArgs[0] as { values: unknown[] };
    // Prisma.sql template produces { strings, values } where values are the interpolated args
    expect(sqlObj.values).toEqual(
      expect.arrayContaining([2000, 800, "loop-1", "org-1"])
    );
  });

  it("passes higher input value for input-only increase", async () => {
    await loopsService.updateTokens("loop-1", "org-1", 5000, 0);

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const sqlObj = capturedExecuteRawArgs[0] as { values: unknown[] };
    expect(sqlObj.values).toContain(5000);
    expect(sqlObj.values).toContain(0);
  });

  it("passes higher output value for output-only increase", async () => {
    await loopsService.updateTokens("loop-1", "org-1", 0, 3000);

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const sqlObj = capturedExecuteRawArgs[0] as { values: unknown[] };
    expect(sqlObj.values).toContain(0);
    expect(sqlObj.values).toContain(3000);
  });

  it("still calls $executeRaw for stale lower values (WHERE clause in DB handles rejection)", async () => {
    // The service always fires the SQL; the WHERE clause
    // (tokens_input < $1 OR tokens_output < $2) ensures the DB no-ops when
    // values are not higher. The service does not pre-check values in TypeScript.
    executeRawMock.mockResolvedValueOnce(0);

    await loopsService.updateTokens("loop-1", "org-1", 100, 50);

    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });
});
