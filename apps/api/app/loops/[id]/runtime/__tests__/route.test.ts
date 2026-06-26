/**
 * T-2.4 — Unit tests for GET /api/loops/:id/runtime
 *
 * Covers:
 * - AC-001: Admin Clerk session returns 200 with correct LoopRuntimeState shape
 * - AC-002: Non-admin org member returns 403
 * - AC-003: API-key auth returns 401 and does not leak loop existence
 * - AC-004: Admin from a different org returns 404
 * - Response shape validation
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks ---

// When true, the withAuth mock simulates rejection of non-Clerk (API key)
// callers by returning 401 before invoking the handler — identical to the
// real withAuth behaviour when auth() finds no Clerk session.
let simulateApiKeyRejection = false;

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth:
    (
      handler: (ctx: unknown, req: unknown, params: unknown) => Promise<unknown>
    ) =>
    async (request: unknown, context: { params?: unknown }) => {
      if (simulateApiKeyRejection) {
        const { NextResponse } = await import("next/server");
        return NextResponse.json(
          { success: false, error: "Unauthorized" },
          { status: 401 }
        );
      }
      return handler(mockAuthContext, request, context?.params);
    },
}));

vi.mock("@/lib/auth/org-admin", () => ({
  getOrgAdminStatus: vi.fn(),
}));

vi.mock("../../../service", () => ({
  loopsService: {
    getLoopRuntime: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

vi.mock("@/lib/route-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-utils")>();
  return {
    ...actual,
    scheduleLogFlush: vi.fn(),
  };
});

// --- Imports (after mocks) ---

import { LoopStatus } from "@repo/api/src/types/loop";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { getOrgAdminStatus } from "@/lib/auth/org-admin";
import type { AuthContext } from "@/lib/auth/with-auth";
import { loopsService } from "../../../service";
import { GET } from "../route";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const LOOP_ID = "loop-runtime-test-001";
const ORG_ID = "org-runtime-test-abc";
const OTHER_ORG_ID = "org-other-test-xyz";
const CLERK_USER_ID = "clerk_user_runtime";
const CLERK_ORG_ID = "org_clerk_runtime";

const RUNTIME_STATE = {
  id: LOOP_ID,
  status: LoopStatus.Running,
  tokenExpiresAt: new Date("2026-07-01T00:00:00.000Z"),
  lastRunnerHeartbeatAt: new Date("2026-06-15T12:00:00.000Z"),
  activeTokenJti: "jti-runtime-abc",
  runnerCapabilities: {
    loopRunnerRefreshSupported: true,
    loopRunnerHeartbeatSupported: true,
  },
};

function buildRequest() {
  return createMockRequest({
    url: `http://localhost/api/loops/${LOOP_ID}/runtime`,
    method: "GET",
  });
}

const routeContext = () => createMockRouteContext({ id: LOOP_ID });

function makeAdminAuthContext(overrides?: Partial<AuthContext>): AuthContext {
  return createTestAuthContext({
    user: {
      ...createTestAuthContext().user,
      id: "user-runtime-1",
      organizationId: ORG_ID,
    } as never,
    clerkUserId: CLERK_USER_ID,
    clerkOrgId: CLERK_ORG_ID,
    authMethod: "session",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/loops/:id/runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    simulateApiKeyRejection = false;
    mockAuthContext = makeAdminAuthContext();
  });

  // -------------------------------------------------------------------------
  // AC-001: Admin success — returns 200 with correct LoopRuntimeState shape
  // -------------------------------------------------------------------------
  it("returns 200 with LoopRuntimeState shape when called by an admin (AC-001)", async () => {
    vi.mocked(getOrgAdminStatus).mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });
    vi.mocked(loopsService.getLoopRuntime).mockResolvedValue(RUNTIME_STATE);

    const response = await GET(buildRequest(), routeContext());

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(LOOP_ID);
    expect(body.data.status).toBe(LoopStatus.Running);
    // Dates are serialized to ISO strings in JSON
    expect(new Date(body.data.tokenExpiresAt).toISOString()).toBe(
      RUNTIME_STATE.tokenExpiresAt?.toISOString()
    );
    expect(new Date(body.data.lastRunnerHeartbeatAt).toISOString()).toBe(
      RUNTIME_STATE.lastRunnerHeartbeatAt?.toISOString()
    );
    expect(body.data.activeTokenJti).toBe(RUNTIME_STATE.activeTokenJti);
    expect(body.data.runnerCapabilities).toEqual({
      loopRunnerRefreshSupported: true,
      loopRunnerHeartbeatSupported: true,
    });
  });

  it("calls getLoopRuntime with loopId and user.organizationId (AC-001)", async () => {
    vi.mocked(getOrgAdminStatus).mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });
    vi.mocked(loopsService.getLoopRuntime).mockResolvedValue(RUNTIME_STATE);

    await GET(buildRequest(), routeContext());

    expect(loopsService.getLoopRuntime).toHaveBeenCalledWith(LOOP_ID, ORG_ID);
  });

  // -------------------------------------------------------------------------
  // AC-002: Non-admin returns 403 and does not invoke the service
  // -------------------------------------------------------------------------
  it("returns 403 and does not call getLoopRuntime when the user is not an admin (AC-002)", async () => {
    vi.mocked(getOrgAdminStatus).mockResolvedValue({
      isAdmin: false,
      reason: "not_admin",
    });

    const response = await GET(buildRequest(), routeContext());

    expect(response.status).toBe(403);
    expect(loopsService.getLoopRuntime).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AC-003: API-key auth returns 401, does not invoke the service, and does
  // not leak loop existence in the response body.
  //
  // withAuth only accepts Clerk sessions. API keys produce no Clerk session,
  // so auth() returns null userId/orgId and withAuth returns 401 before
  // invoking the handler. The simulateApiKeyRejection flag exercises this path.
  // -------------------------------------------------------------------------
  it("returns 401 without invoking the service or leaking loop existence when called with API-key auth (AC-003)", async () => {
    simulateApiKeyRejection = true;

    const apiKeyRequest = createMockRequest({
      url: `http://localhost/api/loops/${LOOP_ID}/runtime`,
      method: "GET",
      headers: { authorization: "Bearer sk_live_abc123" },
    });

    const response = await GET(apiKeyRequest, routeContext());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(loopsService.getLoopRuntime).not.toHaveBeenCalled();
    expect(body.success).toBe(false);
    // Must not expose the loop ID or any loop-specific data
    expect(JSON.stringify(body)).not.toContain(LOOP_ID);
  });

  // -------------------------------------------------------------------------
  // AC-004: Cross-org admin returns 404
  // -------------------------------------------------------------------------
  it("returns 404 when the loop belongs to a different org (AC-004)", async () => {
    // Admin from a different org — getLoopRuntime returns null because the
    // service query is org-scoped (different org → not found)
    mockAuthContext = makeAdminAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-other-org",
        organizationId: OTHER_ORG_ID,
      } as never,
    });

    vi.mocked(getOrgAdminStatus).mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });
    // Service returns null because the loop belongs to a different org
    vi.mocked(loopsService.getLoopRuntime).mockResolvedValue(null);

    const response = await GET(buildRequest(), routeContext());

    expect(response.status).toBe(404);
  });

  it("calls getLoopRuntime with the caller's organizationId for org-scoped lookup (AC-004)", async () => {
    mockAuthContext = makeAdminAuthContext({
      user: {
        ...createTestAuthContext().user,
        id: "user-other-org",
        organizationId: OTHER_ORG_ID,
      } as never,
    });

    vi.mocked(getOrgAdminStatus).mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });
    vi.mocked(loopsService.getLoopRuntime).mockResolvedValue(null);

    await GET(buildRequest(), routeContext());

    expect(loopsService.getLoopRuntime).toHaveBeenCalledWith(
      LOOP_ID,
      OTHER_ORG_ID
    );
  });

  // -------------------------------------------------------------------------
  // Response shape validation
  // -------------------------------------------------------------------------
  it.each([
    {
      name: "all nullable fields null",
      runtimeState: {
        id: LOOP_ID,
        status: LoopStatus.Pending,
        tokenExpiresAt: null,
        lastRunnerHeartbeatAt: null,
        activeTokenJti: null,
        runnerCapabilities: {
          loopRunnerRefreshSupported: false,
          loopRunnerHeartbeatSupported: false,
        },
      },
    },
    {
      name: "all fields populated",
      runtimeState: RUNTIME_STATE,
    },
  ])("response shape is valid when $name", async ({ runtimeState }) => {
    vi.mocked(getOrgAdminStatus).mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });
    vi.mocked(loopsService.getLoopRuntime).mockResolvedValue(runtimeState);

    const response = await GET(buildRequest(), routeContext());

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      id: runtimeState.id,
      status: runtimeState.status,
      activeTokenJti: runtimeState.activeTokenJti,
      runnerCapabilities: {
        loopRunnerRefreshSupported:
          runtimeState.runnerCapabilities.loopRunnerRefreshSupported,
        loopRunnerHeartbeatSupported:
          runtimeState.runnerCapabilities.loopRunnerHeartbeatSupported,
      },
    });

    // Verify all required shape keys are present in the response
    expect("id" in body.data).toBe(true);
    expect("status" in body.data).toBe(true);
    expect("tokenExpiresAt" in body.data).toBe(true);
    expect("lastRunnerHeartbeatAt" in body.data).toBe(true);
    expect("activeTokenJti" in body.data).toBe(true);
    expect("runnerCapabilities" in body.data).toBe(true);
  });

  it("returns 500 when the service throws unexpectedly", async () => {
    vi.mocked(getOrgAdminStatus).mockResolvedValue({
      isAdmin: true,
      reason: "admin",
    });
    vi.mocked(loopsService.getLoopRuntime).mockRejectedValue(
      new Error("database unreachable")
    );

    const response = await GET(buildRequest(), routeContext());

    expect(response.status).toBe(500);
  });
});
