import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  auth: vi.fn(),
  verifyToken: vi.fn(),
  findOrganization: vi.fn(),
  findUser: vi.fn(),
  verifyKey: vi.fn(),
  getStatusSnapshot: vi.fn(),
  scheduleLogFlush: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  setAppSpanAttributes: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  getAuth: mocks.getAuth,
  auth: mocks.auth,
  verifyToken: mocks.verifyToken,
}));
vi.mock("@repo/auth/desktop-session-jwt", () => ({
  isDesktopSessionToken: () => false,
}));
vi.mock("@/lib/auth/desktop-session-auth", () => ({
  resolveDesktopSessionContext: vi.fn(),
}));
vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  getDesktopManagedPopRequestFailure: vi.fn(),
  resolveDesktopManagedPopMode: vi.fn(),
}));
vi.mock("@/lib/auth/resolve-org-header", () => ({
  resolveOrgHeader: async () => ({ kind: "resolved", clerkOrgId: "clerk-org" }),
}));
vi.mock("@/app/organizations/service", () => ({
  organizationsService: { findByClerkId: mocks.findOrganization },
}));
vi.mock("@/app/users/service", () => ({
  usersService: { findByClerkIdAndOrg: mocks.findUser },
}));
vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: { verifyKeyWithMetadata: mocks.verifyKey },
}));
vi.mock("@/lib/route-utils", () => ({
  logRequestCompleted: vi.fn(),
  scheduleLogFlush: mocks.scheduleLogFlush,
}));
vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: mocks.logWarn, info: vi.fn() },
}));
vi.mock("@repo/observability/tracing/spans", () => ({
  setAppSpanAttributes: mocks.setAppSpanAttributes,
}));
vi.mock("../service", () => ({
  computeTargetsService: { getStatusSnapshot: mocks.getStatusSnapshot },
}));
// Initial response tests do not run the established-stream poll loop. Its real
// timer and teardown coverage stays in route.test.ts.
vi.mock("@/lib/sse-stream", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sse-stream")>()),
  createSseStream: () =>
    new ReadableStream({ start: (controller) => controller.close() }),
  createSseResponse: (stream: ReadableStream) => new Response(stream),
  encodeSseData: vi.fn(),
  remainingStreamDurationMs: vi.fn(),
}));

import {
  authFailureThrottle,
  pollFailureThrottle,
  SNAPSHOT_FAILURE_LOG_INTERVAL_MS,
  snapshotFailureThrottle,
} from "./poll-helpers";
import { GET } from "./route";

const ORG_ID = "019d45b6-455c-7125-9274-0472e4d2e0ad";
const DB_ERROR = Object.assign(new Error("database unavailable"), {
  code: "ECONNREFUSED",
});
const request = (token?: string) =>
  new Request("https://api.test/compute-targets/status-stream", {
    headers: token
      ? {
          authorization: `Bearer ${token}`,
          "x-organization-id": "untrusted-org",
        }
      : {},
  });
