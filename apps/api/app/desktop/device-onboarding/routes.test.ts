import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopDeviceOnboardingService: {
    start: vi.fn(),
    poll: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    getByUserCode: vi.fn(),
  },
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
  resolveSessionUser: vi.fn(),
}));

vi.mock("./service", () => ({
  desktopDeviceOnboardingService: mocks.desktopDeviceOnboardingService,
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  isDesktopManagedPopEnforcementEnabled:
    mocks.isDesktopManagedPopEnforcementEnabled,
}));

vi.mock("@/lib/auth/session-user", () => ({
  resolveSessionUser: mocks.resolveSessionUser,
}));

import { POST as approvePOST } from "./approve/route";
import { POST as pollPOST } from "./poll/route";
import { GET as sessionGET } from "./session/route";
import { POST as startPOST } from "./start/route";

const gatewayId = "019dd545-b11d-444d-9956-0310752e2481";
const deviceSessionId = "019dd545-9926-7447-99fe-2671bf53acb1";

function publicKeyPem(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

function jsonRequest(body: unknown, headers?: HeadersInit): Request {
  return new Request("https://api.closedloop.ai/desktop/device-onboarding", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("Desktop device-onboarding route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(true);
    mocks.resolveSessionUser.mockResolvedValue({
      clerkUserId: "clerk-user-1",
      user: {
        id: "user-1",
        organizationId: "org-1",
      },
    });
  });

  it("returns an exact retryable rate-limit contract on start", async () => {
    mocks.desktopDeviceOnboardingService.start.mockResolvedValue({
      status: "rate_limited",
    });

    const response = await startPOST(
      jsonRequest(
        {
          webAppOrigin: "http://localhost:3000",
          gatewayId,
          gatewayPublicKeyPem: publicKeyPem(),
          machineName: "Daniel-MBP",
          platform: "darwin",
          desktopVersion: "0.13.22",
          desktopSecurityUpgradeProtocolVersion: 1,
        },
        { "x-forwarded-for": "203.0.113.10, 10.0.0.1" }
      )
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_RATE_LIMITED",
      retryable: true,
    });
    expect(mocks.desktopDeviceOnboardingService.start).toHaveBeenCalledWith(
      expect.objectContaining({ requestIp: "203.0.113.10" })
    );
  });

  it("returns an exact retryable poll failure when persistence throws", async () => {
    mocks.desktopDeviceOnboardingService.poll.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await pollPOST(
      jsonRequest({
        deviceSessionId,
        deviceSessionSecret: "secret",
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_POLL_FAILED",
      retryable: true,
    });
  });

  it("returns an exact retryable approval failure when persistence throws", async () => {
    mocks.desktopDeviceOnboardingService.approve.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await approvePOST(
      jsonRequest({
        userCode: "ABCD1234",
        action: "approve",
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_APPROVAL_FAILED",
      retryable: true,
    });
  });

  it("returns an exact retryable deny failure when persistence throws", async () => {
    mocks.desktopDeviceOnboardingService.deny.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await approvePOST(
      jsonRequest({
        userCode: "ABCD1234",
        action: "deny",
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_APPROVAL_FAILED",
      retryable: true,
    });
    expect(mocks.desktopDeviceOnboardingService.deny).toHaveBeenCalledWith({
      userCode: "ABCD1234",
      organizationId: "org-1",
      userId: "user-1",
    });
  });

  it("returns an exact retryable session lookup failure when persistence throws", async () => {
    mocks.desktopDeviceOnboardingService.getByUserCode = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));

    const response = await sessionGET(
      new Request(
        "https://api.closedloop.ai/desktop/device-onboarding/session?code=ABCD1234"
      )
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_LOOKUP_FAILED",
      retryable: true,
    });
  });

  it("blocks approval before mutation when the rollout flag is disabled", async () => {
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);

    const response = await approvePOST(
      jsonRequest({
        userCode: "ABCD1234",
        action: "approve",
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_SECURITY_UPGRADE_DISABLED",
      retryable: false,
    });
    expect(mocks.desktopDeviceOnboardingService.approve).not.toHaveBeenCalled();
  });
});
