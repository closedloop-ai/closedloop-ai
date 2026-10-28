import {
  RepoSource,
  type UseResolvedJobReposResult,
} from "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos";
import { JobRepositoriesSection } from "@repo/app/documents/editors/shared/job-repositories-section";
import { TEAM_REPOSITORIES_LOAD_FAILURE } from "@repo/app/teams/hooks/use-team-repositories-union";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `JobRepositoriesSection` resolves default branches via `useDefaultBranches`
// (TanStack `useQueries`). Stub it with a deterministic in-memory map so the
// component-under-test does not need a QueryClientProvider.
const branchMap: Record<string, string> = {
  "repo-a": "main",
  "repo-b": "develop",
  "repo-c": "trunk",
};

// Full branch list per repo so the per-row override Select has options
// (mirrors what `useDefaultBranches` now returns alongside the default).
const branchesMap: Record<
  string,
  Array<{ name: string; isDefault: boolean }>
> = {
  "repo-a": [
    { name: "main", isDefault: true },
    { name: "develop", isDefault: false },
    { name: "feature/x", isDefault: false },
  ],
  "repo-b": [
    { name: "develop", isDefault: true },
    { name: "main", isDefault: false },
  ],
  "repo-c": [
    { name: "trunk", isDefault: true },
    { name: "release/2024", isDefault: false },
  ],
};

vi.mock("@repo/app/github/hooks/use-default-branches", () => ({
  useDefaultBranches: ({ repoIds }: { repoIds: string[] }) => ({
    branchByRepoId: Object.fromEntries(
      repoIds.filter((id) => branchMap[id]).map((id) => [id, branchMap[id]])
    ),
    branchesByRepoId: Object.fromEntries(
      repoIds.filter((id) => branchesMap[id]).map((id) => [id, branchesMap[id]])
    ),
    isLoading: false,
  }),
}));

const REPOS_HEADER_REGEX = /repositories/i;
const LOADING_REPOS_REGEX = /loading repositories/i;
const NO_REPOS_REGEX = /no repositories curated/i;
const PROJECT_OVERRIDE_REGEX = /project override/i;
const INCLUDE_REPO_A_REGEX = /include org\/repo-a/i;
const LAST_REPO_REGEX = /at least one repository must remain/i;
const BRANCH_FOR_REPO_A_REGEX = /Branch for org\/repo-a/i;
const BRANCH_FOR_REPO_B_REGEX = /Branch for org\/repo-b/i;
const BRANCH_OPTION_FEATURE_X_REGEX = /feature\/x/i;
const BRANCH_OPTION_MAIN_REGEX = /^main/i;

function makeRepo(id: string, fullName: string) {
  return {
    id: `team-repo-${id}`,
    teamId: "team-1",
    installationRepositoryId: id,
    isDefaultSelected: false,
    isPrimary: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    repository: {
      id,
      installationId: "install-1",
      githubRepoId: id,
      name: fullName.split("/")[1] ?? "",
      owner: fullName.split("/")[0] ?? "",
      fullName,
      private: false,
    },
  };
}

function buildResolved(
  overrides: Partial<UseResolvedJobReposResult>
): UseResolvedJobReposResult {
  return {
    primary: null,
    additional: [],
    pool: [],
    isLoading: false,
    poolError: null,
    ...overrides,
  };
}

