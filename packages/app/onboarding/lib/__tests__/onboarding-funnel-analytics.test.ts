import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAccountMode,
  OnboardingAccountOutcome,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
  OnboardingSyncPolicyChoice,
  OrgMembershipOutcome,
  onboardingAccountModesForOutcome,
  syncPolicyChoiceForDataSyncLevel,
} from "@repo/api/src/types/onboarding-analytics";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingFlowSession } from "../onboarding-flow-session";
import { deriveOnboardingTransitionEmissions } from "../onboarding-funnel-analytics";

const FLOW_STARTED_AT_MS = 1_700_000_000_000;
const FLOW_COMPLETED_AT_MS = FLOW_STARTED_AT_MS + 90_000;

function webContext(
  overrides: Partial<OnboardingContext> = {}
): OnboardingContext {
  return {
    accountProvider: null,
    accountStatus: AccountStatus.Established,
    analysisStarted: false,
    desktopAppDownloaded: false,
    githubConnected: false,
    host: OnboardingHost.Web,
    membership: OrganizationMembership.FirstUser,
    organizationActive: KnownFlag.No,
    organizationHasSyncedSessionData: KnownFlag.Yes,
    syncConsentRecorded: KnownFlag.Unknown,
    teamInvited: false,
    tourCompleted: false,
    ...overrides,
  };
}

function stateAt(
  phase: OnboardingPhase,
  history: OnboardingPhase[] = [],
  overrides: Partial<OnboardingMachineState> = {}
): OnboardingMachineState {
  return {
    accountProvider: null,
    history,
    organizationEstablished: false,
    phase,
    resuming: false,
    ...overrides,
  };
}

function session(
  overrides: Partial<OnboardingFlowSession> = {}
): OnboardingFlowSession {
  return {
    flowId: "flow-1",
    skippedSteps: [],
    startedAtMs: FLOW_STARTED_AT_MS,
    ...overrides,
  };
}

