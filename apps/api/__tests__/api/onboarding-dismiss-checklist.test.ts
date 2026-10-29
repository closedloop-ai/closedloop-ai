/**
 * Route test for PUT /onboarding/dismiss-checklist.
 *
 * ISS-5991: dismissal is per-user, so the route must hand the service the
 * caller's own id alongside the organization id — an org-scoped call would hide
 * the checklist for every member.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";

// --- Mocks (must come before imports) ---

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context?: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/app/onboarding/service");

// --- Imports (after mocks) ---

import { PUT } from "@/app/onboarding/dismiss-checklist/route";
import { onboardingService } from "@/app/onboarding/service";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

const dismissRequest = () =>
  createMockRequest({
    method: "PUT",
    url: "http://localhost:3002/onboarding/dismiss-checklist",
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  vi.mocked(onboardingService.dismissChecklist).mockResolvedValue({
    wizardCompleted: true,
    checklistDismissed: true,
    checklist: [],
  });
});

describe("PUT /onboarding/dismiss-checklist", () => {
  it("dismisses for the calling user, not just the organization", async () => {
    const response = await PUT(dismissRequest(), createMockRouteContext({}));

    expect(response.status).toBe(200);
    expect(onboardingService.dismissChecklist).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      undefined
    );
  });

  it("scopes the dismissal to whichever member is calling", async () => {
    mockAuthContext = createTestAuthContext({
      user: { ...createTestAuthContext().user, id: "other-member-id" },
    });

    await PUT(dismissRequest(), createMockRouteContext({}));

    expect(onboardingService.dismissChecklist).toHaveBeenCalledWith(
      mockAuthContext.user.organizationId,
      "other-member-id",
      undefined
    );
  });

  it("returns the caller's dismissed status in the response body", async () => {
    const response = await PUT(dismissRequest(), createMockRouteContext({}));
    const body = await response.json();

    expect(body.data.checklistDismissed).toBe(true);
  });
});
