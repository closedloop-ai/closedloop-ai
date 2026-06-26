import {
  COMMAND_SIGNING_CAPABILITY_KEY,
  type ComputeTarget,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheComputeTargetsForSigning,
  getCachedComputeTargetForSigning,
  isCachedComputeTargetSigningEffective,
} from "./compute-target-signing-cache";

function makeTarget(
  id: string,
  overrides: Partial<ComputeTarget> = {}
): ComputeTarget {
  return {
    id,
    organizationId: "org-1",
    userId: "user-1",
    machineName: `target-${id}`,
    platform: "darwin",
    capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: true },
    supportedOperations: [],
    lastSeenAt: new Date("2026-05-10T12:00:00.000Z"),
    isOnline: true,
    isSharedWithOrg: false,
    serverCapabilities: { computeTargetSigning: true },
    selectedHarness: HarnessType.Claude,
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    updatedAt: new Date("2026-05-10T12:00:00.000Z"),
    ...overrides,
  };
}

describe("compute target signing cache", () => {
  beforeEach(() => {
    cacheComputeTargetsForSigning([]);
  });

  it("replaces the full snapshot and drops IDs absent from the latest list", () => {
    cacheComputeTargetsForSigning([
      makeTarget("target-1"),
      makeTarget("target-2", { serverCapabilities: {} }),
    ]);

    expect(getCachedComputeTargetForSigning("target-1")?.id).toBe("target-1");
    expect(isCachedComputeTargetSigningEffective("target-1")).toBe(true);
    expect(isCachedComputeTargetSigningEffective("target-2")).toBe(false);

    cacheComputeTargetsForSigning([
      makeTarget("target-2"),
      makeTarget("target-3"),
    ]);

    expect(getCachedComputeTargetForSigning("target-1")).toBeNull();
    expect(isCachedComputeTargetSigningEffective("target-1")).toBe(false);
    expect(isCachedComputeTargetSigningEffective("target-2")).toBe(true);
    expect(isCachedComputeTargetSigningEffective("target-3")).toBe(true);
  });

  it("requires both desktop and server capability bits for effective signing", () => {
    cacheComputeTargetsForSigning([
      makeTarget("eligible"),
      makeTarget("desktop-disabled", {
        capabilities: { [COMMAND_SIGNING_CAPABILITY_KEY]: false },
      }),
      makeTarget("server-disabled", { serverCapabilities: {} }),
    ]);

    expect(isCachedComputeTargetSigningEffective("eligible")).toBe(true);
    expect(isCachedComputeTargetSigningEffective("desktop-disabled")).toBe(
      false
    );
    expect(isCachedComputeTargetSigningEffective("server-disabled")).toBe(
      false
    );
  });
});