describe("deriveOnboardingTransitionEmissions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FLOW_COMPLETED_AT_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits completed-then-viewed with the flow context for an ordinary advance", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext(),
      event: {
        provider: AccountProvider.GitHub,
        type: OnboardingEvent.AccountEstablished,
      },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.CreateOrganization, [
        OnboardingPhase.Welcome,
        OnboardingPhase.Account,
      ]),
      priorState: stateAt(OnboardingPhase.Account, [OnboardingPhase.Welcome]),
      session: session(),
    });

    expect(emissions).toEqual([
      {
        event: OnboardingAnalyticsEvent.StepCompleted,
        properties: {
          [OnboardingAnalyticsProperty.FlowId]: "flow-1",
          [OnboardingAnalyticsProperty.FirstOrgUser]: "unknown",
          [OnboardingAnalyticsProperty.StepIndex]: 1,
          [OnboardingAnalyticsProperty.Step]: OnboardingPhase.Account,
          [OnboardingAnalyticsProperty.AccountProvider]: AccountProvider.GitHub,
        },
      },
      {
        event: OnboardingAnalyticsEvent.StepViewed,
        properties: {
          [OnboardingAnalyticsProperty.FlowId]: "flow-1",
          [OnboardingAnalyticsProperty.FirstOrgUser]: "unknown",
          [OnboardingAnalyticsProperty.StepIndex]: 2,
          [OnboardingAnalyticsProperty.Step]:
            OnboardingPhase.CreateOrganization,
        },
      },
    ]);
  });

  it("emits step_skipped with skip_available derived from the download guard's own predicate", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext({
        membership: OrganizationMembership.ExistingMember,
      }),
      event: { type: OnboardingEvent.SkipDownload },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.DashboardAvailable),
      priorState: stateAt(OnboardingPhase.DownloadDesktop),
      session: session(),
    });

    expect(emissions[0]?.event).toBe(OnboardingAnalyticsEvent.StepSkipped);
    expect(emissions[0]?.properties).toMatchObject({
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.DownloadDesktop,
      [OnboardingAnalyticsProperty.SkipAvailable]: true,
    });
    expect(emissions[1]?.event).toBe(OnboardingAnalyticsEvent.StepViewed);
  });

  it("emits step_back with from_step and no completion", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext(),
      event: { type: OnboardingEvent.Back },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.Welcome),
      priorState: stateAt(OnboardingPhase.Account, [OnboardingPhase.Welcome]),
      session: session(),
    });

    expect(emissions.map((emission) => emission.event)).toEqual([
      OnboardingAnalyticsEvent.StepBack,
      OnboardingAnalyticsEvent.StepViewed,
    ]);
    expect(emissions[0]?.properties).toMatchObject({
      [OnboardingAnalyticsProperty.FromStep]: OnboardingPhase.Account,
    });
  });

  it("emits flow_completed with duration and skipped steps when the run reaches Ready", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext(),
      event: { type: OnboardingEvent.FinishTour },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.Ready),
      priorState: stateAt(OnboardingPhase.DashboardTour),
      session: session({
        firstOrgUser: "true",
        skippedSteps: [OnboardingPhase.InviteTeam],
      }),
    });

    const completion = emissions.at(-1);
    expect(completion?.event).toBe(OnboardingAnalyticsEvent.FlowCompleted);
    expect(completion?.properties).toMatchObject({
      [OnboardingAnalyticsProperty.FirstOrgUser]: "true",
      [OnboardingAnalyticsProperty.DurationSeconds]: 90,
      [OnboardingAnalyticsProperty.StepsSkipped]: [OnboardingPhase.InviteTeam],
    });
  });

  it("omits duration_seconds when the flow start was never observed, rather than inventing one", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext(),
      event: { type: OnboardingEvent.FinishTour },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.Ready),
      priorState: stateAt(OnboardingPhase.DashboardTour),
      session: session({ startedAtMs: null }),
    });

    const completion = emissions.at(-1);
    expect(completion?.event).toBe(OnboardingAnalyticsEvent.FlowCompleted);
    expect(completion?.properties).not.toHaveProperty(
      OnboardingAnalyticsProperty.DurationSeconds
    );
  });

  it("carries the measured session_discovery outcome on the desktop completion (ISS-10502)", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext({ host: OnboardingHost.Desktop }),
      event: { type: OnboardingEvent.ContinueFromDiscovery },
      host: OnboardingHost.Desktop,
      nextState: stateAt(OnboardingPhase.Account, [
        OnboardingPhase.Welcome,
        OnboardingPhase.SessionDiscovery,
      ]),
      outcome: {
        harnessesDetected: ["claude", "codex"],
        harnessesDetectedCount: 2,
        sessionsFoundCount: 41,
      },
      priorState: stateAt(OnboardingPhase.SessionDiscovery, [
        OnboardingPhase.Welcome,
      ]),
      session: session(),
    });

    expect(emissions[0]?.event).toBe(OnboardingAnalyticsEvent.StepCompleted);
    expect(emissions[0]?.properties).toMatchObject({
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.SessionDiscovery,
      [OnboardingAnalyticsProperty.StepIndex]: 1,
      [OnboardingAnalyticsProperty.SessionsFoundCount]: 41,
      [OnboardingAnalyticsProperty.HarnessesDetectedCount]: 2,
      [OnboardingAnalyticsProperty.HarnessesDetected]: ["claude", "codex"],
    });
  });

  it("omits the discovery counts entirely when the host measured nothing", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext({ host: OnboardingHost.Desktop }),
      event: { type: OnboardingEvent.ContinueFromDiscovery },
      host: OnboardingHost.Desktop,
      nextState: stateAt(OnboardingPhase.Account, [
        OnboardingPhase.Welcome,
        OnboardingPhase.SessionDiscovery,
      ]),
      priorState: stateAt(OnboardingPhase.SessionDiscovery, [
        OnboardingPhase.Welcome,
      ]),
      session: session(),
    });

    const completed = emissions[0]?.properties ?? {};
    expect(emissions[0]?.event).toBe(OnboardingAnalyticsEvent.StepCompleted);
    expect(OnboardingAnalyticsProperty.SessionsFoundCount in completed).toBe(
      false
    );
    expect(
      OnboardingAnalyticsProperty.HarnessesDetectedCount in completed
    ).toBe(false);
    expect(OnboardingAnalyticsProperty.HarnessesDetected in completed).toBe(
      false
    );
  });

  it("carries sync_policy_choice on the desktop sync completion (ISS-10502)", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext({ host: OnboardingHost.Desktop }),
      event: { type: OnboardingEvent.ContinueFromSyncPolicy },
      host: OnboardingHost.Desktop,
      nextState: stateAt(OnboardingPhase.InviteTeam),
      outcome: {
        syncPolicyChoice: OnboardingSyncPolicyChoice.MetadataOnly,
      },
      priorState: stateAt(OnboardingPhase.SyncPolicy),
      session: session(),
    });

    expect(emissions[0]?.event).toBe(OnboardingAnalyticsEvent.StepCompleted);
    expect(emissions[0]?.properties).toMatchObject({
      [OnboardingAnalyticsProperty.Step]: OnboardingPhase.SyncPolicy,
      // ISS-10890: the sync policy follows the organization step (3).
      [OnboardingAnalyticsProperty.StepIndex]: 4,
      [OnboardingAnalyticsProperty.SyncPolicyChoice]:
        OnboardingSyncPolicyChoice.MetadataOnly,
    });
  });

  it("maps every consent-store level to a wire sync_policy_choice 1:1", () => {
    expect(syncPolicyChoiceForDataSyncLevel(DataSyncLevel.Full)).toBe(
      OnboardingSyncPolicyChoice.FullTranscripts
    );
    expect(syncPolicyChoiceForDataSyncLevel(DataSyncLevel.Redacted)).toBe(
      OnboardingSyncPolicyChoice.RedactedTranscripts
    );
    expect(syncPolicyChoiceForDataSyncLevel(DataSyncLevel.Metadata)).toBe(
      OnboardingSyncPolicyChoice.MetadataOnly
    );
    expect(syncPolicyChoiceForDataSyncLevel(DataSyncLevel.Off)).toBe(
      OnboardingSyncPolicyChoice.Off
    );
  });

  it("emits org_membership for the org steps", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext({
        membership: OrganizationMembership.ExistingMember,
      }),
      event: { type: OnboardingEvent.OrganizationReady },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.InviteTeam),
      priorState: stateAt(OnboardingPhase.ChooseOrganization),
      session: session({ firstOrgUser: "false" }),
    });

    expect(emissions[0]?.properties).toMatchObject({
      [OnboardingAnalyticsProperty.OrgMembership]: OrgMembershipOutcome.Joined,
      [OnboardingAnalyticsProperty.FirstOrgUser]: "false",
    });
  });

  it("records a first user choosing the organization their signup made as created (ISS-11090)", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext({
        membership: OrganizationMembership.FirstUser,
        organizationActive: KnownFlag.Yes,
      }),
      event: { type: OnboardingEvent.OrganizationReady },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.InviteTeam),
      priorState: stateAt(OnboardingPhase.ChooseOrganization),
      session: session({ firstOrgUser: "true" }),
    });

    expect(emissions[0]?.properties).toMatchObject({
      [OnboardingAnalyticsProperty.OrgMembership]: OrgMembershipOutcome.Created,
    });
  });

  it("emits only step_viewed for a resumed step, and nothing for a marker transition", () => {
    const resumed = deriveOnboardingTransitionEmissions({
      context: webContext(),
      event: {
        step: PendingOnboardingStep.InviteTeam,
        type: OnboardingEvent.ResumePendingStep,
      },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.InviteTeam),
      priorState: stateAt(OnboardingPhase.Ready),
      session: session(),
    });
    expect(resumed.map((emission) => emission.event)).toEqual([
      OnboardingAnalyticsEvent.StepViewed,
    ]);

    const marker = deriveOnboardingTransitionEmissions({
      context: webContext(),
      event: { type: OnboardingEvent.FinishTour },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.Ready),
      priorState: stateAt(OnboardingPhase.Ready),
      session: session(),
    });
    expect(marker).toEqual([]);
  });

  // The original arrival at Ready already emitted flow_completed and ended the
  // session, so a resumed step (ResumePendingStep from the completion card)
  // returning to Ready completes the STEP, never the flow again — a second
  // completion would carry a freshly minted flow_id with no matching start.
  it("does not emit a second flow_completed when a resumed step returns to Ready", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext(),
      event: { type: OnboardingEvent.SendInvitations },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.Ready),
      priorState: stateAt(OnboardingPhase.InviteTeam, [], {
        organizationEstablished: true,
        resuming: true,
      }),
      session: session({ startedAtMs: null }),
    });

    expect(emissions.map((emission) => emission.event)).toEqual([
      OnboardingAnalyticsEvent.StepCompleted,
      OnboardingAnalyticsEvent.StepViewed,
    ]);
    expect(
      emissions.some(
        (emission) => emission.event === OnboardingAnalyticsEvent.FlowCompleted
      )
    ).toBe(false);
  });

  it("never claims a step_completed for a deferred tour nobody saw", () => {
    const emissions = deriveOnboardingTransitionEmissions({
      context: webContext(),
      event: { type: OnboardingEvent.DeferTour },
      host: OnboardingHost.Web,
      nextState: stateAt(OnboardingPhase.Ready),
      priorState: stateAt(OnboardingPhase.DashboardTour),
      session: session(),
    });

    expect(emissions.map((emission) => emission.event)).toEqual([
      OnboardingAnalyticsEvent.StepViewed,
      OnboardingAnalyticsEvent.FlowCompleted,
    ]);
  });
});

