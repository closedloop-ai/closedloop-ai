/**
 * @file install-source.test.ts
 * @description Contract tests for the FEA-4090 install-source resolver.
 *
 * Durable provenance (wongk): a recorded {@link InstallOrigin} milestone is the
 * authoritative source and wins over any current distribution policy, so a later
 * policy change (reconcile relabel, opt-in status flip) can never rewrite the
 * label. Each arrival path stamps the right origin; every origin maps to the
 * right source. The legacy {@link DistributionMode}/`targetStatus` derivation is
 * a compat fallback only, for packs installed before origin recording existed.
 */

import { describe, expect, it } from "vitest";
import {
  DistributionMode,
  DistributionTargetStatusValue,
} from "../distribution";
import {
  InstallOrigin,
  InstallSource,
  type InstallSourceInput,
  resolveInstallSource,
} from "../install-source";

describe("resolveInstallSource — durable recorded origin (provenance)", () => {
  it("returns each recorded origin's canonical source verbatim", () => {
    const cases: [InstallOrigin, InstallSource][] = [
      [InstallOrigin.AutoInstalled, InstallSource.Pushed],
      [InstallOrigin.OptedIn, InstallSource.OptedIn],
      [InstallOrigin.SelfInstalled, InstallSource.Self],
      [InstallOrigin.Required, InstallSource.Required],
    ];
    for (const [recordedOrigin, expected] of cases) {
      expect(resolveInstallSource({ recordedOrigin })).toBe(expected);
    }
  });

  it("a recorded origin wins over current distribution policy (no reconcile relabel)", () => {
    // The reconciler now reports auto_install policy for a pack the member
    // actually self-installed. Because a durable self origin was stamped at
    // install time, the label stays "self" — policy does not relabel it.
    expect(
      resolveInstallSource({
        recordedOrigin: InstallOrigin.SelfInstalled,
        distributionMode: DistributionMode.AutoInstall,
        required: true,
      })
    ).toBe(InstallSource.Self);
  });

  it("a recorded opt-in origin does not flip when the mutable status later fails", () => {
    // installedAt is preserved but a later per-device status went to `failed`.
    // The monotonic origin milestone keeps the provenance honest.
    expect(
      resolveInstallSource({
        recordedOrigin: InstallOrigin.OptedIn,
        distributionMode: DistributionMode.OptIn,
        targetStatus: DistributionTargetStatusValue.Failed,
      })
    ).toBe(InstallSource.OptedIn);
  });

  it("a recorded origin needs no per-adapter precedence over overlapping policy rows", () => {
    // Overlapping distributions would force a precedence rule in a policy-set
    // derivation; a single recorded origin removes the question entirely.
    expect(
      resolveInstallSource({ recordedOrigin: InstallOrigin.Required })
    ).toBe(InstallSource.Required);
  });

  it("degrades an unrecognized / legacy recorded origin to unknown, never a mislabel", () => {
    const input = {
      recordedOrigin: "future_origin",
    } as unknown as InstallSourceInput;
    expect(resolveInstallSource(input)).toBe(InstallSource.Unknown);
  });
});

describe("resolveInstallSource — legacy policy fallback (pre-origin packs)", () => {
  it("resolves self only when a linkage-capable payload reports no link", () => {
    expect(resolveInstallSource({ linkageKnown: true })).toBe(
      InstallSource.Self
    );
    expect(
      resolveInstallSource({ linkageKnown: true, distributionMode: null })
    ).toBe(InstallSource.Self);
  });

  it("degrades to unknown for a payload that cannot report linkage", () => {
    // No recordedOrigin, no linkageKnown, no mode → the resolver must not claim self.
    expect(resolveInstallSource({})).toBe(InstallSource.Unknown);
    expect(resolveInstallSource({ distributionMode: null })).toBe(
      InstallSource.Unknown
    );
  });

  it("resolves an auto_install distribution to pushed", () => {
    expect(
      resolveInstallSource({ distributionMode: DistributionMode.AutoInstall })
    ).toBe(InstallSource.Pushed);
  });

  it("resolves a required auto_install distribution to required", () => {
    expect(
      resolveInstallSource({
        distributionMode: DistributionMode.AutoInstall,
        required: true,
      })
    ).toBe(InstallSource.Required);
  });

  it("resolves an accepted opt_in distribution to opted-in", () => {
    for (const targetStatus of [
      DistributionTargetStatusValue.OptedIn,
      DistributionTargetStatusValue.Installed,
      DistributionTargetStatusValue.Enabled,
    ]) {
      expect(
        resolveInstallSource({
          distributionMode: DistributionMode.OptIn,
          targetStatus,
        })
      ).toBe(InstallSource.OptedIn);
    }
  });

  it("does not over-claim org provenance for a not-yet-accepted opt_in", () => {
    for (const targetStatus of [
      DistributionTargetStatusValue.Pending,
      DistributionTargetStatusValue.Declined,
      DistributionTargetStatusValue.Failed,
    ]) {
      expect(
        resolveInstallSource({
          distributionMode: DistributionMode.OptIn,
          targetStatus,
        })
      ).toBe(InstallSource.Self);
    }
    // opt_in with no known target status also does not claim opted-in.
    expect(
      resolveInstallSource({ distributionMode: DistributionMode.OptIn })
    ).toBe(InstallSource.Self);
  });

  it("falls back to unknown for an unrecognized / legacy distribution mode", () => {
    const input = {
      distributionMode: "future_delivery_mode",
    } as unknown as InstallSourceInput;
    expect(resolveInstallSource(input)).toBe(InstallSource.Unknown);
  });
});

describe("install-source canonical value sets", () => {
  it("exposes exactly the canonical source states", () => {
    expect(Object.values(InstallSource).sort()).toEqual(
      ["opted-in", "pushed", "required", "self", "unknown"].sort()
    );
  });

  it("exposes exactly the canonical durable origin milestones", () => {
    expect(Object.values(InstallOrigin).sort()).toEqual(
      ["auto_installed", "opted_in", "required", "self_installed"].sort()
    );
  });
});
