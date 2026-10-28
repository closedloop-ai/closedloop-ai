/**
 * The deferred-completion contract: priority order, host applicability, and the
 * phase each resumed step re-enters. Pure data — no React.
 */

import { describe, expect, it } from "vitest";
import {
  canSkipDesktopDownload,
  listApplicableOnboardingSteps,
  listPendingOnboardingSteps,
  PENDING_STEP_PRIORITY,
  phaseForPendingStep,
  resolvePendingOnboardingStep,
  summarizeOnboardingCompletion,
} from "./onboarding-completion.ts";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
  PendingOnboardingStep,
} from "./onboarding-phase.ts";

function context(
  overrides: Partial<OnboardingContext> = {}
): OnboardingContext {
  return {
    host: OnboardingHost.Desktop,
    membership: OrganizationMembership.FirstUser,
    accountStatus: AccountStatus.Established,
    accountProvider: AccountProvider.GitHub,
    githubConnected: true,
    desktopAppDownloaded: true,
    organizationHasSyncedSessionData: KnownFlag.Yes,
    syncConsentRecorded: KnownFlag.Yes,
    teamInvited: true,
    analysisStarted: true,
    tourCompleted: true,
    organizationActive: KnownFlag.Yes,
    ...overrides,
  };
}

describe("priority order", () => {
  it("matches the order PRD-689 documents", () => {
    expect(PENDING_STEP_PRIORITY).toEqual([
      PendingOnboardingStep.CreateAccount,
      PendingOnboardingStep.DownloadDesktop,
      PendingOnboardingStep.ConnectGitHub,
      PendingOnboardingStep.InviteTeam,
      PendingOnboardingStep.ChooseSessionSync,
    ]);
  });

  it("offers the account before every other outstanding step", () => {
    const everythingOutstanding = context({
      host: OnboardingHost.Desktop,
      accountStatus: AccountStatus.Skipped,
      accountProvider: AccountProvider.Google,
      githubConnected: false,
      syncConsentRecorded: KnownFlag.No,
      teamInvited: false,
    });

    expect(resolvePendingOnboardingStep(everythingOutstanding)).toBe(
      PendingOnboardingStep.CreateAccount
    );
    expect(listPendingOnboardingSteps(everythingOutstanding)).toEqual([
      PendingOnboardingStep.CreateAccount,
      PendingOnboardingStep.ConnectGitHub,
      PendingOnboardingStep.InviteTeam,
      PendingOnboardingStep.ChooseSessionSync,
    ]);
  });

  it("offers the download before GitHub and invitations on Web", () => {
    const webOutstanding = context({
      host: OnboardingHost.Web,
      accountProvider: AccountProvider.Google,
      githubConnected: false,
      desktopAppDownloaded: false,
      teamInvited: false,
    });

    expect(resolvePendingOnboardingStep(webOutstanding)).toBe(
      PendingOnboardingStep.DownloadDesktop
    );
  });

  it("offers GitHub before invitations once the earlier two are satisfied", () => {
    expect(
      resolvePendingOnboardingStep(
        context({
          accountProvider: AccountProvider.Google,
          githubConnected: false,
          teamInvited: false,
        })
      )
    ).toBe(PendingOnboardingStep.ConnectGitHub);
  });

  it("offers the Desktop sync choice only after earlier Desktop steps finish", () => {
    expect(
      resolvePendingOnboardingStep(
        context({ syncConsentRecorded: KnownFlag.No })
      )
    ).toBe(PendingOnboardingStep.ChooseSessionSync);
  });

  it("returns null when nothing is outstanding", () => {
    expect(resolvePendingOnboardingStep(context())).toBeNull();
    expect(listPendingOnboardingSteps(context())).toEqual([]);
  });
});

