import { DesktopSecurityStatus } from "@repo/api/src/types/compute-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  stubTrustedOriginEnv,
  TRUSTED_APP_ORIGIN,
  UNTRUSTED_ORIGIN,
} from "@/__tests__/utils/trusted-origin.test-helpers";

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
    stubTrustedOriginEnv();
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
    // `dispatchRelayCommandToRelay` resolves a `RelayDispatchResult`, and the
    // route branches on `.delivered`; a bare `true` reads as undelivered.
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({ delivered: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a non-allowlisted webAppOrigin before the target is ever looked up", async () => {
    // This route answers 422 TARGET_NOT_UPGRADEABLE from two places: a body
    // that fails schema validation, and a non-allowlisted origin. So status
    // alone proves nothing. Here the body parses, and the origin guard runs
    // before the target lookup — so `findOwnedById` never being called is what
    // pins the rejection to the allowlist. Drop the canonicalizeTrustedOrigin
    // call and the request proceeds to look up the target and mint an attempt.
    const response = await POST(request({ webAppOrigin: UNTRUSTED_ORIGIN }), {
      params: Promise.resolve({ id: "target-1" }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      code: "TARGET_NOT_UPGRADEABLE",
      retryable: false,
    });
    expect(mocks.findOwnedById).not.toHaveBeenCalled();
    expect(mocks.createAttempt).not.toHaveBeenCalled();
    expect(mocks.createCommand).not.toHaveBeenCalled();
    expect(mocks.dispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });

  it("dispatches the upgrade command for an allowlisted webAppOrigin", async () => {
    // The positive half of the guard: the same request shape with an
    // allowlisted origin reaches the target lookup and dispatches, so the
    // rejection above is attributable to the origin and nothing else.
    const response = await POST(request({ webAppOrigin: TRUSTED_APP_ORIGIN }), {
      params: Promise.resolve({ id: "target-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.findOwnedById).toHaveBeenCalled();
    expect(mocks.createAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ webAppOrigin: TRUSTED_APP_ORIGIN })
    );
    expect(mocks.dispatchRelayCommandToRelay).toHaveBeenCalled();
  });

  it("returns a retryable contract error when attempt persistence fails", async () => {
    mocks.createAttempt.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(request({ webAppOrigin: TRUSTED_APP_ORIGIN }), {
      params: Promise.resolve({ id: "target-1" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "UPGRADE_ATTEMPT_CREATE_FAILED",
      retryable: true,
    });
    expect(mocks.createCommand).not.toHaveBeenCalled();
    expect(mocks.dispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });
});
