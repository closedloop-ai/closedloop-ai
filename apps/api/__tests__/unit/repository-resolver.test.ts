/**
 * Unit tests for `loadProjectRepoDefaults` — the apps/api
 * composition that pairs the pure resolver in `@repo/api/src/types/project`
 * with `teamsService.getRepositoriesByProject` to produce a primary repo's
 * installation id + fullName for downstream callers.
 */

import type { TeamRepository } from "@repo/api/src/types/teams";
import { vi } from "vitest";

const { getRepositoriesByProject, countTeamsForProject } = vi.hoisted(() => ({
  getRepositoriesByProject: vi.fn(),
  countTeamsForProject: vi.fn(),
}));

vi.mock("@/app/teams/service", () => ({
  teamsService: { getRepositoriesByProject, countTeamsForProject },
}));

import { loadProjectRepoDefaults } from "@/app/projects/repository-resolver";

function teamRepoRow(
  installationRepositoryId: string,
  fullName: string,
  flags: {
    teamId?: string;
    isPrimary?: boolean;
    isDefaultSelected?: boolean;
  } = {}
): TeamRepository {
  return {
    id: `tr-${installationRepositoryId}`,
    teamId: flags.teamId ?? "team-1",
    installationRepositoryId,
    isDefaultSelected: flags.isDefaultSelected ?? false,
    isPrimary: flags.isPrimary ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
    repository: {
      id: installationRepositoryId,
      installationId: "inst-1",
      githubRepoId: `gh-${installationRepositoryId}`,
      fullName,
      name: fullName.split("/")[1] ?? fullName,
      owner: fullName.split("/")[0] ?? "owner",
      private: false,
    },
  };
}

describe("loadProjectRepoDefaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the primary's fullName when the override resolves into the team pool", async () => {
    getRepositoriesByProject.mockResolvedValueOnce([
      teamRepoRow("repo-a", "acme/a", {
        isPrimary: true,
        isDefaultSelected: true,
      }),
      teamRepoRow("repo-b", "acme/b", { isDefaultSelected: true }),
    ]);
    countTeamsForProject.mockResolvedValueOnce(1);

    const result = await loadProjectRepoDefaults({
      projectId: "proj-1",
      organizationId: "org-1",
      projectSettings: {
        repositoryOverrides: {
          selectedRepoIds: ["repo-a", "repo-b"],
          primaryRepoId: "repo-a",
        },
      },
    });

    expect(result).toEqual({
      override: {
        selectedRepoIds: ["repo-a", "repo-b"],
        primaryRepoId: "repo-a",
      },
      primary: { installationRepositoryId: "repo-a", fullName: "acme/a" },
    });
  });

  it("inherits a single team's defaults when no override is set", async () => {
    getRepositoriesByProject.mockResolvedValueOnce([
      teamRepoRow("repo-a", "acme/a", {
        isPrimary: true,
        isDefaultSelected: true,
      }),
      teamRepoRow("repo-b", "acme/b"),
    ]);
    countTeamsForProject.mockResolvedValueOnce(1);

    const result = await loadProjectRepoDefaults({
      projectId: "proj-1",
      organizationId: "org-1",
      projectSettings: {},
    });

    expect(result?.override.primaryRepoId).toBe("repo-a");
    expect(result?.primary).toEqual({
      installationRepositoryId: "repo-a",
      fullName: "acme/a",
    });
  });

  it("returns null for a multi-team project with no override and no legacy", async () => {
    getRepositoriesByProject.mockResolvedValueOnce([
      teamRepoRow("repo-a", "acme/a", { teamId: "team-1", isPrimary: true }),
      teamRepoRow("repo-b", "acme/b", { teamId: "team-2", isPrimary: true }),
    ]);
    countTeamsForProject.mockResolvedValueOnce(2);

    const result = await loadProjectRepoDefaults({
      projectId: "proj-1",
      organizationId: "org-1",
      projectSettings: {},
    });

    expect(result).toBeNull();
  });

  it("returns null when only one of several teams has curated repos", async () => {
    // Project belongs to team-1 (one repo) and team-2 (no repos). The repo
    // query returns only team-1's row, so deriving teamCount from that set
    // would be 1. countTeamsForProject still reports 2, forcing the user to
    // pick at job launch (per AC-005).
    getRepositoriesByProject.mockResolvedValueOnce([
      teamRepoRow("repo-a", "acme/a", {
        teamId: "team-1",
        isPrimary: true,
        isDefaultSelected: true,
      }),
    ]);
    countTeamsForProject.mockResolvedValueOnce(2);

    const result = await loadProjectRepoDefaults({
      projectId: "proj-1",
      organizationId: "org-1",
      projectSettings: {},
    });

    expect(result).toBeNull();
  });

  it("falls back to legacy fullName when primary is outside the team pool", async () => {
    getRepositoriesByProject.mockResolvedValueOnce([]);
    countTeamsForProject.mockResolvedValueOnce(0);

    const result = await loadProjectRepoDefaults({
      projectId: "proj-1",
      organizationId: "org-1",
      projectSettings: {
        defaultRepository: {
          repoId: "legacy",
          repoFullName: "acme/legacy",
          branch: "main",
        },
      },
    });

    expect(result).toEqual({
      override: { selectedRepoIds: ["legacy"], primaryRepoId: "legacy" },
      primary: {
        installationRepositoryId: "legacy",
        fullName: "acme/legacy",
      },
    });
  });
});
