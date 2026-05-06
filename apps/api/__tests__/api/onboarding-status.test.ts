/**
 * Integration test for GET /onboarding with a desktop managed API key.
 *
 * Verifies AC-002: the response includes `wizardCompleted: boolean` when called
 * with a desktop managed API key (authMethod: "api_key"), supporting FR6 auto-suppress
 * of the desktop onboarding popup.
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/app/onboarding/service");

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/onboarding/route";
import { onboardingService } from "@/app/onboarding/service";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    authMethod: "api_key",
    apiKeyScopes: ["read"],
  });
});

describe("GET /onboarding with a desktop managed API key", () => {
  it("returns wizardCompleted: true when the wizard is complete", async () => {
    vi.mocked(onboardingService.getStatus).mockResolvedValue({
      wizardCompleted: true,
      checklistDismissed: false,
      checklist: [],
    });

    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:3002/onboarding",
        headers: {
          authorization: "Bearer sk_live_desktop_managed_key",
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(typeof json.data.wizardCompleted).toBe("boolean");
    expect(json.data.wizardCompleted).toBe(true);
    expect(onboardingService.getStatus).toHaveBeenCalledWith("test-org-id");
  });

  it("returns wizardCompleted: false when the wizard is not yet complete", async () => {
    vi.mocked(onboardingService.getStatus).mockResolvedValue({
      wizardCompleted: false,
      checklistDismissed: false,
      checklist: [],
    });

    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:3002/onboarding",
        headers: {
          authorization: "Bearer sk_live_desktop_managed_key",
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(typeof json.data.wizardCompleted).toBe("boolean");
    expect(json.data.wizardCompleted).toBe(false);
    expect(onboardingService.getStatus).toHaveBeenCalledWith("test-org-id");
  });

  it("returns 500 when the onboarding service throws", async () => {
    vi.mocked(onboardingService.getStatus).mockRejectedValue(
      new Error("Database unavailable")
    );

    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:3002/onboarding",
        headers: {
          authorization: "Bearer sk_live_desktop_managed_key",
        },
      }),
      createMockRouteContext({})
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.success).toBe(false);
  });
});
