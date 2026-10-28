// @vitest-environment jsdom

/**
 * The production host's two conditional wirings, driven through the real
 * `GuidedOnboardingDialogHost` mount because the defects both lived in what the
 * host PASSES, not in what a step renders from hand-made props.
 *
 * ISS-11255: the GitHub step's Skip control is passed only on the initial run
 * (`resuming === false`); a step resumed from the checklist leaves through Back.
 * ISS-11256: the Account step's per-method auth callbacks are passed only where
 * the host can service them, and a reader who already holds an account is not
 * shown the create-account methods at all.
 */

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { resolvePendingOnboardingStep } from "@repo/api/src/types/onboarding-completion";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
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
  type OnboardingContext,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { settingsLocalSyncPolicyReady } from "@repo/api/src/types/settings-host-capabilities";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { GITHUB_CONNECT_PROMPT_COPY } from "../../../github/lib/github-connect-copy";
import { buildOnboardingContext } from "../../lib/guided-onboarding-fixtures";
import {
  requiresGitHubStep,
  resolvePostInvitePhase,
  transitionOnboarding,
} from "../../lib/onboarding-transitions";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

const SKIP_NAME = "Skip for now";
const CONNECT_NAME =
  GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Connect].ctaLabel;
/** A settled, disconnected read: what puts the connect prompt on screen. */
const GITHUB_DISCONNECTED = { connected: false } as const;
const CONTINUE_WITH_GITHUB = "Continue with GitHub";
const CONTINUE_WITH_GOOGLE = "Continue with Google";
const CREATE_WITH_EMAIL = "Create account with email";

const mockHostDeps = vi.hoisted(() => ({
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
    invite: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockHostDeps.useGuidedOnboardingTransition.mockReturnValue({
    isPending: false,
    mutate: mockHostDeps.mutate,
  });
});

describe("ISS-11255: the GitHub step's Skip control", () => {
  it("survives on the initial Desktop run, whose only other exit is a grant", () => {
    showSnapshot(
      snapshotFor(initialDesktopGitHubState(), {
        accountProvider: AccountProvider.Google,
        accountStatus: AccountStatus.Established,
        githubConnected: false,
      })
    );

    renderHost({
      desktopMode: true,
      githubStatus: GITHUB_DISCONNECTED,
      host: OnboardingHost.Desktop,
    });

    // The step really mounted: its own connect control is on screen beside the
    // deferral, so the assertion below is about the Skip and not about a screen
    // that failed to render.
    expect(screen.getByRole("button", { name: CONNECT_NAME })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: SKIP_NAME }));

    expect(mockHostDeps.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: { type: OnboardingEvent.SkipGitHub },
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it("is absent once the step is resumed from the checklist, where Back leaves the flow", () => {
    showSnapshot(
      snapshotFor(resumedGitHubState(), {
        accountProvider: AccountProvider.Google,
        accountStatus: AccountStatus.Established,
        githubConnected: false,
      })
    );

    renderHost({
      desktopMode: true,
      githubStatus: GITHUB_DISCONNECTED,
      host: OnboardingHost.Desktop,
    });

    expect(screen.getByRole("button", { name: CONNECT_NAME })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: SKIP_NAME })).toBeNull();
  });

  /**
   * The same resumed step under Web, which reaches it through the identical
   * checklist route: `STEP_HOSTS[ConnectGitHub]` lists both hosts.
   */
  it("is absent on a Web run resumed from the checklist too", () => {
    showSnapshot(
      snapshotFor(resumedGitHubState(), {
        accountProvider: AccountProvider.Google,
        accountStatus: AccountStatus.Established,
        githubConnected: false,
      })
    );

    renderHost({
      githubStatus: GITHUB_DISCONNECTED,
      host: OnboardingHost.Web,
    });

    expect(screen.getByRole("button", { name: CONNECT_NAME })).not.toBeNull();
    expect(screen.queryByRole("button", { name: SKIP_NAME })).toBeNull();
  });

  /**
   * The host-independence tripwire.
   *
   * `buildGitHubSkipHandler` is keyed on the run's `resuming` flag and takes
   * no host, so the PR that introduced it claims Web keeps its Skip the day Web gains
   * an initial-run GitHub phase. That claim cannot be asserted through a
   * render today, and saying so is the point: `resolvePostInvitePhase` sends
   * an initial Web run to `DownloadDesktop`, `PHASE_EDGES[DownloadDesktop]`
   * leads only to `DashboardAvailable`, and `restoreOnboardingState` refuses a
   * Desktop chain under Web with `UnreachableOnHost` — so no Web run can hold
   * this phase with a blocking predecessor, and a render assertion would be
   * pinning a state the machine cannot produce.
   *
   * What IS assertable is the premise. ISS-11254 is adding exactly this path;
   * when it lands, this case goes red, and whoever lands it has to come back
   * to `buildGitHubSkipHandler` and give Web the render coverage that
   * becomes possible then. Without this, gating the handler on
   * `host === OnboardingHost.Desktop` leaves every case in this file green.
   */
  it("has no initial-run Web path to the GitHub step yet, which is what ISS-11254 changes", () => {
    const webContext = buildOnboardingContext({
      accountProvider: AccountProvider.Google,
      accountStatus: AccountStatus.Established,
      analysisStarted: true,
      githubConnected: false,
      host: OnboardingHost.Web,
      membership: OrganizationMembership.ExistingMember,
      organizationActive: KnownFlag.Yes,
      tourCompleted: true,
    });

    // The provider genuinely leaves the step owed — so the phase below is
    // Web's routing decision, not an absent prerequisite.
    expect(requiresGitHubStep(webContext)).toBe(true);
    expect(
      resolvePostInvitePhase(
        { ...webAccountState(), phase: OnboardingPhase.InviteTeam },
        webContext
      )
    ).toBe(OnboardingPhase.DownloadDesktop);
  });
});