/**
 * PRD-736 `account_mode` on the account completion (ISS-10913). The desktop
 * host supplies an already-folded, non-empty set; web supplies none.
 */
describe("account_mode on onboarding_step_completed[account]", () => {
  function accountCompletion(
    outcome?: Parameters<
      typeof deriveOnboardingTransitionEmissions
    >[0]["outcome"]
  ) {
    return deriveOnboardingTransitionEmissions({
      context: webContext({ host: OnboardingHost.Desktop }),
      event: {
        provider: AccountProvider.GitHub,
        type: OnboardingEvent.AccountEstablished,
      },
      host: OnboardingHost.Desktop,
      nextState: stateAt(OnboardingPhase.CreateOrganization, [
        OnboardingPhase.Account,
      ]),
      outcome,
      priorState: stateAt(OnboardingPhase.Account),
      session: session(),
    }).find(
      (emission) => emission.event === OnboardingAnalyticsEvent.StepCompleted
    );
  }

  it("emits created + signed_in beside account_provider for a new account that authenticated", () => {
    const completed = accountCompletion({
      accountMode: onboardingAccountModesForOutcome(
        OnboardingAccountOutcome.CreatedSignedIn
      ),
    });

    expect(completed?.properties).toMatchObject({
      [OnboardingAnalyticsProperty.AccountProvider]: AccountProvider.GitHub,
      [OnboardingAnalyticsProperty.AccountMode]: [
        OnboardingAccountMode.Created,
        OnboardingAccountMode.SignedIn,
      ],
    });
  });

  // NAMED FOR WHAT IT PINS, not for an AC it cannot reach (tamsinb on #7793).
  // The fixture hands an AccountEstablished completion a logged_out fold, which
  // NO production path posts — the only emit site fires on `accountStatus ===
  // Established`, i.e. an authenticated main process. This pins the emitter's
  // passthrough of whatever set the host supplies, nothing about the
  // created+logged_out AC; the outcome itself is covered where it is actually
  // produced, in `desktop-auth-account-outcome.test.ts`.
  it("passes a created + logged_out fold through to the property verbatim", () => {
    const completed = accountCompletion({
      accountMode: onboardingAccountModesForOutcome(
        OnboardingAccountOutcome.CreatedLoggedOut
      ),
    });

    expect(
      completed?.properties[OnboardingAnalyticsProperty.AccountMode]
    ).toEqual([OnboardingAccountMode.Created, OnboardingAccountMode.LoggedOut]);
  });

  it("emits signed_in alone when an existing account authenticated", () => {
    const completed = accountCompletion({
      accountMode: onboardingAccountModesForOutcome(
        OnboardingAccountOutcome.SignedIn
      ),
    });

    expect(
      completed?.properties[OnboardingAnalyticsProperty.AccountMode]
    ).toEqual([OnboardingAccountMode.SignedIn]);
  });

  // Passthrough only, for the same reason as the created + logged_out case
  // above — a bare logged_out cannot reach a completed Account step either.
  it("passes a logged_out-alone fold through to the property verbatim", () => {
    const completed = accountCompletion({
      accountMode: onboardingAccountModesForOutcome(
        OnboardingAccountOutcome.LoggedOut
      ),
    });

    expect(
      completed?.properties[OnboardingAnalyticsProperty.AccountMode]
    ).toEqual([OnboardingAccountMode.LoggedOut]);
  });

  it("emits unknown — never an omission — for an auth return a skewed gateway cannot describe", () => {
    const completed = accountCompletion({
      accountMode: onboardingAccountModesForOutcome(undefined),
    });

    expect(
      completed?.properties[OnboardingAnalyticsProperty.AccountMode]
    ).toEqual([OnboardingAccountMode.Unknown]);
  });

  it("omits the property only for a host that supplied no auth outcome at all", () => {
    // Web: the guided dialog observes no external auth return, so there is
    // nothing to report — not even an unknown it did not measure.
    const completed = accountCompletion(undefined);

    expect(completed?.properties).not.toHaveProperty(
      OnboardingAnalyticsProperty.AccountMode
    );
    expect(
      completed?.properties[OnboardingAnalyticsProperty.AccountProvider]
    ).toBe(AccountProvider.GitHub);
  });
});

describe("download action outcomes (ISS-12230)", () => {
  it.each([
    [{ downloadClicked: false }, false],
    [undefined, true],
  ] as const)(
    "reports %s as download_clicked=%s",
    (outcome, downloadClicked) => {
      const emissions = deriveOnboardingTransitionEmissions({
        context: webContext(),
        event: { type: OnboardingEvent.DownloadDesktopApp },
        outcome,
        host: OnboardingHost.Web,
        nextState: stateAt(OnboardingPhase.ConnectGitHub),
        priorState: stateAt(OnboardingPhase.DownloadDesktop),
        session: session(),
      });
      expect(emissions[0]).toEqual({
        event: OnboardingAnalyticsEvent.StepCompleted,
        properties: expect.objectContaining({
          [OnboardingAnalyticsProperty.Step]: OnboardingPhase.DownloadDesktop,
          [OnboardingAnalyticsProperty.DownloadClicked]: downloadClicked,
        }),
      });
    }
  );
});
