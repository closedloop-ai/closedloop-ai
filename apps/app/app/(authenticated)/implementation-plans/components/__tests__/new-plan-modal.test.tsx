import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import { NewPlanModal } from "../new-plan-modal";

// Mock the hooks
const mockUseRouter = vi.fn();
const mockUseArtifacts = vi.fn();
const mockUseCreateArtifact = vi.fn();
const mockUseCreateAndGenerateArtifact = vi.fn();
const mockUseProjects = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => mockUseRouter(),
}));

vi.mock("@/hooks/queries/use-artifacts", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-artifacts");
  return {
    ...actual,
    useArtifacts: () => mockUseArtifacts(),
    useCreateArtifact: () => mockUseCreateArtifact(),
    useCreateAndGenerateArtifact: () => mockUseCreateAndGenerateArtifact(),
  };
});

vi.mock("@/hooks/queries/use-projects", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-projects");
  return {
    ...actual,
    useProjects: () => mockUseProjects(),
  };
});

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
        createMockArtifact({
          id: "prd-1",
          title: "Dashboard PRD",
          type: "PRD",
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

  describe("Modal with source artifact (PRD mode)", () => {
    it("should pre-fill title and fileName from source artifact", () => {
      const mockSourceArtifact = createMockArtifact({
        id: "prd-1",
        title: "Dashboard Redesign PRD",
        type: "PRD",
        fileName: "dashboard-redesign.md",
      });

      render(<NewPlanModal open={true} sourceArtifact={mockSourceArtifact} />);

      // Verify title is pre-filled
      const titleInput = screen.getByLabelText(TITLE_REGEX) as HTMLInputElement;
      expect(titleInput.value).toBe(
        "Implementation Plan: Dashboard Redesign PRD"
      );

      // Verify fileName is pre-filled
      const fileNameInput = screen.getByLabelText(
        FILE_NAME_REGEX
      ) as HTMLInputElement;
      expect(fileNameInput.value).toBe("dashboard-redesign-impl-plan.md");
    });

    it("should show source artifact as read-only field", () => {
      const mockSourceArtifact = createMockArtifact({
        id: "prd-1",
        title: "Dashboard Redesign PRD",
        type: "PRD",
      });

      render(<NewPlanModal open={true} sourceArtifact={mockSourceArtifact} />);

      // Verify source artifact is displayed but not selectable
      expect(screen.getByText("Dashboard Redesign PRD")).toBeInTheDocument();

      // Verify there's no PRD dropdown (PrdSelector should not render)
      const sourceLabel = screen.getByText(SOURCE_REGEX, {
        selector: "label",
      });
      expect(sourceLabel.textContent).not.toContain("Source PRD");
      expect(sourceLabel.textContent).toContain("(optional)");
    });

    it("should not show project selector when source artifact is provided", () => {
      const mockSourceArtifact = createMockArtifact({
        id: "prd-1",
        title: "Dashboard Redesign PRD",
        type: "PRD",
        projectId: "project-1",
      });

      render(<NewPlanModal open={true} sourceArtifact={mockSourceArtifact} />);

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
      });

      const mockSourceArtifact = createMockArtifact({
        id: "prd-1",
        title: "Dashboard PRD",
        type: "PRD",
        projectId: "project-1",
        workstreamId: "ws-1",
        targetRepo: "org/repo",
        targetBranch: "main",
      });

      mockCreateAndGenerateMutate.mockImplementation((input, options) => {
        options?.onSuccess?.({
          ...input,
          id: "new-plan-123",
          slug: "dashboard-impl-plan",
        });
      });

      render(<NewPlanModal open={true} sourceArtifact={mockSourceArtifact} />);

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
      expect(mutationArg).toMatchObject({
        type: "IMPLEMENTATION_PLAN",
        sourceId: "prd-1",
        projectId: "project-1",
        workstreamId: "ws-1",
        targetRepo: "org/repo",
        targetBranch: "main",
      });
    });
  });

  describe("PRD selector behavior", () => {
    it("should load PRDs when modal opens without source artifact", async () => {
      const mockPrds = [
        createMockArtifact({
          id: "prd-1",
          title: "Dashboard PRD",
          type: "PRD",
        }),
        createMockArtifact({
          id: "prd-2",
          title: "Authentication PRD",
          type: "PRD",
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
        createMockArtifact({
          id: "prd-1",
          title: "Dashboard Redesign",
          type: "PRD",
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
        expect(titleInput.value).toContain("Implementation Plan:");
        expect(titleInput.value).toContain("Dashboard Redesign");

        const fileNameInput = screen.getByLabelText(
          FILE_NAME_REGEX
        ) as HTMLInputElement;
        expect(fileNameInput.value).toBe("dashboard-redesign-impl-plan.md");
      });
    });

    it("should show PlanPreview when PRD is selected", async () => {
      const mockPrds = [
        createMockArtifact({
          id: "prd-1",
          title: "Dashboard PRD",
          type: "PRD",
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
        expect(fileNameInput.value).toBe("my-dashboard-plan-impl-plan.md");
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

    it("should reset form when modal is closed", async () => {
      const mockOnOpenChange = vi.fn();

      const { rerender } = render(
        <NewPlanModal onOpenChange={mockOnOpenChange} open={true} />
      );

      // Fill in some fields
      const titleInput = screen.getByLabelText(TITLE_REGEX);
      fireEvent.change(titleInput, { target: { value: "Test Title" } });

      // Close modal
      const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
      cancelButton.click();

      await waitFor(() => {
        expect(mockOnOpenChange).toHaveBeenCalledWith(false);
      });

      // Reopen modal - form should be reset
      mockOnOpenChange.mockClear();
      rerender(<NewPlanModal onOpenChange={mockOnOpenChange} open={true} />);

      await waitFor(() => {
        const titleInputReset = screen.getByLabelText(
          TITLE_REGEX
        ) as HTMLInputElement;
        expect(titleInputReset.value).toBe("");
      });
    });
  });
});
