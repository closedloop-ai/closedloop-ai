import {
  type GitHubRepository,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { TEAM_REPOSITORIES_LOAD_FAILURE } from "@repo/app/teams/hooks/use-team-repositories-union";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installPointerCaptureShims } from "@/__tests__/helpers/pointer-capture-shims";
import {
  NO_CONFIGURED_REPOSITORIES_COPY,
  TeamRepositoriesSection,
} from "../team-repositories-section";
import type { TeamModalState, TeamRepositoryDraft } from "../use-team-modal";

installPointerCaptureShims();

const ADD_ONE_ABOVE_REGEX = /Add one above\./;

const mockUseGitHubRepositories = vi.fn();

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubRepositories: (...args: unknown[]) =>
    mockUseGitHubRepositories(...args),
}));

function githubRepo(
  overrides: Partial<GitHubRepository> = {}
): GitHubRepository {
  return {
    id: "install-repo-1",
    fullName: "closedloop-ai/closedloop-ai",
    name: "closedloop-ai",
    owner: "closedloop-ai",
    private: true,
    githubRepoId: "1",
    lastPushedAt: null,
    source: GitHubRepositorySource.Installation,
    ...overrides,
  };
}

function draft(
  overrides: Partial<TeamRepositoryDraft> = {}
): TeamRepositoryDraft {
  return {
    draftId: "draft-1",
    teamRepositoryId: "team-repo-1",
    installationRepositoryId: "install-repo-1",
    isDefaultSelected: false,
    isPrimary: false,
    repository: {
      id: "install-repo-1",
      githubRepoId: "1",
      fullName: "closedloop-ai/closedloop-ai",
      name: "closedloop-ai",
      owner: "closedloop-ai",
      private: true,
    },
    ...overrides,
  };
}

function makeState(overrides: Partial<TeamModalState> = {}): TeamModalState {
  const base = {
    configuredReposUnavailable: false,
    isCurrentUserTeamAdmin: true,
    loadingConfiguredRepos: false,
    repoDrafts: [] as TeamRepositoryDraft[] | null,
    stageAddRepo: vi.fn(),
    stageRemoveRepo: vi.fn(),
    stageSetPrimary: vi.fn(),
    stageToggleDefault: vi.fn(),
    ...overrides,
  };
  return base as unknown as TeamModalState;
}

function renderSection(state: TeamModalState, enabled = true) {
  return render(<TeamRepositoriesSection enabled={enabled} state={state} />);
}