describe("host applicability", () => {
  it("never offers the account step on Web, which required it", () => {
    // A Web run cannot reach AccountStatus.Skipped, but the projection must not
    // depend on that being impossible upstream.
    const web = context({
      host: OnboardingHost.Web,
      accountStatus: AccountStatus.Skipped,
    });

    expect(listPendingOnboardingSteps(web)).not.toContain(
      PendingOnboardingStep.CreateAccount
    );
  });

  it("never offers the Desktop download to a Desktop user", () => {
    const desktop = context({
      host: OnboardingHost.Desktop,
      desktopAppDownloaded: false,
    });

    expect(listPendingOnboardingSteps(desktop)).not.toContain(
      PendingOnboardingStep.DownloadDesktop
    );
  });

  it("never offers the Desktop sync choice on Web", () => {
    const web = context({
      host: OnboardingHost.Web,
      syncConsentRecorded: KnownFlag.No,
    });

    expect(listPendingOnboardingSteps(web)).not.toContain(
      PendingOnboardingStep.ChooseSessionSync
    );
  });
});

/**
 * ISS-8349 review (T5). Both halves of the summary used to count against every
 * declared step, so a Desktop user was silently credited with the Web-only
 * installer download they are never shown. ISS-8353 adds the Desktop-only sync
 * choice, so the same host-applicability boundary now protects Web from being
 * credited with Desktop-local consent.
 */
describe("completion summary", () => {
  it("counts a complete Desktop user against the four Desktop steps", () => {
    expect(summarizeOnboardingCompletion(context())).toEqual({
      completed: 4,
      total: 4,
    });
  });

  it("counts a complete Web user against the three Web steps", () => {
    expect(
      summarizeOnboardingCompletion(context({ host: OnboardingHost.Web }))
    ).toEqual({ completed: 3, total: 3 });
  });

  it("never credits a host for a step it does not show", () => {
    // The Desktop denominator must not move when the Web-only installer flag is
    // cleared, and the Web one must not move when Desktop-only steps are owed.
    expect(
      summarizeOnboardingCompletion(context({ desktopAppDownloaded: false }))
    ).toEqual({ completed: 4, total: 4 });
    expect(
      summarizeOnboardingCompletion(
        context({
          host: OnboardingHost.Web,
          accountStatus: AccountStatus.Skipped,
          syncConsentRecorded: KnownFlag.No,
        })
      )
    ).toEqual({ completed: 3, total: 3 });
  });

  it("subtracts only the outstanding applicable steps", () => {
    expect(
      summarizeOnboardingCompletion(
        context({ teamInvited: false, githubConnected: false })
      )
    ).toEqual({ completed: 2, total: 4 });
  });

  it("agrees with the pending list on every host", () => {
    for (const host of [OnboardingHost.Desktop, OnboardingHost.Web]) {
      const ctx = context({
        host,
        accountStatus: AccountStatus.Skipped,
        desktopAppDownloaded: false,
        githubConnected: false,
        syncConsentRecorded: KnownFlag.No,
        teamInvited: false,
      });
      const summary = summarizeOnboardingCompletion(ctx);

      expect(summary.total).toBe(listApplicableOnboardingSteps(ctx).length);
      expect(summary.total - summary.completed).toBe(
        listPendingOnboardingSteps(ctx).length
      );
      expect(summary).toEqual({
        completed: 0,
        total: host === OnboardingHost.Desktop ? 4 : 3,
      });
    }
  });
});

describe("resume targets", () => {
  it("maps every step to the phase that renders it", () => {
    expect(phaseForPendingStep(PendingOnboardingStep.CreateAccount)).toBe(
      OnboardingPhase.Account
    );
    expect(phaseForPendingStep(PendingOnboardingStep.DownloadDesktop)).toBe(
      OnboardingPhase.DownloadDesktop
    );
    expect(phaseForPendingStep(PendingOnboardingStep.ConnectGitHub)).toBe(
      OnboardingPhase.ConnectGitHub
    );
    expect(phaseForPendingStep(PendingOnboardingStep.InviteTeam)).toBe(
      OnboardingPhase.InviteTeam
    );
  });

  /**
   * ISS-11249. The sync election used to resolve to the Connected Devices
   * settings panel, which is why the one choice the run owns was the one it did
   * not present. Asserted against the PHASE CONSTANT rather than against the map
   * this module exports, so the expectation is independent of whatever the map
   * currently says.
   */
  it("routes the sync-choice step to the phase that renders it, not out to Settings", () => {
    expect(phaseForPendingStep(PendingOnboardingStep.ChooseSessionSync)).toBe(
      OnboardingPhase.SyncPolicy
    );
  });

  /**
   * Every member, by construction. A list written out by hand goes green on a
   * step it forgot; this cannot be written without naming all five, because
   * `PENDING_STEP_PRIORITY` is derived from an exhaustive record and a resumed
   * step with no blocking phase would leave `undefined` here.
   */
  it("gives every step a blocking phase to resume into", () => {
    for (const step of PENDING_STEP_PRIORITY) {
      expect(Object.values(OnboardingPhase)).toContain(
        phaseForPendingStep(step)
      );
    }
    expect(PENDING_STEP_PRIORITY).toHaveLength(
      Object.keys(PendingOnboardingStep).length
    );
  });
});

