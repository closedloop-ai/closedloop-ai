import { DocumentType } from "@repo/api/src/types/document";
import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMultiRepoPrdEnabled } from "@/hooks/use-multi-repo-prd-enabled";
import { CreateDocumentModal } from "../create-document-modal";

// ---- Module-level mocks ----

// Mock at the useMultiRepoPrdEnabled layer as instructed
vi.mock("@/hooks/use-multi-repo-prd-enabled", () => ({
  useMultiRepoPrdEnabled: vi.fn(() => false),
}));

// Controllable AdditionalReposPicker mock so individual tests can inject a
// fully-completed row without driving Radix Select interactions in jsdom.
//
// Default implementation: a stateful component that renders an "Add Repository"
// button. When clicked it shows a "Repository 1" row label and reports an
// incomplete row to the parent — preserving the behavior that existing tests
// rely on (disabled Generate PRD, reset-on-cancel, etc.).
//
// Individual tests override mockAdditionalReposPickerImpl to simulate other
// picker states (e.g. a fully-completed row already present on mount).
type PickerProps = {
  onChange: (repos: AdditionalRepoRef[]) => void;
  onIncompleteChange?: (hasIncomplete: boolean) => void;
  initialValue: AdditionalRepoRef[];
  targetRepo: string;
};

// Simulates the real picker: "Add Repository" button adds a row that shows
// "Repository 1" and marks the form incomplete until the row is removed.
function DefaultPickerImpl({ onChange, onIncompleteChange }: PickerProps) {
  const [rowCount, setRowCount] = useState(0);
  return (
    <div>
      {Array.from({ length: rowCount }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable, test-only
        <span key={i}>Repository {i + 1}</span>
      ))}
      <button
        onClick={() => {
          const next = rowCount + 1;
          setRowCount(next);
          onIncompleteChange?.(true);
          onChange([]);
        }}
        type="button"
      >
        Add Repository
      </button>
    </div>
  );
}

let mockAdditionalReposPickerImpl: (props: PickerProps) => React.ReactNode = (
  props
) => <DefaultPickerImpl {...props} />;

vi.mock(
  "@/app/(authenticated)/implementation-plans/components/additional-repos-picker",
  () => ({
    AdditionalReposPicker: (props: PickerProps) =>
      mockAdditionalReposPickerImpl(props),
  })
);

vi.mock("@/hooks/queries/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({
    data: { connected: true },
    isLoading: false,
  }),
  useGitHubRepositories: () => ({
    data: [
      { id: "repo-1", name: "primary-repo", fullName: "org/primary-repo" },
    ],
    isLoading: false,
  }),
  useGitHubBranches: () => ({ data: { branches: [] }, isLoading: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/hooks/queries/use-documents", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-documents");
  return {
    ...actual,
    useCreateDocument: () => mockUseCreateDocument(),
    useDocumentsByProject: (...args: unknown[]) =>
      mockUseDocumentsByProject(...args),
  };
});

vi.mock("@/hooks/queries/use-loops", () => ({
  useRunLoop: () => mockUseRunLoop(),
}));

vi.mock("@/hooks/queries/use-projects", () => ({
  useProject: (...args: unknown[]) => mockUseProject(...args),
  useProjectsByTeam: (...args: unknown[]) => mockUseProjectsByTeam(...args),
}));

vi.mock("@/hooks/queries/use-teams", () => ({
  useTeamMembers: (...args: unknown[]) => mockUseTeamMembers(...args),
}));

vi.mock("@repo/api/src/types/project", async () => {
  const actual = await vi.importActual("@repo/api/src/types/project");
  return {
    ...actual,
    getProjectSettings: () => ({}),
  };
});

// ---- Mock function declarations (must be defined before vi.mock factory usage) ----

const mockUseCreateDocument = vi.fn();
const mockUseRunLoop = vi.fn();
const mockUseDocumentsByProject = vi.fn();
const mockUseProject = vi.fn();
const mockUseProjectsByTeam = vi.fn();
const mockUseTeamMembers = vi.fn();

// ---- Top-level regex constants (Biome useTopLevelRegex) ----

const ADD_REPO_REGEX = /add repository/i;
const CANCEL_REGEX = /cancel/i;
const GENERATE_PRD_REGEX = /^generate prd$/i;
const REPO_1_REGEX = /repository 1/i;
const TITLE_REGEX = /title/i;
const ADDITIONAL_REPOS_LABEL_REGEX = /additional repositories/i;
const TARGET_REPOSITORY_REGEX = /target repository/i;

// ---- Helpers ----

// cmdk (Popover+Command) needs ResizeObserver which jsdom does not provide.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockedUseMultiRepoPrdEnabled = vi.mocked(useMultiRepoPrdEnabled);

