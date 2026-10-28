// @vitest-environment jsdom

/**
 * ISS-10195 follow-up: the host must open on a run it is HANDED, with no server
 * snapshot behind it.
 *
 * This is the regression itself. A signed-out guest never fires
 * `useGuidedOnboardingSnapshot` (it gates on `userId !== null`), so `data` is
 * `undefined` and the host's `open` was false for want of a snapshot rather
 * than because of any phase. The first case below fails without the `run` seam;
 * the counterfactual beside it pins that the seam is what carries it, by
 * driving the SAME mount with the same absent server read and no run.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingAccountMode } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { settingsLocalSyncPolicyReady } from "@repo/api/src/types/settings-host-capabilities";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";
import { DESKTOP_WELCOME_CTA_LABEL } from "../guided-onboarding-welcome-copy";

const mockHostDeps = vi.hoisted(() => ({
  inviteTeam: vi.fn(),
  mutate: vi.fn(),
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

vi.mock("../../hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: mockHostDeps.inviteTeam,
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));

vi.mock("../../hooks/use-onboarding-organization-members", () => ({
  useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
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

/** The desktop startup pass mid-import, as `useStartupReadiness` reports it. */
const RUNNING_STARTUP_OVERRIDE = {
  active: true,
  analyzed: 2,
  counterUnit: "source files",
  found: 5,
  label: "Processing agent history",
  percent: 40,
  progressLabel: "Agent history source files processed",
};

const WELCOME_HEADING = "Discover how you (and your team) build with AI.";

beforeEach(() => {
  vi.clearAllMocks();
  // The guest's actual server read: the query never fires, so there is no data.
  mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
    data: undefined,
    isLoading: false,
  });
  mockHostDeps.useGuidedOnboardingTransition.mockReturnValue({
    isPending: false,
    mutate: mockHostDeps.mutate,
  });
});

