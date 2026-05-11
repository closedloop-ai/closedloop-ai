import {
  ComputePreference,
  type ComputeTarget,
} from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import { resolveEffectiveComputeTargetSelection } from "../compute-target-selection";

function makeTarget(
  id: string,
  isOnline: boolean,
  lastSeenAt: string,
  ownerName?: string
): ComputeTarget {
  return {
    id,
    organizationId: "org-1",
    userId: ownerName ? "user-2" : "user-1",
    machineName: id,
    platform: "darwin",
    capabilities: {},
    supportedOperations: [],
    lastSeenAt: new Date(lastSeenAt),
    isOnline,
    isSharedWithOrg: ownerName !== undefined,
    ownerName,
    createdAt: new Date(lastSeenAt),
    updatedAt: new Date(lastSeenAt),
  };
}

describe("resolveEffectiveComputeTargetSelection", () => {
  it("uses an online persisted local target as the effective target", () => {
    const target = makeTarget("target-1", true, "2026-04-28T12:00:00.000Z");

    const selection = resolveEffectiveComputeTargetSelection({
      preference: {
        preferredComputeMode: ComputePreference.Local,
        computeTargetId: target.id,
      },
      targets: [target],
    });

    expect(selection.currentPreference).toBe(ComputePreference.Local);
    expect(selection.needsSelection).toBe(false);
    expect(selection.effectiveTarget).toBe(target);
    expect(selection.effectiveTargetId).toBe(target.id);
  });

  it("preserves Cloud fallback when explicit selection is not required", () => {
    const selection = resolveEffectiveComputeTargetSelection({
      preference: {
        preferredComputeMode: ComputePreference.Cloud,
        isExplicit: false,
      },
      targets: [],
    });

    expect(selection.currentPreference).toBe(ComputePreference.Cloud);
    expect(selection.needsSelection).toBe(false);
  });

  it("requires selection when flag is enabled and preference is inferred", () => {
    const target = makeTarget("target-1", true, "2026-04-28T12:00:00.000Z");

    const selection = resolveEffectiveComputeTargetSelection({
      preference: {
        preferredComputeMode: ComputePreference.Cloud,
        isExplicit: false,
      },
      requireExplicitSelection: true,
      targets: [target],
    });

    expect(selection.currentPreference).toBeNull();
    expect(selection.needsSelection).toBe(true);
    expect(selection.effectiveTarget).toBeNull();
    expect(selection.effectiveTargetId).toBeNull();
    expect(selection.onlineTargets).toEqual([target]);
  });

  it("renders persisted Cloud as selected when explicit selection is required", () => {
    const selection = resolveEffectiveComputeTargetSelection({
      preference: {
        preferredComputeMode: ComputePreference.Cloud,
        isExplicit: true,
      },
      requireExplicitSelection: true,
      targets: [],
    });

    expect(selection.currentPreference).toBe(ComputePreference.Cloud);
    expect(selection.needsSelection).toBe(false);
  });

  it("falls back to the most recently active online target when the persisted target is offline", () => {
    const offline = makeTarget(
      "offline-target",
      false,
      "2026-04-28T13:00:00.000Z"
    );
    const olderOnline = makeTarget(
      "older-online",
      true,
      "2026-04-28T12:00:00.000Z"
    );
    const newerOnline = makeTarget(
      "newer-online",
      true,
      "2026-04-28T14:00:00.000Z"
    );

    const selection = resolveEffectiveComputeTargetSelection({
      preference: {
        preferredComputeMode: ComputePreference.Local,
        computeTargetId: offline.id,
      },
      targets: [offline, olderOnline, newerOnline],
    });

    expect(selection.effectiveTarget).toBe(newerOnline);
    expect(selection.effectiveTargetId).toBe(newerOnline.id);
  });

  it("does not expose an effective local target when Cloud is selected", () => {
    const target = makeTarget("target-1", true, "2026-04-28T12:00:00.000Z");

    const selection = resolveEffectiveComputeTargetSelection({
      preference: {
        preferredComputeMode: ComputePreference.Cloud,
        computeTargetId: target.id,
      },
      targets: [target],
    });

    expect(selection.currentPreference).toBe(ComputePreference.Cloud);
    expect(selection.effectiveTarget).toBeNull();
    expect(selection.effectiveTargetId).toBe(target.id);
  });

  it("can select a persisted online shared target", () => {
    const sharedTarget = makeTarget(
      "shared-target",
      true,
      "2026-04-28T12:00:00.000Z",
      "Mike"
    );

    const selection = resolveEffectiveComputeTargetSelection({
      preference: {
        preferredComputeMode: ComputePreference.Local,
        computeTargetId: sharedTarget.id,
      },
      targets: [sharedTarget],
    });

    expect(selection.effectiveTarget).toBe(sharedTarget);
    expect(selection.effectiveTarget?.ownerName).toBe("Mike");
  });

  it("reports no installed targets when the target list is empty", () => {
    const selection = resolveEffectiveComputeTargetSelection({
      preference: { preferredComputeMode: ComputePreference.Local },
      targets: [],
    });

    expect(selection.effectiveTarget).toBeNull();
    expect(selection.notInstalled).toBe(true);
    expect(selection.allOffline).toBe(false);
  });

  it("reports all targets offline without selecting an effective target", () => {
    const offlineTarget = makeTarget(
      "offline-target",
      false,
      "2026-04-28T12:00:00.000Z"
    );

    const selection = resolveEffectiveComputeTargetSelection({
      preference: {
        preferredComputeMode: ComputePreference.Local,
        computeTargetId: offlineTarget.id,
      },
      targets: [offlineTarget],
    });

    expect(selection.effectiveTarget).toBeNull();
    expect(selection.notInstalled).toBe(false);
    expect(selection.allOffline).toBe(true);
  });
});
