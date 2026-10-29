// @vitest-environment jsdom

/**
 * The sidebar checklist CTA and the blocking modal, mounted TOGETHER over one
 * QueryClient and one fake API (ISS-11249, ISS-11251).
 *
 * Neither half proves the product on its own: the card's own suite stubs the
 * transition hook, so it can only say a mutation was requested, and the host's
 * suites hand themselves a snapshot already parked on the phase under test. The
 * defect both tickets describe lives exactly in the seam between them — a press
 * that posts a transition the modal then does not render — so the press and the
 * screen it is supposed to produce have to be observed in one tree.
 */

import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
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
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { createGuidedQueryClient } from "../../hooks/__tests__/guided-onboarding.test-helpers";
import type { GuidedOnboardingRun } from "../../lib/guided-onboarding-run";
import { transitionOnboarding } from "../../lib/onboarding-transitions";
import { GETTING_STARTED_STEP_CONTENT } from "../getting-started-card-shell";
import { GuidedGettingStartedCard } from "../guided-getting-started-card";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

const mockApiClient = { get: vi.fn(), post: vi.fn() };

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const INVITE_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.InviteTeam].label;
const SYNC_ACTION_NAME =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.ChooseSessionSync].label;
/** Copy only the opened invite step emits. */
const INVITE_STEP_TITLE = "Invite people you build with";
/** Copy only the opened sync step emits. */
const SYNC_STEP_TITLE = "Choose what to sync";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resuming a checklist step from the sidebar card", () => {
  it("opens the invite step from the 2/4 state where both invite and sync are outstanding", async () => {
    mountShell({ syncConsentRecorded: KnownFlag.No, teamInvited: false });

    await waitFor(() => expect(screen.getByText("2/4")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: INVITE_ACTION_NAME }));

    await waitFor(() =>
      expect(screen.getByText(INVITE_STEP_TITLE)).toBeInTheDocument()
    );
  });

  it("opens the invite step from the 3/4 state where only invite is outstanding", async () => {
    mountShell({ syncConsentRecorded: KnownFlag.Yes, teamInvited: false });

    await waitFor(() => expect(screen.getByText("3/4")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: INVITE_ACTION_NAME }));

    await waitFor(() =>
      expect(screen.getByText(INVITE_STEP_TITLE)).toBeInTheDocument()
    );
  });

  /**
   * ISS-11251. The state the operator's inert press was in: a run override owns
   * the mount, so before the fix the card drew the SERVER run and posted a server
   * transition this modal was not watching — the press did nothing at all, with no
   * toast, because a failed guided transition is deliberately silent.
   *
   * The run here is a REAL run, not a stub: its `postTransition` runs the same
   * machine the server path pre-flights and publishes the next snapshot, so a card
   * that posts through it moves the very mount the reader is looking at.
   */
  it("opens the invite step when a run override owns the mount", async () => {
    mountShell({
      syncConsentRecorded: KnownFlag.No,
      teamInvited: false,
      useRunOverride: true,
    });

    await waitFor(() => expect(screen.getByText("2/4")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: INVITE_ACTION_NAME }));

    await waitFor(() =>
      expect(screen.getByText(INVITE_STEP_TITLE)).toBeInTheDocument()
    );
  });

  /**
   * ISS-11249 review (@tamsinb): on the RUN path the card's own `disabled` gate
   * never closed. `transition.isPending` belongs to the mutation the card only
   * fires when no run is supplied, so with a run in play it is false forever — a
   * double press posted `ResumePendingStep` twice against the same revision, the
   * server answered 409 on the second, and the handoff run treats a determinate
   * answer as the server ruling on the position and releases its hold.
   *
   * The poster here deliberately does NOT settle and does NOT move the snapshot:
   * that is the in-flight window the gate exists to cover, and the only window in
   * which a second press is reachable at all.
   */
  it("posts one resume for a double press while the run's post is in flight", async () => {
    const posted: string[] = [];
    mountShell({
      pendingPost: posted,
      syncConsentRecorded: KnownFlag.No,
      teamInvited: false,
      useRunOverride: true,
    });

    await waitFor(() => expect(screen.getByText("2/4")).toBeInTheDocument());
    const action = screen.getByRole("button", { name: INVITE_ACTION_NAME });
    fireEvent.click(action);
    await waitFor(() => expect(posted).toHaveLength(1));

    fireEvent.click(action);
    expect(action).toBeDisabled();
    expect(posted).toHaveLength(1);
  });

  it("opens the sync step in the modal rather than sending the reader to Settings", async () => {
    mountShell({ syncConsentRecorded: KnownFlag.No, teamInvited: true });

    await waitFor(() => expect(screen.getByText("3/4")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: SYNC_ACTION_NAME }));

    await waitFor(() =>
      expect(screen.getByText(SYNC_STEP_TITLE)).toBeInTheDocument()
    );
  });
});

