import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import {
  isSetupGateStepOwed,
  resolveSetupGate,
} from "../first-user-setup-gate";

const FIRST = OrganizationMembership.FirstUser;
const EXISTING = OrganizationMembership.ExistingMember;

describe("resolveSetupGate (ISS-12363)", () => {
  it("holds a first user who has not downloaded Desktop, download first", () => {
    const gate = resolveSetupGate({
      desktopAppDownloaded: false,
      membership: FIRST,
      syncPolicy: null,
    });
    expect(gate.blocking).toBe(true);
    expect(gate.nextStep).toBe(PendingOnboardingStep.DownloadDesktop);
  });

  it("keeps holding a first user after the download until a policy is chosen", () => {
    // The ticket's headline: downloading Desktop alone is not setup.
    const gate = resolveSetupGate({
      desktopAppDownloaded: true,
      membership: FIRST,
      syncPolicy: null,
    });
    expect(gate.blocking).toBe(true);
    expect(gate.nextStep).toBe(PendingOnboardingStep.ChooseSessionSync);
    expect(gate.steps).toEqual([
      { complete: true, step: PendingOnboardingStep.DownloadDesktop },
      { complete: false, step: PendingOnboardingStep.ChooseSessionSync },
    ]);
  });

  it("holds a first user who chose a policy but never downloaded Desktop", () => {
    const gate = resolveSetupGate({
      desktopAppDownloaded: false,
      membership: FIRST,
      syncPolicy: DataSyncLevel.Full,
    });
    expect(gate.blocking).toBe(true);
    expect(gate.nextStep).toBe(PendingOnboardingStep.DownloadDesktop);
  });

  it.each([
    DataSyncLevel.Off,
    DataSyncLevel.Metadata,
    DataSyncLevel.Full,
  ] as const)(
    "releases a first user once Desktop is downloaded and %s is chosen",
    (level) => {
      const gate = resolveSetupGate({
        desktopAppDownloaded: true,
        membership: FIRST,
        syncPolicy: level,
      });
      expect(gate.blocking).toBe(false);
      expect(gate.nextStep).toBeNull();
    }
  );

  it("treats an explicit Off as a finished choice and an unset policy as unfinished", () => {
    const off = resolveSetupGate({
      desktopAppDownloaded: true,
      membership: FIRST,
      syncPolicy: DataSyncLevel.Off,
    });
    const unset = resolveSetupGate({
      desktopAppDownloaded: true,
      membership: FIRST,
      syncPolicy: null,
    });
    expect(off.steps[1]).toEqual({
      complete: true,
      step: PendingOnboardingStep.ChooseSessionSync,
    });
    expect(unset.steps[1]).toEqual({
      complete: false,
      step: PendingOnboardingStep.ChooseSessionSync,
    });
    expect(off.blocking).not.toBe(unset.blocking);
  });

  it.each([
    [false, null],
    [true, null],
    [false, DataSyncLevel.Off],
  ] as const)(
    "never holds an existing member (downloaded=%s, policy=%s) but still reports the next step",
    (desktopAppDownloaded, syncPolicy) => {
      const gate = resolveSetupGate({
        desktopAppDownloaded,
        membership: EXISTING,
        syncPolicy,
      });
      expect(gate.blocking).toBe(false);
      expect(gate.nextStep).not.toBeNull();
    }
  );

  it("orders the completion card's steps download, then sync", () => {
    const gate = resolveSetupGate({
      desktopAppDownloaded: false,
      membership: EXISTING,
      syncPolicy: null,
    });
    expect(gate.steps.map((state) => state.step)).toEqual([
      PendingOnboardingStep.DownloadDesktop,
      PendingOnboardingStep.ChooseSessionSync,
    ]);
    expect(gate.nextStep).toBe(PendingOnboardingStep.DownloadDesktop);
  });

  it.each([
    ["an absent membership", undefined],
    ["a spelling from another build", "member"],
    ["a non-string", 2],
  ])("fails closed on %s", (_label, membership) => {
    const gate = resolveSetupGate({
      desktopAppDownloaded: true,
      membership,
      syncPolicy: null,
    });
    expect(gate.blocking).toBe(true);
  });
});

describe("isSetupGateStepOwed (ISS-12363, PR #8819 review)", () => {
  const SYNC = PendingOnboardingStep.ChooseSessionSync;

  it("owes the sync choice to a first user before the download is recorded", () => {
    // The modal routes on this while the download write is still in flight,
    // so `nextStep` still reads DownloadDesktop; the sync step is owed anyway.
    const gate = resolveSetupGate({
      desktopAppDownloaded: false,
      membership: FIRST,
      syncPolicy: null,
    });
    expect(isSetupGateStepOwed(gate, SYNC)).toBe(true);
  });

  it("does not owe the sync choice once one is recorded, Off included", () => {
    const gate = resolveSetupGate({
      desktopAppDownloaded: false,
      membership: FIRST,
      syncPolicy: DataSyncLevel.Off,
    });
    expect(isSetupGateStepOwed(gate, SYNC)).toBe(false);
  });

  it("never owes an existing member anything", () => {
    const gate = resolveSetupGate({
      desktopAppDownloaded: true,
      membership: EXISTING,
      syncPolicy: null,
    });
    expect(isSetupGateStepOwed(gate, SYNC)).toBe(false);
  });
});
