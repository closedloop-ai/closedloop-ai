/**
 * Edge coverage, guards, and Back history for the onboarding machine.
 *
 * The `DIAGRAM_EDGES` table below is the acceptance evidence for "every diagram
 * edge is represented by a typed event and guard": each row names one edge of
 * the PRD-689 finite-state diagram and asserts the machine takes it.
 */

import {
  OnboardingEvent,
  type OnboardingEventInput,
  OnboardingRejection,
} from "@repo/api/src/types/onboarding-events";
import {
  AccountProvider,
  AccountStatus,
  isBlockingPhase,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { transitionOnboarding } from "../onboarding-transitions";
import { context, move, stateAt } from "./onboarding-transitions-test-helpers";

type DiagramEdge = {
  edge: string;
  from: OnboardingPhase;
  event: OnboardingEventInput;
  ctx: OnboardingContext;
  to: OnboardingPhase;
  state?: Partial<OnboardingMachineState>;
};

const DIAGRAM_EDGES: readonly DiagramEdge[] = [
  {
    edge: "Welcome --> Parsing: Desktop",
    from: OnboardingPhase.Welcome,
    event: { type: OnboardingEvent.Start },
    ctx: context({ host: OnboardingHost.Desktop }),
    to: OnboardingPhase.SessionDiscovery,
  },
  {
    edge: "Welcome --> Account: Web",
    from: OnboardingPhase.Welcome,
    event: { type: OnboardingEvent.Start },
    ctx: context({ host: OnboardingHost.Web }),
    to: OnboardingPhase.Account,
  },
  {
    edge: "Parsing --> Account: Continue",
    from: OnboardingPhase.SessionDiscovery,
    event: { type: OnboardingEvent.ContinueFromDiscovery },
    ctx: context(),
    to: OnboardingPhase.Account,
  },
  {
    edge: "Account --> Complete: Desktop / Skip for now",
    from: OnboardingPhase.Account,
    event: { type: OnboardingEvent.SkipAccount },
    ctx: context({ host: OnboardingHost.Desktop }),
    to: OnboardingPhase.DashboardAvailable,
  },
  {
    edge: "Account --> CreateOrganization: first user",
    from: OnboardingPhase.Account,
    event: {
      type: OnboardingEvent.AccountEstablished,
      provider: AccountProvider.GitHub,
    },
    ctx: context({
      membership: OrganizationMembership.FirstUser,
      organizationActive: KnownFlag.No,
    }),
    to: OnboardingPhase.CreateOrganization,
  },
  {
    edge: "Account --> ChooseOrganization: first user already in an organization",
    from: OnboardingPhase.Account,
    event: {
      type: OnboardingEvent.AccountEstablished,
      provider: AccountProvider.GitHub,
    },
    ctx: context({
      membership: OrganizationMembership.FirstUser,
      organizationActive: KnownFlag.Yes,
    }),
    to: OnboardingPhase.ChooseOrganization,
  },
  {
    edge: "Account --> ChooseOrganization: existing member",
    from: OnboardingPhase.Account,
    event: {
      type: OnboardingEvent.AccountEstablished,
      provider: AccountProvider.GitHub,
    },
    ctx: context({ membership: OrganizationMembership.ExistingMember }),
    to: OnboardingPhase.ChooseOrganization,
  },
  {
    edge: "CreateOrganization --> SyncPolicy: Desktop",
    from: OnboardingPhase.CreateOrganization,
    event: { type: OnboardingEvent.OrganizationReady },
    ctx: context({ host: OnboardingHost.Desktop }),
    to: OnboardingPhase.SyncPolicy,
  },
  {
    edge: "ChooseOrganization --> SyncPolicy: Desktop",
    from: OnboardingPhase.ChooseOrganization,
    event: { type: OnboardingEvent.OrganizationReady },
    ctx: context({ host: OnboardingHost.Desktop }),
    to: OnboardingPhase.SyncPolicy,
  },
  {
    edge: "CreateOrganization --> InviteTeam: Web",
    from: OnboardingPhase.CreateOrganization,
    event: { type: OnboardingEvent.OrganizationReady },
    ctx: context({ host: OnboardingHost.Web }),
    to: OnboardingPhase.InviteTeam,
  },
  {
    edge: "ChooseOrganization --> InviteTeam: Web",
    from: OnboardingPhase.ChooseOrganization,
    event: { type: OnboardingEvent.OrganizationReady },
    ctx: context({ host: OnboardingHost.Web }),
    to: OnboardingPhase.InviteTeam,
  },
  {
    edge: "SyncPolicy --> InviteTeam: Continue",
    from: OnboardingPhase.SyncPolicy,
    event: { type: OnboardingEvent.ContinueFromSyncPolicy },
    ctx: context({ host: OnboardingHost.Desktop }),
    to: OnboardingPhase.InviteTeam,
    state: { organizationEstablished: true },
  },
  {
    edge: "InviteTeam --> DownloadDesktop: Web",
    from: OnboardingPhase.InviteTeam,
    event: { type: OnboardingEvent.SendInvitations },
    ctx: context({ host: OnboardingHost.Web }),
    to: OnboardingPhase.DownloadDesktop,
  },
  {
    edge: "InviteTeam --> ConnectGitHub: Desktop + Google + GitHub missing",
    from: OnboardingPhase.InviteTeam,
    event: { type: OnboardingEvent.SkipInvitations },
    ctx: context({
      host: OnboardingHost.Desktop,
      accountProvider: AccountProvider.Google,
      githubConnected: false,
    }),
    to: OnboardingPhase.ConnectGitHub,
  },
  {
    edge: "InviteTeam --> ConnectGitHub: Desktop + email + GitHub missing",
    from: OnboardingPhase.InviteTeam,
    event: { type: OnboardingEvent.SkipInvitations },
    ctx: context({
      host: OnboardingHost.Desktop,
      accountProvider: AccountProvider.Email,
      githubConnected: false,
    }),
    to: OnboardingPhase.ConnectGitHub,
  },
  {
    edge: "InviteTeam --> ConnectGitHub: Desktop + unknown provider + GitHub missing",
    from: OnboardingPhase.InviteTeam,
    event: { type: OnboardingEvent.SkipInvitations },
    ctx: context({
      host: OnboardingHost.Desktop,
      accountProvider: null,
      githubConnected: false,
    }),
    to: OnboardingPhase.ConnectGitHub,
  },
  {
    edge: "InviteTeam --> Complete: Desktop + GitHub already connected",
    from: OnboardingPhase.InviteTeam,
    event: { type: OnboardingEvent.SendInvitations },
    ctx: context({
      host: OnboardingHost.Desktop,
      accountProvider: AccountProvider.GitHub,
      githubConnected: true,
    }),
    to: OnboardingPhase.DashboardAvailable,
  },
  {
    edge: "InviteTeam --> Complete: resumed checklist step",
    from: OnboardingPhase.InviteTeam,
    event: { type: OnboardingEvent.SendInvitations },
    ctx: context({ host: OnboardingHost.Web }),
    state: { resuming: true },
    to: OnboardingPhase.DashboardAvailable,
  },
  {
    edge: "DownloadDesktop --> ConnectGitHub: Web + Google + GitHub missing",
    from: OnboardingPhase.DownloadDesktop,
    event: { type: OnboardingEvent.DownloadDesktopApp },
    ctx: context({
      host: OnboardingHost.Web,
      accountProvider: AccountProvider.Google,
      githubConnected: false,
    }),
    to: OnboardingPhase.ConnectGitHub,
  },
  {
    edge: "DownloadDesktop --> ConnectGitHub: Web + email + GitHub missing",
    from: OnboardingPhase.DownloadDesktop,
    event: { type: OnboardingEvent.SkipDownload },
    ctx: context({
      host: OnboardingHost.Web,
      accountProvider: AccountProvider.Email,
      githubConnected: false,
      membership: OrganizationMembership.ExistingMember,
    }),
    to: OnboardingPhase.ConnectGitHub,
  },
  {
    edge: "DownloadDesktop --> ConnectGitHub: Web + unknown provider + GitHub missing",
    from: OnboardingPhase.DownloadDesktop,
    event: { type: OnboardingEvent.DownloadDesktopApp },
    ctx: context({
      host: OnboardingHost.Web,
      accountProvider: null,
      githubConnected: false,
    }),
    to: OnboardingPhase.ConnectGitHub,
  },
  {
    edge: "DownloadDesktop --> Complete: Downloaded, GitHub already connected",
    from: OnboardingPhase.DownloadDesktop,
    event: { type: OnboardingEvent.DownloadDesktopApp },
    ctx: context({
      host: OnboardingHost.Web,
      accountProvider: AccountProvider.GitHub,
      githubConnected: true,
    }),
    to: OnboardingPhase.DashboardAvailable,
  },
  {
    edge: "DownloadDesktop --> Complete: eligible Web user skips, GitHub already connected",
    from: OnboardingPhase.DownloadDesktop,
    event: { type: OnboardingEvent.SkipDownload },
    ctx: context({
      host: OnboardingHost.Web,
      accountProvider: AccountProvider.GitHub,
      githubConnected: true,
      membership: OrganizationMembership.ExistingMember,
    }),
    to: OnboardingPhase.DashboardAvailable,
  },
  {
    edge: "DownloadDesktop --> Complete: resumed checklist step",
    from: OnboardingPhase.DownloadDesktop,
    event: { type: OnboardingEvent.DownloadDesktopApp },
    ctx: context({
      host: OnboardingHost.Web,
      accountProvider: AccountProvider.Google,
      githubConnected: false,
    }),
    state: { resuming: true },
    to: OnboardingPhase.DashboardAvailable,
  },
  {
    edge: "ConnectGitHub --> Complete: Connect",
    from: OnboardingPhase.ConnectGitHub,
    event: { type: OnboardingEvent.ConnectGitHub },
    ctx: context(),
    to: OnboardingPhase.DashboardAvailable,
  },
  {
    edge: "ConnectGitHub --> Complete: skip",
    from: OnboardingPhase.ConnectGitHub,
    event: { type: OnboardingEvent.SkipGitHub },
    ctx: context(),
    to: OnboardingPhase.DashboardAvailable,
  },
  {
    edge: "Complete --> DashboardTour: first completion",
    from: OnboardingPhase.DashboardAvailable,
    event: { type: OnboardingEvent.DashboardEntered },
    ctx: context({ tourCompleted: false }),
    to: OnboardingPhase.DashboardTour,
  },
  {
    edge: "Complete --> PendingStep: tour already completed",
    from: OnboardingPhase.DashboardAvailable,
    event: { type: OnboardingEvent.DashboardEntered },
    ctx: context({ tourCompleted: true }),
    to: OnboardingPhase.Ready,
  },
  {
    edge: "DashboardTour --> PendingStep: Done or Skip tour",
    from: OnboardingPhase.DashboardTour,
    event: { type: OnboardingEvent.FinishTour },
    ctx: context(),
    to: OnboardingPhase.Ready,
  },
  {
    edge: "DashboardTour --> PendingStep: nothing to show (PLN-1875 Step 9)",
    from: OnboardingPhase.DashboardTour,
    event: { type: OnboardingEvent.DeferTour },
    ctx: context(),
    to: OnboardingPhase.Ready,
  },
  {
    edge: "PendingStep --> Account: 1. Desktop account was skipped",
    from: OnboardingPhase.Ready,
    event: {
      type: OnboardingEvent.ResumePendingStep,
      step: PendingOnboardingStep.CreateAccount,
    },
    ctx: context({
      host: OnboardingHost.Desktop,
      accountStatus: AccountStatus.Skipped,
    }),
    to: OnboardingPhase.Account,
  },
  {
    edge: "PendingStep --> DownloadDesktop: 2. Web Desktop app is missing",
    from: OnboardingPhase.Ready,
    event: {
      type: OnboardingEvent.ResumePendingStep,
      step: PendingOnboardingStep.DownloadDesktop,
    },
    ctx: context({
      host: OnboardingHost.Web,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: false,
    }),
    to: OnboardingPhase.DownloadDesktop,
  },
  {
    edge: "PendingStep --> ConnectGitHub: 3. email account lacks GitHub",
    from: OnboardingPhase.Ready,
    event: {
      type: OnboardingEvent.ResumePendingStep,
      step: PendingOnboardingStep.ConnectGitHub,
    },
    ctx: context({
      host: OnboardingHost.Desktop,
      accountStatus: AccountStatus.Established,
      accountProvider: AccountProvider.Email,
      githubConnected: false,
    }),
    to: OnboardingPhase.ConnectGitHub,
  },
  {
    edge: "PendingStep --> InviteTeam: 4. Team invitation was skipped",
    from: OnboardingPhase.Ready,
    event: {
      type: OnboardingEvent.ResumePendingStep,
      step: PendingOnboardingStep.InviteTeam,
    },
    ctx: context({
      host: OnboardingHost.Desktop,
      accountStatus: AccountStatus.Established,
      githubConnected: true,
      teamInvited: false,
    }),
    to: OnboardingPhase.InviteTeam,
  },
];

describe("diagram edge coverage", () => {
  it.each(DIAGRAM_EDGES)("takes $edge", ({ from, event, ctx, to, state }) => {
    expect(move(stateAt(from, state), event, ctx).phase).toBe(to);
  });
});

describe("guards", () => {
  it("blocks Desktop discovery Continue until analysis has begun", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.SessionDiscovery),
      { type: OnboardingEvent.ContinueFromDiscovery },
      context({ analysisStarted: false })
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.GuardBlocked,
    });
  });

  it("refuses to skip the required Web account", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.Account),
      { type: OnboardingEvent.SkipAccount },
      context({ host: OnboardingHost.Web })
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.GuardBlocked,
    });
  });

  it("blocks the download skip for the organization's first user", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.DownloadDesktop),
      { type: OnboardingEvent.SkipDownload },
      context({
        host: OnboardingHost.Web,
        membership: OrganizationMembership.FirstUser,
      })
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.GuardBlocked,
    });
  });

  it("rejects an event that has no edge out of the current phase", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.Welcome),
      { type: OnboardingEvent.ConnectGitHub },
      context()
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.NotAllowedFromPhase,
    });
  });

  it("rejects resuming a step the completion card is not offering", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.Ready),
      {
        type: OnboardingEvent.ResumePendingStep,
        step: PendingOnboardingStep.InviteTeam,
      },
      // The account is skipped, so create-account outranks invite-team.
      context({
        host: OnboardingHost.Desktop,
        accountStatus: AccountStatus.Skipped,
      })
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.StepNotPending,
    });
  });

  it("leaves the caller's state untouched when an event is rejected", () => {
    const before = stateAt(OnboardingPhase.Account, {
      history: [OnboardingPhase.Welcome],
    });
    const snapshot = structuredClone(before);

    transitionOnboarding(
      before,
      { type: OnboardingEvent.SkipAccount },
      context({ host: OnboardingHost.Web })
    );

    expect(before).toEqual(snapshot);
  });
});

