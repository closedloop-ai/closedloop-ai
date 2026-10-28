// @vitest-environment jsdom

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GETTING_STARTED_CARD_LABEL,
  GETTING_STARTED_STEP_CONTENT,
} from "../getting-started-card-shell";
import { GuidedGettingStartedCard } from "../guided-getting-started-card";

const mockGuidedHooks = vi.hoisted(() => ({
  mutate: vi.fn(),
  useGuidedOnboardingSnapshot: vi.fn(),
  useGuidedOnboardingTransition: vi.fn(),
}));

vi.mock("../../hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: mockGuidedHooks.useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition: mockGuidedHooks.useGuidedOnboardingTransition,
}));

// ISS-10942: the action carries the pending step's OWN label, not a generic
// "Continue" / "Open Settings". Read from the canonical map so a reworded label
// moves this file with it.
const SYNC_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.ChooseSessionSync].label;
const GITHUB_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.ConnectGitHub].label;

beforeEach(() => {
  vi.clearAllMocks();
  mockGuidedHooks.useGuidedOnboardingSnapshot.mockReturnValue({
    data: readySnapshot(),
    isLoading: false,
  });
  mockGuidedHooks.useGuidedOnboardingTransition.mockReturnValue({
    isPending: false,
    mutate: mockGuidedHooks.mutate,
  });
});

describe("GuidedGettingStartedCard", () => {
  /**
   * ISS-11249: the sync election resumes a PHASE, so its action is the same
   * in-modal button every other step gets. A link here would be the Settings
   * detour the operator reported.
   */
  it("renders the Desktop sync choice last as an in-modal action, not a Settings link", () => {
    renderCard({
      host: OnboardingHost.Desktop,
      syncConsentRecorded: KnownFlag.No,
    });

    expect(screen.getByText("3/4")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SYNC_ACTION_NAME })
    ).toBeEnabled();
    expect(screen.queryByRole("link", { name: SYNC_ACTION_NAME })).toBeNull();
  });

  /**
   * ISS-11249: the denominator no longer moves with a Settings link's existence.
   * Before the fix the same context read 2/3 with no link and 2/4 with one, which
   * is what made "Getting started" count differently either side of sign-in.
   */
  it("keeps the Desktop denominator at four with no Settings link in play", () => {
    const snapshot = readySnapshot({ githubConnected: false });
    mockGuidedHooks.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });

    renderCard({
      host: OnboardingHost.Desktop,
      syncConsentRecorded: KnownFlag.No,
    });

    expect(screen.getByText(GITHUB_ACTION_NAME)).toBeInTheDocument();
    expect(screen.getByText("2/4")).toBeInTheDocument();
  });

  it("withholds the sync row until the Desktop consent read is settled", () => {
    renderCard({
      host: OnboardingHost.Desktop,
      syncConsentReadSettled: false,
      syncConsentRecorded: KnownFlag.No,
    });

    expect(screen.queryByLabelText(GETTING_STARTED_CARD_LABEL)).toBeNull();
  });

  it("keeps a settled unknown consent read incomplete and actionable", () => {
    renderCard({
      host: OnboardingHost.Desktop,
      syncConsentReadSettled: true,
      syncConsentRecorded: KnownFlag.Unknown,
    });

    expect(
      screen.getByRole("button", { name: SYNC_ACTION_NAME })
    ).toBeEnabled();
  });

  it("dispatches ResumePendingStep for a phase-backed row", () => {
    const snapshot = readySnapshot({ githubConnected: false });
    mockGuidedHooks.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });

    renderCard({
      host: OnboardingHost.Desktop,
      syncConsentRecorded: KnownFlag.No,
    });

    expect(screen.getByText(GITHUB_ACTION_NAME)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: GITHUB_ACTION_NAME }));
    expect(mockGuidedHooks.mutate).toHaveBeenCalledWith({
      event: {
        step: PendingOnboardingStep.ConnectGitHub,
        type: OnboardingEvent.ResumePendingStep,
      },
      snapshot,
    });
  });
});

function renderCard(
  props: Partial<ComponentProps<typeof GuidedGettingStartedCard>>
) {
  const navigation = createMemoryNavigation({ initialPath: "/dashboard" });

  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
    >
      <NavigationProvider adapter={navigation.adapter}>
        <GuidedGettingStartedCard
          analysisStarted={true}
          host={OnboardingHost.Desktop}
          {...props}
        />
      </NavigationProvider>
    </FeatureFlagAdapterProvider>
  );
}

function readySnapshot(
  context: Partial<GuidedOnboardingSnapshot["context"]> = {}
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: true,
      ...context,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 3,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: [
        OnboardingPhase.DashboardAvailable,
        OnboardingPhase.DashboardTour,
      ],
      organizationEstablished: true,
      phase: OnboardingPhase.Ready,
      resuming: false,
    }),
  };
}