describe("ISS-11255 AC2: deferral survives through the checklist item", () => {
  it("re-enters the GitHub step from the card, and its Back leaves the flow", () => {
    const context = desktopGitHubContext();
    const skipped = transitionOnboarding(
      initialDesktopGitHubState(),
      { type: OnboardingEvent.SkipGitHub },
      context
    );
    expect(skipped.status).toBe("moved");
    if (skipped.status !== "moved") {
      return;
    }
    expect(skipped.state.phase).toBe(OnboardingPhase.DashboardAvailable);
    // Resuming is entered from Ready, which is where the card lives.
    const ready = move(
      skipped.state,
      { type: OnboardingEvent.DashboardEntered },
      context
    );
    expect(ready.phase).toBe(OnboardingPhase.Ready);
    // The card offers exactly this step, so the resume below is the one a reader
    // can actually click rather than an event only a test can post.
    expect(resolvePendingOnboardingStep(context)).toBe(
      PendingOnboardingStep.ConnectGitHub
    );

    const resumed = move(
      ready,
      {
        step: PendingOnboardingStep.ConnectGitHub,
        type: OnboardingEvent.ResumePendingStep,
      },
      context
    );
    expect(resumed.phase).toBe(OnboardingPhase.ConnectGitHub);

    // And the resumed step is leavable without a grant, which is why it needs no
    // Skip of its own (see the render assertion above).
    expect(move(resumed, { type: OnboardingEvent.Back }, context).phase).toBe(
      OnboardingPhase.DashboardAvailable
    );
  });
});

/**
 * `buildGitHubSkipHandler` reads only `resuming`, so a history-less initial
 * GitHub state would be offered Skip with no blocking predecessor behind it.
 * The restore boundary refuses such a state, so the host never holds one.
 * Pinned because an unpinned "cannot happen" is how it stops being true.
 */
describe("ISS-11255: a history-less GitHub state is unreachable, not untested", () => {
  it("restores a history-less GitHub state to Welcome instead", () => {
    const restored = restoreOnboardingState(
      serializeOnboardingState({
        accountProvider: null,
        history: [],
        organizationEstablished: true,
        phase: OnboardingPhase.ConnectGitHub,
        resuming: false,
      }),
      OnboardingHost.Desktop
    );

    expect(restored.outcome).toBe(OnboardingRestoreOutcome.UnreachableState);
    expect(restored.state.phase).toBe(OnboardingPhase.Welcome);
    expect(restored.state.history).toEqual([]);
  });
});

