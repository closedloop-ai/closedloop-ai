import { vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/lib/loops/compute-target-route-helpers", () => ({
  resolveComputeTargetForRoute: vi.fn(),
}));

vi.mock("../../service", async () => {
  const actual =
    await vi.importActual<typeof import("../../service")>("../../service");
  return {
    ...actual,
    loopsService: {
      ...actual.loopsService,
      resume: vi.fn(),
    },
  };
});

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  launchLoop: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Imports (after mocks) ---

import { LoopStatus } from "@repo/api/src/types/loop";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveComputeTargetForRoute } from "@/lib/loops/compute-target-route-helpers";
import { launchLoop } from "@/lib/loops/loop-orchestrator";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../../__tests__/utils/auth-helpers";
import { loopsService } from "../../service";
import { POST } from "./route";

const LOOP_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORG_ID = "test-org-id";
const USER_ID = "test-user-id";
const VALID_COMPUTE_TARGET_UUID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    user: {
      id: USER_ID,
      organizationId: ORG_ID,
    } as any,
    authMethod: "session",
    apiKeyScopes: undefined,
  });

  // Default: resolveComputeTargetForRoute returns a resolved target
  vi.mocked(resolveComputeTargetForRoute).mockResolvedValue({
    computeTargetId: undefined,
  });

  // Default: loopsService.resume returns a new loop
  vi.mocked(loopsService.resume).mockResolvedValue({
    loopId: "new-id",
    status: LoopStatus.Pending,
  });

  // Default: launchLoop resolves with a task ARN string
  vi.mocked(launchLoop).mockResolvedValue("mock-task-arn");
});

describe("POST /loops/[id]/resume", () => {
  it("calls resolveComputeTargetForRoute with (organizationId, userId, undefined) when no body", async () => {
    const response = await POST(
      createMockRequest({
        url: `http://localhost:3002/loops/${LOOP_ID}/resume`,
        method: "POST",
        body: {},
      }),
      createMockRouteContext({ id: LOOP_ID })
    );

    expect(response.status).toBe(200);
    expect(resolveComputeTargetForRoute).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      undefined
    );
  });

  it("returns HTTP 400 when computeTargetId is not a valid UUID", async () => {
    const response = await POST(
      createMockRequest({
        url: `http://localhost:3002/loops/${LOOP_ID}/resume`,
        method: "POST",
        body: { computeTargetId: "not-a-uuid" },
      }),
      createMockRouteContext({ id: LOOP_ID })
    );

    expect(response.status).toBe(400);
    expect(resolveComputeTargetForRoute).not.toHaveBeenCalled();
  });

  it("returns the resolver error response when computeTargetId hint is not found", async () => {
    vi.mocked(resolveComputeTargetForRoute).mockResolvedValue({
      errorResponse: NextResponse.json(
        { success: false, error: "Compute target not found" },
        { status: 404 }
      ),
    });

    const response = await POST(
      createMockRequest({
        url: `http://localhost:3002/loops/${LOOP_ID}/resume`,
        method: "POST",
        body: { computeTargetId: VALID_COMPUTE_TARGET_UUID },
      }),
      createMockRouteContext({ id: LOOP_ID })
    );

    expect(response.status).toBe(404);
    expect(resolveComputeTargetForRoute).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      VALID_COMPUTE_TARGET_UUID
    );
    expect(loopsService.resume).not.toHaveBeenCalled();
  });

  it("returns 200 with loopId when called with API key auth context", async () => {
    mockAuthContext = createTestAuthContext({
      user: {
        id: USER_ID,
        organizationId: ORG_ID,
      } as any,
      authMethod: "api_key",
      apiKeyScopes: ["write"],
    });

    const response = await POST(
      createMockRequest({
        url: `http://localhost:3002/loops/${LOOP_ID}/resume`,
        method: "POST",
        body: {},
      }),
      createMockRouteContext({ id: LOOP_ID })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.loopId).toBe("new-id");
  });
});
