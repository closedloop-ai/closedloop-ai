/**
 * ISS-10988: the guided run's completion and `/onboarding/status` must agree.
 *
 * `OnboardingGuard` routes on `wizardCompleted`. A web guided run that leaves
 * its blocking takeover hands off to the Dashboard, so if the status still
 * reads `false` for that reader the guard sends them to `/onboarding` — the
 * start of onboarding, straight after its last step. Driven against the REAL
 * transition, snapshot and status services over one fake database, so the
 * status is read from exactly the row the transition wrote.
 */

import { KnownFlag } from "@repo/api/src/types/onboarding-phase";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  getUserExternalAccountProviders: vi.fn(),
  organizationHasSyncedSessionData: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: mocks.withDb,
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    getUserExternalAccountProviders: mocks.getUserExternalAccountProviders,
  },
}));

vi.mock("@/app/agent-sessions/organization-synced-session-data", () => ({
  organizationHasSyncedSessionData: mocks.organizationHasSyncedSessionData,
}));

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import {
  ONBOARDING_STATE_VERSION,
  type PersistedOnboardingState,
  restoreOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  isBlockingPhase,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import {
  createGuidedOnboardingDb,
  type GuidedOnboardingSeed,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-db";
import {
  attemptRow,
  CLERK_USER_A,
  currentEraOrganizationRow,
  ORG_A,
  transitionCommand,
  USER_A,
  USER_A_TEAMMATE,
  userRow,
} from "@/__tests__/support/onboarding-guided/guided-onboarding.test-fixtures";
import { expectAccepted } from "@/__tests__/support/onboarding-guided/guided-onboarding.test-helpers";
import { onboardingService } from "../../service";
import { guidedOnboardingSnapshotService } from "../snapshot-service";
import { guidedOnboardingTransitionService } from "../transition-service";

const FINAL_STEP_REVISION = 4;

/** The web run on its last blocking step, organization already set up. */
function connectGitHubStepState(): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: OnboardingPhase.ConnectGitHub,
    history: [
      OnboardingPhase.Welcome,
      OnboardingPhase.Account,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.InviteTeam,
    ],
    accountProvider: null,
    resuming: false,
    organizationEstablished: true,
  };
}

/** What the client's machine posts when that last step is skipped. */
function dashboardAvailableState(): PersistedOnboardingState {
  const prior = connectGitHubStepState();
  return {
    ...prior,
    phase: OnboardingPhase.DashboardAvailable,
    history: [...prior.history, OnboardingPhase.ConnectGitHub],
  };
}

function install(seed: GuidedOnboardingSeed): void {
  // A post-cutoff organization with no team, no project and no legacy wizard
  // marker: the organization Clerk's own sign-up task has just created.
  const db = createGuidedOnboardingDb({
    organizations: [currentEraOrganizationRow(ORG_A)],
    users: [userRow(USER_A, ORG_A), userRow(USER_A_TEAMMATE, ORG_A)],
    ...seed,
  });
  mocks.withDb.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
  mocks.withDb.tx.mockImplementation((callback: (client: unknown) => unknown) =>
    callback(db.client)
  );
}

function finishLastStep() {
  return guidedOnboardingTransitionService.apply({
    organizationId: ORG_A,
    userId: USER_A,
    clerkUserId: CLERK_USER_A,
    command: transitionCommand({
      event: { type: OnboardingEvent.SkipGitHub },
      revision: FINAL_STEP_REVISION,
      state: dashboardAvailableState(),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserExternalAccountProviders.mockResolvedValue([]);
  mocks.organizationHasSyncedSessionData.mockResolvedValue(KnownFlag.No);
});

describe("guided onboarding completion — /onboarding/status agreement", () => {
  it("reports the wizard completed once the caller's guided run leaves its last step, and keeps it on the next read", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-final-step",
          revision: FINAL_STEP_REVISION,
          state: connectGitHubStepState(),
        }),
      ],
    });
    // The run is mid-takeover, so the guard's answer is still "not finished".
    expect(
      (await onboardingService.getStatus(ORG_A, USER_A)).wizardCompleted
    ).toBe(false);

    expectAccepted(await finishLastStep());

    expect(
      (await onboardingService.getStatus(ORG_A, USER_A)).wizardCompleted
    ).toBe(true);
    // The reload: a fresh read of both halves the web shell renders from.
    expect(
      (await onboardingService.getStatus(ORG_A, USER_A)).wizardCompleted
    ).toBe(true);
    const reloaded = await guidedOnboardingSnapshotService.getSnapshot({
      organizationId: ORG_A,
      userId: USER_A,
      clerkUserId: CLERK_USER_A,
      host: OnboardingHost.Web,
    });
    const reloadedPhase = restoreOnboardingState(
      reloaded.state,
      OnboardingHost.Web
    ).state.phase;
    expect(reloadedPhase).toBe(OnboardingPhase.DashboardAvailable);
    expect(isBlockingPhase(reloadedPhase)).toBe(false);
  });

  it("is the caller's completion only — a teammate who has not run it is still not finished", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-final-step",
          revision: FINAL_STEP_REVISION,
          state: connectGitHubStepState(),
        }),
      ],
    });

    expectAccepted(await finishLastStep());

    expect(
      (await onboardingService.getStatus(ORG_A, USER_A)).wizardCompleted
    ).toBe(true);
    expect(
      (await onboardingService.getStatus(ORG_A, USER_A_TEAMMATE))
        .wizardCompleted
    ).toBe(false);
  });

  it("does not count a run that reached the Dashboard without establishing an organization", async () => {
    install({
      attempts: [
        attemptRow({
          id: "attempt-skipped-account",
          revision: FINAL_STEP_REVISION,
          state: {
            version: ONBOARDING_STATE_VERSION,
            phase: OnboardingPhase.DashboardAvailable,
            history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
            accountProvider: null,
            resuming: false,
            organizationEstablished: false,
          },
        }),
      ],
    });

    expect(
      (await onboardingService.getStatus(ORG_A, USER_A)).wizardCompleted
    ).toBe(false);
  });
});
