import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTarget,
  installDb,
} from "@/__tests__/support/compute-targets/service.test-fixtures";

const mocks = vi.hoisted(() => ({
  isDesktopManagedPopEnforcementEnabled: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  ApiKeySource: {
    DESKTOP_MANAGED: "DESKTOP_MANAGED",
    USER_CREATED: "USER_CREATED",
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/auth/desktop-managed-pop", () => ({
  isDesktopManagedPopEnforcementEnabled:
    mocks.isDesktopManagedPopEnforcementEnabled,
}));

vi.mock("@/lib/compute-target-signing-eligibility", () => ({
  CommandSigningEligibilityStatus: {
    Eligible: "eligible",
    Ineligible: "ineligible",
    Unknown: "unknown",
  },
  loadActiveDesktopManagedGatewayIds: vi.fn(),
}));

import { computeTargetsService } from "./service";

const EXISTING_TARGET = {
  id: "target-1",
  machineName: "machine-1",
  platform: "darwin",
  capabilities: {},
  supportedOperations: ["git_action"],
  gatewayId: "gateway-stale",
};

describe("computeTargetsService clears a gatewayId a hello did not declare (ISS-12032)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDesktopManagedPopEnforcementEnabled.mockResolvedValue(false);
  });

  it("updateOwned writes gatewayId null for an explicit null, without a conflict lookup", async () => {
    const findFirst = vi.fn().mockResolvedValue(EXISTING_TARGET);
    const update = vi.fn().mockResolvedValue(buildTarget({ gatewayId: null }));
    installDb(mocks.withDb, { computeTarget: { findFirst, update } });

    await computeTargetsService.updateOwned("target-1", "org-1", "user-1", {
      platform: "darwin",
      gatewayId: null,
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]?.data).toMatchObject({ gatewayId: null });
  });

  it("updateOwned leaves the stored gatewayId alone when the field is omitted", async () => {
    const findFirst = vi.fn().mockResolvedValue(EXISTING_TARGET);
    const update = vi.fn().mockResolvedValue(buildTarget());
    installDb(mocks.withDb, { computeTarget: { findFirst, update } });

    await computeTargetsService.updateOwned("target-1", "org-1", "user-1", {
      platform: "darwin",
    });

    expect(Object.hasOwn(update.mock.calls[0]?.[0]?.data, "gatewayId")).toBe(
      false
    );
  });

  it("register clears the matched machine's gatewayId for an explicit null", async () => {
    const upsert = vi.fn().mockResolvedValue(buildTarget({ gatewayId: null }));
    installDb(mocks.withDb, {
      computeTarget: {
        findUnique: vi.fn().mockResolvedValue(EXISTING_TARGET),
        upsert,
      },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      supportedOperations: ["git_action"],
      gatewayId: null,
    });

    expect(upsert.mock.calls[0]?.[0]?.update).toMatchObject({
      gatewayId: null,
    });
  });

  it("register leaves the matched machine's gatewayId alone when the field is omitted", async () => {
    const upsert = vi.fn().mockResolvedValue(buildTarget());
    installDb(mocks.withDb, {
      computeTarget: {
        findUnique: vi.fn().mockResolvedValue(EXISTING_TARGET),
        upsert,
      },
    });

    await computeTargetsService.register("org-1", "user-1", {
      machineName: "machine-1",
      platform: "darwin",
      supportedOperations: ["git_action"],
    });

    expect(Object.hasOwn(upsert.mock.calls[0]?.[0]?.update, "gatewayId")).toBe(
      false
    );
  });
});