/**
 * ISS-8349 review (T4). Back was handled before the phase was consulted, so a
 * completed run could walk Ready -> DashboardTour -> DashboardAvailable and on
 * into the blocking setup screens it had already finished. Back is documented
 * as a blocking-flow control, so the non-blocking phases must refuse it.
 */
describe("Back is refused outside the blocking flow", () => {
  const NON_BLOCKING_PHASES: readonly OnboardingPhase[] = [
    OnboardingPhase.DashboardAvailable,
    OnboardingPhase.DashboardTour,
    OnboardingPhase.Ready,
  ];

  for (const phase of NON_BLOCKING_PHASES) {
    it(`rejects Back from ${phase} even with history behind it`, () => {
      const result = transitionOnboarding(
        stateAt(phase, {
          history: [
            OnboardingPhase.Welcome,
            OnboardingPhase.Account,
            OnboardingPhase.ConnectGitHub,
          ],
        }),
        { type: OnboardingEvent.Back },
        context()
      );

      expect(result).toEqual({
        status: "rejected",
        reason: OnboardingRejection.NotAllowedFromPhase,
      });
    });
  }

  it("cannot walk a finished Web run back into the blocking flow", () => {
    const ctx = context({
      host: OnboardingHost.Web,
      accountStatus: AccountStatus.Established,
      accountProvider: AccountProvider.Google,
      membership: OrganizationMembership.ExistingMember,
    });
    // Walk a real run to Ready, so the history genuinely holds the setup phases.
    let state = move(
      stateAt(OnboardingPhase.Welcome),
      { type: OnboardingEvent.Start },
      ctx
    );
    state = move(state, { type: OnboardingEvent.OrganizationReady }, ctx);
    state = move(state, { type: OnboardingEvent.SkipInvitations }, ctx);
    state = move(state, { type: OnboardingEvent.SkipDownload }, ctx);
    // ISS-11254: this Google run owes the GitHub step, so the download gate
    // exits into it rather than to the Dashboard. The walk has to take the real
    // step, or it never reaches the finished run whose Back this pins.
    expect(state.phase).toBe(OnboardingPhase.ConnectGitHub);
    state = move(state, { type: OnboardingEvent.ConnectGitHub }, ctx);
    state = move(state, { type: OnboardingEvent.DashboardEntered }, ctx);
    state = move(state, { type: OnboardingEvent.FinishTour }, ctx);
    expect(state.phase).toBe(OnboardingPhase.Ready);
    expect(state.history).toContain(OnboardingPhase.DownloadDesktop);
    expect(state.history).toContain(OnboardingPhase.ConnectGitHub);

    // Three Backs is the reviewer's walk: Ready, tour, Dashboard, then setup.
    for (let step = 0; step < 3; step += 1) {
      const result = transitionOnboarding(
        state,
        { type: OnboardingEvent.Back },
        ctx
      );
      expect(result).toEqual({
        status: "rejected",
        reason: OnboardingRejection.NotAllowedFromPhase,
      });
    }
    expect(isBlockingPhase(state.phase)).toBe(false);
  });

  it("still returns a resumed step to the Dashboard", () => {
    const ctx = context({
      host: OnboardingHost.Desktop,
      teamInvited: false,
      githubConnected: true,
      accountStatus: AccountStatus.Established,
    });
    const resumed = move(
      stateAt(OnboardingPhase.Ready, { organizationEstablished: true }),
      {
        type: OnboardingEvent.ResumePendingStep,
        step: PendingOnboardingStep.InviteTeam,
      },
      ctx
    );
    const backedOut = move(resumed, { type: OnboardingEvent.Back }, ctx);

    expect(backedOut.phase).toBe(OnboardingPhase.DashboardAvailable);
    expect(backedOut.resuming).toBe(false);
  });
});

