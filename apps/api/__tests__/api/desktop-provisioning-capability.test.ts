import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/desktop/provisioning-capability/route";
import {
  isDesktopManagedPopPlatformSupported,
  isDesktopManagedPopProvisioningEnabled,
} from "@/lib/desktop-managed-pop-provisioning";
import {
  createMockRequest,
  createTestAuthContext,
} from "../utils/auth-helpers";

let authContext = createTestAuthContext();

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(authContext, request, context?.params ?? Promise.resolve({})),
}));

vi.mock("@/lib/desktop-managed-pop-provisioning");

describe("GET /desktop/provisioning-capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authContext = createTestAuthContext();
    vi.mocked(isDesktopManagedPopPlatformSupported).mockImplementation(
      (platform) => platform === "darwin"
    );
    vi.mocked(isDesktopManagedPopProvisioningEnabled).mockResolvedValue(true);
  });

  it("returns enabled only for supported macOS platform plus enabled flag", async () => {
    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "https://api.closedloop.ai/desktop/provisioning-capability?platform=darwin",
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        automatedManagedProvisioningEnabled: true,
        supportedPlatform: "darwin",
      },
    });
    expect(isDesktopManagedPopProvisioningEnabled).toHaveBeenCalledWith(
      authContext.user.id,
      "darwin"
    );
  });

  it("fails closed for unsupported platforms even when the flag would be enabled", async () => {
    vi.mocked(isDesktopManagedPopProvisioningEnabled).mockResolvedValue(true);

    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "https://api.closedloop.ai/desktop/provisioning-capability?platform=linux",
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        automatedManagedProvisioningEnabled: false,
        supportedPlatform: null,
        unsupportedReason: "unsupported_platform",
      },
    });
    expect(isDesktopManagedPopProvisioningEnabled).not.toHaveBeenCalled();
  });
});
