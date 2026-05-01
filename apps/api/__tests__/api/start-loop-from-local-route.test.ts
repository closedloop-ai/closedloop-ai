import { vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

const mockState = vi.hoisted(() => ({
  authContext: undefined as AuthContext | undefined,
  startPlanLoopFromLocal: vi.fn(),
  launchPlanLoop: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockState.authContext, request, context?.params),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/documents/execution-service", () => {
  return {
    documentExecutionService: {
      startPlanLoopFromLocal: mockState.startPlanLoopFromLocal,
    },
  };
});

vi.mock("@/lib/loops/launch-plan-loop", () => {
  return {
    launchPlanLoop: mockState.launchPlanLoop,
  };
});

import { beforeEach, describe, expect, it } from "vitest";
import { documentExecutionService } from "@/app/documents/execution-service";
import { POST } from "@/app/plans/start-loop-from-local/route";
import { launchPlanLoop } from "@/lib/loops/launch-plan-loop";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const requestBody = {
  featureId: "11111111-1111-4111-8111-111111111111",
  computeTargetId: "22222222-2222-4222-8222-222222222222",
  localRepoPath: "/tmp/repo",
};

const readyToLaunchResult = {
  outcome: "ready-to-launch",
  documentId: "33333333-3333-4333-8333-333333333333",
  documentSlug: "impl-plan",
  document: {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "impl-plan",
    title: "Implementation plan",
  },
} as const;

describe("POST /plans/start-loop-from-local", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.authContext = createTestAuthContext({
      user: { id: "user-1", organizationId: "org-1" } as any,
    });

    vi.mocked(
      documentExecutionService.startPlanLoopFromLocal
    ).mockResolvedValue(readyToLaunchResult as any);
  });

  it("returns a callback-specific actionable message for callback_unavailable failures", async () => {
    vi.mocked(launchPlanLoop).mockResolvedValue({
      ok: false,
      error: "callback_unavailable",
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/plans/start-loop-from-local",
        body: requestBody,
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe(
      "Loop dispatch failed because the desktop app could not reach the cloud callback endpoint. Check cloud connection in the desktop app and retry."
    );
  });

  it("keeps generic launch_failed messaging unchanged", async () => {
    vi.mocked(launchPlanLoop).mockResolvedValue({
      ok: false,
      error: "launch_failed",
    });

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/plans/start-loop-from-local",
        body: requestBody,
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe(
      "Loop dispatch failed. The desktop app may be disconnected."
    );
  });
});
