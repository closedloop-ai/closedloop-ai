import { useFeatureFlag } from "@repo/analytics/client";
import { MAX_ADDITIONAL_REPOS } from "@repo/api/src/types/loop";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdditionalReposPicker } from "../additional-repos-picker";
import { NewPlanModal } from "../new-plan-modal";

// ---- Module-level mocks ----

vi.mock("@/hooks/queries/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({
    data: { connected: false },
    isLoading: false,
  }),
  useGitHubRepositories: () => ({ data: [], isLoading: false }),
  useGitHubBranches: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: vi.fn(() => ({ key: "multi-repo-execute", enabled: true })),
}));

// NewPlanModal dependencies (only needed for feature-flag tests)
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/hooks/queries/use-documents", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-documents");
  return {
    ...actual,
    useDocuments: () => ({ data: [], isLoading: false }),
    useCreateDocument: () => ({ mutate: vi.fn(), isPending: false }),
    useCreateAndGenerateDocument: () => ({
      mutate: vi.fn(),
      isPending: false,
      clearTargetSelection: vi.fn(),
      multiTargetState: null,
      selectTarget: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/queries/use-projects", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-projects");
  return {
    ...actual,
    useProjects: () => ({ data: [], isLoading: false }),
    useProject: () => ({ data: null, isLoading: false }),
  };
});

vi.mock("@repo/api/src/types/project", async () => {
  const actual = await vi.importActual("@repo/api/src/types/project");
  return { ...actual, getProjectSettings: () => ({}) };
});

// PLN-462: NewPlanModal reads the inherited peer set via TanStack Query.
// Stub it so this test doesn't need a QueryClientProvider.
vi.mock("@/hooks/queries/use-loops", () => ({
  useInheritedAdditionalRepos: () => ({
    data: { additionalRepos: [], source: null },
    isFetched: true,
  }),
}));

// PLN-237: NewPlanModal resolves the project's primary repo via
// `useTeamRepositoriesUnion` (TanStack `useQueries`). Stub it so this test
// doesn't need a QueryClientProvider.
vi.mock("@/hooks/use-team-repositories-union", () => ({
  useTeamRepositoriesUnion: () => ({
    repositories: [],
    isLoading: false,
    error: null,
  }),
}));

// ---- Regex constants (top-level to satisfy Biome useTopLevelRegex) ----

const ADD_REPO_REGEX = /add repository/i;
const REMOVE_REPO_REGEX = /remove repository/i;
const MAX_REACHED_REGEX = /maximum of.*additional repositories reached/i;
const REPO_1_REGEX = /repository 1/i;
const PRIMARY_REPO_ERROR_REGEX = /cannot use the primary repository/i;
const DUPLICATE_REPO_ERROR_REGEX = /duplicate repository/i;
const GENERATE_PLAN_REGEX = /generate plan/i;

// ---- Helpers ----

function renderPicker(
  overrides: Partial<Parameters<typeof AdditionalReposPicker>[0]> = {}
) {
  const onChange = vi.fn();
  const onIncompleteChange = vi.fn();
  render(
    <AdditionalReposPicker
      initialValue={[]}
      onChange={onChange}
      onIncompleteChange={onIncompleteChange}
      targetRepo="org/primary-repo"
      {...overrides}
    />
  );
  return { onChange, onIncompleteChange };
}

// ---- Tests ----

