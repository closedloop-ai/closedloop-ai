import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import {
  GitHubInstallationStatus,
  type GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
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
import type { TeamWithCounts } from "@repo/api/src/types/teams";
import { ApproverRole, type User } from "@repo/api/src/types/user";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";

// API responses every live page reads, for Surfaces pages that render
// the live route component. The signed-in identity matches the Clerk
// stand-in (.storybook/clerk-nextjs-mock.tsx) and the app-core story
// providers: user `user_test` in org `org_test`.

const FIXTURE_CREATED_AT = new Date("2026-01-12T09:00:00.000Z");

export const currentUserFixture: User = {
  active: true,
  avatarUrl: null,
  clerkId: "user_test",
  createdAt: FIXTURE_CREATED_AT,
  email: "dana@example.com",
  firstName: "Dana",
  githubUsername: "dana-reyes",
  id: "user_test",
  lastName: "Reyes",
  linearId: null,
  organizationId: "org_test",
  phoneNumber: null,
  role: ApproverRole.Engineer,
  slackId: null,
  updatedAt: FIXTURE_CREATED_AT,
};

export const githubConnectedFixture: GitHubIntegrationStatus = {
  connected: true,
  installation: {
    id: "ghi_test",
    installationId: "48151623",
    accountLogin: "closedloop-ai",
    accountType: "Organization",
    status: GitHubInstallationStatus.Active,
    repositorySelection: "selected",
    repositoryCount: 12,
    claimedAt: "2026-01-12T09:30:00.000Z",
    createdAt: "2026-01-12T09:30:00.000Z",
  },
};

/** A workspace whose guided onboarding is finished, so no tour or checklist opens. */
export const settledOnboardingSnapshotFixture: GuidedOnboardingSnapshot = {
  attemptId: "attempt-storybook-settled",
  context: {
    accountProvider: null,
    accountStatus: AccountStatus.Established,
    desktopAppDownloaded: true,
    githubConnected: true,
    membership: OrganizationMembership.FirstUser,
    organizationHasSyncedSessionData: KnownFlag.Yes,
    teamInvited: true,
    tourCompleted: true,
  },
  experienceVariant: WorkspaceExperience.V2,
  restoreOutcome: OnboardingRestoreOutcome.Restored,
  revision: 1,
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

/** A guided onboarding run sitting at `phase`, with the tour not yet done. */
export function guidedTourSnapshotFixture(
  phase: OnboardingPhase
): GuidedOnboardingSnapshot {
  return {
    ...settledOnboardingSnapshotFixture,
    attemptId: "attempt-storybook-tour",
    context: {
      ...settledOnboardingSnapshotFixture.context,
      tourCompleted: false,
    },
    state: serializeOnboardingState({
      accountProvider: null,
      history: [OnboardingPhase.DashboardAvailable],
      organizationEstablished: true,
      phase,
      resuming: false,
    }),
  };
}

export function sessionListResponse(items: AgentSessionListItem[]) {
  return {
    items,
    total: items.length,
    viewerScope: AgentSessionViewerScope.Self,
  };
}

/** The reads every authenticated page makes: the current user, GitHub, onboarding. */
export const liveAppShellRoutes: FixtureRoute[] = [
  { method: "GET", path: "/me", respond: () => currentUserFixture },
  {
    method: "GET",
    path: "/integrations/github",
    respond: () => githubConnectedFixture,
  },
  {
    method: "GET",
    path: "/onboarding/guided/snapshot",
    respond: () => settledOnboardingSnapshotFixture,
  },
];

function teammate(
  id: string,
  firstName: string,
  lastName: string,
  role: ApproverRole
): User {
  return {
    ...currentUserFixture,
    clerkId: id,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
    firstName,
    githubUsername: `${firstName.toLowerCase()}-${lastName.toLowerCase()}`,
    id,
    lastName,
    role,
  };
}

/** The workspace roster `GET /users` returns: the signed-in user and three teammates. */
export const organizationUsersFixture: User[] = [
  currentUserFixture,
  teammate("user_emma", "Emma", "Chen", ApproverRole.Pm),
  teammate("user_marcus", "Marcus", "Webb", ApproverRole.Engineer),
  teammate("user_priya", "Priya", "Nair", ApproverRole.Designer),
];

function team(
  id: string,
  name: string,
  memberCount: number,
  projectCount: number
): TeamWithCounts {
  return {
    createdAt: FIXTURE_CREATED_AT,
    id,
    memberCount,
    name,
    organizationId: "org_test",
    projectCount,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    updatedAt: FIXTURE_CREATED_AT,
  };
}

/** `GET /teams`: the teams the frame's "Your Teams" section lists. */
export const teamsFixture: TeamWithCounts[] = [
  team("team_demo", "ClosedLoop Demo", 4, 2),
  team("team_closedloop", "ClosedLoop", 12, 6),
  team("team_platform", "Platform Engineering", 7, 3),
];
