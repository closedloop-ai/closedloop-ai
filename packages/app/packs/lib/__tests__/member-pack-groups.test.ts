/**
 * @file member-pack-groups.test.ts
 * @description Behavioral tests for the FEA-4089 member by-source grouping: a
 * pack is bucketed into Required / Installed / Available from its real
 * `DistributionMode` + per-target status, its row carries the honest resolved
 * `InstallSource`, a dual-source self+blessed pack resolves to a single source
 * (no double-badge), and a required pack whose push failed shows as a strand row
 * inside Required rather than being dropped.
 */

import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { InstallSource } from "@repo/api/src/types/install-source";
import { describe, expect, it } from "vitest";
import { groupMemberPacks, MemberPackGroup } from "../member-pack-groups";
import type {
  PackDistribution,
  PackDistributionTarget,
  PackView,
} from "../pack-view";

function target(
  overrides: Partial<PackDistributionTarget> = {}
): PackDistributionTarget {
  return {
    id: "tgt-1",
    status: DistributionTargetStatusValue.Installed,
    ...overrides,
  };
}

function distribution(
  overrides: Partial<PackDistribution> = {}
): PackDistribution {
  return {
    id: "dist-1",
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    targetCount: 1,
    installedCount: 1,
    pendingCount: 0,
    failedCount: 0,
    targetingEntries: [],
    adoptionLoaded: true,
    ...overrides,
  };
}

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "pack-1",
    name: "Security Baseline",
    publisher: "Platform Eng",
    version: "4.2.0",
    description: "Org security gates",
    verified: false,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    distribution: null,
    performance: null,
    ...overrides,
  };
}