describe("ISS-11256: the Account step's auth controls", () => {
  /*
   * The snapshot mocked here is a SKEWED PRODUCER's, named as such: since
   * ISS-11256 `buildServerContext` reports `Established` unconditionally, so no
   * API deploy carrying that change emits `Skipped`, and neither does the guest
   * run (`None`) or the handoff (`null`, then the server's measured context).
   * What does emit it is an API deploy that has not landed ISS-11256 yet, read
   * by a client built from this commit — the window `readerHasAccount`'s session
   * arm exists to cover, per the repo's version-skew carve-out.
   *
   * Pinned against that payload rather than against a null snapshot, because a
   * null snapshot leaves `currentState` null and the dialog on its restoring
   * body: no Account step renders, so the three nulls below would pass with the
   * session arm deleted and prove nothing. This case dies when it is deleted.
   */
  it("are not rendered to a signed-in reader whose snapshot still reports Skipped", () => {
    showSnapshot(
      snapshotFor(webAccountState(), {
        accountProvider: null,
        accountStatus: AccountStatus.Skipped,
      })
    );

    renderHost({
      account: { email: "reader@example.com", status: "signed-in" },
      host: OnboardingHost.Web,
    });

    expect(
      screen.queryByRole("button", { name: CONTINUE_WITH_GITHUB })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: CONTINUE_WITH_GOOGLE })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: CREATE_WITH_EMAIL })
    ).toBeNull();
    // The positive sibling: the step mounted and says what it replaced those
    // three controls with, so the nulls above are not a failed render.
    expect(screen.getByText("Account created")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(mockHostDeps.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          provider: AccountProvider.Email,
          type: OnboardingEvent.AccountEstablished,
        },
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it("still work for a host that wired onAccountSelect", () => {
    const onAccountSelect = vi.fn();
    showSnapshot(
      snapshotFor(webAccountState(), {
        accountProvider: null,
        accountStatus: AccountStatus.None,
      })
    );

    renderHost({
      desktopMode: true,
      host: OnboardingHost.Desktop,
      onAccountSelect,
    });

    // All three, because the defect was all three: the host BUILDS this set, and
    // a missing key is `tsc`-clean (every dialog prop here is optional) and falls
    // silently back to `onComplete`.
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_WITH_GITHUB }));
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_WITH_GOOGLE }));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "reader@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: CREATE_WITH_EMAIL }));

    expect(onAccountSelect).toHaveBeenNthCalledWith(1, {
      event: {
        provider: AccountProvider.GitHub,
        type: OnboardingEvent.AccountEstablished,
      },
      method: "github",
    });
    expect(onAccountSelect).toHaveBeenNthCalledWith(2, {
      event: {
        provider: AccountProvider.Google,
        type: OnboardingEvent.AccountEstablished,
      },
      method: "google",
    });
    expect(onAccountSelect).toHaveBeenNthCalledWith(3, {
      email: "reader@example.com",
      event: {
        provider: AccountProvider.Email,
        type: OnboardingEvent.AccountEstablished,
      },
      method: "email",
    });
  });

  /**
   * The degenerate residue: a host with no `onAccountSelect` AND no account fact
   * to report. The methods do render there, so each one must still reach the
   * host's own completion path rather than resolving to nothing — which is what
   * an always-supplied callback folding to `undefined` did.
   *
   * Reaching that path is NOT the run completing, and this case pins both
   * halves so the weaker one cannot be misread as success. `handleComplete`'s
   * false branch calls `onDashboardAvailable()` and posts nothing, so the run
   * stays on the blocking `Account` phase and the modal does not close — the
   * limitation the desktop host's own `onSignIn` comment already records, and
   * the reason this PR makes the controls ABSENT for a reader who has an
   * account rather than wiring them to this path. Neither production shell
   * reaches this configuration: Web passes `account` for every reader and
   * Desktop wires `onAccountSelect`.
   */
  it("fall back to the host's completion path, which navigates without settling the run", () => {
    const onDashboardAvailable = vi.fn();
    showSnapshot(
      snapshotFor(webAccountState(), {
        accountProvider: null,
        accountStatus: AccountStatus.None,
      })
    );

    renderHost({ host: OnboardingHost.Web, onDashboardAvailable });

    fireEvent.click(screen.getByRole("button", { name: CONTINUE_WITH_GITHUB }));

    expect(onDashboardAvailable).toHaveBeenCalledTimes(1);
    // The absence that makes the line above honest, on the same click: no
    // transition is posted, so `account_established` never lands and the
    // phase the run is persisted on does not move.
    expect(mockHostDeps.mutate).not.toHaveBeenCalled();
  });
});

