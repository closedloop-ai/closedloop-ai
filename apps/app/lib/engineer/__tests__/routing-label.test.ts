import {
  type ComputeTarget,
  DesktopSecurityStatus,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { describe, expect, test } from "vitest";
import { resolveTargetLabel } from "../routing-label";

function makeTarget(id: string, machineName: string): ComputeTarget {
  const timestamp = new Date("2026-04-13T18:41:00.000Z");
  return {
    id,
    organizationId: "org-1",
    userId: "user-1",
    machineName,
    platform: "darwin",
    lastSeenAt: timestamp,
    isOnline: true,
    isSharedWithOrg: false,
    supportedOperations: [],
    capabilities: {},
    security: {
      status: DesktopSecurityStatus.Unknown,
      reason: "FEATURE_DISABLED",
      upgradeSupported: false,
    },
    selectedHarness: HarnessType.Claude,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("resolveTargetLabel", () => {
  test("returns the matched target's machine name for CloudRelay with a known target", () => {
    const targets = [makeTarget("target-1", "alice-macbook")];
    const label = resolveTargetLabel(
      { mode: EngineerRoutingMode.CloudRelay, computeTargetId: "target-1" },
      targets
    );
    expect(label).toBe("alice-macbook");
  });

  test("returns undefined for CloudRelay when the selected target is not in the list", () => {
    const targets = [makeTarget("target-1", "alice-macbook")];
    const label = resolveTargetLabel(
      {
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "target-missing",
      },
      targets
    );
    expect(label).toBeUndefined();
  });

  test("returns 'localhost' for LocalElectron regardless of the target list", () => {
    const label = resolveTargetLabel(
      { mode: EngineerRoutingMode.LocalElectron, computeTargetId: null },
      []
    );
    expect(label).toBe("localhost");
  });

  test("returns undefined for CloudRelay with no selected compute target", () => {
    const targets = [makeTarget("target-1", "alice-macbook")];
    const label = resolveTargetLabel(
      { mode: EngineerRoutingMode.CloudRelay, computeTargetId: null },
      targets
    );
    expect(label).toBeUndefined();
  });
});
