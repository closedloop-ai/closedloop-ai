import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import { log } from "@repo/observability/log";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/tracing/spans", () => ({
  setAppSpanAttributes: vi.fn(),
  withAppSpan: (_name: string, callback: () => unknown) => callback(),
}));

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidateIds,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "@/__tests__/utils/db-helpers";
import {
  BranchListEnrichmentFailureKind,
  BranchListEnrichmentRead,
  branchListEnrichmentFailureThrottle,
} from "./branch-list-enrichment";
import { branchReadService } from "./branch-read-service";

/**
 * ISS-10297 (incident ISS-10295) — usage/identity enrichment is OPTIONAL
 * analytics on the REQUIRED Branches list path. Before this change a slow
 * Session-link scan threw out of the list read and the whole surface answered
 * `Failed to fetch branches` (674 expired-transaction 500s in 24h on
 * 2026-09-14). The contract in `apps/api/app/branches/AGENTS.md` is that the
 * rows come back with the analytics fields OMITTED instead.
 *
 * Both enrichment reads reach Prisma through `db.artifactLink.findMany`, so
 * rejecting that mock is the lever: the identity/usage scan passes `targetId`
 * (branch ids), the even-split divisor read passes `sourceId` (session ids),
 * which is what lets one case fail ONLY the divisor. The GLOBAL divisor
 * candidates read is a `$queryRaw`, which is what lets another fail only that.
 */
