/**
 * PR #1174 — authenticateLoopRunnerRequest ordering tests.
 *
 * The orchestrator must extract+verify the Bearer JWT BEFORE any DB lookup,
 * so unauthenticated callers cannot use the endpoint as a loop-existence
 * oracle and malformed tokens never trigger DB I/O.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindRunnerAuthData, mockVerifyToken, mockWithDb } = vi.hoisted(
  () => ({
    mockFindRunnerAuthData: vi.fn(),
    mockVerifyToken: vi.fn(),
    mockWithDb: vi.fn(),
  })
);

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@repo/observability/error", () => ({
  parseError: (e: unknown) => String(e),
}));

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

vi.mock("@repo/auth/loop-runner-jwt", () => ({
  verifyLoopRunnerToken: mockVerifyToken,
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: { findRunnerAuthData: mockFindRunnerAuthData },
}));

import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";

const LOOP_ID = "loop-abc-123";
const ORG_ID = "org-xyz-456";
const ROUTE = "/loops/loop-abc-123/events";
const JTI = "jti-runner-001";

function createRequest(authorization?: string): Request {
  const headers = new Headers();
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return new Request("https://api.closedloop.ai/loops/loop-abc-123/events", {
    headers,
    method: "POST",
  });
}

describe("authenticateLoopRunnerRequest — verify-before-DB ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({
        loop: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      })
    );
  });

  it("returns 401 and skips findRunnerAuthData when the Authorization header is missing", async () => {
    const response = (await authenticateLoopRunnerRequest(
      createRequest(),
      LOOP_ID,
      ROUTE
    )) as Response;

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(401);
    expect(mockFindRunnerAuthData).not.toHaveBeenCalled();
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it("returns 401 and skips findRunnerAuthData when verifyLoopRunnerToken throws", async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error("bad signature"));

    const response = (await authenticateLoopRunnerRequest(
      createRequest("Bearer garbage-token"),
      LOOP_ID,
      ROUTE
    )) as Response;

    expect(response.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledWith("garbage-token");
    expect(mockFindRunnerAuthData).not.toHaveBeenCalled();
  });

  it("returns 403 and skips findRunnerAuthData when the loopId claim does not match the URL param", async () => {
    mockVerifyToken.mockResolvedValueOnce({
      loopId: "different-loop",
      organizationId: ORG_ID,
      tokenId: JTI,
    });

    const response = (await authenticateLoopRunnerRequest(
      createRequest("Bearer valid"),
      LOOP_ID,
      ROUTE
    )) as Response;

    expect(response.status).toBe(403);
    expect(mockFindRunnerAuthData).not.toHaveBeenCalled();
  });

  it("returns 403 only after JWT verification for an unknown loopId (no existence oracle)", async () => {
    mockVerifyToken.mockResolvedValueOnce({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      tokenId: JTI,
    });
    mockFindRunnerAuthData.mockResolvedValueOnce(null);

    const response = (await authenticateLoopRunnerRequest(
      createRequest("Bearer valid"),
      LOOP_ID,
      ROUTE
    )) as Response;

    expect(response.status).toBe(403);
    expect(mockVerifyToken).toHaveBeenCalledTimes(1);
    expect(mockFindRunnerAuthData).toHaveBeenCalledWith(LOOP_ID);
  });

  it("returns 403 on org mismatch between the JWT claim and the loop record", async () => {
    mockVerifyToken.mockResolvedValueOnce({
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      tokenId: JTI,
    });
    mockFindRunnerAuthData.mockResolvedValueOnce({
      organizationId: "different-org",
      activeTokenJti: JTI,
      status: "RUNNING",
    });

    const response = (await authenticateLoopRunnerRequest(
      createRequest("Bearer valid"),
      LOOP_ID,
      ROUTE
    )) as Response;

    expect(response.status).toBe(403);
  });

  it("does not globally reject a terminal loop when the presented JTI already matches", async () => {
    const claims = {
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      tokenId: JTI,
    };
    mockVerifyToken.mockResolvedValueOnce(claims);
    mockFindRunnerAuthData.mockResolvedValueOnce({
      organizationId: ORG_ID,
      activeTokenJti: JTI,
      status: "COMPLETED",
    });

    const response = await authenticateLoopRunnerRequest(
      createRequest("Bearer valid"),
      LOOP_ID,
      ROUTE
    );

    expect(response).toEqual(claims);
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("returns the verified claims on the happy path", async () => {
    const claims = {
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      tokenId: JTI,
    };
    mockVerifyToken.mockResolvedValueOnce(claims);
    mockFindRunnerAuthData.mockResolvedValueOnce({
      organizationId: ORG_ID,
      activeTokenJti: JTI,
      status: "RUNNING",
    });

    const result = await authenticateLoopRunnerRequest(
      createRequest("Bearer valid"),
      LOOP_ID,
      ROUTE
    );

    expect(result).toEqual(claims);
  });
});
