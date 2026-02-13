import { ArtifactSubtype } from "@repo/api/src/types/artifact";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import { CreateArtifactModal } from "../create-artifact-modal";

// Mock the hooks
const mockUseCreateArtifact = vi.fn();
const mockUseArtifactsByProject = vi.fn();
const mockUseOrganizationUsers = vi.fn();
const mockUseGitHubIntegrationStatus = vi.fn();
const mockUseGitHubRepositories = vi.fn();
const mockUseGitHubBranches = vi.fn();
const mockUseOrgTemplateBySubtype = vi.fn();

vi.mock("@/hooks/queries/use-artifacts", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-artifacts");
  return {
    ...actual,
    useCreateArtifact: () => mockUseCreateArtifact(),
    useArtifactsByProject: (...args: unknown[]) =>
      mockUseArtifactsByProject(...args),
  };
});

vi.mock("@/hooks/queries/use-users", () => ({
  useOrganizationUsers: () => mockUseOrganizationUsers(),
}));

vi.mock("@/hooks/queries/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => mockUseGitHubIntegrationStatus(),
  useGitHubRepositories: (options?: unknown) =>
    mockUseGitHubRepositories(options),
  useGitHubBranches: (repoId: string, options?: unknown) =>
    mockUseGitHubBranches(repoId, options),
}));

vi.mock("@/hooks/queries/use-templates", () => ({
  useOrgTemplateBySubtype: (subtype: string, options?: unknown) =>
    mockUseOrgTemplateBySubtype(subtype, options),
}));

// Regex constants for testing
const TITLE_REGEX = /title/i;
const REQUIRED_REGEX = /\*/;
const SOURCE_PRD_REGEX = /source prd/i;
const OPTIONAL_REGEX = /\(optional\)/i;
const FILE_NAME_REGEX = /file name/i;
const _APPROVER_REGEX = /approver/i;
const TARGET_REPOSITORY_REGEX = /target repository/i;
const TARGET_BRANCH_REGEX = /target branch/i;
const _STATUS_REGEX = /^status$/i;
const CANCEL_REGEX = /cancel/i;
const CREATE_IMPL_PLAN_REGEX = /create impl plan/i;
const CREATE_PRD_REGEX = /create prd/i;
const PASTE_MARKDOWN_CONTENT_REGEX = /paste markdown content here/i;
const CONNECT_GITHUB_REGEX = /connect github to select a repository/i;
const CREATING_REGEX = /creating\.\.\./i;
const NO_PRDS_REGEX = /no prds in this project/i;