describe("Back history", () => {
  it("walks the Desktop order forward, then back through it in reverse", () => {
    const ctx = context({
      host: OnboardingHost.Desktop,
      membership: OrganizationMembership.ExistingMember,
    });
    let state = stateAt(OnboardingPhase.Welcome);
    state = move(state, { type: OnboardingEvent.Start }, ctx);
    expect(state.phase).toBe(OnboardingPhase.SessionDiscovery);
    state = move(state, { type: OnboardingEvent.ContinueFromDiscovery }, ctx);
    expect(state.phase).toBe(OnboardingPhase.Account);
    state = move(
      state,
      {
        type: OnboardingEvent.AccountEstablished,
        provider: AccountProvider.GitHub,
      },
      ctx
    );
    expect(state.phase).toBe(OnboardingPhase.ChooseOrganization);
    state = move(state, { type: OnboardingEvent.OrganizationReady }, ctx);
    expect(state.phase).toBe(OnboardingPhase.SyncPolicy);
    state = move(state, { type: OnboardingEvent.ContinueFromSyncPolicy }, ctx);

    expect(state.phase).toBe(OnboardingPhase.InviteTeam);
    expect(state.history).toEqual([
      OnboardingPhase.Welcome,
      OnboardingPhase.SessionDiscovery,
      OnboardingPhase.Account,
      OnboardingPhase.ChooseOrganization,
      OnboardingPhase.SyncPolicy,
    ]);

    state = move(state, { type: OnboardingEvent.Back }, ctx);
    expect(state.phase).toBe(OnboardingPhase.SyncPolicy);
    state = move(state, { type: OnboardingEvent.Back }, ctx);
    expect(state.phase).toBe(OnboardingPhase.ChooseOrganization);
    state = move(state, { type: OnboardingEvent.Back }, ctx);
    expect(state.phase).toBe(OnboardingPhase.Account);
    state = move(state, { type: OnboardingEvent.Back }, ctx);
    expect(state.phase).toBe(OnboardingPhase.SessionDiscovery);
    state = move(state, { type: OnboardingEvent.Back }, ctx);
    expect(state.phase).toBe(OnboardingPhase.Welcome);
    expect(state.history).toEqual([]);
  });

  it.each([
    {
      membership: OrganizationMembership.FirstUser,
      organizationActive: KnownFlag.No,
      organizationPhase: OnboardingPhase.CreateOrganization,
    },
    {
      membership: OrganizationMembership.ExistingMember,
      organizationActive: KnownFlag.Yes,
      organizationPhase: OnboardingPhase.ChooseOrganization,
    },
  ])(
    "returns from the sync policy to $organizationPhase, the organization step it came from",
    ({ membership, organizationActive, organizationPhase }) => {
      const ctx = context({
        host: OnboardingHost.Desktop,
        membership,
        organizationActive,
      });
      const atOrganization = move(
        stateAt(OnboardingPhase.Account, {
          history: [OnboardingPhase.Welcome, OnboardingPhase.SessionDiscovery],
        }),
        {
          type: OnboardingEvent.AccountEstablished,
          provider: AccountProvider.GitHub,
        },
        ctx
      );
      expect(atOrganization.phase).toBe(organizationPhase);
      const atSyncPolicy = move(
        atOrganization,
        { type: OnboardingEvent.OrganizationReady },
        ctx
      );
      expect(atSyncPolicy.phase).toBe(OnboardingPhase.SyncPolicy);

      const backedOut = move(atSyncPolicy, { type: OnboardingEvent.Back }, ctx);

      expect(backedOut.phase).toBe(organizationPhase);
      expect(backedOut.phase).not.toBe(OnboardingPhase.Welcome);
    }
  );

  it("never invents a phase the run did not visit", () => {
    // Web skips discovery, so Back out of Account lands on Welcome, not on the
    // Desktop-only screen between them in the diagram.
    const ctx = context({ host: OnboardingHost.Web });
    const state = move(
      move(
        stateAt(OnboardingPhase.Welcome),
        { type: OnboardingEvent.Start },
        ctx
      ),
      { type: OnboardingEvent.Back },
      ctx
    );

    expect(state.phase).toBe(OnboardingPhase.Welcome);
  });

  it("rejects Back at the start of the run", () => {
    const result = transitionOnboarding(
      stateAt(OnboardingPhase.Welcome),
      { type: OnboardingEvent.Back },
      context()
    );

    expect(result).toEqual({
      status: "rejected",
      reason: OnboardingRejection.NoHistory,
    });
  });

  it("returns a resumed step to the Dashboard and clears the resuming flag", () => {
    const ctx = context({
      host: OnboardingHost.Desktop,
      accountStatus: AccountStatus.Skipped,
    });
    const resumed = move(
      stateAt(OnboardingPhase.Ready),
      {
        type: OnboardingEvent.ResumePendingStep,
        step: PendingOnboardingStep.CreateAccount,
      },
      ctx
    );

    expect(resumed).toEqual({
      phase: OnboardingPhase.Account,
      organizationEstablished: false,
      history: [OnboardingPhase.DashboardAvailable],
      accountProvider: null,
      resuming: true,
    });

    const backedOut = move(resumed, { type: OnboardingEvent.Back }, ctx);
    expect(backedOut.phase).toBe(OnboardingPhase.DashboardAvailable);
    expect(backedOut.resuming).toBe(false);
  });

  it("returns a resumed account to the Dashboard once the organization tail has run", () => {
    const ctx = context({
      host: OnboardingHost.Desktop,
      accountStatus: AccountStatus.Skipped,
    });
    const resumed = move(
      stateAt(OnboardingPhase.Ready, { organizationEstablished: true }),
      {
        type: OnboardingEvent.ResumePendingStep,
        step: PendingOnboardingStep.CreateAccount,
      },
      ctx
    );
    const completed = move(
      resumed,
      {
        type: OnboardingEvent.AccountEstablished,
        provider: AccountProvider.GitHub,
      },
      ctx
    );

    expect(completed.phase).toBe(OnboardingPhase.DashboardAvailable);
    expect(completed.resuming).toBe(false);
  });
});