describe("groupMemberPacks", () => {
  it("groups an auto_install pack into Required with a source label, not Installed", () => {
    const groups = groupMemberPacks([
      pack({
        id: "req",
        distribution: distribution({ mode: DistributionMode.AutoInstall }),
      }),
    ]);

    expect(groups[MemberPackGroup.Required]).toHaveLength(1);
    expect(groups[MemberPackGroup.Installed]).toHaveLength(0);
    // The row carries the honest resolved source (pushed → "Auto-installed"
    // label upstream), not a hand-rolled string.
    expect(groups[MemberPackGroup.Required][0]?.source).toBe(
      InstallSource.Pushed
    );
    expect(groups[MemberPackGroup.Required][0]?.installFailed).toBe(false);
  });

  it("keeps a required pack whose push FAILED as a strand row inside Required (not dropped)", () => {
    const groups = groupMemberPacks([
      pack({
        id: "req-failed",
        distribution: distribution({
          mode: DistributionMode.AutoInstall,
          targets: [target({ status: DistributionTargetStatusValue.Failed })],
        }),
      }),
    ]);

    // The honest failed-install strand: present in Required, flagged failed —
    // never a silent absence.
    expect(groups[MemberPackGroup.Required]).toHaveLength(1);
    expect(groups[MemberPackGroup.Available]).toHaveLength(0);
    expect(groups[MemberPackGroup.Required][0]?.installFailed).toBe(true);
  });

  it("groups an accepted opt_in pack into Installed as org-blessed (opted-in)", () => {
    const groups = groupMemberPacks([
      pack({
        id: "blessed",
        distribution: distribution({
          mode: DistributionMode.OptIn,
          targets: [target({ status: DistributionTargetStatusValue.OptedIn })],
        }),
      }),
    ]);

    expect(groups[MemberPackGroup.Installed]).toHaveLength(1);
    expect(groups[MemberPackGroup.Required]).toHaveLength(0);
    expect(groups[MemberPackGroup.Installed][0]?.source).toBe(
      InstallSource.OptedIn
    );
  });

  it("says a dual-source self+blessed pack's source ONCE (opted-in wins, no double-badge)", () => {
    // A pack the member both self-installed AND accepted an org offer for: the
    // resolver picks the strongest truthful label (org-blessed opted-in) and the
    // row carries exactly that one source — never two.
    const groups = groupMemberPacks([
      pack({
        id: "dual",
        installedByMe: true,
        distribution: distribution({
          mode: DistributionMode.OptIn,
          targets: [target({ status: DistributionTargetStatusValue.OptedIn })],
        }),
      }),
    ]);

    const row = groups[MemberPackGroup.Installed][0];
    expect(row?.source).toBe(InstallSource.OptedIn);
    // The strand flag stays off — this is a clean install, not a failure.
    expect(row?.installFailed).toBe(false);
  });

  it("groups a self-installed pack (no distribution, installedByMe) into Installed as self", () => {
    const groups = groupMemberPacks([
      pack({ id: "self", installedByMe: true, distribution: null }),
    ]);

    expect(groups[MemberPackGroup.Installed]).toHaveLength(1);
    expect(groups[MemberPackGroup.Installed][0]?.source).toBe(
      InstallSource.Self
    );
  });

  it("groups a catalog pack the member neither has nor is required into Available with no source", () => {
    const groups = groupMemberPacks([
      pack({ id: "avail", installedByMe: false, distribution: null }),
    ]);

    expect(groups[MemberPackGroup.Available]).toHaveLength(1);
    expect(groups[MemberPackGroup.Installed]).toHaveLength(0);
    // Nothing to claim about provenance for a pack you don't have.
    expect(groups[MemberPackGroup.Available][0]?.source).toBeNull();
  });

  it("does not treat an unaccepted opt_in offer as installed — it lands in Available", () => {
    const groups = groupMemberPacks([
      pack({
        id: "offered",
        installedByMe: false,
        distribution: distribution({
          mode: DistributionMode.OptIn,
          // A detail read populated the member's status: still pending, not
          // accepted, so it is a mere offer.
          targets: [target({ status: DistributionTargetStatusValue.Pending })],
        }),
      }),
    ]);

    expect(groups[MemberPackGroup.Available]).toHaveLength(1);
    expect(groups[MemberPackGroup.Installed]).toHaveLength(0);
    expect(groups[MemberPackGroup.Required]).toHaveLength(0);
  });

  it("marks a specific auto_install distribution Required only for a targeted member", () => {
    const specificPack = pack({
      id: "targeted",
      distribution: distribution({
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.Specific,
        targetingEntries: [{ computeTargetId: null, userId: "member-me" }],
      }),
    });

    const groups = groupMemberPacks([specificPack], "member-me");

    expect(groups[MemberPackGroup.Required]).toHaveLength(1);
    expect(groups[MemberPackGroup.Available]).toHaveLength(0);
  });

  it("does NOT mark a specific auto_install distribution Required for an untargeted member", () => {
    const specificPack = pack({
      id: "other-member",
      distribution: distribution({
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.Specific,
        targetingEntries: [{ computeTargetId: null, userId: "someone-else" }],
      }),
    });

    const groups = groupMemberPacks([specificPack], "member-me");

    // The untargeted member is told the truth: this pack isn't required for
    // them — it lands in Available, never Required.
    expect(groups[MemberPackGroup.Required]).toHaveLength(0);
    expect(groups[MemberPackGroup.Available]).toHaveLength(1);
  });

  it("degrades a specific distribution to not-Required when the member identity is unknown", () => {
    const specificPack = pack({
      id: "no-identity",
      distribution: distribution({
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.Specific,
        targetingEntries: [{ computeTargetId: null, userId: "member-me" }],
      }),
    });

    // No memberUserId — we can't confirm the member is targeted, so we don't
    // fabricate a Required state for everyone.
    const groups = groupMemberPacks([specificPack]);

    expect(groups[MemberPackGroup.Required]).toHaveLength(0);
    expect(groups[MemberPackGroup.Available]).toHaveLength(1);
  });

  it("does NOT mark a specific distribution Required from compute-target-only targeting (unresolvable on this read)", () => {
    const specificPack = pack({
      id: "device-only",
      distribution: distribution({
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.Specific,
        // Only a device is named — the list read carries no member↔device
        // roster, so we can't confirm this is the member's device.
        targetingEntries: [{ computeTargetId: "device-1", userId: null }],
      }),
    });

    const groups = groupMemberPacks([specificPack], "member-me");

    expect(groups[MemberPackGroup.Required]).toHaveLength(0);
    expect(groups[MemberPackGroup.Available]).toHaveLength(1);
  });

  it("still marks an ALL-targeting auto_install distribution Required for every member", () => {
    const allPack = pack({
      id: "all",
      distribution: distribution({
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.All,
      }),
    });

    // `all` genuinely targets everyone — Required regardless of member id.
    const groups = groupMemberPacks([allPack], "member-me");

    expect(groups[MemberPackGroup.Required]).toHaveLength(1);
  });

  it("marks a pack Required from an older ALL distribution even when the newer summary distribution targets someone else (two-row case)", () => {
    // The catalog item has two distributions: the summary/newest one is an
    // `auto_install specific` targeting a DIFFERENT member; an older
    // `auto_install all` requires everyone. Folding to the first distribution
    // alone would drop the pack into Available for this member — the FEA-4166
    // review bug. Evaluating ALL distributions keeps it Required.
    const newestSpecificOther = distribution({
      id: "dist-newest-specific",
      mode: DistributionMode.AutoInstall,
      targetingType: DistributionTargetingType.Specific,
      targetingEntries: [{ computeTargetId: null, userId: "someone-else" }],
    });
    const olderAll = distribution({
      id: "dist-older-all",
      mode: DistributionMode.AutoInstall,
      targetingType: DistributionTargetingType.All,
    });

    const twoRowPack = pack({
      id: "two-row",
      // Summary folds to the newest (specific, other member).
      distribution: newestSpecificOther,
      // But the org has both — the member projection must see all of them.
      allDistributions: [newestSpecificOther, olderAll],
    });

    const groups = groupMemberPacks([twoRowPack], "member-me");

    expect(groups[MemberPackGroup.Required]).toHaveLength(1);
    expect(groups[MemberPackGroup.Available]).toHaveLength(0);
  });

  it("keeps a specific-other-member pack in Available when NO other distribution requires this member", () => {
    // Guard the opposite branch: with only the specific-other distribution (no
    // `all` sibling), the member is genuinely not required — the multi-dist
    // evaluation must not fabricate Required from an unrelated distribution.
    const specificOther = distribution({
      id: "dist-specific-other",
      mode: DistributionMode.AutoInstall,
      targetingType: DistributionTargetingType.Specific,
      targetingEntries: [{ computeTargetId: null, userId: "someone-else" }],
    });

    const groups = groupMemberPacks(
      [
        pack({
          id: "only-other",
          distribution: specificOther,
          allDistributions: [specificOther],
        }),
      ],
      "member-me"
    );

    expect(groups[MemberPackGroup.Required]).toHaveLength(0);
    expect(groups[MemberPackGroup.Available]).toHaveLength(1);
  });
});
