import type { GitHubRepository } from "@repo/api/src/types/github";
import {
  type TeamMember,
  type TeamRepository,
  TeamRole,
  type TeamWithCounts,
} from "@repo/api/src/types/teams";
import {
  ApproverRole,
  type BasicUser,
  type User,
} from "@repo/api/src/types/user";
import { type Mock, vi } from "vitest";
import type { useTeamModal } from "../../use-team-modal";

// Shared harness for the useTeamModal suites. The `vi.mock` calls themselves
// stay in each test file — Vitest hoists those above imports, so they cannot
// be centralised — but everything downstream of them (the mock instances,
// mutation stand-ins, fixtures, and the baseline mock returns) lives here so
// the suites cannot drift apart.

// Hook mocks

export const mockUseCurrentUser: Mock = vi.fn();
export const mockUseOrganizationUsers: Mock = vi.fn();
export const mockUseTeamMembers: Mock = vi.fn();
export const mockUseTeamRepositories: Mock = vi.fn();
export const mockNavigate: Mock = vi.fn();

type SimpleMutation = { mutate: Mock; isPending: boolean };
type AsyncMutation = { mutateAsync: Mock; isPending: boolean };
type HybridMutation = { mutate: Mock; mutateAsync: Mock; isPending: boolean };

export const createTeamMutation: SimpleMutation = {
  mutate: vi.fn(),
  isPending: false,
};
export const updateTeamMutation: SimpleMutation = {
  mutate: vi.fn(),
  isPending: false,
};
export const deleteTeamMutation: SimpleMutation = {
  mutate: vi.fn(),
  isPending: false,
};
export const addMemberMutation: HybridMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  isPending: false,
};
export const removeMemberMutation: AsyncMutation = {
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  isPending: false,
};
export const updateRoleMutation: AsyncMutation = {
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  isPending: false,
};
export const addRepoMutation: AsyncMutation = {
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  isPending: false,
};
export const updateRepoMutation: AsyncMutation = {
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  isPending: false,
};
export const removeRepoMutation: AsyncMutation = {
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  isPending: false,
};

/**
 * Resets every mock hook and mutation stand-in to its baseline state. Mutation
 * `mutate`/`mutateAsync` fields get brand-new `vi.fn()`s (not just cleared) so a
 * `mockRejectedValueOnce`/`mockImplementation` staged by one test can never
 * leak into the next.
 */
export function resetTeamModalMocks() {
  vi.clearAllMocks();

  createTeamMutation.mutate = vi.fn();
  createTeamMutation.isPending = false;
  updateTeamMutation.mutate = vi.fn();
  updateTeamMutation.isPending = false;
  deleteTeamMutation.mutate = vi.fn();
  deleteTeamMutation.isPending = false;
  addMemberMutation.mutate = vi.fn();
  addMemberMutation.mutateAsync = vi.fn().mockResolvedValue(undefined);
  addMemberMutation.isPending = false;
  removeMemberMutation.mutateAsync = vi.fn().mockResolvedValue(undefined);
  removeMemberMutation.isPending = false;
  updateRoleMutation.mutateAsync = vi.fn().mockResolvedValue(undefined);
  updateRoleMutation.isPending = false;
  addRepoMutation.mutateAsync = vi.fn().mockResolvedValue(undefined);
  addRepoMutation.isPending = false;
  updateRepoMutation.mutateAsync = vi.fn().mockResolvedValue(undefined);
  updateRepoMutation.isPending = false;
  removeRepoMutation.mutateAsync = vi.fn().mockResolvedValue(undefined);
  removeRepoMutation.isPending = false;

  mockUseCurrentUser.mockReturnValue({ data: undefined, isPending: true });
  mockUseOrganizationUsers.mockReturnValue({ data: [], isLoading: false });
  // `isLoadingError` is read by useTeamModal's hydration guards, so the baseline
  // states it rather than leaning on a destructuring default — a harness that
  // omits a field the hook reads cannot exercise the branch that reads it.
  mockUseTeamMembers.mockReturnValue({
    data: [],
    isLoading: false,
    isLoadingError: false,
  });
  mockUseTeamRepositories.mockReturnValue({
    data: [],
    isLoadingError: false,
    isPending: false,
  });
}

// Fixtures

export function basicUser(
  id: string,
  firstName: string,
  lastName: string
): BasicUser {
  return {
    id,
    email: `${id}@example.com`,
    firstName,
    lastName,
    avatarUrl: null,
  };
}

export function fullUser(
  id: string,
  firstName: string,
  lastName: string
): User {
  return {
    id,
    clerkId: `clerk_${id}`,
    organizationId: "org-1",
    email: `${id}@example.com`,
    firstName,
    lastName,
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };
}

export const CURRENT_USER = fullUser("user-owner", "Ada", "Owner");
export const ORG_USER_B = fullUser("user-b", "Bob", "Builder");

export const TEAM: TeamWithCounts = {
  id: "team-1",
  organizationId: "org-1",
  name: "Engineering",
  slug: "engineering",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  memberCount: 2,
  projectCount: 1,
};

export const MEMBER_OWNER: TeamMember = {
  id: "member-owner",
  teamId: TEAM.id,
  userId: "user-owner",
  role: TeamRole.Owner,
  createdAt: new Date("2024-01-01"),
  user: basicUser("user-owner", "Ada", "Owner"),
};

export const MEMBER_PLAIN: TeamMember = {
  id: "member-plain",
  teamId: TEAM.id,
  userId: "user-plain",
  role: TeamRole.Member,
  createdAt: new Date("2024-01-01"),
  user: basicUser("user-plain", "Plain", "Person"),
};

export const REPO_A: TeamRepository = {
  id: "repo-a",
  teamId: TEAM.id,
  installationRepositoryId: "install-repo-a",
  isDefaultSelected: true,
  isPrimary: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  repository: {
    id: "install-repo-a",
    installationId: "install-1",
    githubRepoId: "gh-a",
    fullName: "acme/repo-a",
    name: "repo-a",
    owner: "acme",
    private: false,
  },
};

export const GITHUB_REPO_B: GitHubRepository = {
  id: "install-repo-b",
  fullName: "acme/repo-b",
  name: "repo-b",
  owner: "acme",
  private: true,
  githubRepoId: "gh-b",
  lastPushedAt: null,
};

export function fakeSubmitEvent() {
  return {
    preventDefault: vi.fn(),
  } as unknown as Parameters<
    ReturnType<typeof useTeamModal>["handleSubmit"]
  >[0];
}
