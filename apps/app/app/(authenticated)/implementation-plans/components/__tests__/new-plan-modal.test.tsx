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
import { NewPlanModal } from "../new-plan-modal";
import type { PlanSource } from "../plan-source";

// Mock the hooks
const mockUseRouter = vi.fn();
const mockUseArtifacts = vi.fn();
const mockUseCreateArtifact = vi.fn();
const mockUseCreateAndGenerateArtifact = vi.fn();
const mockUseProjects = vi.fn();
const mockUseProject = vi.fn();
const mockUsePreLoopGate = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => mockUseRouter(),
}));

vi.mock("@/hooks/queries/use-documents", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-documents");
  return {
    ...actual,
    useDocuments: () => mockUseArtifacts(),
    useCreateDocument: () => mockUseCreateArtifact(),
    useCreateAndGenerateDocument: () => mockUseCreateAndGenerateArtifact(),
  };
});

vi.mock("@repo/api/src/types/project", async () => {
  const actual = await vi.importActual("@repo/api/src/types/project");
  return {
    ...actual,
    getProjectSettings: () => ({}),
  };
});

vi.mock("@/hooks/queries/use-projects", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-projects");
  return {
    ...actual,
    useProject: (...args: unknown[]) => mockUseProject(...args),
    useProjects: () => mockUseProjects(),
  };
});

vi.mock("@/lib/system-check/pre-loop-system-check-provider", () => ({
  useOptionalPreLoopSystemCheckGate: () => mockUsePreLoopGate(),
}));

vi.mock("@/hooks/queries/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({
    data: { connected: false },
    isLoading: false,
  }),
  useGitHubRepositories: () => ({ data: [], isLoading: false }),
  useGitHubBranches: () => ({ data: undefined, isLoading: false }),
}));

// PLN-462: NewPlanModal calls useInheritedAdditionalRepos under TanStack
// Query. Stub it so the existing tests don't need a QueryClientProvider —
// the multi-repo behaviour has its own dedicated test file.
vi.mock("@/hooks/queries/use-loops", () => ({
  useInheritedAdditionalRepos: () => ({
    data: { additionalRepos: [], source: null },
    isFetched: true,
  }),
}));

// PLN-237: NewPlanModal resolves the project's primary repo via
// `useTeamRepositoriesUnion`, which uses `useQueries` and would require a
// QueryClientProvider. Stub it for these structural tests; multi-repo
// behaviour has its own dedicated test file.
vi.mock("@/hooks/use-team-repositories-union", () => ({
  useTeamRepositoriesUnion: () => ({
    repositories: [],
    isLoading: false,
    error: null,
  }),
}));

function createMockSource(overrides?: Partial<PlanSource>): PlanSource {
  return {
    id: "source-1",
    title: "Test Source",
    ...overrides,
  } as PlanSource;
}

// Regex constants for testing
const TITLE_REGEX = /title/i;
const CREATE_PLAN_REGEX = /create plan/i;
const PROJECT_REGEX = /project/i;
const PROJECT_START_REGEX = /^project/i;
const SOURCE_PRD_REGEX = /source prd/i;
const SOURCE_REGEX = /source/i;
const FILE_NAME_REGEX = /file name/i;
const GENERATE_PLAN_REGEX = /generate plan/i;
const NEW_PLAN_REGEX = /new plan/i;
const CANCEL_REGEX = /cancel/i;
const PLAN_CREATED_WITH_REGEX = /plan will be created with:/i;
const TARGET_REPO_REGEX = /target repo:/i;
const TARGET_BRANCH_REGEX = /target branch:/i;
const TARGET_SELECTION_PROMPT_REGEX =
  /select a compute target to start generation/i;