/** Every subset of `items`, so no combination of outstanding steps is skipped. */
function powerSet<T>(items: readonly T[]): T[][] {
  const subsets: T[][] = [[]];
  for (const item of items) {
    const grown: T[][] = [];
    for (const subset of subsets) {
      grown.push([...subset, item]);
    }
    subsets.push(...grown);
  }
  return subsets;
}

/**
 * ISS-11251 AC1/AC2, as an INVARIANT over every reachable checklist state rather
 * than a sample of them.
 *
 * The card offers `listActionableOnboardingSteps(listPendingOnboardingSteps(ctx))[0]`
 * and the machine's `transitionFromReady` will only accept
 * `resolvePendingOnboardingStep(ctx)`. If those two can ever disagree, the card
 * renders an enabled control whose press is rejected as `StepNotPending` and
 * silently does nothing — which is the shape the operator reported. This sweeps
 * all 2^5 outstanding combinations on both hosts, in both actionability states,
 * and asserts they never disagree.
 *
 * Deliberately over the RANK contract rather than over a fixture: the property
 * holds because the only conditionally-dropped member ranks last, so dropping it
 * can never change the head of a non-empty list. A test that sampled two states
 * would pass while a re-rank silently broke that.
 */
describe("the offered step and the resumable step cannot disagree", () => {
  it("agrees for every outstanding combination on every host", () => {
    const outstanding: Record<
      PendingOnboardingStep,
      Partial<OnboardingContext>
    > = {
      [PendingOnboardingStep.CreateAccount]: {
        accountStatus: AccountStatus.Skipped,
      },
      [PendingOnboardingStep.DownloadDesktop]: {
        desktopAppDownloaded: false,
      },
      [PendingOnboardingStep.ConnectGitHub]: { githubConnected: false },
      [PendingOnboardingStep.InviteTeam]: { teamInvited: false },
      [PendingOnboardingStep.ChooseSessionSync]: {
        syncConsentRecorded: KnownFlag.No,
      },
    };
    const steps = Object.keys(outstanding) as PendingOnboardingStep[];

    for (const host of Object.values(OnboardingHost)) {
      for (const subset of powerSet(steps)) {
        let overrides: Partial<OnboardingContext> = { host };
        for (const step of subset) {
          overrides = { ...overrides, ...outstanding[step] };
        }
        const scenario = context(overrides);
        const pending = listPendingOnboardingSteps(scenario);
        for (const settled of [true, false]) {
          // The card's own narrowing, restated from its one conditional member
          // rather than imported: this module cannot import the component layer.
          const offered =
            (settled
              ? pending
              : pending.filter(
                  (step) => step !== PendingOnboardingStep.ChooseSessionSync
                ))[0] ?? null;
          if (offered === null) {
            continue;
          }
          expect(offered).toBe(resolvePendingOnboardingStep(scenario));
        }
      }
    }
  });
});

describe("canSkipDesktopDownload", () => {
  it("grants the skip to an existing member and withholds it from the first user", () => {
    expect(
      canSkipDesktopDownload(
        context({ membership: OrganizationMembership.ExistingMember })
      )
    ).toBe(true);
    expect(
      canSkipDesktopDownload(
        context({ membership: OrganizationMembership.FirstUser })
      )
    ).toBe(false);
  });
});
