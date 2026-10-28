import {
  type GitHubRepository,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicRepositoriesSection } from "../public-repositories-section";

const mockUseGitHubRepositories = vi.fn();
const mockUseAddPublicRepository = vi.fn();
const mockUseRemovePublicRepository = vi.fn();
const mockGetErrorMessage = vi.fn();
const mockAddMutate = vi.fn();
const mockAddReset = vi.fn();
const mockRemoveMutate = vi.fn();
const ADD_BUTTON_NAME = /^add$/i;
const REPO_URL_INPUT_NAME = /repository url/i;

const PUBLIC_REPO: GitHubRepository = {
  fullName: "octocat/hello-world",
  githubRepoId: "1001",
  id: "repo-1",
  lastPushedAt: null,
  name: "hello-world",
  owner: "octocat",
  private: false,
  source: GitHubRepositorySource.Public,
};

const INSTALLATION_REPO: GitHubRepository = {
  fullName: "closedloop-ai/closedloop-ai",
  githubRepoId: "1002",
  id: "repo-2",
  lastPushedAt: null,
  name: "closedloop-ai",
  owner: "closedloop-ai",
  private: true,
  source: GitHubRepositorySource.Installation,
};

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useAddPublicRepository: () => mockUseAddPublicRepository(),
  useGitHubRepositories: () => mockUseGitHubRepositories(),
  useRemovePublicRepository: () => mockUseRemovePublicRepository(),
}));

vi.mock("@repo/app/shared/api/api-error", () => ({
  getErrorMessage: (error: unknown) => mockGetErrorMessage(error),
}));

describe("PublicRepositoriesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGitHubRepositories.mockReturnValue({ data: [], isLoading: false });
    mockUseAddPublicRepository.mockReturnValue({
      error: null,
      isError: false,
      isPending: false,
      mutate: mockAddMutate,
      reset: mockAddReset,
    });
    mockUseRemovePublicRepository.mockReturnValue({
      mutate: mockRemoveMutate,
    });
    mockGetErrorMessage.mockReturnValue("Something went wrong");
  });

  it("shows a loading spinner while repositories are loading", () => {
    mockUseGitHubRepositories.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    const { container } = render(<PublicRepositoriesSection />);

    expect(screen.getByText("Loading repositories...")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no public repositories", () => {
    render(<PublicRepositoriesSection />);

    expect(
      screen.getByText("No public repositories added yet.")
    ).toBeInTheDocument();
  });

  it("renders only public repositories as linked entries", () => {
    mockUseGitHubRepositories.mockReturnValue({
      data: [PUBLIC_REPO, INSTALLATION_REPO],
      isLoading: false,
    });

    render(<PublicRepositoriesSection />);

    expect(
      screen.getByRole("link", { name: "octocat/hello-world" })
    ).toHaveAttribute("href", "https://github.com/octocat/hello-world");
    expect(
      screen.queryByText("closedloop-ai/closedloop-ai")
    ).not.toBeInTheDocument();
  });

  it("adds a repository and clears the input on success", async () => {
    mockAddMutate.mockImplementation((_input, callbacks) => {
      callbacks?.onSuccess?.();
    });

    render(<PublicRepositoriesSection />);

    const input = screen.getByRole("textbox", { name: REPO_URL_INPUT_NAME });
    await userEvent.type(input, "octocat/hello-world");
    await userEvent.click(
      screen.getByRole("button", { name: ADD_BUTTON_NAME })
    );

    expect(mockAddMutate).toHaveBeenCalledWith(
      { url: "octocat/hello-world" },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    expect(input).toHaveValue("");
  });

  it("does not call the add mutation when submitted with an empty URL", () => {
    const { container } = render(<PublicRepositoriesSection />);

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(mockAddMutate).not.toHaveBeenCalled();
  });

  it("removes a repository and disables its control while the removal is pending", async () => {
    mockUseGitHubRepositories.mockReturnValue({
      data: [PUBLIC_REPO],
      isLoading: false,
    });
    mockRemoveMutate.mockImplementation(() => {
      // Intentionally does not invoke onSettled, simulating an in-flight removal.
    });

    render(<PublicRepositoriesSection />);

    const removeButton = screen.getByRole("button", {
      name: "Remove octocat/hello-world",
    });
    await userEvent.click(removeButton);

    expect(mockRemoveMutate).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ onSettled: expect.any(Function) })
    );
    expect(
      screen.getByRole("button", { name: "Remove octocat/hello-world" })
    ).toBeDisabled();
  });

  it("shows the mapped error message after a failed add", () => {
    mockUseAddPublicRepository.mockReturnValue({
      error: new Error("Repository not found"),
      isError: true,
      isPending: false,
      mutate: mockAddMutate,
      reset: mockAddReset,
    });
    mockGetErrorMessage.mockReturnValue("Repository not found");

    render(<PublicRepositoriesSection />);

    expect(screen.getByText("Repository not found")).toBeInTheDocument();
  });
});