describe("CreateArtifactModal", () => {
  const mockMutate = vi.fn();
  const mockOnOpenChange = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks
    mockUseCreateArtifact.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });

    mockUseArtifactsByProject.mockReturnValue({
      data: [],
      isLoading: false,
    });

    mockUseOrganizationUsers.mockReturnValue({
      data: [],
      isLoading: false,
    });

    mockUseGitHubIntegrationStatus.mockReturnValue({
      data: { connected: false },
      isLoading: false,
    });

    mockUseGitHubRepositories.mockReturnValue({
      data: [],
      isLoading: false,
    });

    mockUseGitHubBranches.mockReturnValue({
      data: { branches: [] },
      isLoading: false,
    });

    mockUseOrgTemplateBySubtype.mockReturnValue({
      data: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe("Implementation Plan creation without PRD", () => {
    it("should render PRD selector with 'optional' label for implementation plans", () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const sourcePrdLabel = screen.getByText(SOURCE_PRD_REGEX);
      expect(sourcePrdLabel).toBeInTheDocument();
      expect(sourcePrdLabel.textContent).toMatch(OPTIONAL_REGEX);
    });

    it("should allow submission without selecting a PRD", async () => {
      mockUseArtifactsByProject.mockReturnValue({
        data: [
          createMockArtifact({
            id: "prd-1",
            title: "Test PRD",
            subtype: "PRD",
          }),
        ],
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Fill in only the required title field
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, {
        target: { value: "Standalone Implementation Plan" },
      });

      // Verify submit button is enabled
      await waitFor(() => {
        const submitButton = screen.getByRole("button", {
          name: CREATE_IMPL_PLAN_REGEX,
        });
        expect(submitButton).not.toBeDisabled();
      });
    });

    it("should submit without parentId when no PRD is selected", async () => {
      mockMutate.mockImplementation((input, options) => {
        options?.onSuccess?.({
          ...input,
          id: "new-plan-123",
          documentSlug: "standalone-plan",
        });
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          open={true}
          projectId="project-1"
        />
      );

      // Fill in title
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Standalone Plan" } });

      // Submit
      const submitButton = screen.getByRole("button", {
        name: CREATE_IMPL_PLAN_REGEX,
      });
      submitButton.click();

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalled();
      });

      // Verify mutation input does NOT include parentId
      const mutationInput = mockMutate.mock.calls[0][0];
      expect(mutationInput).toMatchObject({
        projectId: "project-1",
        subtype: ArtifactSubtype.ImplementationPlan,
        title: "Standalone Plan",
        status: "DRAFT",
      });
      expect(mutationInput.parentId).toBeUndefined();
    });

    it("should include parentId when PRD is selected", async () => {
      const mockPrds = [
        createMockArtifact({
          id: "prd-1",
          title: "Test PRD",
          subtype: "PRD",
          targetRepo: "org/repo",
          targetBranch: "main",
        }),
      ];

      mockUseArtifactsByProject.mockReturnValue({
        data: mockPrds,
        isLoading: false,
      });

      mockMutate.mockImplementation((input, options) => {
        options?.onSuccess?.({
          ...input,
          id: "new-plan-123",
          documentSlug: "plan-from-prd",
        });
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Select PRD
      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      await waitFor(() => {
        const option = screen.getByText("Test PRD");
        option.click();
      });

      // Fill in title
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Plan from PRD" } });

      // Submit
      const submitButton = screen.getByRole("button", {
        name: CREATE_IMPL_PLAN_REGEX,
      });
      submitButton.click();

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalled();
      });

      // Verify mutation input INCLUDES parentId
      const mutationInput = mockMutate.mock.calls[0][0];
      expect(mutationInput).toMatchObject({
        projectId: "project-1",
        subtype: ArtifactSubtype.ImplementationPlan,
        title: "Plan from PRD",
        parentId: "prd-1",
      });
    });

    it("should pre-populate fields from selected PRD", async () => {
      const mockPrds = [
        createMockArtifact({
          id: "prd-1",
          title: "Test PRD",
          subtype: "PRD",
          targetRepo: "org/repo",
          targetBranch: "develop",
          status: "APPROVED",
        }),
      ];

      mockUseArtifactsByProject.mockReturnValue({
        data: mockPrds,
        isLoading: false,
      });

      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });

      mockUseGitHubRepositories.mockReturnValue({
        data: [
          { id: "repo-1", name: "repo", fullName: "org/repo" },
          { id: "repo-2", name: "other", fullName: "org/other" },
        ],
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Select PRD
      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      await waitFor(() => {
        const option = screen.getByText("Test PRD");
        option.click();
      });

      // Verify status is pre-populated from PRD
      await waitFor(() => {
        // Status select should show "Approved" (the fourth combobox: PRD, Title, Approver, Repo, Branch, Status)
        const comboboxes = screen.getAllByRole("combobox");
        const statusCombobox = comboboxes.find((cb) =>
          cb.textContent?.includes("Approved")
        );
        expect(statusCombobox).toBeDefined();
      });
    });
  });

  describe("PRD creation (document artifact)", () => {
    it("should not show PRD selector for PRD artifacts", () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      expect(screen.queryByLabelText(SOURCE_PRD_REGEX)).not.toBeInTheDocument();
    });

    it("should show content textarea for PRD artifacts", () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const contentTextarea = screen.getByPlaceholderText(
        PASTE_MARKDOWN_CONTENT_REGEX
      );
      expect(contentTextarea).toBeInTheDocument();
    });

    it("should render correct modal title for PRD", () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Use getByRole to specifically target the dialog title
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent("Create PRD");
    });

    it("should render correct submit button text for PRD", () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const submitButton = screen.getByRole("button", {
        name: CREATE_PRD_REGEX,
      });
      expect(submitButton).toBeInTheDocument();
    });
  });

  describe("Form fields and validation", () => {
    it("should require title field", () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const titleLabel = screen.getByText(TITLE_REGEX);
      expect(titleLabel.textContent).toMatch(REQUIRED_REGEX);

      // Submit button should be disabled when title is empty
      const submitButton = screen.getByRole("button", {
        name: CREATE_IMPL_PLAN_REGEX,
      });
      expect(submitButton).toBeDisabled();
    });

    it("should enable submit button when title is filled", async () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Fill in title
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "My Plan" } });

      // Submit button should be enabled
      await waitFor(() => {
        const submitButton = screen.getByRole("button", {
          name: CREATE_IMPL_PLAN_REGEX,
        });
        expect(submitButton).not.toBeDisabled();
      });
    });

    it("should auto-generate filename from title", async () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Enter title with special characters and spaces
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, {
        target: { value: "My Dashboard Plan! @#$ 2024" },
      });

      // Verify filename is auto-generated with sanitization
      await waitFor(() => {
        const fileNameInput = screen.getByLabelText(
          FILE_NAME_REGEX
        ) as HTMLInputElement;
        // Special characters are removed, then spaces become dashes
        expect(fileNameInput.value).toBe("my-dashboard-plan-2024.md");
      });
    });

    it("should allow manual filename editing", async () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const fileNameInput = screen.getByLabelText(FILE_NAME_REGEX);
      fireEvent.change(fileNameInput, {
        target: { value: "custom-filename.md" },
      });

      await waitFor(() => {
        expect((fileNameInput as HTMLInputElement).value).toBe(
          "custom-filename.md"
        );
      });
    });

    it("should render all form fields for implementation plan", () => {
      // Enable GitHub to ensure repository and branch selects render
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Fields with proper form associations
      expect(screen.getByLabelText(SOURCE_PRD_REGEX)).toBeInTheDocument();
      expect(screen.getByLabelText(TITLE_REGEX)).toBeInTheDocument();
      expect(screen.getByLabelText(FILE_NAME_REGEX)).toBeInTheDocument();
      expect(
        screen.getByLabelText(TARGET_REPOSITORY_REGEX)
      ).toBeInTheDocument();
      expect(screen.getByLabelText(TARGET_BRANCH_REGEX)).toBeInTheDocument();

      // Fields without proper form associations - check by label text
      expect(screen.getByText("Approver")).toBeInTheDocument();
      expect(screen.getByText("Status")).toBeInTheDocument();
    });
  });

  describe("GitHub integration", () => {
    it("should show message when GitHub is not connected", () => {
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: false },
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      expect(screen.getByText(CONNECT_GITHUB_REGEX)).toBeInTheDocument();
    });

    it("should show repository selector when GitHub is connected", () => {
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });

      mockUseGitHubRepositories.mockReturnValue({
        data: [
          { id: "repo-1", name: "repo1", fullName: "org/repo1" },
          { id: "repo-2", name: "repo2", fullName: "org/repo2" },
        ],
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const repoSelector = screen.getByRole("combobox", {
        name: TARGET_REPOSITORY_REGEX,
      });
      expect(repoSelector).toBeInTheDocument();
      expect(repoSelector).not.toBeDisabled();
    });

    it("should load branches when repository is selected", async () => {
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });

      mockUseGitHubRepositories.mockReturnValue({
        data: [{ id: "repo-1", name: "repo", fullName: "org/repo" }],
        isLoading: false,
      });

      mockUseGitHubBranches.mockReturnValue({
        data: {
          branches: [
            { name: "main", isDefault: true },
            { name: "develop", isDefault: false },
          ],
        },
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Select repository
      const repoSelector = screen.getByRole("combobox", {
        name: TARGET_REPOSITORY_REGEX,
      });
      repoSelector.click();

      await waitFor(() => {
        const repoOption = screen.getByText("org/repo");
        repoOption.click();
      });

      // Verify branches are loaded - useGitHubBranches should have been called
      await waitFor(() => {
        expect(mockUseGitHubBranches).toHaveBeenCalledWith(
          "repo-1",
          expect.any(Object)
        );
      });
    });

    it("should disable branch selector until repository is selected", () => {
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const branchSelector = screen.getByRole("combobox", {
        name: TARGET_BRANCH_REGEX,
      });
      expect(branchSelector).toBeDisabled();
    });
  });

  describe("Modal controls", () => {
    it("should call onOpenChange when cancel is clicked", () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
      cancelButton.click();

      expect(mockOnOpenChange).toHaveBeenCalledWith(false);
    });

    it("should call onSuccess after successful creation", async () => {
      const mockArtifact = {
        id: "new-artifact-123",
        title: "Test Artifact",
        documentSlug: "test-artifact",
      };

      mockMutate.mockImplementation((_input, options) => {
        options?.onSuccess?.(mockArtifact);
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          open={true}
          projectId="project-1"
        />
      );

      // Fill in title
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Test Artifact" } });

      // Submit
      const submitButton = screen.getByRole("button", {
        name: CREATE_IMPL_PLAN_REGEX,
      });
      submitButton.click();

      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalledWith(mockArtifact);
        expect(mockOnOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it("should reset form when modal is closed", async () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      // Fill in some fields
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Test Title" } });

      // Close modal
      const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
      cancelButton.click();

      // Reopen modal - form should be reset
      cleanup();
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={vi.fn()}
          open={true}
          projectId="project-1"
        />
      );

      await waitFor(() => {
        const titleInputReset = screen.getByLabelText(
          TITLE_REGEX
        ) as HTMLInputElement;
        expect(titleInputReset.value).toBe("");
      });
    });

    it("should show loading state while creating", () => {
      mockUseCreateArtifact.mockReturnValue({
        mutate: mockMutate,
        isPending: true,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      expect(screen.getByText(CREATING_REGEX)).toBeInTheDocument();
    });
  });

  describe("PRD loading behavior", () => {
    it("should fetch PRDs when modal opens for implementation plan", () => {
      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      expect(mockUseArtifactsByProject).toHaveBeenCalledWith(
        "project-1",
        true,
        expect.objectContaining({ enabled: true })
      );
    });

    it("should not fetch PRDs for non-implementation-plan artifacts", () => {
      mockUseArtifactsByProject.mockClear();

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      expect(mockUseArtifactsByProject).toHaveBeenCalledWith(
        "project-1",
        true,
        expect.objectContaining({ enabled: false })
      );
    });

    it("should show loading state in PRD selector", async () => {
      mockUseArtifactsByProject.mockReturnValue({
        data: [],
        isLoading: true,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      // Should show loading spinner inside the dropdown (lucide LoaderIcon with animate-spin class)
      await waitFor(() => {
        const loadingIcon = document.querySelector(".animate-spin");
        expect(loadingIcon).toBeInTheDocument();
      });
    });

    it("should show message when no PRDs exist", async () => {
      mockUseArtifactsByProject.mockReturnValue({
        data: [],
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      await waitFor(() => {
        expect(screen.getByText(NO_PRDS_REGEX)).toBeInTheDocument();
      });
    });

    it("should filter artifacts to show only PRDs", async () => {
      const mockArtifacts = [
        createMockArtifact({ id: "prd-1", title: "PRD 1", subtype: "PRD" }),
        createMockArtifact({
          id: "plan-1",
          title: "Plan 1",
          subtype: "IMPLEMENTATION_PLAN",
        }),
        createMockArtifact({ id: "prd-2", title: "PRD 2", subtype: "PRD" }),
      ];

      mockUseArtifactsByProject.mockReturnValue({
        data: mockArtifacts,
        isLoading: false,
      });

      render(
        <CreateArtifactModal
          artifactSubtype={ArtifactSubtype.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
        />
      );

      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      // Should only show PRDs, not the implementation plan
      await waitFor(() => {
        expect(screen.getByText("PRD 1")).toBeInTheDocument();
        expect(screen.getByText("PRD 2")).toBeInTheDocument();
      });
      expect(screen.queryByText("Plan 1")).not.toBeInTheDocument();
    });
  });
});
