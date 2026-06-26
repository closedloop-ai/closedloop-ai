import { LoopCommand } from "@repo/api/src/types/loop";
import {
  RepoSource,
  useResolvedJobRepos,
} from "@repo/app/loops/hooks/use-resolved-job-repos";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hook collaborators are stubbed at module load. Each test reconfigures the
// stubs to drive a specific resolution-chain branch.
const mockUseProject = vi.fn();
const mockUseTeamRepositoriesUnion = vi.fn();
const mockUseInheritedAdditionalRepos = vi.fn();

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProject: (...args: unknown[]) => mockUseProject(...args),
}));

vi.mock("@repo/app/teams/hooks/use-team-repositories-union", () => ({
  useTeamRepositoriesUnion: (...args: unknown[]) =>
    mockUseTeamRepositoriesUnion(...args),
}));

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useInheritedAdditionalRepos: (...args: unknown[]) =>
    mockUseInheritedAdditionalRepos(...args),
}));

type PoolRepo = {
  installationRepositoryId: string;
  isDefaultSelected: boolean;
  isPrimary: boolean;
  fullName: string;
};

function makePool(rows: PoolRepo[]) {
  return rows.map((r) => ({
    id: `team-repo-${r.installationRepositoryId}`,
    teamId: "team-1",
    installationRepositoryId: r.installationRepositoryId,
    isDefaultSelected: r.isDefaultSelected,
    isPrimary: r.isPrimary,
    createdAt: new Date(),
    updatedAt: new Date(),
    repository: {
      id: r.installationRepositoryId,
      installationId: "install-1",
      githubRepoId: r.installationRepositoryId,
      name: r.fullName.split("/")[1] ?? "",
      owner: r.fullName.split("/")[0] ?? "",
      fullName: r.fullName,
      private: false,
    },
  }));
}

type Setup = {
  projectSettings?: Record<string, unknown>;
  teamCount?: number;
  pool?: ReturnType<typeof makePool>;
  inherited?: { additionalRepos: Array<{ fullName: string; branch: string }> };
};

function configure(setup: Setup) {
  const teamCount = setup.teamCount ?? 1;
  const teams = Array.from({ length: teamCount }, (_, i) => ({
    id: `team-${i + 1}`,
    name: `Team ${i + 1}`,
  }));
  mockUseProject.mockReturnValue({
    data: { teams, settings: setup.projectSettings ?? {} },
    isLoading: false,
  });
  mockUseTeamRepositoriesUnion.mockReturnValue({
    repositories: setup.pool ?? [],
    isLoading: false,
    error: null,
  });
  mockUseInheritedAdditionalRepos.mockReturnValue({
    data: setup.inherited
      ? {
          additionalRepos: setup.inherited.additionalRepos,
          source: { loopId: "loop-1", command: LoopCommand.Plan },
        }
      : { additionalRepos: [], source: null },
    isLoading: false,
  });
}

describe("useResolvedJobRepos (PLN-529)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null primary when the project has no resolution data", () => {
    configure({ pool: makePool([]) });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.primary).toBeNull();
    expect(result.current.additional).toEqual([]);
  });

  it("labels the primary as project-override when the project carries an override", () => {
    configure({
      projectSettings: {
        repositoryOverrides: {
          selectedRepoIds: ["r1"],
          primaryRepoId: "r1",
        },
      },
      pool: makePool([
        {
          installationRepositoryId: "r1",
          isDefaultSelected: false,
          isPrimary: false,
          fullName: "org/r1",
        },
      ]),
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.primary?.fullName).toBe("org/r1");
    expect(result.current.primary?.source).toBe(RepoSource.ProjectOverride);
  });

  it("labels the primary as team-default for a single-team project with team-marked primary", () => {
    configure({
      pool: makePool([
        {
          installationRepositoryId: "r1",
          isDefaultSelected: true,
          isPrimary: true,
          fullName: "org/r1",
        },
        {
          installationRepositoryId: "r2",
          isDefaultSelected: true,
          isPrimary: false,
          fullName: "org/r2",
        },
      ]),
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.primary?.fullName).toBe("org/r1");
    expect(result.current.primary?.source).toBe(RepoSource.TeamDefault);
    expect(result.current.additional).toEqual([
      expect.objectContaining({
        fullName: "org/r2",
        source: RepoSource.TeamDefault,
      }),
    ]);
  });

  it("uses the inherited prior-loop peers as additional with prior-loop label", () => {
    configure({
      pool: makePool([
        {
          installationRepositoryId: "r1",
          isDefaultSelected: true,
          isPrimary: true,
          fullName: "org/r1",
        },
        {
          installationRepositoryId: "r2",
          isDefaultSelected: false,
          isPrimary: false,
          fullName: "org/r2",
        },
      ]),
      inherited: {
        additionalRepos: [{ fullName: "org/r2", branch: "feature/x" }],
      },
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({
        projectId: "p1",
        artifactId: "doc-1",
        command: LoopCommand.Execute,
      })
    );
    expect(result.current.additional).toEqual([
      expect.objectContaining({
        fullName: "org/r2",
        source: RepoSource.PriorLoop,
        // PR #1134 review P1: prior-loop peer branches are preserved so the
        // follow-up run keeps the same branch the prior loop used instead of
        // falling back to the GitHub default.
        branch: "feature/x",
      }),
    ]);
  });

  it("returns null primary in the multi-team-no-override case", () => {
    configure({
      teamCount: 2,
      pool: makePool([
        {
          installationRepositoryId: "r1",
          isDefaultSelected: true,
          isPrimary: false,
          fullName: "org/r1",
        },
      ]),
    });
    const { result } = renderHook(() =>
      useResolvedJobRepos({ projectId: "p1" })
    );
    expect(result.current.primary).toBeNull();
  });
});