describe("TeamRepositoriesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGitHubRepositories.mockReturnValue({ data: [], isLoading: false });
  });

  it("shows the repository picker and Add control for a team admin", () => {
    renderSection(makeState({ isCurrentUserTeamAdmin: true }));

    expect(
      screen.getByText("Select a repository to add...")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add repository" })
    ).toBeInTheDocument();
  });

  it("hides the repository picker and Add control for a non-admin", () => {
    renderSection(makeState({ isCurrentUserTeamAdmin: false }));

    expect(
      screen.queryByText("Select a repository to add...")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add repository" })
    ).not.toBeInTheDocument();
  });

  it("disables Add until a repository is selected", () => {
    mockUseGitHubRepositories.mockReturnValue({
      data: [githubRepo()],
      isLoading: false,
    });

    renderSection(makeState());

    expect(
      screen.getByRole("button", { name: "Add repository" })
    ).toBeDisabled();
  });

  it("disables Add while repoDrafts have not hydrated, even with a repo picked", async () => {
    mockUseGitHubRepositories.mockReturnValue({
      data: [githubRepo()],
      isLoading: false,
    });

    renderSection(makeState({ repoDrafts: null }));

    screen.getByRole("combobox").click();
    const option = await screen.findByText("closedloop-ai/closedloop-ai");
    fireEvent.click(option);

    expect(
      screen.getByRole("button", { name: "Add repository" })
    ).toBeDisabled();
  });

  it("adds the selected repository and resets the picker", async () => {
    const stageAddRepo = vi.fn();
    mockUseGitHubRepositories.mockReturnValue({
      data: [githubRepo()],
      isLoading: false,
    });

    renderSection(makeState({ stageAddRepo, repoDrafts: [] }));

    screen.getByRole("combobox").click();
    const option = await screen.findByText("closedloop-ai/closedloop-ai");
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));

    expect(stageAddRepo).toHaveBeenCalledWith(githubRepo());
    expect(
      screen.getByText("Select a repository to add...")
    ).toBeInTheDocument();
  });

  it("shows the no-repositories message when the org has nothing left to add", async () => {
    mockUseGitHubRepositories.mockReturnValue({ data: [], isLoading: false });

    renderSection(makeState());
    screen.getByRole("combobox").click();

    expect(
      await screen.findByText("No additional repositories available")
    ).toBeInTheDocument();
  });

  it("shows a spinner instead of the draft list while configured repos load", () => {
    renderSection(makeState({ loadingConfiguredRepos: true, repoDrafts: [] }));

    expect(
      screen.queryByText("No repositories configured. Add one above.")
    ).not.toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("shows an admin-facing empty state when there are no configured repos", () => {
    renderSection(makeState({ repoDrafts: [], isCurrentUserTeamAdmin: true }));

    expect(
      screen.getByText("No repositories configured. Add one above.")
    ).toBeInTheDocument();
  });

  it("shows a plain empty state for a non-admin with no configured repos", () => {
    renderSection(makeState({ repoDrafts: [], isCurrentUserTeamAdmin: false }));

    expect(screen.getByText("No repositories configured.")).toBeInTheDocument();
    expect(screen.queryByText(ADD_ONE_ABOVE_REGEX)).not.toBeInTheDocument();
  });

  // ISS-9895. The failure and the genuine empty team assert the same two
  // locators, so neither can pass by rendering the other's state.
  it("names a failed repositories read instead of claiming the team has none", () => {
    renderSection(
      makeState({ configuredReposUnavailable: true, repoDrafts: null })
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      TEAM_REPOSITORIES_LOAD_FAILURE
    );
    expect(
      screen.queryByText(NO_CONFIGURED_REPOSITORIES_COPY, { exact: false })
    ).toBeNull();
  });

  // Review of #8040. A repo picked while the read had failed stays picked; once
  // the recovered baseline holds that repo, Add must not stage it a second time.
  it("does not re-add a picked repository the recovered baseline already holds", async () => {
    const stageAddRepo = vi.fn();
    const { rerender } = await pickDuringFailedRead(stageAddRepo);

    rerender(
      <TeamRepositoriesSection
        enabled
        state={makeState({ repoDrafts: [draft()], stageAddRepo })}
      />
    );
    const add = screen.getByRole("button", { name: "Add repository" });
    fireEvent.click(add);

    expect(add).toBeDisabled();
    expect(stageAddRepo).not.toHaveBeenCalled();
  });

  // Review of #8040. That stale pick is cleared, not hidden: removing the
  // recovered repo offers it again, and it must come back unpicked.
  it("does not bring the pick back when the recovered repository is removed", async () => {
    const stageRemoveRepo = vi.fn();
    const { rerender } = await pickDuringFailedRead();

    rerender(
      <TeamRepositoriesSection
        enabled
        state={makeState({ repoDrafts: [draft()], stageRemoveRepo })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove repository" }));
    expect(stageRemoveRepo).toHaveBeenCalledWith("draft-1");
    rerender(
      <TeamRepositoriesSection
        enabled
        state={makeState({ repoDrafts: [], stageRemoveRepo })}
      />
    );

    expect(
      screen.getByText("Select a repository to add...")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add repository" })
    ).toBeDisabled();
  });

  it("shows the empty state and no failure when the read succeeds with none", () => {
    renderSection(makeState({ repoDrafts: [] }));

    expect(
      screen.getByText(NO_CONFIGURED_REPOSITORIES_COPY, { exact: false })
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders each draft's default checkbox, primary radio, and star for the primary", () => {
    renderSection(
      makeState({
        repoDrafts: [
          draft({ draftId: "d1", isDefaultSelected: true, isPrimary: true }),
          draft({
            draftId: "d2",
            installationRepositoryId: "install-repo-2",
            isDefaultSelected: false,
            isPrimary: false,
            repository: {
              id: "install-repo-2",
              githubRepoId: "2",
              fullName: "closedloop-ai/other",
              name: "other",
              owner: "closedloop-ai",
              private: true,
            },
          }),
        ],
      })
    );

    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked();
    expect(screen.getAllByRole("radio")[0]).toBeChecked();
    expect(screen.getAllByRole("radio")[1]).not.toBeChecked();
    expect(screen.getByText("closedloop-ai/closedloop-ai")).toHaveClass(
      "font-semibold"
    );
  });

  it("toggles Default directly for a non-primary draft", () => {
    const stageToggleDefault = vi.fn();
    renderSection(
      makeState({
        stageToggleDefault,
        repoDrafts: [draft({ isPrimary: false, isDefaultSelected: false })],
      })
    );

    fireEvent.click(screen.getByRole("checkbox"));

    expect(stageToggleDefault).toHaveBeenCalledWith("draft-1", true);
  });

  it("opens a confirmation dialog before un-defaulting the primary repo", () => {
    const stageToggleDefault = vi.fn();
    renderSection(
      makeState({
        stageToggleDefault,
        repoDrafts: [draft({ isPrimary: true, isDefaultSelected: true })],
      })
    );

    fireEvent.click(screen.getByRole("checkbox"));

    expect(stageToggleDefault).not.toHaveBeenCalled();
    expect(screen.getByText("Remove primary repository?")).toBeInTheDocument();
  });

  it("un-defaults the primary repo once the confirmation is accepted", () => {
    const stageToggleDefault = vi.fn();
    renderSection(
      makeState({
        stageToggleDefault,
        repoDrafts: [
          draft({ draftId: "d1", isPrimary: true, isDefaultSelected: true }),
        ],
      })
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from defaults" })
    );

    expect(stageToggleDefault).toHaveBeenCalledWith("d1", false);
    expect(
      screen.queryByText("Remove primary repository?")
    ).not.toBeInTheDocument();
  });

  it("leaves the primary untouched when the confirmation is canceled", () => {
    const stageToggleDefault = vi.fn();
    renderSection(
      makeState({
        stageToggleDefault,
        repoDrafts: [draft({ isPrimary: true, isDefaultSelected: true })],
      })
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(stageToggleDefault).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Remove primary repository?")
    ).not.toBeInTheDocument();
  });

  it("sets a new primary when a different draft's radio is selected", () => {
    const stageSetPrimary = vi.fn();
    renderSection(
      makeState({
        stageSetPrimary,
        repoDrafts: [
          draft({ draftId: "d1", isPrimary: true }),
          draft({
            draftId: "d2",
            installationRepositoryId: "install-repo-2",
            repository: {
              id: "install-repo-2",
              githubRepoId: "2",
              fullName: "closedloop-ai/other",
              name: "other",
              owner: "closedloop-ai",
              private: true,
            },
          }),
        ],
      })
    );

    fireEvent.click(screen.getAllByRole("radio")[1]);

    expect(stageSetPrimary).toHaveBeenCalledWith("d2");
  });

  it("removes a draft when its Remove button is clicked (admin only)", () => {
    const stageRemoveRepo = vi.fn();
    renderSection(
      makeState({
        stageRemoveRepo,
        isCurrentUserTeamAdmin: true,
        repoDrafts: [draft({ draftId: "d1" })],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove repository" }));

    expect(stageRemoveRepo).toHaveBeenCalledWith("d1");
  });

  it("hides the Remove control for a non-admin", () => {
    renderSection(
      makeState({
        isCurrentUserTeamAdmin: false,
        repoDrafts: [draft()],
      })
    );

    expect(
      screen.queryByRole("button", { name: "Remove repository" })
    ).not.toBeInTheDocument();
  });

  it("disables the primary radio group for a non-admin", () => {
    renderSection(
      makeState({
        isCurrentUserTeamAdmin: false,
        repoDrafts: [draft()],
      })
    );

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });
});

/** Picks the org's one repo while the configured-repositories read has failed. */
async function pickDuringFailedRead(stageAddRepo = vi.fn()) {
  mockUseGitHubRepositories.mockReturnValue({
    data: [githubRepo()],
    isLoading: false,
  });
  const rendered = renderSection(
    makeState({
      configuredReposUnavailable: true,
      repoDrafts: null,
      stageAddRepo,
    })
  );
  screen.getByRole("combobox").click();
  fireEvent.click(await screen.findByText("closedloop-ai/closedloop-ai"));
  return rendered;
}