describe("AdditionalReposPicker", () => {
  afterEach(() => {
    cleanup();
  });

  describe("adding rows", () => {
    it("adds a row when the Add Repository button is clicked", async () => {
      renderPicker();

      fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));

      await waitFor(() => {
        expect(screen.getByText(REPO_1_REGEX)).toBeInTheDocument();
      });
    });

    it("adds multiple rows up to MAX_ADDITIONAL_REPOS", async () => {
      renderPicker();

      for (let i = 0; i < MAX_ADDITIONAL_REPOS; i++) {
        fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));
      }

      await waitFor(() => {
        expect(
          screen.getByText(`Repository ${MAX_ADDITIONAL_REPOS}`)
        ).toBeInTheDocument();
      });
    });
  });

  describe("removing rows", () => {
    it("removes a row when its remove button is clicked", async () => {
      renderPicker();

      // Add one row first
      fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));
      await waitFor(() => {
        expect(screen.getByText(REPO_1_REGEX)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: REMOVE_REPO_REGEX }));

      await waitFor(() => {
        expect(screen.queryByText(REPO_1_REGEX)).not.toBeInTheDocument();
      });
    });
  });

  describe("max-count enforcement", () => {
    it("hides the Add Repository button and shows the limit-reached message when MAX_ADDITIONAL_REPOS rows exist", () => {
      const fullRows = Array.from({ length: MAX_ADDITIONAL_REPOS }, (_, i) => ({
        fullName: `org/repo-${i + 1}`,
        branch: "main",
      }));

      renderPicker({ initialValue: fullRows, targetRepo: "org/primary-repo" });

      expect(
        screen.queryByRole("button", { name: ADD_REPO_REGEX })
      ).not.toBeInTheDocument();
      expect(screen.getByText(MAX_REACHED_REGEX)).toBeInTheDocument();
    });
  });

  describe("primary-repo conflict validation", () => {
    it("shows an error when a row's fullName matches targetRepo (case-insensitive)", () => {
      renderPicker({
        initialValue: [{ fullName: "Org/Primary-Repo", branch: "main" }],
        targetRepo: "org/primary-repo",
      });

      expect(screen.getByText(PRIMARY_REPO_ERROR_REGEX)).toBeInTheDocument();
    });
  });

  describe("duplicate detection", () => {
    it("shows a duplicate error when two rows select the same repo (case-insensitive)", () => {
      renderPicker({
        initialValue: [
          { fullName: "org/shared-repo", branch: "main" },
          { fullName: "Org/Shared-Repo", branch: "develop" },
        ],
        targetRepo: "org/primary-repo",
      });

      expect(screen.getByText(DUPLICATE_REPO_ERROR_REGEX)).toBeInTheDocument();
    });
  });

  describe("onChange propagation", () => {
    it("does not propagate placeholder rows to the parent when a new row is added", async () => {
      const { onChange, onIncompleteChange } = renderPicker();

      fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));

      await waitFor(() => {
        expect(screen.getByText(REPO_1_REGEX)).toBeInTheDocument();
      });

      // Parent state should never receive an invalid { fullName: "", branch: "" }
      // — only fully-specified rows leak upstream via onChange.
      expect(onChange).toHaveBeenCalledWith([]);
      expect(onChange).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ fullName: "", branch: "" }),
        ])
      );
      // But the parent is told the form has an incomplete row so it can
      // disable submit until the user finishes filling the row.
      expect(onIncompleteChange).toHaveBeenCalledWith(true);
    });

    it("reports incomplete → complete transition when a row is removed", async () => {
      const { onIncompleteChange } = renderPicker();

      fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));
      await waitFor(() => {
        expect(screen.getByText(REPO_1_REGEX)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: REMOVE_REPO_REGEX }));

      await waitFor(() => {
        expect(onIncompleteChange).toHaveBeenLastCalledWith(false);
      });
    });
  });
});

describe("NewPlanModal — feature flag behavior for AdditionalReposPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders AdditionalReposPicker when feature flag is enabled", async () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "multi-repo-execute",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });

    render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

    // The picker shows the "Add Repository" button when visible
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: ADD_REPO_REGEX })
      ).toBeInTheDocument();
    });
  });

  it("does not render AdditionalReposPicker when feature flag is explicitly disabled", async () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "multi-repo-execute",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });

    render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: ADD_REPO_REGEX })
      ).not.toBeInTheDocument();
    });
  });

  it("does not render AdditionalReposPicker when feature flag returns undefined (default-off)", async () => {
    vi.mocked(useFeatureFlag).mockReturnValue(undefined);

    render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

    // Picker gate uses `=== true`, matching branch-pr / chat convention —
    // unassigned users do not see the picker during rollout.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: ADD_REPO_REGEX })
      ).not.toBeInTheDocument();
    });
  });

  it("disables Generate Plan when an added repository row is incomplete", async () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "multi-repo-execute",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });

    render(
      <NewPlanModal
        onOpenChange={vi.fn()}
        open={true}
        source={{
          id: "prd-1",
          targetBranch: "main",
          targetRepo: "org/primary-repo",
          title: "Dashboard PRD",
        }}
      />
    );

    const submitButton = screen.getByRole("button", {
      name: GENERATE_PLAN_REGEX,
    });
    expect(submitButton).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));

    await waitFor(() => {
      expect(submitButton).toBeDisabled();
    });
  });
});
