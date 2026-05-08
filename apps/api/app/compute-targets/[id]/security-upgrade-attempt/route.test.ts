import { DesktopSecurityStatus } from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSessionUser: vi.fn(),
  findOwnedById: vi.fn(),
  createAttempt: vi.fn(),
  createCommand: vi.fn(),
  markCommandExpired: vi.fn(),
  dispatchRelayCommandToRelay: vi.fn(),
  toRelayOperation: vi.fn(),
}));

vi.mock("@/lib/auth/session-user", () => ({
  resolveSessionUser: mocks.resolveSessionUser,
}));

vi.mock("@/lib/auth/canonical-trusted-origin", () => ({
  canonicalizeTrustedOrigin: (origin: string) =>
    origin.startsWith("https://") ? origin : null,
}));

vi.mock("@/app/desktop/onboarding-attempt/service", () => ({
  desktopOnboardingAttemptsService: {
    create: mocks.createAttempt,
  },
}));

vi.mock("../../service", () => ({
  computeTargetsService: {
    findOwnedById: mocks.findOwnedById,
  },
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    createCommand: mocks.createCommand,
    markCommandExpired: mocks.markCommandExpired,
  },
}));

vi.mock("../../relay-command-helpers", () => ({
  dispatchRelayCommandToRelay: mocks.dispatchRelayCommandToRelay,
  toRelayOperation: mocks.toRelayOperation,
}));

import { POST } from "./route";

const target = {
  id: "target-1",
  gatewayId: "550e8400-e29b-41d4-a716-446655440000",
  isOnline: true,
  security: {
    status: DesktopSecurityStatus.UpgradeAvailable,
    reason: "NO_BOUND_MANAGED_KEY",
    upgradeSupported: true,
  },
};

function request(body: unknown): Request {
  return new Request(
    "https://api.closedloop.ai/compute-targets/target-1/security-upgrade-attempt",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

describe("POST /compute-targets/:id/security-upgrade-attempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSessionUser.mockResolvedValue({
      clerkUserId: "clerk-user-1",
      user: {
        id: "user-1",
        organizationId: "org-1",
      },
    });
    mocks.findOwnedById.mockResolvedValue(target);
    mocks.createAttempt.mockResolvedValue({
      onboardingAttemptId: "attempt-1",
      expiresAt: new Date("2026-04-28T20:00:00.000Z"),
    });
    mocks.createCommand.mockResolvedValue({
      command: { commandId: "command-1" },
    });
    mocks.toRelayOperation.mockReturnValue({
      operationId: "desktop_security_upgrade",
      operation: "engineer_http_request",
      params: {},
      streaming: false,
    });
    mocks.dispatchRelayCommandToRelay.mockResolvedValue(true);
  });

  it("returns a retryable contract error when attempt persistence fails", async () => {
    mocks.createAttempt.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(
      request({ webAppOrigin: "https://app.closedloop.ai" }),
      {
        params: Promise.resolve({ id: "target-1" }),
      }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "UPGRADE_ATTEMPT_CREATE_FAILED",
      retryable: true,
    });
    expect(mocks.createCommand).not.toHaveBeenCalled();
    expect(mocks.dispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });
});