/**
 * ISS-8349 review (T1). `SkipAccount` is the only path that defers the account
 * step, and it reaches the Dashboard WITHOUT running the
 * organization/sync/invite tail. Routing the later resumed account back to the
 * Dashboard therefore stranded the user on a Dashboard with no organization,
 * with no remaining route to `CreateOrganization` or `ChooseOrganization`.
 */
describe("skipping the account and resuming it later", () => {
  const RESUME_MEMBERSHIPS: readonly {
    membership: OrganizationMembership;
    organizationPhase: OnboardingPhase;
  }[] = [
    {
      membership: OrganizationMembership.FirstUser,
      organizationPhase: OnboardingPhase.CreateOrganization,
    },
    {
      membership: OrganizationMembership.ExistingMember,
      organizationPhase: OnboardingPhase.ChooseOrganization,
    },
  ];

  for (const { membership, organizationPhase } of RESUME_MEMBERSHIPS) {
    it(`reaches ${organizationPhase} for a ${membership} who skipped the account`, () => {
      const skipping = context({
        host: OnboardingHost.Desktop,
        membership,
        accountStatus: AccountStatus.None,
      });
      // The Desktop skip walk, exactly as a user takes it.
      const started = move(
        stateAt(OnboardingPhase.Welcome),
        { type: OnboardingEvent.Start },
        skipping
      );
      const atAccount = move(
        started,
        { type: OnboardingEvent.ContinueFromDiscovery },
        skipping
      );
      const skipped = move(
        atAccount,
        { type: OnboardingEvent.SkipAccount },
        skipping
      );
      expect(skipped.phase).toBe(OnboardingPhase.DashboardAvailable);
      expect(skipped.organizationEstablished).toBe(false);

      // The account is now the outstanding step the completion card offers.
      const deferred = context({
        host: OnboardingHost.Desktop,
        membership,
        accountStatus: AccountStatus.Skipped,
      });
      const inTour = move(
        skipped,
        { type: OnboardingEvent.DashboardEntered },
        deferred
      );
      const ready = move(
        inTour,
        { type: OnboardingEvent.FinishTour },
        deferred
      );
      expect(ready.phase).toBe(OnboardingPhase.Ready);

      const resumed = move(
        ready,
        {
          type: OnboardingEvent.ResumePendingStep,
          step: PendingOnboardingStep.CreateAccount,
        },
        deferred
      );
      expect(resumed.phase).toBe(OnboardingPhase.Account);

      const established = move(
        resumed,
        {
          type: OnboardingEvent.AccountEstablished,
          provider: AccountProvider.Google,
        },
        deferred
      );

      expect(established.phase).toBe(organizationPhase);
      // The deferred tail is not a single resumed step, so the rest of it
      // (sync policy, invitations, GitHub) plays out normally.
      expect(established.resuming).toBe(false);
    });
  }

  it("records the organization tail so a second resume is not replayed", () => {
    const ctx = context({
      host: OnboardingHost.Desktop,
      membership: OrganizationMembership.FirstUser,
      accountStatus: AccountStatus.Skipped,
    });
    const atOrganization = move(
      stateAt(OnboardingPhase.Account, {
        resuming: true,
        history: [OnboardingPhase.DashboardAvailable],
      }),
      {
        type: OnboardingEvent.AccountEstablished,
        provider: AccountProvider.GitHub,
      },
      ctx
    );
    const afterOrganization = move(
      atOrganization,
      { type: OnboardingEvent.OrganizationReady },
      ctx
    );

    expect(afterOrganization.organizationEstablished).toBe(true);
  });

  it("persists the accepted account provider in the machine state", () => {
    const established = move(
      stateAt(OnboardingPhase.Account),
      {
        type: OnboardingEvent.AccountEstablished,
        provider: AccountProvider.Email,
      },
      context({ membership: OrganizationMembership.FirstUser })
    );

    expect(established.accountProvider).toBe(AccountProvider.Email);
  });
});

