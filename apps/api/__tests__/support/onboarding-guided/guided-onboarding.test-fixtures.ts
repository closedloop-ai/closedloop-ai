/**
 * @file guided-onboarding.test-fixtures.ts
 * @description Shared identities, seed rows and command builders for the
 * guided onboarding suites (ISS-8375).
 */

import { randomUUID } from "node:crypto";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import type { GuidedOnboardingTransitionRequest } from "@repo/api/src/types/onboarding-guided";
import {
  ONBOARDING_STATE_VERSION,
  type PersistedOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  createInitialOnboardingState,
  OnboardingHost,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { GitHubInstallationStatus } from "@repo/database";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import type {
  FakeAttemptRow,
  FakeComputeTargetRow,
  FakeGitHubUserConnectionRow,
  FakeInstallationRow,
  FakeOrganizationRow,
  FakeOrganizationScopedRow,
  FakeUserRow,
} from "./guided-onboarding.test-db";

export const ORG_A = "org-a";
export const ORG_B = "org-b";
/** The caller in {@link ORG_A}. */
export const USER_A = "user-a";
/** {@link USER_A}'s teammate in the SAME organization. */
export const USER_A_TEAMMATE = "user-a-teammate";
/** A member of {@link ORG_B}. */
export const USER_B = "user-b";
export const CLERK_USER_A = "clerk_user_a";

export const EXPERIENCE_VARIANT = "web-master-v2";

/** A run that has advanced past Welcome, so a Back or a resume is expressible. */
export function persistedAccountState(): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: OnboardingPhase.Account,
    history: [OnboardingPhase.Welcome],
    accountProvider: null,
    resuming: false,
    organizationEstablished: false,
  };
}

/** The state a fresh run starts from. */
export function initialPersistedState(): PersistedOnboardingState {
  return serializeOnboardingState(createInitialOnboardingState());
}

/**
 * A step resumed from the completion card: the shape `ResumePendingStep` writes
 * out of `Ready`, history rewritten to the Dashboard so Back returns to the app
 * rather than into the finished blocking run.
 */
export function persistedResumedConnectGitHubState(): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: OnboardingPhase.ConnectGitHub,
    history: [OnboardingPhase.DashboardAvailable],
    accountProvider: null,
    resuming: true,
    organizationEstablished: true,
  };
}

/**
 * The state a FINISHED resumed step writes: `resolvePostInvitePhase` sends a
 * resumed invite to the Dashboard and `advance` clears `resuming`, leaving the
 * left phase on history. It is what the transition response carries, and the
 * host reads `DashboardAvailable` from it to run its dashboard handoff.
 */
export function persistedPostResumeDashboardState(): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: OnboardingPhase.DashboardAvailable,
    history: [OnboardingPhase.DashboardAvailable, OnboardingPhase.InviteTeam],
    accountProvider: null,
    resuming: false,
    organizationEstablished: true,
  };
}

/** A Web-only phase, used to prove the host reachability fallback fires. */
export function persistedDownloadDesktopState(): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: OnboardingPhase.DownloadDesktop,
    history: [
      OnboardingPhase.Welcome,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.InviteTeam,
    ],
    accountProvider: null,
    resuming: false,
    organizationEstablished: true,
  };
}

/**
 * `Ready` with an empty history: shape-valid, drawable on either host, and
 * producible by no run of the machine — nothing can occupy `Ready` without
 * having walked there.
 *
 * The exact payload the write boundary has to refuse: the read path recovers it
 * to a fresh run, but the `completedAt` a transition stamps on the way in is
 * durable and does not heal.
 */
export function unreachableReadyState(): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: OnboardingPhase.Ready,
    history: [],
    accountProvider: null,
    resuming: false,
    organizationEstablished: false,
  };
}

/** The resting state; arriving here stamps `completedAt` unless the arrival was
 * a deferred tour, which the server cannot tell from a failed dashboard. */
export function persistedReadyState(): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: OnboardingPhase.Ready,
    history: [
      OnboardingPhase.Welcome,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.InviteTeam,
      OnboardingPhase.DashboardAvailable,
      OnboardingPhase.DashboardTour,
    ],
    accountProvider: null,
    resuming: false,
    organizationEstablished: true,
  };
}

export function attemptRow(
  overrides: Partial<FakeAttemptRow> & Pick<FakeAttemptRow, "id">
): FakeAttemptRow {
  return {
    userId: USER_A,
    organizationId: ORG_A,
    experienceVariant: EXPERIENCE_VARIANT,
    host: OnboardingHost.Web,
    state: persistedAccountState(),
    revision: 3,
    lastCommandId: null,
    accountSkippedAt: null,
    desktopDownloadedAt: null,
    tourCompletedAt: null,
    invitesSentAt: null,
    completedAt: null,
    createdAt: LIVE_ATTEMPT_CREATED_AT,
    ...overrides,
  };
}

/** A run started after the snapshot's settled fold reached production. */
export const LIVE_ATTEMPT_CREATED_AT = new Date("2026-09-20T00:00:00.000Z");

/**
 * A run started before the settled fold reached production, when an
 * already-onboarded account could still be shown the takeover (ISS-9916).
 */