describe("NewPlanModal", () => {
  const mockPush = vi.fn();
  const mockMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: mockPush });
    mockUseCreateArtifact.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });
    mockUseCreateAndGenerateArtifact.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      clearTargetSelection: vi.fn(),
      multiTargetState: null,
      selectTarget: vi.fn(),
    });
    mockUseArtifacts.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
    mockUseProjects.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
    mockUseProject.mockReturnValue({
      data: null,
      isLoading: false,
    });
    mockUsePreLoopGate.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  describe("Modal without source artifact (standalone mode)", () => {
    it("should allow submission without selecting a source artifact", async () => {
      // Controlled mode - modal is open
      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Fill in the required title field
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, {
        target: { value: "Standalone Implementation Plan" },
      });

      // Verify submit button is enabled (not disabled)
      await waitFor(() => {
        const submitButton = screen.getByRole("button", {
          name: CREATE_PLAN_REGEX,
        });
        expect(submitButton).not.toBeDisabled();
      });
    });

    it("should show project selector when no source is selected", async () => {
      const mockProjects = [
        { id: "project-1", name: "Project Alpha" },
        { id: "project-2", name: "Project Beta" },
      ];

      mockUseProjects.mockReturnValue({
        data: mockProjects,
        isLoading: false,
        error: null,
      });

      // Controlled mode - modal is open
      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Verify project selector is present
      await waitFor(() => {
        expect(screen.getByLabelText(PROJECT_REGEX)).toBeInTheDocument();
      });
    });

    it("should hide project selector when source PRD is selected", async () => {
      const mockPrds = [
        createMockDocument({
          id: "prd-1",
          title: "Dashboard PRD",
          type: DocumentType.Prd,
          projectId: "project-1",
        }),
      ];

      mockUseArtifacts.mockReturnValue({
        data: mockPrds,
        isLoading: false,
        error: null,
      });

      // Controlled mode - modal is open
      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Select a PRD
      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      await waitFor(() => {
        const option = screen.getByText("Dashboard PRD");
        option.click();
      });

      // Verify project selector is not shown
      await waitFor(() => {
        expect(
          screen.queryByLabelText(PROJECT_START_REGEX)
        ).not.toBeInTheDocument();
      });
    });

    it("should call create-only mutation when no source is selected", async () => {
      const mockOnOpenChange = vi.fn();

      // Mock successful creation
      mockMutate.mockImplementation((input, options) => {
        options?.onSuccess?.({
          ...input,
          id: "new-plan-123",
          slug: "standalone-plan",
        });
      });

      render(<NewPlanModal onOpenChange={mockOnOpenChange} open={true} />);

      // Fill in title
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Standalone Plan" } });

      // Submit
      const submitButton = screen.getByRole("button", {
        name: CREATE_PLAN_REGEX,
      });
      submitButton.click();

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalled();
      });

      // Verify mutation input
      const mutationInput = mockMutate.mock.calls[0][0];
      expect(mutationInput).toMatchObject({
        type: "IMPLEMENTATION_PLAN",
        title: "Standalone Plan",
        status: "DRAFT",
      });
      expect(mutationInput.sourceId).toBeUndefined();
      expect(mutationInput.workstreamId).toBeUndefined();
      expect(mutationInput.targetRepo).toBeUndefined();
      expect(mutationInput.targetBranch).toBeUndefined();
    });
  });

  describe("Modal with source (PRD mode)", () => {
    it("should pre-fill title and fileName from source", () => {
      const mockSource = createMockSource({
        id: "prd-1",
        title: "Dashboard Redesign PRD",
        fileName: "dashboard-redesign.md",
      });

      render(<NewPlanModal open={true} source={mockSource} />);

      // Verify title is pre-filled
      const titleInput = screen.getByLabelText(TITLE_REGEX) as HTMLInputElement;
      expect(titleInput.value).toBe("Plan: Dashboard Redesign PRD");

      // Verify fileName is pre-filled
      const fileNameInput = screen.getByLabelText(
        FILE_NAME_REGEX
      ) as HTMLInputElement;
      expect(fileNameInput.value).toBe("dashboard-redesign-plan.md");
    });

    it("should show source as read-only field", () => {
      const mockSource = createMockSource({
        id: "prd-1",
        title: "Dashboard Redesign PRD",
      });

      render(<NewPlanModal open={true} source={mockSource} />);

      // Verify source is displayed but not selectable
      expect(screen.getByText("Dashboard Redesign PRD")).toBeInTheDocument();

      // Verify there's no PRD dropdown (PrdSelector should not render)
      const sourceLabel = screen.getByText(SOURCE_REGEX, {
        selector: "label",
      });
      expect(sourceLabel.textContent).not.toContain("Source PRD");
      expect(sourceLabel.textContent).toContain("(optional)");
    });

    it("should not show project selector when source is provided", () => {
      const mockSource = createMockSource({
        id: "prd-1",
        title: "Dashboard Redesign PRD",
        projectId: "project-1",
      });

      render(<NewPlanModal open={true} source={mockSource} />);

      // Project selector should not be rendered
      expect(
        screen.queryByLabelText(PROJECT_START_REGEX)
      ).not.toBeInTheDocument();
    });

    it("should call create+generate mutation with source-derived fields", async () => {
      const mockCreateAndGenerateMutate = vi.fn();
      mockUseCreateAndGenerateArtifact.mockReturnValue({
        mutate: mockCreateAndGenerateMutate,
        isPending: false,
        clearTargetSelection: vi.fn(),
        multiTargetState: null,
        selectTarget: vi.fn(),
      });

      const mockSource = createMockSource({
        id: "prd-1",
        title: "Dashboard PRD",
        projectId: "project-1",
        workstreamId: "ws-1",
        targetRepo: "org/repo",
        targetBranch: "main",
      });

      mockCreateAndGenerateMutate.mockImplementation((input, options) => {
        options?.onSuccess?.({
          ...input,
          id: "new-plan-123",
          slug: "dashboard-plan",
        });
      });

      render(<NewPlanModal open={true} source={mockSource} />);

      // Submit the form (title is already pre-filled)
      const submitButton = screen.getByRole("button", {
        name: GENERATE_PLAN_REGEX,
      });
      submitButton.click();

      await waitFor(() => {
        expect(mockCreateAndGenerateMutate).toHaveBeenCalled();
      });

      // Verify mutation input includes source-derived fields
      const mutationArg = mockCreateAndGenerateMutate.mock.calls[0][0];
      expect(mutationArg.input).toMatchObject({
        type: "IMPLEMENTATION_PLAN",
        sourceId: "prd-1",
        projectId: "project-1",
        workstreamId: "ws-1",
        targetRepo: "org/repo",
        targetBranch: "main",
      });
    });

    it("does not create a generated plan until the pre-loop gate executes the callback", async () => {
      const mockCreateAndGenerateMutate = vi.fn();
      const mockRunWithPreLoopSystemCheck = vi
        .fn()
        .mockResolvedValue({ status: "blocked", attemptId: "attempt-1" });
      mockUseCreateAndGenerateArtifact.mockReturnValue({
        mutate: mockCreateAndGenerateMutate,
        isPending: false,
        clearTargetSelection: vi.fn(),
        multiTargetState: null,
        selectTarget: vi.fn(),
      });
      mockUsePreLoopGate.mockReturnValue({
        runWithPreLoopSystemCheck: mockRunWithPreLoopSystemCheck,
        cancelPendingPreLoopAttempt: vi.fn(),
        isChecking: false,
        isDialogOpen: false,
        pendingOwnerKey: null,
        pendingCommand: null,
      });

      const mockSource = createMockSource({
        id: "prd-1",
        title: "Dashboard PRD",
        projectId: "project-1",
        targetRepo: "org/repo",
      });

      render(<NewPlanModal open={true} source={mockSource} />);

      screen.getByRole("button", { name: GENERATE_PLAN_REGEX }).click();

      await waitFor(() => {
        expect(mockRunWithPreLoopSystemCheck).toHaveBeenCalledOnce();
      });
      expect(mockCreateAndGenerateMutate).not.toHaveBeenCalled();

      const [metadata, execute] = mockRunWithPreLoopSystemCheck.mock.calls[0];
      expect(metadata).toMatchObject({
        command: "generate_plan",
        documentType: "implementation_plan",
        ownerKey: expect.stringContaining("new-plan:"),
      });

      execute({});

      expect(mockCreateAndGenerateMutate).toHaveBeenCalledOnce();
      expect(mockCreateAndGenerateMutate.mock.calls[0][0].input).toMatchObject({
        type: "IMPLEMENTATION_PLAN",
        sourceId: "prd-1",
        projectId: "project-1",
        targetRepo: "org/repo",
      });
    });

    it("cancels a pending pre-loop generate attempt when the modal closes", () => {
      const mockCancelPending = vi.fn();
      mockUsePreLoopGate.mockReturnValue({
        runWithPreLoopSystemCheck: vi.fn(),
        cancelPendingPreLoopAttempt: mockCancelPending,
        isChecking: false,
        isDialogOpen: true,
        pendingOwnerKey: "some-owner",
        pendingCommand: "generate_plan",
      });

      render(
        <NewPlanModal
          onOpenChange={vi.fn()}
          open={true}
          source={createMockSource({ id: "prd-1" })}
        />
      );

      screen.getByRole("button", { name: CANCEL_REGEX }).click();

      expect(mockCancelPending).toHaveBeenCalledWith(
        expect.stringContaining("new-plan:")
      );
    });

    it("does not disable Generate Plan while another owner has a pre-loop check pending", () => {
      mockUsePreLoopGate.mockReturnValue({
        runWithPreLoopSystemCheck: vi.fn(),
        cancelPendingPreLoopAttempt: vi.fn(),
        isChecking: true,
        isDialogOpen: false,
        pendingOwnerKey: "other-owner",
        pendingCommand: "generate_plan",
      });

      render(
        <NewPlanModal
          open={true}
          source={createMockSource({
            id: "prd-1",
            title: "Dashboard PRD",
            targetRepo: "org/repo",
          })}
        />
      );

      const submitButton = screen.getByRole("button", {
        name: GENERATE_PLAN_REGEX,
      });
      expect(submitButton).not.toBeDisabled();
    });

    it("disables Generate Plan while post-create target selection is pending", () => {
      mockUseCreateAndGenerateArtifact.mockReturnValue({
        mutate: vi.fn(),
        isPending: false,
        clearTargetSelection: vi.fn(),
        multiTargetState: {
          availableTargets: [
            {
              id: "target-1",
              machineName: "Workstation",
              status: "online",
            },
          ],
        },
        selectTarget: vi.fn(),
      });

      render(
        <NewPlanModal
          open={true}
          source={createMockSource({
            id: "prd-1",
            title: "Dashboard PRD",
            projectId: "project-1",
            targetRepo: "org/repo",
          })}
        />
      );

      expect(
        screen.getByText(TARGET_SELECTION_PROMPT_REGEX)
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: GENERATE_PLAN_REGEX })
      ).toBeDisabled();
    });
  });

  describe("PRD selector behavior", () => {
    it("should load PRDs when modal opens without source artifact", async () => {
      const mockPrds = [
        createMockDocument({
          id: "prd-1",
          title: "Dashboard PRD",
          type: DocumentType.Prd,
        }),
        createMockDocument({
          id: "prd-2",
          title: "Authentication PRD",
          type: DocumentType.Prd,
        }),
      ];

      mockUseArtifacts.mockReturnValue({
        data: mockPrds,
        isLoading: false,
        error: null,
      });

      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Open PRD selector
      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      // Verify PRDs are loaded
      await waitFor(() => {
        expect(screen.getByText("Dashboard PRD")).toBeInTheDocument();
        expect(screen.getByText("Authentication PRD")).toBeInTheDocument();
      });
    });

    it("should update title and fileName when PRD is selected", async () => {
      const mockPrds = [
        createMockDocument({
          id: "prd-1",
          title: "Dashboard Redesign",
          type: DocumentType.Prd,
          fileName: "dashboard-redesign.md",
        }),
      ];

      mockUseArtifacts.mockReturnValue({
        data: mockPrds,
        isLoading: false,
        error: null,
      });

      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Select PRD
      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      await waitFor(() => {
        const option = screen.getByText("Dashboard Redesign");
        option.click();
      });

      // Verify title and fileName are updated
      await waitFor(() => {
        const titleInput = screen.getByLabelText(
          TITLE_REGEX
        ) as HTMLInputElement;
        expect(titleInput.value).toContain("Plan:");
        expect(titleInput.value).toContain("Dashboard Redesign");

        const fileNameInput = screen.getByLabelText(
          FILE_NAME_REGEX
        ) as HTMLInputElement;
        expect(fileNameInput.value).toBe("dashboard-redesign-plan.md");
      });
    });

    it("should show PlanPreview when PRD is selected", async () => {
      const mockPrds = [
        createMockDocument({
          id: "prd-1",
          title: "Dashboard PRD",
          type: DocumentType.Prd,
          targetRepo: "org/repo",
          targetBranch: "main",
        }),
      ];

      mockUseArtifacts.mockReturnValue({
        data: mockPrds,
        isLoading: false,
        error: null,
      });

      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Select PRD
      const prdSelector = screen.getByLabelText(SOURCE_PRD_REGEX);
      prdSelector.click();

      await waitFor(() => {
        const option = screen.getByText("Dashboard PRD");
        option.click();
      });

      // Verify PlanPreview appears with target repo/branch info
      await waitFor(() => {
        expect(screen.getByText(PLAN_CREATED_WITH_REGEX)).toBeInTheDocument();
        expect(screen.getByText(TARGET_REPO_REGEX)).toBeInTheDocument();
        expect(screen.getByText("org/repo")).toBeInTheDocument();
        expect(screen.getByText(TARGET_BRANCH_REGEX)).toBeInTheDocument();
        expect(screen.getByText("main")).toBeInTheDocument();
      });
    });
  });

  describe("Form validation", () => {
    it("should show error when submitting without title", () => {
      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Try to submit without entering a title
      const submitButton = screen.getByRole("button", {
        name: CREATE_PLAN_REGEX,
      });

      // Button should be disabled when title is empty
      expect(submitButton).toBeDisabled();
    });

    it("should enable submit button when title is filled", async () => {
      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Fill in title
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, {
        target: { value: "My Implementation Plan" },
      });

      // Submit button should be enabled
      await waitFor(() => {
        const submitButton = screen.getByRole("button", {
          name: CREATE_PLAN_REGEX,
        });
        expect(submitButton).not.toBeDisabled();
      });
    });

    it("should auto-generate fileName when title is entered", async () => {
      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Enter title
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "My Dashboard Plan" } });

      // Verify fileName is auto-generated
      await waitFor(() => {
        const fileNameInput = screen.getByLabelText(
          FILE_NAME_REGEX
        ) as HTMLInputElement;
        expect(fileNameInput.value).toBe("my-dashboard-plan-plan.md");
      });
    });
  });

  describe("Project selector behavior", () => {
    it("should load projects when modal opens and no source is selected", async () => {
      const mockProjects = [
        { id: "project-1", name: "Project Alpha" },
        { id: "project-2", name: "Project Beta" },
      ];

      mockUseProjects.mockReturnValue({
        data: mockProjects,
        isLoading: false,
        error: null,
      });

      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Open project selector
      const projectSelector = screen.getByLabelText(PROJECT_REGEX);
      projectSelector.click();

      // Verify projects are loaded
      await waitFor(() => {
        expect(screen.getByText("Project Alpha")).toBeInTheDocument();
        expect(screen.getByText("Project Beta")).toBeInTheDocument();
      });
    });

    it("should pass selected projectId to create mutation", async () => {
      const mockProjects = [
        { id: "project-1", name: "Project Alpha" },
        { id: "project-2", name: "Project Beta" },
      ];

      mockUseProjects.mockReturnValue({
        data: mockProjects,
        isLoading: false,
        error: null,
      });

      mockMutate.mockImplementation((input, options) => {
        options?.onSuccess?.({
          ...input,
          id: "new-plan-123",
          slug: "test-plan",
        });
      });

      render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

      // Fill in title
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Test Plan" } });

      // Select project
      const projectSelector = screen.getByLabelText(PROJECT_REGEX);
      projectSelector.click();

      await waitFor(() => {
        const option = screen.getByText("Project Alpha");
        option.click();
      });

      // Submit
      const submitButton = screen.getByRole("button", {
        name: CREATE_PLAN_REGEX,
      });
      submitButton.click();

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalled();
      });

      // Verify mutation includes projectId
      const mutationInput = mockMutate.mock.calls[0][0];
      expect(mutationInput.projectId).toBe("project-1");
    });
  });

  describe("Modal controls", () => {
    it("should render trigger button in uncontrolled mode", () => {
      render(<NewPlanModal />);

      expect(
        screen.getByRole("button", { name: NEW_PLAN_REGEX })
      ).toBeInTheDocument();
    });

    it("should not render trigger button in controlled mode", () => {
      render(<NewPlanModal onOpenChange={vi.fn()} open={false} />);

      expect(
        screen.queryByRole("button", { name: NEW_PLAN_REGEX })
      ).not.toBeInTheDocument();
    });

    it("should clear pending target selection state when closed", () => {
      const clearTargetSelection = vi.fn();
      const onOpenChange = vi.fn();
      mockUseCreateAndGenerateArtifact.mockReturnValue({
        mutate: vi.fn(),
        isPending: false,
        clearTargetSelection,
        multiTargetState: {
          availableTargets: [
            {
              id: "target-1",
              machineName: "Workstation",
              status: "online",
            },
          ],
        },
        selectTarget: vi.fn(),
      });

      render(<NewPlanModal onOpenChange={onOpenChange} open={true} />);

      fireEvent.click(screen.getByRole("button", { name: CANCEL_REGEX }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(clearTargetSelection).toHaveBeenCalledTimes(1);
    });
  });
});
