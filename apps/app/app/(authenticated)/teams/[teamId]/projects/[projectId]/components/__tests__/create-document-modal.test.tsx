import { DocumentType } from "@repo/api/src/types/document";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDocument } from "@/__tests__/fixtures/documents";
import { CreateDocumentModal } from "../create-document-modal";

// Mock the hooks
const mockUseCreateArtifact = vi.fn();
const mockUseGeneratePrdLaunch = vi.fn();
const mockUseArtifact = vi.fn();
const mockUseArtifactsByProject = vi.fn();
const mockUseTeamMembers = vi.fn();
const mockUseGitHubIntegrationStatus = vi.fn();
const mockUseGitHubRepositories = vi.fn();
const mockUseGitHubBranches = vi.fn();
const mockUseOrgTemplateByType = vi.fn();
const mockUseProject = vi.fn();
const mockUseProjectsByTeam = vi.fn();
const mockUsePreLoopGate = vi.fn();

vi.mock("@repo/api/src/types/project", async () => {
  const actual = await vi.importActual("@repo/api/src/types/project");
  return {
    ...actual,
    getProjectSettings: () => ({}),
  };
});

vi.mock("@/hooks/queries/use-projects", () => ({
  useProject: (...args: unknown[]) => mockUseProject(...args),
  useProjectsByTeam: (...args: unknown[]) => mockUseProjectsByTeam(...args),
}));

vi.mock("@/hooks/queries/use-documents", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-documents");
  return {
    ...actual,
    useCreateDocument: () => mockUseCreateArtifact(),
    useGeneratePrdLaunch: () => mockUseGeneratePrdLaunch(),
    useDocument: (...args: unknown[]) => mockUseArtifact(...args),
    useDocumentsByProject: (...args: unknown[]) =>
      mockUseArtifactsByProject(...args),
  };
});

vi.mock("@/lib/system-check/pre-loop-system-check-provider", () => ({
  useOptionalPreLoopSystemCheckGate: () => mockUsePreLoopGate(),
}));

vi.mock("@/hooks/queries/use-teams", () => ({
  useTeamMembers: (...args: unknown[]) => mockUseTeamMembers(...args),
}));

vi.mock("@/hooks/queries/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => mockUseGitHubIntegrationStatus(),
  useGitHubRepositories: (options?: unknown) =>
    mockUseGitHubRepositories(options),
  useGitHubBranches: (repoId: string, options?: unknown) =>
    mockUseGitHubBranches(repoId, options),
}));

vi.mock("@/hooks/queries/use-templates", () => ({
  useOrgTemplateByType: (type: string, options?: unknown) =>
    mockUseOrgTemplateByType(type, options),
}));

// cmdk (Popover+Command) needs ResizeObserver which jsdom doesn't provide.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Regex constants for testing
const TITLE_REGEX = /title/i;
const REQUIRED_REGEX = /\*/;
const SOURCE_PRD_REGEX = /context source/i;
const OPTIONAL_REGEX = /\(optional\)/i;
const FILE_NAME_REGEX = /file name/i;
const _APPROVER_REGEX = /approver/i;
const TARGET_REPOSITORY_REGEX = /target repository/i;
const TARGET_BRANCH_REGEX = /target branch/i;
const _STATUS_REGEX = /^status$/i;
const CANCEL_REGEX = /cancel/i;
const CREATE_IMPL_PLAN_REGEX = /create implementation plan/i;
const SAVE_REGEX = /^save$/i;
const GENERATE_PRD_REGEX = /^generate prd$/i;
const PASTE_MARKDOWN_CONTENT_REGEX = /paste or upload markdown content/i;
const CONNECT_GITHUB_REGEX = /connect github to select a repository/i;
const CREATING_REGEX = /creating\.\.\./i;
const NO_PRDS_REGEX = /no prds or features in this project/i;
const LOADING_REGEX = /loading/i;
const TARGET_SELECTION_PROMPT_REGEX =
  /select a compute target to start generation/i;

