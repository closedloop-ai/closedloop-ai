/**
 * ISS-4905: desktop onboarding reported "setup complete" for any non-revoked
 * Desktop-managed key, including one `verifyKeyWithMetadata` now refuses. That
 * told the user provisioning was done behind a credential that cannot
 * authenticate, and suppressed the reprovisioning that would fix it.
 */

import { API_KEY_SCOPES } from "@repo/api/src/types/api-key";
import { DesktopProvisioningReadinessStatus } from "@repo/api/src/types/electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: { DESKTOP_MANAGED: "DESKTOP_MANAGED" },
  withDb: mocks.withDb,
}));

import { desktopOnboardingAttemptsService } from "../service";

const apiKeyFindMany = vi.fn();
const computeTargetFindFirst = vi.fn();

beforeEach(() => {
  apiKeyFindMany.mockReset();
  computeTargetFindFirst.mockReset();
  apiKeyFindMany.mockResolvedValue([{ gatewayId: "gateway-a" }]);
  computeTargetFindFirst.mockResolvedValue({
    id: "target-1",
    gatewayId: "gateway-a",
  });
  mocks.withDb.mockReset();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      apiKey: { findMany: apiKeyFindMany },
      computeTarget: { findFirst: computeTargetFindFirst },
    })
  );
});

describe("desktopOnboardingAttemptsService.getReadiness", () => {
  it("only counts a key that could actually authenticate", async () => {
    await desktopOnboardingAttemptsService.getReadiness("org-1", "user-1");

    const { where } = apiKeyFindMany.mock.calls[0][0];
    expect(where.scopes).toEqual({ hasSome: [...API_KEY_SCOPES] });
    expect(where.revokedAt).toBeNull();
    expect(where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
    expect(where).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      source: "DESKTOP_MANAGED",
      boundPublicKey: { not: null },
      gatewayId: { not: null },
    });
  });

  it("reports incomplete when no usable key protects a gateway", async () => {
    apiKeyFindMany.mockResolvedValue([]);

    const result = await desktopOnboardingAttemptsService.getReadiness(
      "org-1",
      "user-1"
    );

    expect(result).toEqual({
      status: DesktopProvisioningReadinessStatus.Incomplete,
    });
    expect(computeTargetFindFirst).not.toHaveBeenCalled();
  });

  it("reports complete when a usable key protects an online target", async () => {
    const result = await desktopOnboardingAttemptsService.getReadiness(
      "org-1",
      "user-1"
    );

    expect(result).toEqual({
      status: DesktopProvisioningReadinessStatus.Complete,
      gatewayId: "gateway-a",
      computeTargetId: "target-1",
    });
  });
});