describe("GuidedOnboardingDialogHost guest run", () => {
  it("opens the welcome step from a supplied run when the server has no snapshot", () => {
    renderHost({ run: guestRun() });

    // BY ROLE, not by text: ISS-11315 gave the dialog a polite live region
    // carrying the step's own heading text, so that string is now in the
    // document twice — the rendered `h2` and the sr-only announcement. The
    // heading is what this case is about.
    expect(screen.getByRole("heading", { name: WELCOME_HEADING })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    ).toBeTruthy();
  });

  it("stays closed on the same absent server read when no run is supplied", () => {
    renderHost();

    expect(screen.queryByRole("heading", { name: WELCOME_HEADING })).toBeNull();
  });

  // ISS-10570: the dashboard mounts BEHIND this modal on both shells, and
  // desktop's first-launch tour arm is phase-blind, so it cannot tell that the
  // run it is about to spend is covered. This is the only thing that tells it.
  // Both states, against the same reporter: a host that reported `true`
  // unconditionally would satisfy the open half alone, and holding a tour
  // unspendable forever is the one direction that cannot be recovered from.
  it("reports the takeover open while a blocking phase holds the modal up", () => {
    const onOpenChange = vi.fn();

    renderHost({ onOpenChange, run: guestRun() });

    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("reports the takeover closed when no run holds the modal up", () => {
    const onOpenChange = vi.fn();

    renderHost({ onOpenChange });

    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("reports the takeover closed when the host goes away", () => {
    const onOpenChange = vi.fn();
    const { unmount } = renderHost({ onOpenChange, run: guestRun() });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    unmount();

    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("renders the startup override when no onboarding dialog is open", () => {
    renderHost({
      analysisBannerOverride: RUNNING_STARTUP_OVERRIDE,
      onAnalysisBannerHeightChange: vi.fn(),
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Processing agent history")).toBeTruthy();
    expect(screen.getByText("2 / 5 source files")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", {
          name: "Agent history source files processed",
        })
        .getAttribute("aria-valuenow")
    ).toBe("40");
  });

  // ISS-10950: the filed bug. The startup pass reported "545 / 7,974 source
  // files" behind an unanswered Welcome modal whose own button says analysis has
  // not started. The override is `active` — suppressing it by handing in an
  // inactive one would prove nothing about the gate.
  it.each([OnboardingPhase.Welcome, OnboardingPhase.SessionDiscovery])(
    "suppresses the startup override on %s",
    (phase) => {
      renderHost({
        analysisBannerOverride: RUNNING_STARTUP_OVERRIDE,
        onAnalysisBannerHeightChange: vi.fn(),
        run: guestRun(phase),
      });

      expect(screen.queryByText("Processing agent history")).toBeNull();
      expect(screen.queryByText("2 / 5 source files")).toBeNull();
      expect(
        screen.queryByRole("progressbar", {
          name: "Agent history source files processed",
        })
      ).toBeNull();
    }
  );

  // AC4's other half: the same override, one phase later, still renders. Without
  // it the suppression above is satisfied by a gate that never opens. Session
  // Discovery is the first phase after Start, which is the agreement (ISS-10890).
  it("renders the startup override after Continue leaves discovery", () => {
    renderHost({
      analysisBannerOverride: RUNNING_STARTUP_OVERRIDE,
      onAnalysisBannerHeightChange: vi.fn(),
      run: guestRun(OnboardingPhase.Account),
    });

    expect(screen.getByText("Processing agent history")).toBeTruthy();
    expect(screen.getByText("2 / 5 source files")).toBeTruthy();
  });

  it.each([
    { history: [OnboardingPhase.Welcome], visible: false },
    {
      history: [
        OnboardingPhase.Welcome,
        OnboardingPhase.SessionDiscovery,
        OnboardingPhase.Account,
        OnboardingPhase.CreateOrganization,
      ],
      visible: true,
    },
  ])(
    "uses Discovery advancement for sync progress: $visible",
    ({ history, visible }) => {
      renderHost({
        analysisBannerOverride: RUNNING_STARTUP_OVERRIDE,
        onAnalysisBannerHeightChange: vi.fn(),
        run: runAt(OnboardingPhase.SyncPolicy, history),
      });

      expect(screen.queryByText("Processing agent history") !== null).toBe(
        visible
      );
    }
  );

  it("does not report agreement for a Start press the run has not taken", () => {
    const onAnalysisAgreed = vi.fn();
    const run = guestRun();
    renderHost({ onAnalysisAgreed, run });

    fireEvent.click(
      screen.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    );

    expect(run.postTransition).toHaveBeenCalledWith(run.snapshot, {
      type: OnboardingEvent.Start,
    });
    expect(onAnalysisAgreed).not.toHaveBeenCalled();
  });

  it("reports agreement once the run has left Welcome through Start", () => {
    const onAnalysisAgreed = vi.fn();
    const view = renderHost({ onAnalysisAgreed, run: guestRun() });
    expect(onAnalysisAgreed).not.toHaveBeenCalled();

    view.rerender(
      <GuidedOnboardingDialogHost
        {...hostProps({
          onAnalysisAgreed,
          run: guestRun(OnboardingPhase.SessionDiscovery),
        })}
      />
    );

    expect(onAnalysisAgreed).toHaveBeenCalledTimes(1);
  });

  it("reports agreement for an ISS-10624-order run restored at the sync step", () => {
    const onAnalysisAgreed = vi.fn();
    renderHost({
      onAnalysisAgreed,
      run: runAt(OnboardingPhase.SyncPolicy, [OnboardingPhase.Welcome]),
    });

    expect(onAnalysisAgreed).toHaveBeenCalledTimes(1);
  });

  it("does not report agreement for a settled run that never passed Welcome here", () => {
    const onAnalysisAgreed = vi.fn();
    renderHost({
      onAnalysisAgreed,
      run: runAt(OnboardingPhase.Ready, [OnboardingPhase.DashboardAvailable]),
    });

    expect(onAnalysisAgreed).not.toHaveBeenCalled();
  });

  it("does not report agreement for a run another device already finished", () => {
    const onAnalysisAgreed = vi.fn();
    renderHost({
      onAnalysisAgreed,
      run: runAt(OnboardingPhase.Ready, [
        OnboardingPhase.Welcome,
        OnboardingPhase.SessionDiscovery,
        OnboardingPhase.Account,
        OnboardingPhase.CreateOrganization,
        OnboardingPhase.SyncPolicy,
        OnboardingPhase.InviteTeam,
        OnboardingPhase.DashboardAvailable,
        OnboardingPhase.DashboardTour,
      ]),
    });

    expect(onAnalysisAgreed).not.toHaveBeenCalled();
  });

  it("routes Start to the run's poster and never to the server mutation", () => {
    const run = guestRun();
    renderHost({ run });

    fireEvent.click(
      screen.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    );

    expect(run.postTransition).toHaveBeenCalledWith(run.snapshot, {
      type: OnboardingEvent.Start,
    });
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
  });

  it("disables the server snapshot query while a run owns the mount", () => {
    renderHost({ run: guestRun() });

    expect(mockHostDeps.useGuidedOnboardingSnapshot).toHaveBeenCalledWith(
      OnboardingHost.Desktop,
      { enabled: false }
    );
  });

  it("leaves the server read enabled when no run is supplied", () => {
    renderHost();

    expect(mockHostDeps.useGuidedOnboardingSnapshot).toHaveBeenCalledWith(
      OnboardingHost.Desktop,
      { enabled: true }
    );
  });

  it("advances Session Discovery through the machine instead of just navigating", () => {
    // The button fell through to `onComplete` -> `onDashboardAvailable()`, which
    // navigated under a dialog whose phase never moved, so the modal stayed up
    // and the click looked inert. Asserting the EVENT, not the absence of a
    // navigation, because navigating is not itself wrong here — failing to
    // advance the run is.
    const run = guestRun(OnboardingPhase.SessionDiscovery);
    renderHost({ run });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(run.postTransition).toHaveBeenCalledWith(
      run.snapshot,
      { type: OnboardingEvent.ContinueFromDiscovery },
      // ISS-10502: an unmeasured discovery reports no counts, never zeros.
      { analytics: {} }
    );
  });

  it("routes the Account step's Sign in control to the host's sign-in", () => {
    // It used to fall back to `onComplete`, which posts nothing unless the
    // account is already Established — so for a guest it navigated beneath a
    // dialog that stayed open, and desktop never called `beginSignIn`.
    const onSignIn = vi.fn();
    const run = guestRun(OnboardingPhase.Account);
    renderHost({ onSignIn, run });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(run.postTransition).not.toHaveBeenCalled();
  });

  // ISS-10913: the desktop host observes the auth return and hands the folded
  // facts down; the shared host attaches them to the account completion.
  it("attaches the host's account_mode to the account-step completion", () => {
    const run = establishedAccountRun();
    renderHost({
      accountMode: [
        OnboardingAccountMode.Created,
        OnboardingAccountMode.SignedIn,
      ],
      run,
    });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(run.postTransition).toHaveBeenCalledWith(
      run.snapshot,
      {
        provider: AccountProvider.GitHub,
        type: OnboardingEvent.AccountEstablished,
      },
      {
        analytics: {
          accountMode: [
            OnboardingAccountMode.Created,
            OnboardingAccountMode.SignedIn,
          ],
        },
      }
    );
  });

  it("posts the account completion with the original arity when no host observed an auth return", () => {
    // Web: a run poster is an external contract, so a host with nothing to
    // report must hand it the same two-argument call it always did.
    const run = establishedAccountRun();
    renderHost({ run });

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(run.postTransition).toHaveBeenCalledWith(run.snapshot, {
      provider: AccountProvider.GitHub,
      type: OnboardingEvent.AccountEstablished,
    });
  });

  it("still posts through the server when a snapshot exists and no run is given", () => {
    const snapshot = guestSnapshot();
    mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
      data: snapshot,
      isLoading: false,
    });

    renderHost();
    fireEvent.click(
      screen.getByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    );

    expect(mockHostDeps.mutate).toHaveBeenCalledWith(
      { event: { type: OnboardingEvent.Start }, snapshot },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });
});

function renderHost(
  props: Partial<ComponentProps<typeof GuidedOnboardingDialogHost>> = {}
) {
  return render(<GuidedOnboardingDialogHost {...hostProps(props)} />);
}

function hostProps(
  props: Partial<ComponentProps<typeof GuidedOnboardingDialogHost>>
): ComponentProps<typeof GuidedOnboardingDialogHost> {
  return {
    analysisStarted: true,
    brand: <span>Closedloop.ai</span>,
    dashboardActive: false,
    desktopMode: true,
    host: OnboardingHost.Desktop,
    onBackFallback: vi.fn(),
    onDashboardAvailable: vi.fn(),
    ...props,
  };
}

/** A guest run held at `phase` with an explicit walked `history`. */
function runAt(phase: OnboardingPhase, history: OnboardingPhase[]) {
  const snapshot = guestSnapshot(phase);
  return {
    isLoading: false,
    postTransition: vi.fn(),
    snapshot: {
      ...snapshot,
      state: serializeOnboardingState({
        ...createInitialOnboardingState(),
        history,
        phase,
      }),
    },
  };
}

/** A guest snapshot: no account, no attempt row, at `phase`. */
function guestSnapshot(
  phase: OnboardingPhase = OnboardingPhase.Welcome
): GuidedOnboardingSnapshot {
  return {
    attemptId: null,
    context: {
      accountProvider: null,
      accountStatus: AccountStatus.None,
      desktopAppDownloaded: true,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Unknown,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Absent,
    revision: 0,
    state: serializeOnboardingState({
      ...createInitialOnboardingState(),
      history: historyFor(phase),
      phase,
    }),
  };
}

/**
 * The path a desktop guest actually walked to reach `phase`.
 *
 * Not decoration: a history that skips an edge restores as
 * `UnreachableState` and recovers to a fresh Welcome, so a fixture with a
 * plausible-looking history would silently test the wrong phase.
 */
function historyFor(phase: OnboardingPhase): OnboardingPhase[] {
  if (phase === OnboardingPhase.Welcome) {
    return [];
  }
  if (phase === OnboardingPhase.SessionDiscovery) {
    return [OnboardingPhase.Welcome];
  }
  if (phase === OnboardingPhase.SyncPolicy) {
    return [
      OnboardingPhase.Welcome,
      OnboardingPhase.SessionDiscovery,
      OnboardingPhase.Account,
      OnboardingPhase.CreateOrganization,
    ];
  }
  return [OnboardingPhase.Welcome, OnboardingPhase.SessionDiscovery];
}

/**
 * A run whose account is already ESTABLISHED at the Account step — the state in
 * which the step's own Continue control completes the step.
 */
function establishedAccountRun() {
  const snapshot = guestSnapshot(OnboardingPhase.Account);
  return {
    isLoading: false,
    postTransition: vi.fn(),
    snapshot: {
      ...snapshot,
      context: {
        ...snapshot.context,
        accountProvider: AccountProvider.GitHub,
        accountStatus: AccountStatus.Established,
      },
    },
  };
}

function guestRun(phase?: OnboardingPhase) {
  return {
    isLoading: false,
    postTransition: vi.fn(),
    snapshot: guestSnapshot(phase),
  };
}
