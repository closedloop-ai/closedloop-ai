import {
  RepoSource,
  type UseResolvedJobReposResult,
} from "@repo/app/loops/hooks/use-resolved-job-repos";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobRepositoriesSection } from "@/app/(authenticated)/components/job-repositories-section";

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
const FROM_PREVIOUS_JOB_REGEX = /from previous job/i;
const INCLUDE_REPO_A_REGEX = /include org\/repo-a/i;
const INCLUDE_REPO_B_REGEX = /include org\/repo-b/i;
const LAST_REPO_REGEX = /at least one repository must remain/i;
const ORG_OUT_REGEX = /org\/out/;
const PRIMARY_REPO_A_REGEX = /Set org\/repo-a as primary/;
const PRIMARY_REPO_B_REGEX = /Set org\/repo-b as primary/;
const BRANCH_FOR_REPO_A_REGEX = /Branch for org\/repo-a/i;
const BRANCH_FOR_REPO_B_REGEX = /Branch for org\/repo-b/i;
const BRANCH_FOR_REPO_C_REGEX = /Branch for org\/repo-c/i;
const BRANCH_OPTION_FEATURE_X_REGEX = /feature\/x/i;
const BRANCH_OPTION_MAIN_REGEX = /^main/i;
const BRANCH_OPTION_RELEASE_2024_REGEX = /release\/2024/i;

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
            inPool: true,
          },
          additional: [
            {
              id: "repo-b",
              fullName: "org/repo-b",
              source: RepoSource.TeamDefault,
              inPool: true,
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
            source: RepoSource.PriorLoop,
            inPool: true,
          },
          pool: [repoA],
        })}
      />
    );
    expect(screen.getByText(FROM_PREVIOUS_JOB_REGEX)).toBeInTheDocument();
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
            inPool: true,
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
            inPool: true,
          },
          additional: [
            {
              id: "repo-b",
              fullName: "org/repo-b",
              source: RepoSource.TeamDefault,
              inPool: true,
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
            inPool: true,
          },
          pool: [repoA],
        })}
      />
    );
    expect(
      screen.getByRole("button", { name: REPOS_HEADER_REGEX })
    ).toBeInTheDocument();
  });

  it("drops a non-pool seed primary and surfaces a banner (review P1)", async () => {
    const onChange = vi.fn();
    const repoA = makeRepo("repo-a", "org/repo-a");
    render(
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        onChange={onChange}
        resolved={buildResolved({
          primary: {
            id: "out-1",
            fullName: "org/out",
            source: RepoSource.ProjectOverride,
            inPool: false,
          },
          pool: [repoA],
        })}
      />
    );
    // Banner names the dropped seed primary.
    expect(screen.getByText(ORG_OUT_REGEX)).toBeInTheDocument();
    // No emitted selection while the user hasn't picked a primary from the
    // actual pool (incomplete signal active).
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(null);
    });
  });

  it("preserves prior-loop peer branch in the emitted selection (review P1)", async () => {
    const onChange = vi.fn();
    const repoA = makeRepo("repo-a", "org/repo-a");
    const repoC = makeRepo("repo-c", "org/repo-c");
    render(
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        onChange={onChange}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.TeamDefault,
            inPool: true,
          },
          additional: [
            {
              id: "repo-c",
              fullName: "org/repo-c",
              source: RepoSource.PriorLoop,
              inPool: true,
              branch: "feature/keep-me",
            },
          ],
          pool: [repoA, repoC],
        })}
      />
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          additional: [{ fullName: "org/repo-c", branch: "feature/keep-me" }],
        })
      );
    });
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
            inPool: true,
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
            inPool: true,
          },
          additional: [
            {
              id: "repo-b",
              fullName: "org/repo-b",
              source: RepoSource.TeamDefault,
              inPool: true,
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

  it("overrides a seeded prior-loop branch with the user-picked value", async () => {
    const onChange = vi.fn();
    const repoA = makeRepo("repo-a", "org/repo-a");
    const repoC = makeRepo("repo-c", "org/repo-c");
    render(
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        onChange={onChange}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.TeamDefault,
            inPool: true,
          },
          additional: [
            {
              id: "repo-c",
              fullName: "org/repo-c",
              source: RepoSource.PriorLoop,
              inPool: true,
              branch: "feature/keep-me",
            },
          ],
          pool: [repoA, repoC],
        })}
      />
    );
    // Initial emission honors the seeded prior-loop branch.
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          additional: [{ fullName: "org/repo-c", branch: "feature/keep-me" }],
        })
      );
    });
    // User picks a different branch — override wins over the seed.
    fireEvent.click(screen.getByLabelText(BRANCH_FOR_REPO_C_REGEX));
    fireEvent.click(
      screen.getByRole("option", { name: BRANCH_OPTION_RELEASE_2024_REGEX })
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          additional: [{ fullName: "org/repo-c", branch: "release/2024" }],
        })
      );
    });
  });

  it("disables primary radio + primary checkbox when lockPrimary is set (review P2)", () => {
    const repoA = makeRepo("repo-a", "org/repo-a");
    const repoB = makeRepo("repo-b", "org/repo-b");
    render(
      <JobRepositoriesSection
        collapseWhenSingleRepo={false}
        lockPrimary
        onChange={vi.fn()}
        resolved={buildResolved({
          primary: {
            id: "repo-a",
            fullName: "org/repo-a",
            source: RepoSource.TeamDefault,
            inPool: true,
          },
          pool: [repoA, repoB],
        })}
      />
    );
    // Both repos' primary radios are disabled — user can't promote repo-b.
    expect(screen.getByLabelText(PRIMARY_REPO_A_REGEX)).toBeDisabled();
    expect(screen.getByLabelText(PRIMARY_REPO_B_REGEX)).toBeDisabled();
    // The current primary's Include checkbox is also disabled so the user
    // can't trigger auto-promotion by deselecting it.
    expect(screen.getByLabelText(INCLUDE_REPO_A_REGEX)).toBeDisabled();
    // Other rows' Include checkboxes remain interactive.
    expect(screen.getByLabelText(INCLUDE_REPO_B_REGEX)).not.toBeDisabled();
  });
});