describe("Branches list enrichment fails open (ISS-10297)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  const TIMEOUT_ERROR = "canceling statement due to statement timeout";
  const FAILED_OPEN_EVENT = "[branches-list] enrichment read failed open";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    // The emission budget is module-level state that `clearAllMocks` does not
    // touch. Without this the throttle case would pass in file order and fail
    // run alone — and, worse, silently suppress a later case's expected line.
    branchListEnrichmentFailureThrottle.clear();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow({})]);
  });

  // Unconditional: a throw between install and a manual restore would otherwise
  // leak the frozen clock into every later file in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  function listServerPage() {
    return branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      pageMode: BranchListPageMode.Server,
    });
  }

  function listLegacyPage() {
    return branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });
  }

  function failedOpenLogLines() {
    return vi
      .mocked(log.error)
      .mock.calls.filter(([message]) => message === FAILED_OPEN_EVENT);
  }

  it("returns the rows with analytics omitted when the usage/identity read fails", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifactLink.findMany.mockRejectedValue(new Error(TIMEOUT_ERROR));

    const response = await listServerPage();

    expect(response.items.map((item) => item.id)).toEqual([branchId]);
    expect(response.sessionCostUsd).toBeUndefined();
    expect(response.lifetimeSessionCostUsd).toBeUndefined();
    expect(response.items[0]?.sessionIds).toEqual([]);
  });

  it("logs and traces the usage/identity failure instead of swallowing it", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifactLink.findMany.mockRejectedValue(new Error(TIMEOUT_ERROR));

    await listServerPage();

    expect(log.error).toHaveBeenCalledWith(
      FAILED_OPEN_EVENT,
      expect.objectContaining({
        organizationId,
        read: BranchListEnrichmentRead.Identity,
        failureKind: BranchListEnrichmentFailureKind.ReadError,
        rowCount: 1,
      })
    );
    expect(setAppSpanAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "branches.list.enrichment.failed_open": true,
        "branches.list.enrichment.failed_open.read":
          BranchListEnrichmentRead.Identity,
      })
    );
  });

  it("keeps a database timeout distinguishable from a programming defect", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifactLink.findMany.mockRejectedValue(
      new TypeError("cannot read properties of undefined")
    );

    await listServerPage();

    expect(log.error).toHaveBeenCalledWith(
      FAILED_OPEN_EVENT,
      expect.objectContaining({
        failureKind: BranchListEnrichmentFailureKind.ProgrammingError,
        errorName: "TypeError",
      })
    );
  });

  /**
   * The defect the first round of review caught (#7312: whitlockk, and the codex
   * P1). Catching the enrichment error INSIDE the callback cannot save the
   * response when that error is what aborted the snapshot: PostgreSQL marks the
   * whole transaction aborted, so Prisma rejects at COMMIT with P2028 and
   * `/branches` keeps 500ing — the incident, untouched.
   *
   * The mock models exactly that sequence, which `mockWithDbTx` alone cannot:
   * it invokes the callback directly and models neither commit nor expiration,
   * so every case above stays green against the broken shape.
   */
  it("retries on a fresh snapshot when the enrichment failure aborted the transaction", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifactLink.findMany.mockRejectedValue(new Error(TIMEOUT_ERROR));

    let transactionCount = 0;
    getMockWithDb().tx = vi
      .fn()
      .mockImplementation(async (callback: (tx: unknown) => unknown) => {
        transactionCount += 1;
        const result = await callback(mockDb);
        if (transactionCount === 1) {
          throw new Error(
            "Transaction already closed: A query cannot be executed on an expired transaction"
          );
        }
        return result;
      });

    const response = await listServerPage();

    // Two snapshots: the aborted one, then the recovery that skips the read
    // which poisoned it.
    expect(transactionCount).toBe(2);
    expect(response.items.map((item) => item.id)).toEqual([branchId]);
  });

  /**
   * The other half of that recovery: a CORE row read is not optional, so its
   * failure must still reject. Without this the retry would mask a real outage
   * behind an empty-looking list, and would double the load doing it.
   */
  it("does not retry when a CORE row read is what failed", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockRejectedValue(
      new Error("core branch row read failed")
    );

    let transactionCount = 0;
    getMockWithDb().tx = vi
      .fn()
      .mockImplementation(async (callback: (tx: unknown) => unknown) => {
        transactionCount += 1;
        return await callback(mockDb);
      });

    await expect(listServerPage()).rejects.toThrow(
      "core branch row read failed"
    );
    expect(transactionCount).toBe(1);
  });

  it("does not retry the corpus scan when its snapshot expires", async () => {
    const expired = Object.assign(new Error("Transaction already closed"), {
      code: "P2028",
    });
    mockDb.$queryRaw.mockRejectedValue(expired);

    await expect(listServerPage()).rejects.toBe(expired);

    expect(getMockWithDb().tx).toHaveBeenCalledTimes(1);
    expect(mockDb.$queryRaw).toHaveBeenCalledTimes(1);
    expect(failedOpenLogLines()).toHaveLength(0);
  });

  /**
   * `/branches` is a pollable authenticated endpoint, so an org stuck in this
   * state would otherwise emit one error line per request (#7312 review,
   * whitlockk). The budget is per (org, read, failureKind) per window.
   */
  it("bounds the failure log to one line per org, read and kind in a window", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifactLink.findMany.mockRejectedValue(new Error(TIMEOUT_ERROR));

    await listServerPage();
    await listServerPage();

    // Both requests still degraded identically; only the SECOND line is
    // suppressed, so behavior never depends on the throttle.
    expect(failedOpenLogLines()).toHaveLength(1);
  });

  // The NON-server arm of the same read, reached in production by `pageData`'s
  // legacy call and — worse — by `getBranchListWithServerFallback`, which falls
  // back to it precisely WHEN a server-page query is rejected. Covering only the
  // server path would leave the incident reachable through the fallback that
  // exists to catch failures.
  it("returns the rows with analytics omitted when the LEGACY path's enrichment fails", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifactLink.findMany.mockRejectedValue(new Error(TIMEOUT_ERROR));

    const response = await listLegacyPage();

    expect(response.items.map((item) => item.id)).toEqual([branchId]);
    expect(response.sessionCostUsd).toBeUndefined();
    expect(response.lifetimeSessionCostUsd).toBeUndefined();
    expect(response.sessionBranchCount).toBeUndefined();
    // EXPECTATION CHANGED in this diff (#7312 review: davetho and whitlockk).
    // It previously asserted `null`. On this wire contract `null` is a MEASURED
    // answer — "no attributable cost" — and the field is optional, so an
    // unavailable read must be spelled by ABSENCE. Publishing `null` here made a
    // branch whose cost failed to load indistinguishable from one that has none.
    expect(response.items[0]?.attributedCostUsd).toBeUndefined();
    expect(response.items[0]?.sessionIds).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      FAILED_OPEN_EVENT,
      expect.objectContaining({
        organizationId,
        read: BranchListEnrichmentRead.Identity,
        failureKind: BranchListEnrichmentFailureKind.ReadError,
      })
    );
  });

  /**
   * The SUCCESS half of the legacy divisor change (#7312 review, whitlockk: "cover
   * the no-pageMode path too"). That arm's two divisor reads — the global
   * authority snapshot and the count built from it — were awaited outside any
   * failure domain and are now inside one. Moving them must not change what
   * they compute when both succeed, so this pins the divisor and the share that
   * the failure cases above assert the ABSENCE of.
   *
   * Their failure paths are the shared `runBranchListEnrichmentRead` exercised
   * by the cases above; this file does not separately force the global
   * authority read to throw.
   */
  it("still computes the LEGACY path's divisor when both reads succeed", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-1", "4.00"),
    ]);

    const response = await listLegacyPage();

    expect(response.items.map((item) => item.id)).toEqual([branchId]);
    expect(response.sessionBranchCount).toEqual({ "s-1": 1 });
    // A measured share, not the absent field the unavailable cases assert.
    expect(response.items[0]?.attributedCostUsd).toEqual(expect.any(Number));
    expect(failedOpenLogLines()).toHaveLength(0);
  });

  it("returns the page without attributed cost when only the divisor read fails", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifactLink.findMany.mockImplementation(
      (args: { where?: { sourceId?: unknown } }) =>
        args?.where?.sourceId
          ? Promise.reject(new Error(TIMEOUT_ERROR))
          : Promise.resolve([makeSessionLink(branchId, "s-1", "4.00")])
    );

    const response = await listServerPage();

    expect(response.items.map((item) => item.id)).toEqual([branchId]);
    // Unavailable, never a fabricated `$0` and never a measured `null`: the
    // divisor is unknown, so the share is.
    expect(response.items[0]?.attributedCostUsd).toBeUndefined();
    expect(response.sessionBranchCount).toBeUndefined();
    // The usage half SURVIVED — this case fails the divisor only.
    expect(response.sessionCostUsd).toEqual({ "s-1": 4 });
    expect(log.error).toHaveBeenCalledWith(
      FAILED_OPEN_EVENT,
      expect.objectContaining({
        organizationId,
        read: BranchListEnrichmentRead.SessionBranchDivisor,
        failureKind: BranchListEnrichmentFailureKind.ReadError,
      })
    );
  });
});
