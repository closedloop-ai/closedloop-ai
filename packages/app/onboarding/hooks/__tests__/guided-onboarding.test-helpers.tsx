/**
 * Fixtures and the mounting harness shared by the guided-onboarding hook suites
 * (PLN-1875 Step 8).
 *
 * The snapshot fixture is built through `serializeOnboardingState` and the
 * canonical phase/flag constants rather than written out as a literal, so a
 * change to the persisted shape fails these suites at the fixture rather than
 * letting them keep parsing a payload the product no longer produces.
 */

import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountStatus,
  KnownFlag,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";

export const ORG_A = "org-a";
export const USER_A = "user-a";
/**
 * The variant the HOST is running, which is what a host actually passes. Taken
 * from the canonical const rather than spelled out, so a suite cannot keep
 * asserting a variant no host produces — since ISS-10195 retired the gate,
 * every host passes v2.
 */
export const EXPERIENCE_VARIANT = WorkspaceExperience.V2;

/**
 * The variant stamped on the run when the server CREATED it — deliberately not
 * {@link EXPERIENCE_VARIANT}, and derived from the same const so the two can
 * never collide back into one string. The wire field is free-form, so a run
 * created under a different cohort name is the skew the create-only precedence
 * exists for.
 */
export const STAMPED_RUN_VARIANT = `${WorkspaceExperience.V2}-cohort-a`;

/**
 * A run parked on the tour: the phase that arms it, reached the one way the
 * machine allows (`DashboardAvailable` is a history root, and its edge to
 * `DashboardTour` is the only way in).
 */
export function tourSnapshot(
  overrides: Partial<GuidedOnboardingSnapshot> = {}
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: null,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: false,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: EXPERIENCE_VARIANT,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 7,
    state: serializeOnboardingState({
      accountProvider: null,
      history: [OnboardingPhase.DashboardAvailable],
      organizationEstablished: true,
      phase: OnboardingPhase.DashboardTour,
      resuming: false,
    }),
    ...overrides,
  };
}

/**
 * A run at REST on `Ready`, with the tour either finished or still owed
 * (PLN-1875 Step 9).
 *
 * `tourCompleted` is the only field that moves between the two readers this
 * describes, and that is deliberate: the phase, the history and the whole rest
 * of the snapshot are identical, so a test that tells them apart can only be
 * reading the completion record. A fixture that also moved the phase would go
 * green on either field.
 */
/**
 * What the server reports for an organization that finished onboarding before
 * the guided flow shipped: the synthetic settled run, and `attemptId: null`
 * because no `OnboardingAttempt` row exists (`guidedOnboardingSnapshotService`,
 * ISS-9916).
 *
 * Deliberately the same phase and the same `tourCompleted: false` as
 * {@link readySnapshot} with a deferred tour. That pair is the whole point: the
 * two are indistinguishable by phase, and only the missing row separates the
 * account that is owed a tour from the one that never deferred anything.
 */
export function legacyCompleteSnapshot(): GuidedOnboardingSnapshot {
  const settled = readySnapshot({ tourCompleted: false });
  return {
    ...settled,
    attemptId: null,
    revision: 0,
    state: serializeOnboardingState({
      accountProvider: null,
      history: [OnboardingPhase.DashboardAvailable],
      organizationEstablished: true,
      phase: OnboardingPhase.Ready,
      resuming: false,
    }),
  };
}

export function readySnapshot({
  tourCompleted,
}: {
  tourCompleted: boolean;
}): GuidedOnboardingSnapshot {
  const parked = tourSnapshot();
  return {
    ...parked,
    context: { ...parked.context, tourCompleted },
    state: serializeOnboardingState({
      accountProvider: null,
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

/**
 * A run that reached the Dashboard but has not been routed on to the tour
 * (PLN-1875 Step 9).
 *
 * `DashboardAvailable` is the diagram's transient `Complete`, and its only edge
 * out is `dashboard_entered` — which no production surface in this repo posts,
 * so this is where a run that finished the blocking flow actually parks. It is
 * neither asking for the tour nor finished with it, which is the pair the
 * standing exists to keep apart.
 */
export function dashboardAvailableSnapshot(): GuidedOnboardingSnapshot {
  const parked = tourSnapshot();
  return {
    ...parked,
    state: serializeOnboardingState({
      accountProvider: null,
      history: [],
      organizationEstablished: true,
      phase: OnboardingPhase.DashboardAvailable,
      resuming: false,
    }),
  };
}

export function createGuidedQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Pinned rather than collected: the mutation suites read cache entries
      // that have no mounted observer, and `gcTime: 0` collects one on the next
      // tick — between the write and the assertion under a loaded run.
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
      mutations: { retry: false },
    },
  });
}

export function createGuidedWrapper(
  queryClient: QueryClient,
  {
    isLoaded = true,
    orgId = ORG_A,
    userId = USER_A,
  }: { isLoaded?: boolean; orgId?: string | null; userId?: string | null } = {}
) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded, orgId, userId })}
      >
        {children}
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}
