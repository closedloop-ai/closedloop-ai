/**
 * T-7.1 — enforceJtiOrPin branch coverage
 *
 * Covers all four return branches of enforceJtiOrPin plus an org-scoping
 * structural assertion on the CAS WHERE clause:
 *
 * - matched: presentedJti === currentJti → no DB write, returns { kind: "matched" }
 * - pinned:  currentJti null, updateMany count=1 → slot pinned for active
 *   loops or runner-completable terminal loops, { kind: "pinned" }
 * - raced:   currentJti null, updateMany count=0 → another request won, { kind: "raced" }
 * - mismatch: currentJti non-null and differs → logs warn, { kind: "mismatch", currentJti }
 * - org-scoping: CAS WHERE clause contains organizationId field
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

const { mockWithDb, mockUpdateMany, mockFindFirst, mockLogWarn } = vi.hoisted(
  () => ({
    mockWithDb: vi.fn(),
    mockUpdateMany: vi.fn(),
    mockFindFirst: vi.fn(),
    mockLogWarn: vi.fn(),
  })
);

vi.mock("@repo/database", () => ({
  LoopStatus: {
    PENDING: "PENDING",
    CLAIMED: "CLAIMED",
    RUNNING: "RUNNING",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
    TIMED_OUT: "TIMED_OUT",
    COMPLETED: "COMPLETED",
  },
  withDb: Object.assign(mockWithDb, { tx: vi.fn() }),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
  },
}));

// --- Imports (after mocks) ---

import { enforceJtiOrPin } from "@/lib/auth/loop-runner-jwt";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOOP_ID = "loop-abc-123";
const ORG_ID = "org-xyz-456";
const PRESENTED_JTI = "jti-presented-001";
const CURRENT_JTI = "jti-current-999";
const ROUTE = "/loops/loop-abc-123/events";
const RUNNER_REQUEST_PINNABLE_STATUSES = [
  "PENDING",
  "CLAIMED",
  "RUNNING",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enforceJtiOrPin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockFindFirst.mockResolvedValue(null);
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({
        loop: { updateMany: mockUpdateMany, findFirst: mockFindFirst },
      })
    );
  });

  describe("matched branch", () => {
    it("returns { kind: 'matched' } without touching the database when presentedJti equals currentJti", async () => {
      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: PRESENTED_JTI,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "matched" });
      expect(mockWithDb).not.toHaveBeenCalled();
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("pinned branch", () => {
    it("returns { kind: 'pinned' } when slot is empty and CAS succeeds (count=1)", async () => {
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "pinned" });
    });

    it("calls updateMany with the presented JTI as the new value", async () => {
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { activeTokenJti: PRESENTED_JTI },
        })
      );
    });
  });

  describe("raced branch", () => {
    it("returns { kind: 'raced' } when CAS fails (count=0) and the row is gone", async () => {
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindFirst.mockResolvedValueOnce(null);

      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "raced" });
      expect(mockFindFirst).toHaveBeenCalledWith({
        where: { id: LOOP_ID, organizationId: ORG_ID },
        select: { activeTokenJti: true, status: true },
      });
    });

    it("returns { kind: 'raced' } when CAS fails and re-read shows activeTokenJti still null (concurrently cleared)", async () => {
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindFirst.mockResolvedValueOnce({ activeTokenJti: null });

      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "raced" });
    });
  });

  describe("NULL → first-token migration concurrent request (CAS re-read)", () => {
    it("returns { kind: 'matched' } when CAS fails but the re-read shows our presentedJti is pinned", async () => {
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindFirst.mockResolvedValueOnce({
        activeTokenJti: PRESENTED_JTI,
        status: "RUNNING",
      });

      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "matched" });
      expect(mockFindFirst).toHaveBeenCalledTimes(1);
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it("returns { kind: 'matched' } when CAS fails but the re-read shows a runner-completable terminal loop pinned to our presentedJti", async () => {
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindFirst.mockResolvedValueOnce({
        activeTokenJti: PRESENTED_JTI,
        status: "FAILED",
      });

      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "matched" });
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it("returns mismatch with the re-read JTI when a different runner won the CAS", async () => {
      const otherJti = "jti-other-runner";
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindFirst.mockResolvedValueOnce({
        activeTokenJti: otherJti,
        status: "RUNNING",
      });

      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "mismatch", currentJti: otherJti });
      expect(mockLogWarn).toHaveBeenCalledWith(
        "token_jti_mismatch_rejected",
        expect.objectContaining({
          event: "token_jti_mismatch_rejected",
          presentedJti: PRESENTED_JTI,
          currentJti: otherJti,
          route: ROUTE,
        })
      );
    });

    it("returns raced when CAS fails and re-read shows a completed terminal loop", async () => {
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindFirst.mockResolvedValueOnce({
        activeTokenJti: PRESENTED_JTI,
        status: "COMPLETED",
      });

      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "raced" });
    });
  });

  describe("mismatch branch", () => {
    it("returns mismatch and skips the database when currentJti differs from presentedJti", async () => {
      const result = await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: CURRENT_JTI,
        route: ROUTE,
      });

      expect(result).toEqual({ kind: "mismatch", currentJti: CURRENT_JTI });
      expect(mockWithDb).not.toHaveBeenCalled();
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("org-scoping structural assertion (CAS WHERE clause)", () => {
    it("includes organizationId in the CAS WHERE clause to prevent cross-org pinning", async () => {
      let capturedArgs: unknown;
      mockUpdateMany.mockImplementationOnce((args: unknown) => {
        capturedArgs = args;
        return Promise.resolve({ count: 1 });
      });

      await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      const args = capturedArgs as {
        where: {
          id: string;
          organizationId: string;
          activeTokenJti: null;
          status: { in: string[] };
        };
        data: { activeTokenJti: string };
      };

      expect(args.where).toEqual({
        id: LOOP_ID,
        organizationId: ORG_ID,
        activeTokenJti: null,
        status: { in: RUNNER_REQUEST_PINNABLE_STATUSES },
      });
    });

    it("scopes CAS to the correct loopId and organizationId pair", async () => {
      const differentOrgId = "org-different-789";
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });

      await enforceJtiOrPin({
        loopId: LOOP_ID,
        organizationId: differentOrgId,
        presentedJti: PRESENTED_JTI,
        currentJti: null,
        route: ROUTE,
      });

      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: differentOrgId,
          }),
        })
      );
    });
  });
});
