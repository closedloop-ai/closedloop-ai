import type { JsonObject } from "@repo/api/src/types/common";
import type { RepositoryOverrides } from "@repo/api/src/types/project";
import type { TeamRepoWithTeamId } from "@repo/app/teams/hooks/use-team-repositories-union";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installPointerCaptureShims } from "@/__tests__/helpers/pointer-capture-shims";
import { RepoOverridePicker } from "../repo-override-picker";

installPointerCaptureShims();

const MULTI_TEAM_NOTICE_REGEX = /This project belongs to multiple teams\./;
const SINGULAR_EMPTY_POOL_REGEX =
  /No repositories curated on this project's team\./;
const PLURAL_EMPTY_POOL_REGEX =
  /No repositories curated on this project's teams\./;

const mockUseTeamRepositoriesUnion = vi.fn();
const mockMutate = vi.fn();

vi.mock("@repo/app/teams/hooks/use-team-repositories-union", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/teams/hooks/use-team-repositories-union")
  >("@repo/app/teams/hooks/use-team-repositories-union");
  return {
    ...actual,
    useTeamRepositoriesUnion: (...args: unknown[]) =>
      mockUseTeamRepositoriesUnion(...args),
  };
});

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useUpdateProject: () => ({ mutate: mockMutate }),
}));

function teamRepo(
  overrides: Partial<TeamRepoWithTeamId> = {}
): TeamRepoWithTeamId {
  return {
    id: "team-repo-1",
    teamId: "team-1",
    installationRepositoryId: "install-repo-1",
    isDefaultSelected: false,
    isPrimary: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    repository: {
      id: "install-repo-1",
      installationId: "installation-1",
      githubRepoId: "1",
      fullName: "closedloop-ai/closedloop-ai",
      name: "closedloop-ai",
      owner: "closedloop-ai",
      private: true,
    },
    ...overrides,
  };
}

function setUnion(
  repositories: TeamRepoWithTeamId[],
  isLoading = false,
  error: string | null = null
) {
  mockUseTeamRepositoriesUnion.mockReturnValue({
    repositories,
    isLoading,
    error,
  });
}

const ONE_TEAM = [{ id: "team-1", name: "Team One" }];
const TWO_TEAMS = [
  { id: "team-1", name: "Team One" },
  { id: "team-2", name: "Team Two" },
];

function renderPicker(
  overrides: Partial<{
    projectId: string;
    teams: { id: string; name: string }[];
    currentSettings: JsonObject;
    currentOverride: RepositoryOverrides | undefined;
    enabled: boolean;
  }> = {}
) {
  return render(
    <RepoOverridePicker
      currentOverride={overrides.currentOverride}
      currentSettings={overrides.currentSettings ?? {}}
      enabled={overrides.enabled}
      projectId={overrides.projectId ?? "project-1"}
      teams={overrides.teams ?? ONE_TEAM}
    />
  );
}

