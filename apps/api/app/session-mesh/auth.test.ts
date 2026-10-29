import { isFeatureFlagEnabledForDistinctId } from "@repo/analytics/feature-flags";
import { SESSION_MESH_V1_FEATURE_FLAG_KEY } from "@repo/api/src/types/session-mesh-flag";
import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  createMockRequest,
  createMockRouteContext,
} from "@/__tests__/utils/auth-helpers";
import type { AuthenticatedHandler, RouteContext } from "@/lib/auth/with-auth";
import { successResponse } from "@/lib/route-utils";
import { withSessionMeshAuth } from "./auth";

vi.mock("@repo/analytics/feature-flags", () => ({
  isFeatureFlagEnabledForDistinctId: vi.fn(),
}));
vi.mock("@/lib/auth/with-any-auth", async () => {
  const { createTestAuthContext } = await import(
    "@/__tests__/utils/auth-helpers"
  );
  return {
    withAnyAuth:
      (handler: AuthenticatedHandler<unknown>) =>
      (request: NextRequest, context: RouteContext) =>
        handler(createTestAuthContext(), request, context.params),
  };
});

describe("Session Mesh cloud rollout gate", () => {
  it.each([false, null, undefined])(
    "does no Mesh work for a non-enabled assignment (%s)",
    async (assignment) => {
      vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(
        assignment ?? null
      );
      const work = vi.fn(async () => successResponse({ recorded: true }));
      const response = await withSessionMeshAuth(work)(
        createMockRequest(),
        createMockRouteContext({})
      );
      expect(response.status).toBe(403);
      expect(work).not.toHaveBeenCalled();
    }
  );

  it("uses the same key and signed-in identity as the web/Desktop UI", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockResolvedValue(true);
    const work = vi.fn(async () => successResponse({ recorded: true }));
    const response = await withSessionMeshAuth(work)(
      createMockRequest(),
      createMockRouteContext({})
    );
    expect(response.status).toBe(200);
    expect(work).toHaveBeenCalledOnce();
    expect(isFeatureFlagEnabledForDistinctId).toHaveBeenCalledWith(
      SESSION_MESH_V1_FEATURE_FLAG_KEY,
      "clerk_test_user"
    );
  });

  it("does no Mesh work when flag evaluation is unavailable", async () => {
    vi.mocked(isFeatureFlagEnabledForDistinctId).mockRejectedValue(
      new Error("flag server offline")
    );
    const work = vi.fn(async () => successResponse({ recorded: true }));
    const response = await withSessionMeshAuth(work)(
      createMockRequest(),
      createMockRouteContext({})
    );
    expect(response.status).toBe(403);
    expect(work).not.toHaveBeenCalled();
  });
});