describe("JobRepositoriesSection (PLN-529)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the loading state until the resolver is ready", () => {
    render(
      <JobRepositoriesSection
        onChange={vi.fn()}
        resolved={buildResolved({ isLoading: true })}
      />
    );
    expect(screen.getByText(LOADING_REPOS_REGEX)).toBeInTheDocument();
  });

  it("renders an empty-pool message when no team repos are curated", () => {
    render(
      <JobRepositoriesSection
        onChange={vi.fn()}
        resolved={buildResolved({ pool: [] })}
      />
    );
    expect(screen.getByText(NO_REPOS_REGEX)).toBeInTheDocument();
  });

  // ISS-5095: a failed read also arrives as an empty pool, so without this
  // branch the section states the team curated nothing and sends the user to a
  // settings page — a claim it has no evidence for.
  it("renders the load failure instead of the empty-pool claim when the read failed", () => {
    render(
      <JobRepositoriesSection
        onChange={vi.fn()}
        resolved={buildResolved({
          pool: [],
          poolError: TEAM_REPOSITORIES_LOAD_FAILURE,
        })}
      />
    );
    expect(
      screen.getByText(TEAM_REPOSITORIES_LOAD_FAILURE)
    ).toBeInTheDocument();
    expect(screen.queryByText(NO_REPOS_REGEX)).not.toBeInTheDocument();
  });

  it("emits the seeded selection on first paint with a complete resolver payload", async () => {
    const onChange = vi.fn();
    const repoA = makeRepo("repo-a", "org/repo-a");
    const repoB = makeRepo("repo-b", "org/repo-b");
    render(
      <JobRepositoriesSection
        onChange={onChange}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.ProjectOverride,
          },
          additional: [
            {
              id: "repo-b",
              fullName: "org/repo-b",
              source: RepoSource.TeamDefault,
            },
          ],
          pool: [repoA, repoB],
        })}
      />
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          primary: { id: "repo-a", fullName: "org/repo-a", branch: "main" },
          additional: [{ fullName: "org/repo-b", branch: "develop" }],
        })
      );
    });
  });

  it("renders the source label for each selected row", () => {
    const repoA = makeRepo("repo-a", "org/repo-a");
    render(
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        onChange={vi.fn()}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.ProjectOverride,
          },
          pool: [repoA],
        })}
      />
    );
    expect(screen.getByText(PROJECT_OVERRIDE_REGEX)).toBeInTheDocument();
  });

  it("blocks the user from deselecting the last selected repo", async () => {
    const onChange = vi.fn();
    const repoA = makeRepo("repo-a", "org/repo-a");
    render(
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        onChange={onChange}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.TeamDefault,
          },
          pool: [repoA],
        })}
      />
    );
    const checkbox = screen.getByLabelText(INCLUDE_REPO_A_REGEX);
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(checkbox).toBeChecked();
    });
    expect(screen.getByText(LAST_REPO_REGEX)).toBeInTheDocument();
  });

  it("auto-promotes the next selected repo when the primary is removed", async () => {
    const onChange = vi.fn();
    const repoA = makeRepo("repo-a", "org/repo-a");
    const repoB = makeRepo("repo-b", "org/repo-b");
    render(
      <JobRepositoriesSection
        onChange={onChange}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.TeamDefault,
          },
          additional: [
            {
              id: "repo-b",
              fullName: "org/repo-b",
              source: RepoSource.TeamDefault,
            },
          ],
          pool: [repoA, repoB],
        })}
      />
    );
    fireEvent.click(screen.getByLabelText(INCLUDE_REPO_A_REGEX));
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          primary: { id: "repo-b", fullName: "org/repo-b", branch: "develop" },
          additional: [],
        })
      );
    });
  });

  it("renders the collapsible header", () => {
    const repoA = makeRepo("repo-a", "org/repo-a");
    render(
      <JobRepositoriesSection
        onChange={vi.fn()}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.TeamDefault,
          },
          pool: [repoA],
        })}
      />
    );
    expect(
      screen.getByRole("button", { name: REPOS_HEADER_REGEX })
    ).toBeInTheDocument();
  });

  it("emits the user-picked branch override for the primary", async () => {
    const onChange = vi.fn();
    const repoA = makeRepo("repo-a", "org/repo-a");
    render(
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        onChange={onChange}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.TeamDefault,
          },
          pool: [repoA],
        })}
      />
    );
    // Initial emission uses the default branch.
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          primary: { id: "repo-a", fullName: "org/repo-a", branch: "main" },
        })
      );
    });
    // User overrides the branch on the primary row.
    fireEvent.click(screen.getByLabelText(BRANCH_FOR_REPO_A_REGEX));
    fireEvent.click(
      screen.getByRole("option", { name: BRANCH_OPTION_FEATURE_X_REGEX })
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            branch: "feature/x",
          },
        })
      );
    });
  });

  it("emits the user-picked branch override for an additional repo", async () => {
    const onChange = vi.fn();
    const repoA = makeRepo("repo-a", "org/repo-a");
    const repoB = makeRepo("repo-b", "org/repo-b");
    render(
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        onChange={onChange}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.TeamDefault,
          },
          additional: [
            {
              id: "repo-b",
              fullName: "org/repo-b",
              source: RepoSource.TeamDefault,
            },
          ],
          pool: [repoA, repoB],
        })}
      />
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          additional: [{ fullName: "org/repo-b", branch: "develop" }],
        })
      );
    });
    fireEvent.click(screen.getByLabelText(BRANCH_FOR_REPO_B_REGEX));
    fireEvent.click(
      screen.getByRole("option", { name: BRANCH_OPTION_MAIN_REGEX })
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          additional: [{ fullName: "org/repo-b", branch: "main" }],
        })
      );
    });
  });
});
