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
  useFeatureFlag: vi.fn(() => ({ key: "multi-repo-plan", enabled: true })),
}));

// NewPlanModal dependencies (only needed for feature-flag tests)
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@/hooks/queries/use-artifacts", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-artifacts");
  return {
    ...actual,
    useArtifacts: () => ({ data: [], isLoading: false }),
    useCreateArtifact: () => ({ mutate: vi.fn(), isPending: false }),
    useCreateAndGenerateArtifact: () => ({ mutate: vi.fn(), isPending: false }),
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

// ---- Regex constants (top-level to satisfy Biome useTopLevelRegex) ----

const ADD_REPO_REGEX = /add repository/i;
const MAX_REACHED_REGEX = /maximum of.*additional repositories reached/i;
const REPO_1_REGEX = /repository 1/i;
const PRIMARY_REPO_ERROR_REGEX = /cannot use the primary repository/i;
const DUPLICATE_REPO_ERROR_REGEX = /duplicate repository/i;

// ---- Helpers ----

function renderPicker(
  overrides: Partial<Parameters<typeof AdditionalReposPicker>[0]> = {}
) {
  const onChange = vi.fn();
  const onValidChange = vi.fn();
  render(
    <AdditionalReposPicker
      onChange={onChange}
      onValidChange={onValidChange}
      targetRepo="org/primary-repo"
      value={[]}
      {...overrides}
    />
  );
  return { onChange, onValidChange };
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

      // The trash icon button is the only button rendered inside the row card
      const removeButtons = screen.getAllByRole("button", {
        name: (_, el) => el?.querySelector("svg") !== null,
      });
      fireEvent.click(removeButtons[0]);

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

      renderPicker({ value: fullRows, targetRepo: "org/primary-repo" });

      expect(
        screen.queryByRole("button", { name: ADD_REPO_REGEX })
      ).not.toBeInTheDocument();
      expect(screen.getByText(MAX_REACHED_REGEX)).toBeInTheDocument();
    });
  });

  describe("primary-repo conflict validation", () => {
    it("shows an error and marks invalid when a row's fullName matches targetRepo (case-insensitive)", () => {
      const { onValidChange } = renderPicker({
        value: [{ fullName: "Org/Primary-Repo", branch: "main" }],
        targetRepo: "org/primary-repo",
      });

      expect(screen.getByText(PRIMARY_REPO_ERROR_REGEX)).toBeInTheDocument();
      expect(onValidChange).toHaveBeenCalledWith(false);
    });
  });

  describe("duplicate detection", () => {
    it("shows a duplicate error and marks invalid when two rows select the same repo (case-insensitive)", () => {
      const { onValidChange } = renderPicker({
        value: [
          { fullName: "org/shared-repo", branch: "main" },
          { fullName: "Org/Shared-Repo", branch: "develop" },
        ],
        targetRepo: "org/primary-repo",
      });

      expect(screen.getByText(DUPLICATE_REPO_ERROR_REGEX)).toBeInTheDocument();
      expect(onValidChange).toHaveBeenCalledWith(false);
    });
  });

  describe("valid state", () => {
    it("calls onValidChange with true when all rows are complete and have no conflicts", () => {
      const { onValidChange } = renderPicker({
        value: [
          { fullName: "org/repo-a", branch: "main" },
          { fullName: "org/repo-b", branch: "develop" },
        ],
        targetRepo: "org/primary-repo",
      });

      expect(onValidChange).toHaveBeenCalledWith(true);
    });
  });

  describe("onChange propagation", () => {
    it("calls onChange with projected row data when a row is added", async () => {
      const { onChange } = renderPicker();

      fireEvent.click(screen.getByRole("button", { name: ADD_REPO_REGEX }));

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith([{ fullName: "", branch: "" }]);
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
      key: "multi-repo-plan",
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
      key: "multi-repo-plan",
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

  it("renders AdditionalReposPicker when feature flag returns undefined (fail-open)", async () => {
    vi.mocked(useFeatureFlag).mockReturnValue(undefined);

    render(<NewPlanModal onOpenChange={vi.fn()} open={true} />);

    // isMultiRepoPickerVisible treats undefined as enabled — picker must render
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: ADD_REPO_REGEX })
      ).toBeInTheDocument();
    });
  });
});