type ModalOverrides = Partial<React.ComponentProps<typeof CreateDocumentModal>>;

function renderModal(overrides: ModalOverrides = {}) {
  const onOpenChange = vi.fn();
  render(
    <CreateDocumentModal
      documentType={DocumentType.Prd}
      onOpenChange={onOpenChange}
      open={true}
      projectId="project-1"
      teamId="team-1"
      {...overrides}
    />
  );
  return { onOpenChange };
}

// ---- Tests ----

describe("CreateDocumentModal — multi-repo PRD picker", () => {
  const mockMutate = vi.fn();
  const mockRunLoopMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    mockAdditionalReposPickerImpl = (props) => <DefaultPickerImpl {...props} />;

    mockUseCreateDocument.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    });

    mockUseRunLoop.mockReturnValue({
      mutate: mockRunLoopMutate,
      isPending: false,
    });

    mockUseDocumentsByProject.mockReturnValue({
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

    mockUseTeamMembers.mockReturnValue({
      data: [],
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders AdditionalReposPicker below target repo when flag is on and documentType is PRD", async () => {
    mockedUseMultiRepoPrdEnabled.mockReturnValue(true);

    renderModal({ documentType: DocumentType.Prd });

    await waitFor(() => {
      expect(
        screen.getByText(ADDITIONAL_REPOS_LABEL_REGEX)
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: ADD_REPO_REGEX })
      ).toBeInTheDocument();
    });
  });

  it("does not render AdditionalReposPicker when flag is off", async () => {
    mockedUseMultiRepoPrdEnabled.mockReturnValue(false);

    renderModal({ documentType: DocumentType.Prd });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: ADD_REPO_REGEX })
      ).not.toBeInTheDocument();
    });
  });

  it("does not render AdditionalReposPicker for non-PRD document types", async () => {
    mockedUseMultiRepoPrdEnabled.mockReturnValue(true);

    renderModal({ documentType: DocumentType.ImplementationPlan });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: ADD_REPO_REGEX })
      ).not.toBeInTheDocument();
    });
  });

  it("disables Generate PRD button when an added repository row is incomplete", async () => {
    mockedUseMultiRepoPrdEnabled.mockReturnValue(true);

    renderModal({ documentType: DocumentType.Prd });

    // Fill in the required title so canGenerate is only blocked by incomplete row
    const titleInput = screen.getByLabelText(TITLE_REGEX);
    fireEvent.change(titleInput, { target: { value: "My PRD" } });

    // Wait for picker to render
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: ADD_REPO_REGEX })
      ).toBeInTheDocument();
    });

    // Click "Add Repository" to add an incomplete row via fireEvent.click
    fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));

    // Generate PRD button should now be disabled because the row is incomplete
    await waitFor(() => {
      const generateButton = screen.getByRole("button", {
        name: GENERATE_PRD_REGEX,
      });
      expect(generateButton).toBeDisabled();
    });
  });

  it("omits additionalRepos from runLoop.mutate payload when flag is on but picker has no rows", async () => {
    // Verifies the conditional-spread guard:
    //   ...(additionalRepos.length > 0 && { additionalRepos })
    // collapses to nothing when the picker is empty, so the wire payload is
    // byte-identical to the flag-off / single-repo path. The positive case
    // (flag on AND picker has a complete row) is covered separately below by
    // "includes additionalRepos in runLoop.mutate payload when flag is on and
    // picker has a complete row".
    mockedUseMultiRepoPrdEnabled.mockReturnValue(true);

    // Simulate createDocument.mutate calling onSuccess so runLoop.mutate is triggered
    mockMutate.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess?: (artifact: { id: string }) => void }
      ) => {
        options?.onSuccess?.({ id: "new-prd-123" });
      }
    );

    renderModal({ documentType: DocumentType.Prd });

    // Fill required title
    const titleInput = screen.getByLabelText(TITLE_REGEX);
    fireEvent.change(titleInput, { target: { value: "Multi-Repo PRD" } });

    // Select a repository so that targetRepo is non-empty (required by handleGenerate)
    const repoSelector = screen.getByRole("combobox", {
      name: TARGET_REPOSITORY_REGEX,
    });
    repoSelector.click();

    await waitFor(() => {
      screen.getByText("org/primary-repo").click();
    });

    // Wait for the Generate PRD button to be enabled
    const generateButton = await screen.findByRole("button", {
      name: GENERATE_PRD_REGEX,
    });

    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(mockRunLoopMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "new-prd-123",
          command: RunLoopCommand.GeneratePrd,
        }),
        expect.objectContaining({
          onError: expect.any(Function),
        })
      );
      const callArg = mockRunLoopMutate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(callArg).not.toHaveProperty("additionalRepos");
    });
  });

  it("does not include additionalRepos in runLoop.mutate payload when flag is off (defense-in-depth)", async () => {
    mockedUseMultiRepoPrdEnabled.mockReturnValue(false);

    mockMutate.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess?: (artifact: { id: string }) => void }
      ) => {
        options?.onSuccess?.({ id: "new-prd-456" });
      }
    );

    renderModal({ documentType: DocumentType.Prd });

    const titleInput = screen.getByLabelText(TITLE_REGEX);
    fireEvent.change(titleInput, { target: { value: "Flag-Off PRD" } });

    // Select a repository so that targetRepo is non-empty (required by handleGenerate)
    const repoSelector = screen.getByRole("combobox", {
      name: TARGET_REPOSITORY_REGEX,
    });
    repoSelector.click();

    await waitFor(() => {
      screen.getByText("org/primary-repo").click();
    });

    const generateButton = await screen.findByRole("button", {
      name: GENERATE_PRD_REGEX,
    });
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(mockRunLoopMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "new-prd-456",
          command: RunLoopCommand.GeneratePrd,
        }),
        expect.objectContaining({
          onError: expect.any(Function),
        })
      );
      const callArg = mockRunLoopMutate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(callArg).not.toHaveProperty("additionalRepos");
    });
  });

  // Case 2 already covers flag=false, which implicitly covers undefined/loading
  // since useFeatureFlagEnabled returns false when flag?.enabled !== true.

  it("includes additionalRepos in runLoop.mutate payload when flag is on and picker has a complete row", async () => {
    mockedUseMultiRepoPrdEnabled.mockReturnValue(true);

    // Override the picker with a component that surfaces a complete row to the
    // parent after mount. Using useEffect so the state update happens outside
    // the render phase, matching the real picker's projectToParent behavior.
    function CompleteRowPickerImpl({
      onChange,
      onIncompleteChange,
    }: PickerProps) {
      useEffect(() => {
        onChange([{ fullName: "org/secondary-repo", branch: "feature" }]);
        onIncompleteChange?.(false);
      }, [onChange, onIncompleteChange]);
      return <span>org/secondary-repo (feature)</span>;
    }
    mockAdditionalReposPickerImpl = (props) => (
      <CompleteRowPickerImpl {...props} />
    );

    mockMutate.mockImplementation(
      (
        _input: unknown,
        options: { onSuccess?: (artifact: { id: string }) => void }
      ) => {
        options?.onSuccess?.({ id: "new-prd-789" });
      }
    );

    renderModal({ documentType: DocumentType.Prd });

    // Fill in the required title
    const titleInput = screen.getByLabelText(TITLE_REGEX);
    fireEvent.change(titleInput, { target: { value: "Multi-Repo PRD" } });

    // Select the primary repository so targetRepo is set (required by handleGenerate)
    const repoSelector = screen.getByRole("combobox", {
      name: TARGET_REPOSITORY_REGEX,
    });
    repoSelector.click();

    await waitFor(() => {
      screen.getByText("org/primary-repo").click();
    });

    const generateButton = await screen.findByRole("button", {
      name: GENERATE_PRD_REGEX,
    });
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(mockRunLoopMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "new-prd-789",
          command: RunLoopCommand.GeneratePrd,
          additionalRepos: [
            { fullName: "org/secondary-repo", branch: "feature" },
          ],
        }),
        expect.objectContaining({
          onError: expect.any(Function),
        })
      );
    });
  });

  it("shows an empty picker (no rows) when modal is reopened after cancel", async () => {
    mockedUseMultiRepoPrdEnabled.mockReturnValue(true);

    const onOpenChange = vi.fn();

    // First render — open modal
    const { unmount } = render(
      <CreateDocumentModal
        documentType={DocumentType.Prd}
        onOpenChange={onOpenChange}
        open={true}
        projectId="project-1"
        teamId="team-1"
      />
    );

    // Wait for picker to appear
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: ADD_REPO_REGEX })
      ).toBeInTheDocument();
    });

    // Add a repository row
    fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));

    // Verify a row was added (there is now a "Repository 1" header)
    await waitFor(() => {
      expect(screen.getByText(REPO_1_REGEX)).toBeInTheDocument();
    });

    // Cancel (close) the modal — resetForm() clears additionalRepos to []
    const cancelButton = screen.getByRole("button", { name: CANCEL_REGEX });
    fireEvent.click(cancelButton);

    // Unmount and remount the modal in open state (simulates user reopening it)
    unmount();

    render(
      <CreateDocumentModal
        documentType={DocumentType.Prd}
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
        teamId="team-1"
      />
    );

    // The picker should appear with no rows (no "Repository 1" label)
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: ADD_REPO_REGEX })
      ).toBeInTheDocument();
      expect(screen.queryByText(REPO_1_REGEX)).not.toBeInTheDocument();
    });
  });
});