describe("CreateDocumentModal", () => {
  const mockMutate = vi.fn();
  const mockGeneratePrdLaunchMutate = vi.fn();
  const mockOnOpenChange = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    // Default mocks
    mockUseCreateArtifact.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });
    mockGeneratePrdLaunchMutate.mockImplementation((input, options) => {
      options?.onSuccess?.({ artifact: input.artifact, status: "launched" });
    });
    mockUseGeneratePrdLaunch.mockReturnValue({
      mutate: mockGeneratePrdLaunchMutate,
      isPending: false,
    });

    mockUseArtifact.mockReturnValue({
      data: null,
      isLoading: false,
    });

    mockUseArtifactsByProject.mockReturnValue({
      data: [],
      isLoading: false,
    });

    mockUseTeamMembers.mockReturnValue({
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

    mockUseOrgTemplateByType.mockReturnValue({
      data: null,
      isLoading: false,
    });

    mockUseProject.mockReturnValue({
      data: null,
      isLoading: false,
    });

    mockUseProjectsByTeam.mockReturnValue({
      data: [],
      isLoading: false,
    });

    mockUsePreLoopGate.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  describe("Implementation Plan creation without PRD", () => {
    it("should render PRD selector with 'optional' label for implementation plans", () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const sourcePrdLabel = screen.getByText(SOURCE_PRD_REGEX);
      expect(sourcePrdLabel).toBeInTheDocument();
      expect(sourcePrdLabel.textContent).toMatch(OPTIONAL_REGEX);
    });

    it("should allow submission without selecting a PRD", async () => {
      mockUseArtifactsByProject.mockReturnValue({
        data: [
          createMockDocument({
            id: "prd-1",
            title: "Test PRD",
            type: "PRD",
          }),
        ],
        isLoading: false,
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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

    it("should submit without sourceId when no PRD is selected", async () => {
      mockMutate.mockImplementation((input, options) => {
        options?.onSuccess?.({
          ...input,
          id: "new-plan-123",
          slug: "standalone-plan",
        });
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          open={true}
          projectId="project-1"
          teamId="team-1"
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

      // Verify mutation input does NOT include sourceId
      const mutationInput = mockMutate.mock.calls[0][0];
      expect(mutationInput).toMatchObject({
        projectId: "project-1",
        type: DocumentType.ImplementationPlan,
        title: "Standalone Plan",
        status: "DRAFT",
      });
      expect(mutationInput.sourceId).toBeUndefined();
    });

    it("should include sourceId when PRD is selected", async () => {
      const mockPrds = [
        createMockDocument({
          id: "prd-1",
          title: "Test PRD",
          type: "PRD",
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
          slug: "plan-from-prd",
        });
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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

      // Verify mutation input INCLUDES sourceId
      const mutationInput = mockMutate.mock.calls[0][0];
      expect(mutationInput).toMatchObject({
        projectId: "project-1",
        type: DocumentType.ImplementationPlan,
        title: "Plan from PRD",
        sourceId: "prd-1",
      });
    });

    it("should pre-populate fields from selected PRD", async () => {
      const mockPrds = [
        createMockDocument({
          id: "prd-1",
          title: "Test PRD",
          type: "PRD",
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
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      expect(screen.queryByLabelText(SOURCE_PRD_REGEX)).not.toBeInTheDocument();
    });

    it("should show content textarea for PRD artifacts", () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const contentTextarea = screen.getByPlaceholderText(
        PASTE_MARKDOWN_CONTENT_REGEX
      );
      expect(contentTextarea).toBeInTheDocument();
    });

    it("should render correct modal title for PRD", () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent("Create PRD");
    });

    it("should render Save and Generate PRD buttons for PRD", () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const saveButton = screen.getByRole("button", {
        name: SAVE_REGEX,
      });
      expect(saveButton).toBeInTheDocument();

      const generateButton = screen.getByRole("button", {
        name: GENERATE_PRD_REGEX,
      });
      expect(generateButton).toBeInTheDocument();
    });

    it("should start PRD generation without a compute target override", async () => {
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });

      mockUseGitHubRepositories.mockReturnValue({
        data: [{ id: "repo-1", name: "repo", fullName: "org/repo" }],
        isLoading: false,
      });

      mockMutate.mockImplementation((_input, options) => {
        options?.onSuccess?.({
          id: "new-prd-123",
          title: "Generated PRD",
          slug: "generated-prd",
        });
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
        target: { value: "Generated PRD" },
      });

      const repoSelector = screen.getByRole("combobox", {
        name: TARGET_REPOSITORY_REGEX,
      });
      repoSelector.click();

      await waitFor(() => {
        screen.getByText("org/repo").click();
      });

      screen.getByRole("button", { name: GENERATE_PRD_REGEX }).click();

      await waitFor(() => {
        expect(mockGeneratePrdLaunchMutate).toHaveBeenCalledWith(
          {
            artifact: expect.objectContaining({ id: "new-prd-123" }),
            additionalRepos: undefined,
            computeTargetId: undefined,
          },
          expect.objectContaining({ onSuccess: expect.any(Function) })
        );
      });
    });

    it("disables Generate PRD while post-create target selection is pending", async () => {
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });
      mockUseGitHubRepositories.mockReturnValue({
        data: [{ id: "repo-1", name: "repo", fullName: "org/repo" }],
        isLoading: false,
      });
      mockMutate.mockImplementation((_input, options) => {
        options?.onSuccess?.({
          id: "new-prd-pending",
          title: "Pending PRD",
          slug: "pending-prd",
        });
      });
      mockGeneratePrdLaunchMutate.mockImplementation((input, options) => {
        options?.onSuccess?.({
          additionalRepos: input.additionalRepos,
          artifact: input.artifact,
          availableTargets: [
            {
              id: "target-1",
              machineName: "Workstation",
              status: "online",
            },
          ],
          status: "pending_target_selection",
        });
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
        target: { value: "Pending PRD" },
      });
      screen.getByRole("combobox", { name: TARGET_REPOSITORY_REGEX }).click();
      await waitFor(() => {
        screen.getByText("org/repo").click();
      });

      screen.getByRole("button", { name: GENERATE_PRD_REGEX }).click();

      await screen.findByText(TARGET_SELECTION_PROMPT_REGEX);
      const generateButton = screen.getByRole("button", {
        name: GENERATE_PRD_REGEX,
      });
      expect(generateButton).toBeDisabled();

      fireEvent.click(generateButton);
      expect(mockMutate).toHaveBeenCalledOnce();
    });

    it("does not create the PRD when the pre-loop gate blocks before executing the callback", async () => {
      const mockRunWithPreLoopSystemCheck = vi
        .fn()
        .mockResolvedValue({ status: "blocked_missing_compute_selection" });
      mockUsePreLoopGate.mockReturnValue({
        runWithPreLoopSystemCheck: mockRunWithPreLoopSystemCheck,
        cancelPendingPreLoopAttempt: vi.fn(),
        isChecking: false,
        isDialogOpen: false,
        pendingOwnerKey: null,
      });
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });
      mockUseGitHubRepositories.mockReturnValue({
        data: [{ id: "repo-1", name: "repo", fullName: "org/repo" }],
        isLoading: false,
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
        target: { value: "Blocked PRD" },
      });
      screen.getByRole("combobox", { name: TARGET_REPOSITORY_REGEX }).click();
      await waitFor(() => {
        screen.getByText("org/repo").click();
      });

      screen.getByRole("button", { name: GENERATE_PRD_REGEX }).click();

      await waitFor(() => {
        expect(mockRunWithPreLoopSystemCheck).toHaveBeenCalledOnce();
      });
      expect(mockRunWithPreLoopSystemCheck.mock.calls[0][0]).toMatchObject({
        command: "generate_prd",
        documentType: "prd",
      });
      expect(mockMutate).not.toHaveBeenCalled();
      expect(mockGeneratePrdLaunchMutate).not.toHaveBeenCalled();
    });

    it("propagates an explicit Local target from the pre-loop gate into the post-create launch", async () => {
      const mockRunWithPreLoopSystemCheck = vi.fn(
        (
          _metadata,
          execute: (context: { computeTargetId: string }) => void
        ) => {
          execute({ computeTargetId: "target-local" });
          return Promise.resolve({
            status: "executed",
            attemptId: "attempt-1",
          });
        }
      );
      mockUsePreLoopGate.mockReturnValue({
        runWithPreLoopSystemCheck: mockRunWithPreLoopSystemCheck,
        cancelPendingPreLoopAttempt: vi.fn(),
        isChecking: false,
        isDialogOpen: false,
        pendingOwnerKey: null,
      });
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });
      mockUseGitHubRepositories.mockReturnValue({
        data: [{ id: "repo-1", name: "repo", fullName: "org/repo" }],
        isLoading: false,
      });
      mockMutate.mockImplementation((_input, options) => {
        options?.onSuccess?.({
          id: "new-prd-local",
          title: "Generated PRD",
          slug: "generated-prd",
        });
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      fireEvent.change(screen.getByLabelText(TITLE_REGEX), {
        target: { value: "Local PRD" },
      });
      screen.getByRole("combobox", { name: TARGET_REPOSITORY_REGEX }).click();
      await waitFor(() => {
        screen.getByText("org/repo").click();
      });

      screen.getByRole("button", { name: GENERATE_PRD_REGEX }).click();

      await waitFor(() => {
        expect(mockGeneratePrdLaunchMutate).toHaveBeenCalledWith(
          {
            artifact: expect.objectContaining({ id: "new-prd-local" }),
            additionalRepos: undefined,
            computeTargetId: "target-local",
          },
          expect.objectContaining({ onSuccess: expect.any(Function) })
        );
      });
    });
  });

  describe("Form fields and validation", () => {
    it("should require title field", () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const titleLabel = screen.getByText(TITLE_REGEX);
      expect(titleLabel.textContent).toMatch(REQUIRED_REGEX);

      const submitButton = screen.getByRole("button", {
        name: CREATE_IMPL_PLAN_REGEX,
      });
      expect(submitButton).toBeDisabled();
    });

    it("should enable submit button when title is filled", async () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "My Plan" } });

      await waitFor(() => {
        const submitButton = screen.getByRole("button", {
          name: CREATE_IMPL_PLAN_REGEX,
        });
        expect(submitButton).not.toBeDisabled();
      });
    });

    it("should auto-generate filename from title", async () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, {
        target: { value: "My Dashboard Plan! @#$ 2024" },
      });

      await waitFor(() => {
        const fileNameInput = screen.getByLabelText(
          FILE_NAME_REGEX
        ) as HTMLInputElement;
        expect(fileNameInput.value).toBe("my-dashboard-plan-2024.md");
      });
    });

    it("should allow manual filename editing", async () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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
      mockUseGitHubIntegrationStatus.mockReturnValue({
        data: { connected: true },
        isLoading: false,
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      expect(screen.getByLabelText(SOURCE_PRD_REGEX)).toBeInTheDocument();
      expect(screen.getByLabelText(TITLE_REGEX)).toBeInTheDocument();
      expect(screen.getByLabelText(FILE_NAME_REGEX)).toBeInTheDocument();
      expect(
        screen.getByLabelText(TARGET_REPOSITORY_REGEX)
      ).toBeInTheDocument();
      expect(screen.getByLabelText(TARGET_BRANCH_REGEX)).toBeInTheDocument();

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
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const repoSelector = screen.getByRole("combobox", {
        name: TARGET_REPOSITORY_REGEX,
      });
      repoSelector.click();

      await waitFor(() => {
        const repoOption = screen.getByText("org/repo");
        repoOption.click();
      });

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
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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
        slug: "test-artifact",
      };

      mockMutate.mockImplementation((_input, options) => {
        options?.onSuccess?.(mockArtifact);
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          onSuccess={mockOnSuccess}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Test Artifact" } });

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
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Test Title" } });

      const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
      cancelButton.click();

      cleanup();
      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={vi.fn()}
          open={true}
          projectId="project-1"
          teamId="team-1"
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
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      expect(screen.getByText(CREATING_REGEX)).toBeInTheDocument();
    });
  });

  describe("PRD loading behavior", () => {
    it("should fetch PRDs when modal opens for implementation plan", () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      expect(mockUseArtifactsByProject).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ enabled: true })
      );
    });

    it("should not fetch PRDs for non-implementation-plan artifacts", () => {
      mockUseArtifactsByProject.mockClear();

      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      expect(mockUseArtifactsByProject).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ enabled: false })
      );
    });

    it("should show loading state in PRD selector", () => {
      mockUseArtifactsByProject.mockReturnValue({
        data: [],
        isLoading: true,
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      expect(prdSelector.textContent).toMatch(LOADING_REGEX);
    });

    it("should show message when no PRDs exist", async () => {
      mockUseArtifactsByProject.mockReturnValue({
        data: [],
        isLoading: false,
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
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
        createMockDocument({ id: "prd-1", title: "PRD 1", type: "PRD" }),
        createMockDocument({
          id: "plan-1",
          title: "Plan 1",
          type: "IMPLEMENTATION_PLAN",
        }),
        createMockDocument({ id: "prd-2", title: "PRD 2", type: "PRD" }),
      ];

      mockUseArtifactsByProject.mockReturnValue({
        data: mockArtifacts,
        isLoading: false,
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.ImplementationPlan}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      await waitFor(() => {
        expect(screen.getByText("PRD 1")).toBeInTheDocument();
        expect(screen.getByText("PRD 2")).toBeInTheDocument();
      });
      expect(screen.queryByText("Plan 1")).not.toBeInTheDocument();
    });
  });
});
