/**
 * Walks the four host/member cohorts PRD-689 documents, end to end, as pure
 * data. If a guard or branch regresses, the cohort's phase sequence changes
 * here — no React, no DOM.
 */

import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { buildOnboardingContext } from "../guided-onboarding-fixtures";
import { transitionOnboarding } from "../onboarding-transitions";

type ContextPatch = Partial<OnboardingContext>;

/** A step in a cohort walk: the event, and the context change it causes. */
type WalkStep = {
  event: OnboardingEventInput;
  /** What the adapter learns as a result of this event. */
  patch?: ContextPatch;
};

function baseContext(overrides: ContextPatch = {}): OnboardingContext {
  // This suite starts before local analysis, unlike the shared default.
  return buildOnboardingContext({ analysisStarted: false, ...overrides });
}

/**
 * Drive the machine through `steps`, returning the phase after each one. A
 * rejected event fails loudly rather than silently producing a shorter walk.
 */
function walkPhases(
  context: OnboardingContext,
  steps: readonly WalkStep[]
): OnboardingPhase[] {
  let state = createInitialOnboardingState();
  let liveContext = context;
  const phases: OnboardingPhase[] = [];
  for (const [index, step] of steps.entries()) {
    const result = transitionOnboarding(state, step.event, liveContext);
    if (result.status !== "moved") {
      throw new Error(
        `step ${index} (${step.event.type}) was rejected: ${result.reason}`
      );
    }
    state = result.state;
    liveContext = { ...liveContext, ...step.patch };
    phases.push(state.phase);
  }
  return phases;
}

const accountViaGoogle: WalkStep = {
  event: {
    type: OnboardingEvent.AccountEstablished,
    provider: AccountProvider.Google,
  },
  patch: {
    accountStatus: AccountStatus.Established,
    accountProvider: AccountProvider.Google,
    githubConnected: false,
  },
};

const accountViaGitHub: WalkStep = {
  event: {
    type: OnboardingEvent.AccountEstablished,
    provider: AccountProvider.GitHub,
  },
  patch: {
    accountStatus: AccountStatus.Established,
    accountProvider: AccountProvider.GitHub,
    githubConnected: true,
  },
};

describe("cohort 1 — Desktop, first user", () => {
  it("routes discovery, create-organization, sync policy, then GitHub for Google auth", () => {
    const phases = walkPhases(baseContext({ analysisStarted: true }), [
      { event: { type: OnboardingEvent.Start } },
      { event: { type: OnboardingEvent.ContinueFromDiscovery } },
      accountViaGoogle,
      { event: { type: OnboardingEvent.OrganizationReady } },
      { event: { type: OnboardingEvent.ContinueFromSyncPolicy } },
      {
        event: { type: OnboardingEvent.SendInvitations },
        patch: { teamInvited: true },
      },
      {
        event: { type: OnboardingEvent.ConnectGitHub },
        patch: { githubConnected: true },
      },
      { event: { type: OnboardingEvent.DashboardEntered } },
      { event: { type: OnboardingEvent.FinishTour } },
    ]);

    expect(phases).toEqual([
      OnboardingPhase.SessionDiscovery,
      OnboardingPhase.Account,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.SyncPolicy,
      OnboardingPhase.InviteTeam,
      OnboardingPhase.ConnectGitHub,
      OnboardingPhase.DashboardAvailable,
      OnboardingPhase.DashboardTour,
      OnboardingPhase.Ready,
    ]);
  });

  it("skips the GitHub step entirely when the account was created with GitHub", () => {
    const phases = walkPhases(baseContext({ analysisStarted: true }), [
      { event: { type: OnboardingEvent.Start } },
      { event: { type: OnboardingEvent.ContinueFromDiscovery } },
      accountViaGitHub,
      { event: { type: OnboardingEvent.OrganizationReady } },
      { event: { type: OnboardingEvent.ContinueFromSyncPolicy } },
      {
        event: { type: OnboardingEvent.SendInvitations },
        patch: { teamInvited: true },
      },
    ]);

    expect(phases.at(-1)).toBe(OnboardingPhase.DashboardAvailable);
    expect(phases).not.toContain(OnboardingPhase.ConnectGitHub);
  });
});

describe("cohort 2 — Desktop, existing organization member", () => {
  it("offers choose-organization rather than create-organization", () => {
    const phases = walkPhases(
      baseContext({
        analysisStarted: true,
        membership: OrganizationMembership.ExistingMember,
      }),
      [
        { event: { type: OnboardingEvent.Start } },
        { event: { type: OnboardingEvent.ContinueFromDiscovery } },
        accountViaGitHub,
        { event: { type: OnboardingEvent.OrganizationReady } },
        { event: { type: OnboardingEvent.ContinueFromSyncPolicy } },
      ]
    );

    expect(phases).toEqual([
      OnboardingPhase.SessionDiscovery,
      OnboardingPhase.Account,
      OnboardingPhase.ChooseOrganization,
      OnboardingPhase.SyncPolicy,
      OnboardingPhase.InviteTeam,
    ]);
  });
});

describe("cohort 3 — Web, first user", () => {
  it("requires the account, skips discovery and sync policy, and gates on download", () => {
    const phases = walkPhases(
      baseContext({
        host: OnboardingHost.Web,
        organizationHasSyncedSessionData: KnownFlag.No,
      }),
      [
        { event: { type: OnboardingEvent.Start } },
        accountViaGitHub,
        { event: { type: OnboardingEvent.OrganizationReady } },
        {
          event: { type: OnboardingEvent.SendInvitations },
          patch: { teamInvited: true },
        },
        {
          event: { type: OnboardingEvent.DownloadDesktopApp },
          patch: { desktopAppDownloaded: true },
        },
        { event: { type: OnboardingEvent.DashboardEntered } },
      ]
    );

    expect(phases).toEqual([
      OnboardingPhase.Account,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.InviteTeam,
      OnboardingPhase.DownloadDesktop,
      OnboardingPhase.DashboardAvailable,
      OnboardingPhase.DashboardTour,
    ]);
    expect(phases).not.toContain(OnboardingPhase.SessionDiscovery);
    expect(phases).not.toContain(OnboardingPhase.SyncPolicy);
  });
});

describe("cohort 4 — Web, existing organization member", () => {
  it("lets a member of an organization with synced data skip the download", () => {
    const phases = walkPhases(
      baseContext({
        host: OnboardingHost.Web,
        membership: OrganizationMembership.ExistingMember,
        organizationHasSyncedSessionData: KnownFlag.Yes,
      }),
      [
        { event: { type: OnboardingEvent.Start } },
        accountViaGitHub,
        { event: { type: OnboardingEvent.OrganizationReady } },
        {
          event: { type: OnboardingEvent.SkipInvitations },
        },
        { event: { type: OnboardingEvent.SkipDownload } },
      ]
    );

    expect(phases).toEqual([
      OnboardingPhase.Account,
      OnboardingPhase.ChooseOrganization,
      OnboardingPhase.InviteTeam,
      OnboardingPhase.DownloadDesktop,
      OnboardingPhase.DashboardAvailable,
    ]);
  });
});
