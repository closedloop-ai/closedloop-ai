// @vitest-environment jsdom

/**
 * ISS-11149 row 2: on web the Dashboard tour never stacks with the blocking
 * modal, and begins only after the modal exits (PRD-689).
 *
 * Web has no arbiter between the two — it relies on the two answers being
 * disjoint over the whole phase set. The nearest existing case
 * (`dashboard-tour-completion.test.ts`, "does not ask from a phase the blocking
 * flow still owns") drives ONE phase through ONE predicate, so a phase newly
 * made tour-owed, or newly dropped out of the blocking set, changes nothing it
 * asserts. This drives BOTH production hooks off ONE snapshot, at EVERY phase,
 * which is the claim itself rather than a sample of it.
 */

import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGuidedDashboardTour } from "../use-guided-dashboard-tour";
import { useOnboardingModalOpen } from "../use-onboarding-modal-open";

const mockSnapshotQuery = vi.hoisted(() => ({
  useGuidedOnboardingSnapshot: vi.fn(),
  useGuidedOnboardingTransition: vi.fn(),
}));

vi.mock("../use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: mockSnapshotQuery.useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition:
    mockSnapshotQuery.useGuidedOnboardingTransition,
}));

const ATTEMPT_ID = "attempt-1";
const EVERY_PHASE = Object.values(OnboardingPhase);

beforeEach(() => {
  mockSnapshotQuery.useGuidedOnboardingTransition.mockReturnValue({
    mutate: vi.fn(),
  });
});

describe("web blocking modal and Dashboard tour", () => {
  it("never reports both open at the same phase", () => {
    for (const phase of EVERY_PHASE) {
      const { modalOpen, tourRequested } = readBothAt(phase);

      expect(
        modalOpen && tourRequested,
        `${phase} opens the modal and the tour together`
      ).toBe(false);
    }
  });

  it("opens the modal on the phases the blocking flow owns", () => {
    // Positive control for the first case, which an always-false pair of hooks
    // would satisfy. Every blocking phase must really open the modal.
    const opened = EVERY_PHASE.filter((phase) => readBothAt(phase).modalOpen);

    expect(opened).toEqual([
      OnboardingPhase.Welcome,
      OnboardingPhase.SessionDiscovery,
      OnboardingPhase.Account,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.ChooseOrganization,
      OnboardingPhase.SyncPolicy,
      OnboardingPhase.InviteTeam,
      OnboardingPhase.DownloadDesktop,
      OnboardingPhase.ConnectGitHub,
    ]);
  });

  it("asks for the tour only once the modal has let go", () => {
    // The other half of the control: the tour is really requested somewhere, and
    // only from phases the first case proved the modal does not own.
    const requested = EVERY_PHASE.filter(
      (phase) => readBothAt(phase).tourRequested
    );

    expect(requested).toEqual([
      OnboardingPhase.DashboardTour,
      OnboardingPhase.Ready,
    ]);
  });
});

/** Both production answers for one phase, from one snapshot. */
function readBothAt(phase: OnboardingPhase): {
  modalOpen: boolean;
  tourRequested: boolean;
} {
  const snapshot = webSnapshot(phase);
  mockSnapshotQuery.useGuidedOnboardingSnapshot.mockReturnValue({
    data: snapshot,
    isLoading: false,
  });
  const answers: { modalOpen: boolean; tourRequested: boolean } = {
    modalOpen: false,
    tourRequested: false,
  };

  function Probe() {
    answers.modalOpen = useOnboardingModalOpen(
      snapshot,
      { ...createInitialOnboardingState(), phase },
      null
    );
    answers.tourRequested = useGuidedDashboardTour({
      analysisStarted: false,
      host: OnboardingHost.Web,
      localSeen: false,
    }).tourRequested;
    return null;
  }

  const view = render(<Probe />);
  view.unmount();
  return answers;
}

/** A stored web run sitting at `phase`, with the tour not yet taken. */
function webSnapshot(phase: OnboardingPhase): GuidedOnboardingSnapshot {
  return {
    attemptId: ATTEMPT_ID,
    context: {
      accountProvider: null,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Unknown,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 1,
    state: serializeOnboardingState({
      ...createInitialOnboardingState(),
      phase,
    }),
  };
}
