import { DocumentType } from "@repo/api/src/types/document";
import type { JobRepoSelection } from "@repo/app/documents/editors/shared/job-repositories/selection";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateDocumentModal } from "../create-document-modal";

// Mock the hooks
const mockUseCreateArtifact = vi.fn();
const mockUseArtifact = vi.fn();
const mockUseArtifactsByProject = vi.fn();
const mockUseTeamMembers = vi.fn();
const mockUseProject = vi.fn();
const mockUseProjectsByTeam = vi.fn();

vi.mock("@repo/api/src/types/project", async () => {
  const actual = await vi.importActual("@repo/api/src/types/project");
  return {
    ...actual,
    getProjectSettings: () => ({}),
  };
});

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProject: (...args: unknown[]) => mockUseProject(...args),
  useProjectsByTeam: (...args: unknown[]) => mockUseProjectsByTeam(...args),
}));

vi.mock("@repo/app/documents/hooks/use-documents", async () => {
  const actual = await vi.importActual(
    "@repo/app/documents/hooks/use-documents"
  );
  return {
    ...actual,
    useCreateDocument: () => mockUseCreateArtifact(),
    useDocument: (...args: unknown[]) => mockUseArtifact(...args),
    useDocumentsByProject: (...args: unknown[]) =>
      mockUseArtifactsByProject(...args),
  };
});

vi.mock("@repo/app/teams/hooks/use-teams", () => ({
  useTeamMembers: (...args: unknown[]) => mockUseTeamMembers(...args),
}));

vi.mock(
  "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos",
  async () => {
    const actual = await vi.importActual<
      typeof import("@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos")
    >(
      "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos"
    );
    return {
      ...actual,
      useResolvedJobRepos: () => ({
        primary: null,
        additional: [],
        pool: [],
        isLoading: false,
      }),
    };
  }
);

// The section is the single repository control. The mock immediately projects
// a complete primary selection so PRD generation (which requires a non-empty
// targetRepo) has a repo to submit, mirroring the real section's behavior
// once a primary is chosen.
vi.mock("@repo/app/documents/editors/shared/job-repositories-section", () => ({
  JobRepositoriesSection: ({
    onChange,
  }: {
    onChange: (selection: JobRepoSelection | null) => void;
  }) => {
    // Emit a complete primary selection exactly once on mount. The parent
    // recreates its `onChange` handler every render, so depending on it would
    // loop; an empty-dep effect with a ref to the latest handler avoids that.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    useEffect(() => {
      onChangeRef.current({
        primary: { id: "repo-1", fullName: "org/repo", branch: "main" },
        additional: [],
      });
    }, []);
    return <div data-testid="job-repositories-section" />;
  },
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
const CANCEL_REGEX = /cancel/i;
const CREATE_IMPL_PLAN_REGEX = /create implementation plan/i;
const SAVE_REGEX = /^save$/i;
const CREATE_PRD_REGEX = /^create prd$/i;
const GENERATE_PRD_REGEX = /^generate prd$/i;
const PASTE_MARKDOWN_CONTENT_REGEX =
  /paste or upload the markdown content for this prd/i;
const CREATING_REGEX = /creating\.\.\./i;
const NO_PRDS_REGEX = /no prds or issues in this project/i;
const LOADING_REGEX = /loading/i;
const PROJECT_RETRY_REGEX = /^retry$/i;
const PROJECT_LABEL_REGEX = /^project/i;

describe("CreateDocumentModal", () => {
  const mockMutate = vi.fn();
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

    mockUseProject.mockReturnValue({
      data: null,
      isLoading: false,
    });

    mockUseProjectsByTeam.mockReturnValue({
      data: [],
      isLoading: false,
    });
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
          repositorySnapshot: {
            repositories: [
              {
                fullName: "org/repo",
                role: "primary",
                position: 0,
                branch: "main",
              },
            ],
            source: "project_defaults",
          },
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

    it("should pre-populate status from selected PRD", async () => {
      const mockPrds = [
        createMockDocument({
          id: "prd-1",
          title: "Test PRD",
          type: "PRD",
          status: "APPROVED",
        }),
      ];

      mockUseArtifactsByProject.mockReturnValue({
        data: mockPrds,
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

    it("offers only Create PRD — the retired Generate PRD action is gone", () => {
      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          projectId="project-1"
          teamId="team-1"
        />
      );

      expect(
        screen.getByRole("button", { name: CREATE_PRD_REGEX })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: GENERATE_PRD_REGEX })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: SAVE_REGEX })
      ).not.toBeInTheDocument();
    });
  });

  describe("Project selector (no projectId prop)", () => {
    it("surfaces a recoverable retry when the team-projects request fails instead of dead-ending on an empty selector", async () => {
      const refetch = vi.fn();
      mockUseProjectsByTeam.mockReturnValue({
        data: [],
        isLoading: false,
        isError: true,
        refetch,
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          teamId="team-1"
        />
      );

      const retry = screen.getByRole("button", { name: PROJECT_RETRY_REGEX });
      expect(retry).toBeInTheDocument();
      // No silent empty selector combobox in the error state.
      expect(
        screen.queryByLabelText(PROJECT_LABEL_REGEX)
      ).not.toBeInTheDocument();

      fireEvent.click(retry);
      await waitFor(() => {
        expect(refetch).toHaveBeenCalledOnce();
      });
    });

    it("renders the project selector (not the error state) when the team-projects request succeeds", () => {
      mockUseProjectsByTeam.mockReturnValue({
        data: [{ id: "project-1", name: "Project One" }],
        isLoading: false,
        isError: false,
      });

      render(
        <CreateDocumentModal
          documentType={DocumentType.Prd}
          onOpenChange={mockOnOpenChange}
          open={true}
          teamId="team-1"
        />
      );

      expect(screen.getByLabelText(PROJECT_LABEL_REGEX)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: PROJECT_RETRY_REGEX })
      ).not.toBeInTheDocument();
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

    it("should render the job repositories section for implementation plan", () => {
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
        screen.getByTestId("job-repositories-section")
      ).toBeInTheDocument();

      expect(screen.getByText("Approver")).toBeInTheDocument();
      expect(screen.getByText("Status")).toBeInTheDocument();
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