function mountShell({
  pendingPost,
  syncConsentRecorded,
  teamInvited,
  useRunOverride = false,
}: {
  /** When given, the run's poster records into it and never settles. */
  pendingPost?: string[];
  syncConsentRecorded: KnownFlag;
  teamInvited: boolean;
  useRunOverride?: boolean;
}) {
  const snapshot = readySnapshot({ teamInvited });
  mockApiClient.get.mockResolvedValue(snapshot);
  mockApiClient.post.mockImplementation(
    (_path: string, command: { state: unknown }) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      state: command.state,
    })
  );
  const navigation = createMemoryNavigation({ initialPath: "/dashboard" });

  render(
    <QueryClientProvider client={createGuidedQueryClient()}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: "org-a",
          userId: "user-a",
        })}
      >
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <NavigationProvider adapter={navigation.adapter}>
            <Shell
              initialSnapshot={snapshot}
              pendingPost={pendingPost}
              syncConsentRecorded={syncConsentRecorded}
              useRunOverride={useRunOverride}
            />
          </NavigationProvider>
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

/**
 * The desktop shape under test: the modal host and the sidebar card as SIBLINGS,
 * handed the same run. `apps/desktop` relays that run between its two trees
 * through `guided-onboarding-run-override-store`; here they share one parent, so
 * the contract the relay exists to satisfy — one run, both mounts — is what is
 * pinned rather than the relay's plumbing.
 */
function Shell({
  initialSnapshot,
  pendingPost,
  syncConsentRecorded,
  useRunOverride,
}: {
  initialSnapshot: GuidedOnboardingSnapshot;
  pendingPost?: string[];
  syncConsentRecorded: KnownFlag;
  useRunOverride: boolean;
}) {
  const localRun = useLocalRun(initialSnapshot, syncConsentRecorded);
  const pendingRun: GuidedOnboardingRun = {
    isLoading: false,
    postTransition: (_current, event) => {
      pendingPost?.push(event.type);
    },
    snapshot: initialSnapshot,
  };
  const run = resolveRun({ localRun, pendingPost, pendingRun, useRunOverride });

  return (
    <>
      <GuidedOnboardingDialogHost
        analysisStarted={true}
        brand={null}
        dashboardActive={true}
        desktopMode={true}
        githubStatus={null}
        host={OnboardingHost.Desktop}
        onBackFallback={() => undefined}
        onDashboardAvailable={() => undefined}
        organizationChosen={true}
        run={run}
        syncConsentRecorded={syncConsentRecorded}
      />
      <GuidedGettingStartedCard
        analysisStarted={true}
        host={OnboardingHost.Desktop}
        run={run}
        syncConsentRecorded={syncConsentRecorded}
      />
    </>
  );
}

/**
 * A local run source in the shape `useGuestGuidedOnboardingRun` and
 * `useGuestGuidedOnboardingHandoff` produce: real machine, real snapshot
 * publication, no server. A stubbed `postTransition` would go green on a card
 * that posted nowhere.
 */
function useLocalRun(
  initialSnapshot: GuidedOnboardingSnapshot,
  syncConsentRecorded: KnownFlag
): GuidedOnboardingRun {
  const [snapshot, setSnapshot] =
    useState<GuidedOnboardingSnapshot>(initialSnapshot);

  return {
    isLoading: false,
    postTransition: (current, event) => {
      const result = transitionOnboarding(
        restoreOnboardingState(current.state, OnboardingHost.Desktop).state,
        event,
        {
          ...current.context,
          analysisStarted: true,
          host: OnboardingHost.Desktop,
          organizationActive: KnownFlag.Yes,
          syncConsentRecorded,
        }
      );
      if (result.status !== "moved") {
        return;
      }
      setSnapshot({
        ...current,
        revision: current.revision + 1,
        state: serializeOnboardingState(result.state),
      });
    },
    snapshot,
  };
}

function readySnapshot({
  teamInvited,
}: {
  teamInvited: boolean;
}): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited,
      tourCompleted: true,
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

/** A run for the mount, or the server path. Extracted to keep `Shell` flat. */
function resolveRun({
  localRun,
  pendingPost,
  pendingRun,
  useRunOverride,
}: {
  localRun: GuidedOnboardingRun;
  pendingPost?: string[];
  pendingRun: GuidedOnboardingRun;
  useRunOverride: boolean;
}): GuidedOnboardingRun | undefined {
  if (!useRunOverride) {
    return;
  }
  return pendingPost ? pendingRun : localRun;
}
