import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));

vi.mock("@/lib/loops/compute-target-route-helpers", () => ({
  resolveComputeTargetForRoute: vi.fn(),
}));

vi.mock("@/lib/loops/explicit-compute-selection", () => ({
  isExplicitComputeSelectionRequired: vi.fn(),
}));

vi.mock("../../service", async () => {
  const actual =
    await vi.importActual<typeof import("../../service")>("../../service");
  return {
    ...actual,
    loopsService: {
      ...actual.loopsService,
      resume: vi.fn(),
      findById: vi.fn(),
    },
  };
});

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  launchLoop: vi.fn(),
}));

// The real `buildMissingAnthropicApiKeyResponse` runs; only its outbound edge
// is stubbed, so the route's Cloud-vs-Local decision is the production one.
vi.mock("@/app/settings/api-key-service", () => ({
  apiKeyService: { resolveApiKey: vi.fn() },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

// --- Imports (after mocks) ---

import { LoopStatus } from "@repo/api/src/types/loop";
import { NextResponse } from "next/server";
import { apiKeyService } from "@/app/settings/api-key-service";
import { resolveComputeTargetForRoute } from "@/lib/loops/compute-target-route-helpers";
import { isExplicitComputeSelectionRequired } from "@/lib/loops/explicit-compute-selection";
import { MISSING_ANTHROPIC_API_KEY_MESSAGE } from "@/lib/loops/loop-dispatch-utils";
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
  vi.mocked(isExplicitComputeSelectionRequired).mockResolvedValue(false);

  // Default: loopsService.findById returns a parent loop (no desktop target)
  vi.mocked(loopsService.findById).mockResolvedValue({
    id: LOOP_ID,
    computeTargetId: null,
    s3StateKey: null,
  } as any);

  // Default: loopsService.resume returns a new loop
  vi.mocked(loopsService.resume).mockResolvedValue({
    loopId: "new-id",
    status: LoopStatus.Pending,
  });

  // Default: launchLoop resolves with a task ARN string
  vi.mocked(launchLoop).mockResolvedValue("mock-task-arn");

  // Default: the Cloud pre-flight finds a key, so it never short-circuits.
  vi.mocked(apiKeyService.resolveApiKey).mockResolvedValue("sk-ant-test");
});

describe("POST /loops/[id]/resume", () => {
  it("does not call resolveComputeTargetForRoute when parent has no compute target", async () => {
    vi.mocked(loopsService.findById).mockResolvedValue({
      id: LOOP_ID,
      computeTargetId: null,
    } as any);

    const response = await POST(
      createMockRequest({
        url: `http://localhost:3002/loops/${LOOP_ID}/resume`,
        method: "POST",
        body: {},
      }),
      createMockRouteContext({ id: LOOP_ID })
    );

    expect(response.status).toBe(200);
    expect(resolveComputeTargetForRoute).not.toHaveBeenCalled();
  });

  it("refuses a keyless Cloud resume before it creates the child loop", async () => {
    // The side effect, not the status code, is the point: the dispatch below
    // would surface the missing key anyway, but only checking first stops every
    // retry inserting another child loop purely to cancel it a moment later.
    // `loopsService.resume` persists `computeTargetId ?? null`, so an
    // unresolved target here really is an ECS child that needs a cloud key.
    vi.mocked(apiKeyService.resolveApiKey).mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        url: `http://localhost:3002/loops/${LOOP_ID}/resume`,
        method: "POST",
        body: {},
      }),
      createMockRouteContext({ id: LOOP_ID })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: MISSING_ANTHROPIC_API_KEY_MESSAGE,
    });
    expect(apiKeyService.resolveApiKey).toHaveBeenCalledWith(USER_ID, ORG_ID);
    expect(loopsService.resume).not.toHaveBeenCalled();
    expect(launchLoop).not.toHaveBeenCalled();
  });

  it("does not run the cloud key pre-flight for a Local resume", async () => {
    // Positive control for the assertion above: Local runs resolve the key on
    // the desktop machine, so blocking them on a cloud-side key would be wrong.
    // Without this, a pre-flight that refused *everything* would still pass the
    // keyless test.
    vi.mocked(apiKeyService.resolveApiKey).mockResolvedValue(null);
    vi.mocked(loopsService.findById).mockResolvedValue({
      id: LOOP_ID,
      computeTargetId: VALID_COMPUTE_TARGET_UUID,
    } as any);
    vi.mocked(resolveComputeTargetForRoute).mockResolvedValue({
      computeTargetId: VALID_COMPUTE_TARGET_UUID,
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
    expect(apiKeyService.resolveApiKey).not.toHaveBeenCalled();
    expect(loopsService.resume).toHaveBeenCalledTimes(1);
  });

  it("validates inherited compute target and passes it to resume", async () => {
    vi.mocked(loopsService.findById).mockResolvedValue({
      id: LOOP_ID,
      computeTargetId: VALID_COMPUTE_TARGET_UUID,
    } as any);
    vi.mocked(resolveComputeTargetForRoute).mockResolvedValue({
      computeTargetId: VALID_COMPUTE_TARGET_UUID,
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
    expect(resolveComputeTargetForRoute).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      VALID_COMPUTE_TARGET_UUID
    );
    expect(loopsService.resume).toHaveBeenCalledWith(
      LOOP_ID,
      ORG_ID,
      USER_ID,
      {},
      VALID_COMPUTE_TARGET_UUID
    );
  });

  it("falls back to cloud when inherited compute target is inaccessible and explicit selection is disabled", async () => {
    vi.mocked(loopsService.findById).mockResolvedValue({
      id: LOOP_ID,
      computeTargetId: VALID_COMPUTE_TARGET_UUID,
    } as any);
    vi.mocked(resolveComputeTargetForRoute).mockResolvedValue({
      errorResponse: NextResponse.json(
        { success: false, error: "Compute target is offline" },
        { status: 400 }
      ),
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
    expect(isExplicitComputeSelectionRequired).toHaveBeenCalledWith({
      clerkUserId: mockAuthContext.user.clerkId,
      userId: USER_ID,
    });
    expect(loopsService.resume).toHaveBeenCalledWith(
      LOOP_ID,
      ORG_ID,
      USER_ID,
      {},
      undefined
    );
    // The resume route now dispatches through `dispatchAndClassify`, which
    // forwards a third `LaunchLoopOptions` argument. Resume passes none, so it
    // arrives as `undefined` — asserted explicitly so a future route change
    // that starts sending real options cannot slip past this expectation.
    expect(launchLoop).toHaveBeenCalledWith("new-id", ORG_ID, undefined);
  });

  it("returns the resolver error when inherited compute target is inaccessible and explicit selection is enabled", async () => {
    vi.mocked(isExplicitComputeSelectionRequired).mockResolvedValue(true);
    vi.mocked(loopsService.findById).mockResolvedValue({
      id: LOOP_ID,
      computeTargetId: VALID_COMPUTE_TARGET_UUID,
    } as any);
    vi.mocked(resolveComputeTargetForRoute).mockResolvedValue({
      errorResponse: NextResponse.json(
        { success: false, error: "Compute target is offline" },
        { status: 400 }
      ),
    });

    const response = await POST(
      createMockRequest({
        url: `http://localhost:3002/loops/${LOOP_ID}/resume`,
        method: "POST",
        body: {},
      }),
      createMockRouteContext({ id: LOOP_ID })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Compute target is offline",
    });
    expect(loopsService.resume).not.toHaveBeenCalled();
    expect(launchLoop).not.toHaveBeenCalled();
  });

  it("returns the no-online-targets resolver error when explicit selection is enabled", async () => {
    vi.mocked(isExplicitComputeSelectionRequired).mockResolvedValue(true);
    vi.mocked(loopsService.findById).mockResolvedValue({
      id: LOOP_ID,
      computeTargetId: VALID_COMPUTE_TARGET_UUID,
    } as any);
    vi.mocked(resolveComputeTargetForRoute).mockResolvedValue({
      errorResponse: NextResponse.json(
        { success: false, error: "No compute targets are online" },
        { status: 400 }
      ),
    });

    const response = await POST(
      createMockRequest({
        url: `http://localhost:3002/loops/${LOOP_ID}/resume`,
        method: "POST",
        body: {},
      }),
      createMockRouteContext({ id: LOOP_ID })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "No compute targets are online",
    });
    expect(loopsService.resume).not.toHaveBeenCalled();
    expect(launchLoop).not.toHaveBeenCalled();
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
