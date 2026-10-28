// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
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
} from "@repo/api/src/types/onboarding-phase";
import { settingsLocalSyncPolicyReady } from "@repo/api/src/types/settings-host-capabilities";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { FIXTURE_JOINABLE_ORGANIZATION } from "../../lib/guided-onboarding-fixtures";
import {
  CHOOSE_ORGANIZATION_LOOKUP_PENDING_COPY as PENDING_COPY,
  CHOOSE_ORGANIZATION_LOOKUP_UNAVAILABLE_COPY as UNAVAILABLE_LOOKUP_COPY,
} from "../guided-onboarding-choose-organization-step";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialog } from "../guided-onboarding-dialog";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

const mockHostDeps = vi.hoisted(() => ({
  useGuidedOnboardingSnapshot: vi.fn(),
  useGuidedOnboardingTransition: vi.fn(),
}));

// Behind `useDesktopAppRunning`: these suites mount the host with no provider.
vi.mock("../../../compute/hooks/use-compute-targets", () => ({
  useComputeTargets: () => ({ data: undefined }),
}));

vi.mock("../../hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: mockHostDeps.useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition: mockHostDeps.useGuidedOnboardingTransition,
}));

vi.mock("../../hooks/use-onboarding-organization-members", () => ({
  useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
}));

