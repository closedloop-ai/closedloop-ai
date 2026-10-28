/**
 * Shared fixtures for the two `useGuestGuidedOnboardingHandoff` suites.
 *
 * There are two because they answer different questions and cannot share a
 * module graph: one stubs the transition hook so it can drive each `onError`
 * shape by hand, and the other runs the REAL hook against a real `QueryClient`
 * so the shared invalidation actually happens. The account identity and the two
 * snapshots are the same contract in both, so they live here rather than
 * drifting apart in copies.
 */

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
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { desktopGuestGuidedOnboardingStorageKey } from "../../dashboard/dashboard-storage-keys";

export const ORG_ID = "org_handoff";
export const USER_ID = "user_handoff";

/**
 * A guest who reached the Account screen — the phase sign-in is offered from,
 * and therefore the state a real handoff carries.
 */
export function seedGuestRecord(): void {
  localStorage.setItem(
    desktopGuestGuidedOnboardingStorageKey,
    JSON.stringify({
      revision: 2,
      state: {
        accountProvider: null,
        history: [OnboardingPhase.Welcome, OnboardingPhase.SessionDiscovery],
        organizationEstablished: false,
        phase: OnboardingPhase.Account,
        resuming: false,
        version: 1,
      },
    })
  );
}

/**
 * ISS-11480: a guest who finished onboarding without an account and later
 * reopened the Account step from the dashboard — the resumed position a
 * mid-session sign-up carries.
 */
export function seedResumedAccountRecord(): void {
  localStorage.setItem(
    desktopGuestGuidedOnboardingStorageKey,
    JSON.stringify({
      revision: 5,
      state: {
        accountProvider: null,
        history: [OnboardingPhase.DashboardAvailable],
        organizationEstablished: false,
        phase: OnboardingPhase.Account,
        resuming: true,
        version: 1,
      },
    })
  );
}

/** A guest parked on the dashboard, where every settled guest run starts. */
export function seedDashboardRecord(): void {
  localStorage.setItem(
    desktopGuestGuidedOnboardingStorageKey,
    JSON.stringify({
      revision: 4,
      state: {
        accountProvider: null,
        history: [],
        organizationEstablished: false,
        phase: OnboardingPhase.DashboardAvailable,
        resuming: false,
        version: 1,
      },
    })
  );
}

/** What the server answers a freshly created account: no attempt, revision 0. */
export function firstRunServerSnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: null,
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
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
    state: serializeOnboardingState(createInitialOnboardingState()),
  };
}
