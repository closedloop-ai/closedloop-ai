import { useFeatureFlag } from "@repo/analytics/client";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocument } from "@/hooks/queries/use-documents";
import { useInitialAdditionalRepos } from "@/hooks/queries/use-loops";
import { useMultiRepoExecuteEnabled } from "@/hooks/use-multi-repo-execute-enabled";
import { ExecutePlanModal } from "../execute-plan-modal";

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
  useFeatureFlag: vi.fn(() => ({ key: "multi-repo-execute", enabled: false })),
}));

vi.mock("@/hooks/queries/use-documents", () => ({
  useDocument: vi.fn(() => ({
    data: { targetRepo: "org/primary-repo" },
    isLoading: false,
  })),
}));

vi.mock("@/hooks/queries/use-loops", () => ({
  useInitialAdditionalRepos: vi.fn(() => ({
    initialAdditionalRepos: undefined,
    isLoadingInitialAdditionalRepos: false,
  })),
}));

// ---- Top-level regex constants (Biome useTopLevelRegex) ----

const EXECUTE_BUTTON_REGEX = /execute plan/i;
const CANCEL_BUTTON_REGEX = /cancel/i;
const FLAG_OFF_BANNER_REGEX = /multi-repo execution is not yet available/i;
const ADD_REPO_REGEX = /add repository/i;

// ---- Helpers ----

const mockedUseFeatureFlag = vi.mocked(useFeatureFlag);
const mockedUseDocument = vi.mocked(useDocument);
const mockedUseInitialAdditionalRepos = vi.mocked(useInitialAdditionalRepos);

type ModalScenario = {
  multiRepoEnabled: boolean;
  initialAdditionalRepos?: { fullName: string; branch: string }[];
};

function setupScenario({
  multiRepoEnabled,
  initialAdditionalRepos,
}: ModalScenario) {
  mockedUseFeatureFlag.mockReturnValue({
    key: "multi-repo-execute",
    enabled: multiRepoEnabled,
    variant: undefined,
    payload: undefined,
  });
  mockedUseInitialAdditionalRepos.mockReturnValue({
    initialAdditionalRepos,
    isLoadingInitialAdditionalRepos: false,
  });
}

type ModalOverrides = Partial<React.ComponentProps<typeof ExecutePlanModal>>;

function renderModal(overrides: ModalOverrides = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ExecutePlanModal
      isLoading={false}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={true}
      planId="plan-id"
      {...overrides}
    />
  );
  return { onConfirm, onOpenChange };
}

// ---- Hook isolation tests ----

describe("useMultiRepoExecuteEnabled", () => {
  afterEach(() => {
    cleanup();
  });

  it("returns true when feature flag enabled is true", () => {
    mockedUseFeatureFlag.mockReturnValue({
      key: "multi-repo-execute",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    const { result } = renderHook(() => useMultiRepoExecuteEnabled());
    expect(result.current).toBe(true);
  });

  it("returns false when feature flag enabled is false", () => {
    mockedUseFeatureFlag.mockReturnValue({
      key: "multi-repo-execute",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });
    const { result } = renderHook(() => useMultiRepoExecuteEnabled());
    expect(result.current).toBe(false);
  });

  it("returns false when feature flag returns undefined", () => {
    mockedUseFeatureFlag.mockReturnValue(undefined);
    const { result } = renderHook(() => useMultiRepoExecuteEnabled());
    expect(result.current).toBe(false);
  });
});

// ---- ExecutePlanModal component tests ----

describe("ExecutePlanModal", () => {
  beforeEach(() => {
    mockedUseDocument.mockReturnValue({
      data: { targetRepo: "org/primary-repo" },
      isLoading: false,
    } as ReturnType<typeof useDocument>);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Case 1: flag-on with inherited repos renders picker
  it("renders AdditionalReposPicker when multiRepoEnabled and repos are inherited", () => {
    setupScenario({
      multiRepoEnabled: true,
      initialAdditionalRepos: [
        { fullName: "org/secondary-repo", branch: "main" },
      ],
    });
    renderModal();

    expect(
      screen.getByRole("button", { name: ADD_REPO_REGEX })
    ).toBeInTheDocument();
  });

  // Case 2: flag-on with incomplete rows disables Execute
  it("disables Execute button when multiRepoEnabled and repos are incomplete", () => {
    setupScenario({
      multiRepoEnabled: true,
      initialAdditionalRepos: [{ fullName: "", branch: "" }],
    });
    renderModal();

    const executeButton = screen.getByRole("button", {
      name: EXECUTE_BUTTON_REGEX,
    });
    expect(executeButton).toBeDisabled();
  });

  // Case 3: flag-off with inherited repos renders banner AND picker NOT rendered
  it("shows flag-off banner and does not render picker when multiRepoEnabled=false with inherited repos", () => {
    setupScenario({
      multiRepoEnabled: false,
      initialAdditionalRepos: [
        { fullName: "org/secondary-repo", branch: "main" },
      ],
    });
    renderModal();

    expect(screen.getByText(FLAG_OFF_BANNER_REGEX)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ADD_REPO_REGEX })
    ).not.toBeInTheDocument();
  });

  // Case 4: flag-off without inherited repos: no banner, no picker
  it("shows no banner and no picker when multiRepoEnabled=false and no inherited repos", () => {
    setupScenario({
      multiRepoEnabled: false,
      initialAdditionalRepos: undefined,
    });
    renderModal();

    expect(screen.queryByText(FLAG_OFF_BANNER_REGEX)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ADD_REPO_REGEX })
    ).not.toBeInTheDocument();
  });

  // Case 5: flag-on with empty/undefined initialAdditionalRepos: simple confirmation
  it("shows simple confirmation body when multiRepoEnabled=true but no inherited repos", () => {
    setupScenario({
      multiRepoEnabled: true,
      initialAdditionalRepos: undefined,
    });
    renderModal();

    expect(
      screen.queryByRole("button", { name: ADD_REPO_REGEX })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(FLAG_OFF_BANNER_REGEX)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: EXECUTE_BUTTON_REGEX })
    ).toBeInTheDocument();
  });

  // Case 6: flag-on repos complete: onConfirm called with repos
  it("calls onConfirm with repos when multiRepoEnabled=true and repos are complete", () => {
    setupScenario({
      multiRepoEnabled: true,
      initialAdditionalRepos: [
        { fullName: "org/secondary-repo", branch: "main" },
      ],
    });
    const { onConfirm } = renderModal();

    const executeButton = screen.getByRole("button", {
      name: EXECUTE_BUTTON_REGEX,
    });
    fireEvent.click(executeButton);

    expect(onConfirm).toHaveBeenCalledWith(
      [{ fullName: "org/secondary-repo", branch: "main" }],
      expect.any(Function)
    );
  });

  // Case 7: flag-off: onConfirm called with no arguments (defense-in-depth guard)
  it("calls onConfirm with undefined additionalRepos when multiRepoEnabled=false", () => {
    setupScenario({
      multiRepoEnabled: false,
      initialAdditionalRepos: [
        { fullName: "org/secondary-repo", branch: "main" },
      ],
    });
    const { onConfirm } = renderModal();

    const executeButton = screen.getByRole("button", {
      name: EXECUTE_BUTTON_REGEX,
    });
    fireEvent.click(executeButton);

    expect(onConfirm).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  // Cancel button renders
  it("renders Cancel button", () => {
    setupScenario({
      multiRepoEnabled: false,
      initialAdditionalRepos: undefined,
    });
    renderModal();

    expect(
      screen.getByRole("button", { name: CANCEL_BUTTON_REGEX })
    ).toBeInTheDocument();
  });
});