describe("isBlockingPhase", () => {
  it("holds the modal open for every setup phase and releases it at the Dashboard", () => {
    expect(isBlockingPhase(OnboardingPhase.Welcome)).toBe(true);
    expect(isBlockingPhase(OnboardingPhase.ConnectGitHub)).toBe(true);
    expect(isBlockingPhase(OnboardingPhase.DashboardAvailable)).toBe(false);
    expect(isBlockingPhase(OnboardingPhase.DashboardTour)).toBe(false);
    expect(isBlockingPhase(OnboardingPhase.Ready)).toBe(false);
  });
});

/**
 * ISS-8349 review (T3). The dispatch used to end in a bare
 * `return transitionFromReady(...)`, so any phase not explicitly matched —
 * including a phase added later — silently inherited Ready's behavior.
 * `PHASE_TRANSITIONS` is now an exhaustive `Record`, so a new phase fails
 * `tsc` until it is mapped; these pin the runtime half.
 */
describe("phase dispatch is exhaustive", () => {
  const ALL_PHASES: readonly OnboardingPhase[] = Object.values(OnboardingPhase);

  it("accepts ResumePendingStep from Ready and from no other phase", () => {
    const ctx = context({
      host: OnboardingHost.Desktop,
      accountStatus: AccountStatus.Skipped,
    });
    const resume: OnboardingEventInput = {
      type: OnboardingEvent.ResumePendingStep,
      step: PendingOnboardingStep.CreateAccount,
    };

    const accepting = ALL_PHASES.filter(
      (phase) =>
        transitionOnboarding(stateAt(phase), resume, ctx).status === "moved"
    );

    expect(accepting).toEqual([OnboardingPhase.Ready]);
  });

  it("rejects an out-of-phase event from every phase rather than falling through", () => {
    const ctx = context();
    // `Start` has an edge out of Welcome only. A phase reaching the old Ready
    // fallback answers StepNotPending instead of NotAllowedFromPhase.
    for (const phase of ALL_PHASES) {
      if (phase === OnboardingPhase.Welcome) {
        continue;
      }
      const result = transitionOnboarding(
        stateAt(phase),
        { type: OnboardingEvent.Start },
        ctx
      );

      expect(result).toEqual({
        status: "rejected",
        reason: OnboardingRejection.NotAllowedFromPhase,
      });
    }
  });
});

/**
 * ISS-10624-era Desktop builds stored the sync step right after Welcome, and
 * that position still restores, so its Continue must keep the order it was
 * recorded in rather than skip discovery, the account, and the organization.
 */
describe("a sync step stored in the ISS-10624 order", () => {
  it("continues to discovery and then the account, not to invitations", () => {
    const ctx = context({
      host: OnboardingHost.Desktop,
      analysisStarted: true,
    });
    const atSyncPolicy = stateAt(OnboardingPhase.SyncPolicy, {
      history: [OnboardingPhase.Welcome],
      organizationEstablished: false,
    });

    const atDiscovery = move(
      atSyncPolicy,
      { type: OnboardingEvent.ContinueFromSyncPolicy },
      ctx
    );
    expect(atDiscovery.phase).toBe(OnboardingPhase.SessionDiscovery);
    expect(atDiscovery.history).toEqual([
      OnboardingPhase.Welcome,
      OnboardingPhase.SyncPolicy,
    ]);

    const atAccount = move(
      atDiscovery,
      { type: OnboardingEvent.ContinueFromDiscovery },
      ctx
    );
    expect(atAccount.phase).toBe(OnboardingPhase.Account);
  });
});