const failureLogs = () =>
  mocks.logError.mock.calls
    .filter(([event]) => event === "compute_target_status_snapshot_failed")
    .map(([, fields]) => fields);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
  vi.stubEnv("CLERK_SECRET_KEY", "sk_test_123");
  vi.resetAllMocks();
  mocks.getAuth.mockReturnValue({ userId: "clerk-user", orgId: "clerk-org" });
  mocks.auth.mockResolvedValue({ userId: null, orgId: null });
  mocks.verifyToken.mockResolvedValue({
    sub: "clerk-user",
    org_id: "clerk-org",
  });
  mocks.findOrganization.mockResolvedValue({ id: ORG_ID });
  mocks.findUser.mockResolvedValue({ id: "user-db", active: true });
  mocks.getStatusSnapshot.mockResolvedValue(new Map());
  authFailureThrottle.clear();
  pollFailureThrottle.clear();
  snapshotFailureThrottle.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("initial status-stream failures through the real auth resolver", () => {
  it("flushes only emitted snapshot failures while attributing every existing request span", async () => {
    mocks.getStatusSnapshot.mockRejectedValue(DB_ERROR);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await GET(request());
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        code: "compute_target_status_snapshot_failed",
      });
    }
    expect(mocks.getStatusSnapshot).toHaveBeenCalledTimes(3);
    expect(failureLogs()).toHaveLength(1);
    expect(failureLogs()[0].organizationId).toBe(ORG_ID);
    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
    expect(mocks.setAppSpanAttributes).toHaveBeenCalledTimes(3);
    expect(mocks.setAppSpanAttributes).toHaveBeenLastCalledWith({
      "app.error.source": "route_handler",
      "error.type": "Error.ECONNREFUSED",
    });
  });

  it("drains a recovered org's expired suppressed failures on a successful request", async () => {
    mocks.getStatusSnapshot
      .mockRejectedValueOnce(DB_ERROR)
      .mockRejectedValueOnce(DB_ERROR);
    await GET(request());
    await GET(request());
    vi.advanceTimersByTime(SNAPSHOT_FAILURE_LOG_INTERVAL_MS * 2);
    expect((await GET(request())).status).toBe(200);
    expect(failureLogs()).toHaveLength(2);
    expect(failureLogs()[1]).toEqual({
      organizationId: ORG_ID,
      occurrences: 1,
      aggregated: true,
      flushedBy: "expiry",
    });
    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(2);
  });

  it("does not flush when draining an expired entry with no suppressed failures", async () => {
    mocks.getStatusSnapshot.mockRejectedValueOnce(DB_ERROR);
    await GET(request());
    vi.advanceTimersByTime(SNAPSHOT_FAILURE_LOG_INTERVAL_MS * 2);
    await GET(request());
    expect(failureLogs()).toHaveLength(1);
    expect(mocks.scheduleLogFlush).toHaveBeenCalledTimes(1);
  });

  it("keeps the coded snapshot 500 when record throws", async () => {
    mocks.getStatusSnapshot.mockRejectedValue(DB_ERROR);
    const record = vi
      .spyOn(snapshotFailureThrottle, "record")
      .mockImplementationOnce(() => {
        throw new Error("throttle exploded");
      });
    const response = await GET(request());
    expect(record).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "compute_target_status_snapshot_failed",
    });
    expect(mocks.logWarn).toHaveBeenCalledOnce();
    expect(mocks.scheduleLogFlush).toHaveBeenCalledOnce();
  });

  it("keeps the response when expiry drain throws", async () => {
    const drain = vi
      .spyOn(snapshotFailureThrottle, "drainExpired")
      .mockImplementationOnce(() => {
        throw new Error("drain exploded");
      });
    expect((await GET(request())).status).toBe(200);
    expect(drain).toHaveBeenCalledOnce();
    expect(mocks.logWarn).toHaveBeenCalledOnce();
    expect(mocks.scheduleLogFlush).toHaveBeenCalledOnce();
  });

  it.each(["request", "bearer", "api-key"])(
    "reports a total auth DB outage via %s without inventing an org",
    async (mode) => {
      mocks.findOrganization.mockRejectedValue(DB_ERROR);
      mocks.verifyKey.mockRejectedValue(DB_ERROR);
      if (mode === "bearer") {
        mocks.getAuth.mockReturnValue({ userId: null, orgId: null });
      }
      const token = mode === "api-key" ? "sk_live_example" : "clerk-token";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await GET(request(token));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          success: false,
          error: "Authentication failed",
        });
      }
      expect(mocks.getStatusSnapshot).not.toHaveBeenCalled();
      expect(failureLogs()).toEqual([
        {
          phase: "auth",
          suppressedSinceLastReport: 0,
          error: "database unavailable",
        },
      ]);
      expect(mocks.scheduleLogFlush).toHaveBeenCalledOnce();
      expect(mocks.setAppSpanAttributes).toHaveBeenLastCalledWith({
        "app.error.source": "auth_wrapper",
        "error.type": "Error.ECONNREFUSED",
      });
    }
  );

  it("keeps invalid bearer tokens at 401 without claiming a database outage", async () => {
    mocks.getAuth.mockReturnValue({ userId: null, orgId: null });
    mocks.verifyToken.mockRejectedValue(new Error("invalid signature"));
    expect((await GET(request("bad-token"))).status).toBe(401);
    expect(mocks.findOrganization).not.toHaveBeenCalled();
    expect(mocks.getStatusSnapshot).not.toHaveBeenCalled();
    expect(failureLogs()).toHaveLength(0);
    expect(mocks.scheduleLogFlush).not.toHaveBeenCalled();
  });
});