function showSnapshot(snapshot: GuidedOnboardingSnapshot) {
  mockHostDeps.useGuidedOnboardingSnapshot.mockReturnValue({
    data: snapshot,
    isLoading: false,
  });
}

function renderHost(
  props: Partial<ComponentProps<typeof GuidedOnboardingDialogHost>>
) {
  return render(
    <GuidedOnboardingDialogHost
      analysisStarted={true}
      brand={<span>Closedloop.ai</span>}
      dashboardActive={false}
      desktopMode={false}
      host={OnboardingHost.Web}
      onBackFallback={vi.fn()}
      onDashboardAvailable={vi.fn()}
      organizationChosen
      organizationName="Example Organization"
      organizationSlug="example-organization"
      {...props}
    />
  );
}

function snapshotFor(
  state: OnboardingMachineState,
  context: Partial<GuidedOnboardingSnapshot["context"]>
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.Google,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: false,
      membership: OrganizationMembership.ExistingMember,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: false,
      ...context,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 5,
    state: serializeOnboardingState(state),
  };
}

/**
 * The initial Desktop run's GitHub phase, walked with the real machine rather
 * than asserted into existence: the restore boundary rejects any state no run
 * can produce, so a hand-built chain would prove nothing about this arm.
 */
function initialDesktopGitHubState(): OnboardingMachineState {
  const context = desktopGitHubContext();
  return walk(
    { ...initialState(), phase: OnboardingPhase.Welcome },
    [
      { type: OnboardingEvent.Start },
      { type: OnboardingEvent.ContinueFromDiscovery },
      {
        provider: AccountProvider.Google,
        type: OnboardingEvent.AccountEstablished,
      },
      { type: OnboardingEvent.OrganizationReady },
      { type: OnboardingEvent.ContinueFromSyncPolicy },
      { type: OnboardingEvent.SkipInvitations },
    ],
    context
  );
}

/** The same phase reached from the getting-started checklist. */
function resumedGitHubState(): OnboardingMachineState {
  return {
    accountProvider: AccountProvider.Google,
    history: [OnboardingPhase.DashboardAvailable],
    organizationEstablished: true,
    phase: OnboardingPhase.ConnectGitHub,
    resuming: true,
  };
}

/** Web's Account phase, reached the only way Web reaches it: Welcome's Start. */
function webAccountState(): OnboardingMachineState {
  return {
    accountProvider: null,
    history: [OnboardingPhase.Welcome],
    organizationEstablished: false,
    phase: OnboardingPhase.Account,
    resuming: false,
  };
}

function initialState(): OnboardingMachineState {
  return {
    accountProvider: null,
    history: [],
    organizationEstablished: false,
    phase: OnboardingPhase.Welcome,
    resuming: false,
  };
}

function walk(
  from: OnboardingMachineState,
  events: readonly Parameters<typeof transitionOnboarding>[1][],
  context: OnboardingContext
): OnboardingMachineState {
  let state = from;
  for (const event of events) {
    const result = transitionOnboarding(state, event, context);
    if (result.status !== "moved") {
      throw new Error(
        `walk stalled at ${state.phase} on ${event.type}: ${result.reason}`
      );
    }
    state = result.state;
  }
  if (state.phase !== OnboardingPhase.ConnectGitHub) {
    throw new Error(`walk ended at ${state.phase}, expected connect_github`);
  }
  return state;
}

/** A Desktop run whose provider leaves the GitHub step owed. */
function desktopGitHubContext(): OnboardingContext {
  return buildOnboardingContext({
    accountProvider: AccountProvider.Google,
    accountStatus: AccountStatus.Established,
    analysisStarted: true,
    githubConnected: false,
    host: OnboardingHost.Desktop,
    membership: OrganizationMembership.ExistingMember,
    organizationActive: KnownFlag.Yes,
    tourCompleted: true,
  });
}

function move(
  state: OnboardingMachineState,
  event: Parameters<typeof transitionOnboarding>[1],
  context: OnboardingContext
): OnboardingMachineState {
  const result = transitionOnboarding(state, event, context);
  if (result.status !== "moved") {
    throw new Error(`expected a move from ${state.phase}: ${result.reason}`);
  }
  return result.state;
}