// The shared host mounts the invite and sync-policy hooks unconditionally, and
// both reach a provider this suite deliberately does not stand up — the seam under
// test is the retry prop, not the invite or the sync write.
vi.mock("../../hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));

vi.mock("../../../shared/settings-host/use-local-sync-policy", () => ({
  useLocalSyncPolicy: () => ({
    isWriting: false,
    state: {
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      status: "settled",
    },
    supported: true,
    write: vi.fn(),
    writeOutcome: null,
  }),
}));

const DOWNLOAD_HREFS = {
  linux: "https://downloads.test/Closedloop.AppImage",
  mac: "https://downloads.test/Closedloop-universal.dmg",
  windows: "https://downloads.test/Closedloop-Setup.exe",
} as const;

/**
 * The Choose-organization phase's WIRING, through the real `GuidedOnboardingDialog`
 * rather than through the step in isolation.
 *
 * Split out of `guided-onboarding-dialog.test.tsx` when ISS-11158's retry case
 * pushed that file past the 1,000-line ceiling. The seam these cases own is
 * `selectChooseOrganizationStepProps` — which dialog prop reaches which step
 * prop — and neither the step suite (which hands the step its props directly)
 * nor the web host suite (which captures the dialog's props on a mock) crosses
 * it. What each arm RENDERS stays in the step suite.
 */
describe("GuidedOnboardingDialog — Choose organization", () => {
  // ISS-11158, the LAST hop, and the reason it lives beside the dialog-level case
  // rather than in the shared host's own suite: that file is at the 1,000-line
  // ceiling, and the seam is the same one this file already owns — which prop
  // reaches which prop — one layer up.
  //
  // The chain is web adapter -> shared `GuidedOnboardingDialogHost` ->
  // `GuidedOnboardingDialog` -> `selectChooseOrganizationStepProps` -> step. The
  // step suite hands the step its prop directly, the web-adapter suite MOCKS the
  // shared host module and reads the prop off the capture, and the case below
  // renders the dialog without the host — so deleting the shared host's one
  // pass-through line left production's Retry inert with every suite still green
  // (review-soul). This presses the real button through the real shared host.
  it("routes the failed-lookup Retry from the shared host to the re-read", () => {
    const onRetryJoinableOrganizationLookup = vi.fn();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: chooseOrganizationSnapshot(),
      isLoading: false,
    });
    mockHostDeps.useGuidedOnboardingTransition.mockReturnValue({
      isPending: false,
      mutate: vi.fn(),
    });

    render(
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: null,
          userId: "user-a",
        })}
      >
        <GuidedOnboardingDialogHost
          analysisStarted
          brand={<span>Closedloop.ai</span>}
          dashboardActive={false}
          desktopMode={false}
          host={OnboardingHost.Web}
          joinableOrganization={{ status: "unavailable" }}
          onBackFallback={vi.fn()}
          onDashboardAvailable={vi.fn()}
          onRetryJoinableOrganizationLookup={onRetryJoinableOrganizationLookup}
          organizationChosen={false}
          organizationName="Example Organization"
          organizationSlug="example-organization"
        />
      </AuthAdapterProvider>
    );

    // Positive control on the arm itself, so a Retry belonging to some other row
    // cannot satisfy this, and the pending sentence is gone from the same card.
    expect(
      screen.getByRole("alert", { name: UNAVAILABLE_LOOKUP_COPY.title })
    ).toBeInTheDocument();
    expect(screen.queryByText(PENDING_COPY.announcement)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: UNAVAILABLE_LOOKUP_COPY.retryLabel })
    );

    expect(onRetryJoinableOrganizationLookup).toHaveBeenCalledTimes(1);
  });

  // ISS-11145 changed what Join DOES, so this case changed with it: Join routes
  // to the host's JOIN, not straight to the phase transition. The run advances
  // only once that join resolves (pinned in the host suite), so asserting
  // `onContinueFromOrganization` here would assert the lying-button behavior the
  // operator ruling removed. What this case still owns is that Create and Join
  // are separate doors.
  it("routes Create new organization away from the join action", () => {
    const onContinueFromOrganization = vi.fn();
    const onJoinOrganization = vi.fn();
    const onStartCreateOrganization = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        // The Join affordance is data-driven: only a matched organization
        // renders one (ISS-8678), and only where the host can honor it
        // (ISS-11145), where the step used to hard-code a row.
        joinableOrganization={FIXTURE_JOINABLE_ORGANIZATION}
        onComplete={vi.fn()}
        onContinueFromOrganization={onContinueFromOrganization}
        onJoinOrganization={onJoinOrganization}
        onStartCreateOrganization={onStartCreateOrganization}
        open
        phase={OnboardingPhase.ChooseOrganization}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Create new organization" })
    );
    expect(onStartCreateOrganization).toHaveBeenCalledTimes(1);
    expect(onJoinOrganization).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(onJoinOrganization).toHaveBeenCalledWith(
      FIXTURE_JOINABLE_ORGANIZATION.status === "available"
        ? FIXTURE_JOINABLE_ORGANIZATION.join
        : undefined
    );
    expect(onStartCreateOrganization).toHaveBeenCalledTimes(1);
    expect(onContinueFromOrganization).not.toHaveBeenCalled();
  });

  // ISS-11158, the SEAM: `selectChooseOrganizationStepProps` is what maps the
  // dialog's `onRetryJoinableOrganizationLookup` onto the step's `onRetryLookup`,
  // and neither the step suite (which injects the step prop directly) nor the web
  // host suite (which captures the dialog prop on a mock) crosses it — so
  // deleting that one line left production's Retry inert with every other case
  // green (review-soul). This renders the REAL dialog and presses the button.
  it("routes the failed-lookup Retry to the host's re-read", () => {
    const onRetryJoinableOrganizationLookup = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        joinableOrganization={{ status: "unavailable" }}
        onComplete={vi.fn()}
        onRetryJoinableOrganizationLookup={onRetryJoinableOrganizationLookup}
        open
        phase={OnboardingPhase.ChooseOrganization}
      />
    );

    expect(
      screen.getByRole("alert", { name: UNAVAILABLE_LOOKUP_COPY.title })
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: UNAVAILABLE_LOOKUP_COPY.retryLabel })
    );

    expect(onRetryJoinableOrganizationLookup).toHaveBeenCalledTimes(1);
  });

  it("wires the organization step's footer sign-out control", () => {
    const onSignOut = vi.fn();
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        onSignOut={onSignOut}
        open
        phase={OnboardingPhase.ChooseOrganization}
      />
    );

    // The footer's Privacy/Terms links moved to
    // `guided-onboarding-legal-links.test.tsx`, which pins the same two anchors
    // on this same phase against the absolute derivation ISS-11397 introduced —
    // and can control `NEXT_PUBLIC_WEB_URL`, which this file cannot.
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("omits the sign-out control when the host offers no sign-out", () => {
    render(
      <GuidedOnboardingDialog
        brand={<span>Closedloop.ai</span>}
        downloadHrefs={DOWNLOAD_HREFS}
        onComplete={vi.fn()}
        open
        phase={OnboardingPhase.ChooseOrganization}
      />
    );

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});

/** A run parked on Choose organization, for the shared-host case above. */
function chooseOrganizationSnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.ExistingMember,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 5,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
      organizationEstablished: false,
      phase: OnboardingPhase.ChooseOrganization,
      resuming: false,
    }),
  };
}