export const PRE_FOLD_ATTEMPT_CREATED_AT = new Date("2026-09-05T00:00:00.000Z");

export function userRow(
  id: string,
  organizationId: string,
  active = true
): FakeUserRow {
  return { id, organizationId, active };
}

export function installationRow(
  organizationId: string,
  status: GitHubInstallationStatus = GitHubInstallationStatus.ACTIVE
): FakeInstallationRow {
  return { id: `installation-${organizationId}`, organizationId, status };
}

/**
 * One member's personal GitHub OAuth grant — the fact the onboarding GitHub
 * step's own CTA actually creates (ISS-11246). `scopes` carries the repo scope
 * the data-connection resolver requires for an ACTIVE grant.
 */
export function githubUserConnectionRow(
  organizationId: string,
  userId: string,
  {
    revokedAt = null,
    scopes = [GITHUB_REPO_SCOPE],
  }: { revokedAt?: Date | null; scopes?: string[] } = {}
): FakeGitHubUserConnectionRow {
  return { organizationId, userId, revokedAt, scopes };
}

export function computeTargetRow(
  organizationId: string,
  userId: string,
  isCloudSentinel = false
): FakeComputeTargetRow {
  return {
    id: `compute-target-${organizationId}-${userId}`,
    organizationId,
    userId,
    isCloudSentinel,
  };
}

export function organizationRow(
  id: string,
  invitesSentAt: string | null = null,
  createdAt: Date = LEGACY_ORGANIZATION_CREATED_AT
): FakeOrganizationRow {
  return {
    createdAt,
    id,
    settings: invitesSentAt === null ? {} : { onboarding: { invitesSentAt } },
  };
}

/**
 * A well-formed transition command. Every field is overridable so a case can
 * make exactly one thing wrong.
 */
export function transitionCommand(
  overrides: Partial<GuidedOnboardingTransitionRequest> = {}
): GuidedOnboardingTransitionRequest {
  return {
    commandId: randomUUID(),
    host: OnboardingHost.Web,
    experienceVariant: EXPERIENCE_VARIANT,
    revision: 3,
    event: { type: OnboardingEvent.OrganizationReady },
    state: persistedAccountState(),
    ...overrides,
  };
}

/** When the legacy onboarding wizard was completed, for an onboarded org. */
export const WIZARD_COMPLETED_AT = "2026-06-01T00:00:00.000Z";

/**
 * An organization that recorded a completed legacy onboarding wizard.
 *
 * The sibling shape — no marker, but teams and projects already exist — is
 * seeded with {@link teamRow} and {@link projectRow} against a plain
 * {@link organizationRow}, and is the arm that covers organizations predating
 * the wizard record.
 */
export function onboardedOrganizationRow(id: string): FakeOrganizationRow {
  return {
    createdAt: LEGACY_ORGANIZATION_CREATED_AT,
    id,
    settings: { onboarding: { wizardCompletedAt: WIZARD_COMPLETED_AT } },
  };
}

/**
 * An organization created AFTER guided onboarding could record a completion,
 * so the teams-and-projects inference does not speak for it (ISS-10339).
 */
export function currentEraOrganizationRow(id: string): FakeOrganizationRow {
  return {
    createdAt: CURRENT_ERA_ORGANIZATION_CREATED_AT,
    id,
    settings: {},
  };
}

/** Comfortably before the `iss8375_onboarding_attempts` migration. */
export const LEGACY_ORGANIZATION_CREATED_AT = new Date(
  "2026-06-01T00:00:00.000Z"
);

/** Comfortably after it. */
export const CURRENT_ERA_ORGANIZATION_CREATED_AT = new Date(
  "2026-09-10T00:00:00.000Z"
);

export function teamRow(organizationId: string): FakeOrganizationScopedRow {
  return { id: `team-${organizationId}`, organizationId };
}

export function projectRow(organizationId: string): FakeOrganizationScopedRow {
  return { id: `project-${organizationId}`, organizationId };
}

/**
 * A post-cutoff organization that DID record a completion.
 *
 * The other post-cutoff arm: {@link currentEraOrganizationRow} is refused the
 * teams-and-projects inference, and this one is admitted on the marker alone,
 * with no team or project row seeded beside it (ISS-10339).
 */
export function currentEraOnboardedOrganizationRow(
  id: string
): FakeOrganizationRow {
  return {
    createdAt: CURRENT_ERA_ORGANIZATION_CREATED_AT,
    id,
    settings: { onboarding: { wizardCompletedAt: WIZARD_COMPLETED_AT } },
  };
}

/** The sync step reached after the organization step, in the ISS-10890 order. */
export function persistedSyncPolicyAfterOrganizationState(): PersistedOnboardingState {
  return {
    version: ONBOARDING_STATE_VERSION,
    phase: OnboardingPhase.SyncPolicy,
    history: [
      OnboardingPhase.Welcome,
      OnboardingPhase.SessionDiscovery,
      OnboardingPhase.Account,
      OnboardingPhase.CreateOrganization,
    ],
    accountProvider: null,
    resuming: false,
    organizationEstablished: true,
  };
}