describe("RepoOverridePicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading indicator while the team-repository union is loading", () => {
    setUnion([], true);

    renderPicker();

    expect(
      screen.getByText("Loading team repositories...")
    ).toBeInTheDocument();
  });

  it("shows an error alert when the union read fails", () => {
    setUnion([], false, "We couldn't load this team's repositories.");

    renderPicker();

    expect(
      screen.getByText("We couldn't load this team's repositories.")
    ).toBeInTheDocument();
  });

  it("shows a singular empty-pool message for a single team", () => {
    setUnion([]);

    renderPicker({ teams: ONE_TEAM });

    expect(screen.getByText(SINGULAR_EMPTY_POOL_REGEX)).toBeInTheDocument();
  });

  it("shows a plural empty-pool message for multiple teams", () => {
    setUnion([]);

    renderPicker({ teams: TWO_TEAMS });

    expect(screen.getByText(PLURAL_EMPTY_POOL_REGEX)).toBeInTheDocument();
  });

  it("shows the multi-team notice when there are multiple teams and no override yet", () => {
    setUnion([teamRepo()]);

    renderPicker({ teams: TWO_TEAMS, currentOverride: undefined });

    expect(screen.getByText(MULTI_TEAM_NOTICE_REGEX)).toBeInTheDocument();
  });

  it("hides the multi-team notice once a project override already exists", () => {
    setUnion([teamRepo({ isPrimary: true, isDefaultSelected: true })]);

    renderPicker({
      teams: TWO_TEAMS,
      currentOverride: {
        selectedRepoIds: ["install-repo-1"],
        primaryRepoId: "install-repo-1",
      },
    });

    expect(screen.queryByText(MULTI_TEAM_NOTICE_REGEX)).not.toBeInTheDocument();
  });

  it("hides the multi-team notice for a single team", () => {
    setUnion([teamRepo()]);

    renderPicker({ teams: ONE_TEAM, currentOverride: undefined });

    expect(screen.queryByText(MULTI_TEAM_NOTICE_REGEX)).not.toBeInTheDocument();
  });

  it("seeds the checkbox and radio from the single-team inherited default", () => {
    setUnion([teamRepo({ isPrimary: true, isDefaultSelected: true })]);

    renderPicker({ teams: ONE_TEAM, currentOverride: undefined });

    expect(
      screen.getByRole("checkbox", {
        name: "Default-select closedloop-ai/closedloop-ai",
      })
    ).toBeChecked();
    expect(
      screen.getByRole("radio", {
        name: "Set closedloop-ai/closedloop-ai as primary",
      })
    ).toBeChecked();
  });

  it("enables Save to persist an inherited default that has no project override yet", () => {
    setUnion([teamRepo({ isPrimary: true, isDefaultSelected: true })]);

    renderPicker({ teams: ONE_TEAM, currentOverride: undefined });

    expect(screen.getByRole("button", { name: "Save defaults" })).toBeEnabled();
  });

  it("disables Save when the current selection already matches the persisted override", () => {
    setUnion([teamRepo({ isPrimary: true, isDefaultSelected: true })]);

    renderPicker({
      teams: ONE_TEAM,
      currentOverride: {
        selectedRepoIds: ["install-repo-1"],
        primaryRepoId: "install-repo-1",
      },
    });

    expect(
      screen.getByRole("button", { name: "Save defaults" })
    ).toBeDisabled();
  });

  // Pins current behavior, and it looks wrong: with only one repo selected,
  // unchecking it empties selectedIds and clears primaryId, which trips
  // canSave's `selectedIds.size > 0` and `primaryId.length > 0` guards — not
  // the `overrideMatchesResolved` dirty check, which never even gets
  // evaluated here. The result is that once a project has a persisted
  // override, there is no way through this UI to clear it back to
  // team-resolved defaults: handleSave only ever writes a full
  // `{ selectedRepoIds, primaryRepoId }` object, and RepositoryOverrides
  // (packages/api/src/types/project.ts) has no representation for "no
  // override" to write instead. The comment on handleToggle ("the user must
  // pick another to save") only states the narrower rule that a new primary
  // must be chosen — it does not mention that clearing down to zero disables
  // Save permanently.
  it("disables Save with no way back to team-resolved defaults once the only selected repo is unchecked", () => {
    setUnion([teamRepo({ isPrimary: true, isDefaultSelected: true })]);

    renderPicker({
      teams: ONE_TEAM,
      currentOverride: {
        selectedRepoIds: ["install-repo-1"],
        primaryRepoId: "install-repo-1",
      },
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Default-select closedloop-ai/closedloop-ai",
      })
    );

    expect(
      screen.getByRole("radio", {
        name: "Set closedloop-ai/closedloop-ai as primary",
      })
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Save defaults" })
    ).toBeDisabled();
  });

  it("selecting a repo as primary auto-checks its default-selected checkbox", () => {
    setUnion([
      teamRepo({
        id: "team-repo-1",
        installationRepositoryId: "install-repo-1",
        repository: {
          id: "install-repo-1",
          installationId: "installation-1",
          githubRepoId: "1",
          fullName: "closedloop-ai/repo-a",
          name: "repo-a",
          owner: "closedloop-ai",
          private: true,
        },
      }),
    ]);

    renderPicker({ teams: ONE_TEAM, currentOverride: undefined });

    fireEvent.click(
      screen.getByRole("radio", { name: "Set closedloop-ai/repo-a as primary" })
    );

    expect(
      screen.getByRole("checkbox", {
        name: "Default-select closedloop-ai/repo-a",
      })
    ).toBeChecked();
  });

  it("clicking Save merges the new override into the current settings and mutates the project", () => {
    setUnion([teamRepo({ isPrimary: true, isDefaultSelected: true })]);

    renderPicker({
      teams: ONE_TEAM,
      currentOverride: undefined,
      currentSettings: { someOtherKey: "keep-me" },
      projectId: "project-42",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    expect(mockMutate).toHaveBeenCalledWith({
      id: "project-42",
      settings: {
        someOtherKey: "keep-me",
        repositoryOverrides: {
          selectedRepoIds: ["install-repo-1"],
          primaryRepoId: "install-repo-1",
        },
      },
    });
  });

  it("passes the enabled flag through to the team-repository union fetch", () => {
    setUnion([]);

    renderPicker({ teams: ONE_TEAM, enabled: false });

    expect(mockUseTeamRepositoriesUnion).toHaveBeenCalledWith({
      teamIds: ["team-1"],
      enabled: false,
    });
  });
});
