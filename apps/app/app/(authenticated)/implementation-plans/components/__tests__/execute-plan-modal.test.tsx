import { useFeatureFlag } from "@repo/analytics/client";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMultiRepoExecuteEnabled } from "@/hooks/use-multi-repo-execute-enabled";
import { useMultiRepoPlanEnabled } from "@/hooks/use-multi-repo-plan-enabled";
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

// ---- Top-level regex constants (Biome useTopLevelRegex) ----

const EXECUTE_BUTTON_REGEX = /execute plan/i;
const CANCEL_BUTTON_REGEX = /cancel/i;
const FLAG_OFF_BANNER_REGEX = /multi-repo execution is not yet available/i;
const ADD_REPO_REGEX = /add repository/i;

// ---- Helper ----

type ModalOverrides = Partial<React.ComponentProps<typeof ExecutePlanModal>>;

function renderModal(overrides: ModalOverrides = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ExecutePlanModal
      initialAdditionalRepos={undefined}
      isLoading={false}
      isLoadingInitialRepos={false}
      multiRepoEnabled={false}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={true}
      targetRepo="org/primary-repo"
      {...overrides}
    />
  );
  return { onConfirm, onOpenChange };
}

// ---- Hook isolation tests ----

describe("useMultiRepoExecuteEnabled", () => {
  const mockedUseFeatureFlag = vi.mocked(useFeatureFlag);

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

describe("useMultiRepoPlanEnabled", () => {
  const mockedUseFeatureFlag = vi.mocked(useFeatureFlag);

  afterEach(() => {
    cleanup();
  });

  it("returns true when feature flag enabled is true", () => {
    mockedUseFeatureFlag.mockReturnValue({
      key: "multi-repo-plan",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    const { result } = renderHook(() => useMultiRepoPlanEnabled());
    expect(result.current).toBe(true);
  });

  it("returns false when feature flag enabled is false", () => {
    mockedUseFeatureFlag.mockReturnValue({
      key: "multi-repo-plan",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });
    const { result } = renderHook(() => useMultiRepoPlanEnabled());
    expect(result.current).toBe(false);
  });

  it("returns false when feature flag returns undefined", () => {
    mockedUseFeatureFlag.mockReturnValue(undefined);
    const { result } = renderHook(() => useMultiRepoPlanEnabled());
    expect(result.current).toBe(false);
  });
});

// ---- ExecutePlanModal component tests ----

describe("ExecutePlanModal", () => {
  afterEach(() => {
    cleanup();
  });

  // Case 1: flag-on with inherited repos renders picker
  it("renders AdditionalReposPicker when multiRepoEnabled and repos are inherited", () => {
    renderModal({
      multiRepoEnabled: true,
      initialAdditionalRepos: [
        { fullName: "org/secondary-repo", branch: "main" },
      ],
    });

    expect(
      screen.getByRole("button", { name: ADD_REPO_REGEX })
    ).toBeInTheDocument();
  });

  // Case 2: flag-on with incomplete rows disables Execute
  it("disables Execute button when multiRepoEnabled and repos are incomplete", () => {
    renderModal({
      multiRepoEnabled: true,
      initialAdditionalRepos: [{ fullName: "", branch: "" }],
    });

    const executeButton = screen.getByRole("button", {
      name: EXECUTE_BUTTON_REGEX,
    });
    expect(executeButton).toBeDisabled();
  });

  // Case 3: flag-off with inherited repos renders banner AND picker NOT rendered
  it("shows flag-off banner and does not render picker when multiRepoEnabled=false with inherited repos", () => {
    renderModal({
      multiRepoEnabled: false,
      initialAdditionalRepos: [
        { fullName: "org/secondary-repo", branch: "main" },
      ],
    });

    expect(screen.getByText(FLAG_OFF_BANNER_REGEX)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ADD_REPO_REGEX })
    ).not.toBeInTheDocument();
  });

  // Case 4: flag-off without inherited repos: no banner, no picker
  it("shows no banner and no picker when multiRepoEnabled=false and no inherited repos", () => {
    renderModal({
      multiRepoEnabled: false,
      initialAdditionalRepos: undefined,
    });

    expect(screen.queryByText(FLAG_OFF_BANNER_REGEX)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ADD_REPO_REGEX })
    ).not.toBeInTheDocument();
  });

  // Case 5: flag-on with empty/undefined initialAdditionalRepos: simple confirmation
  it("shows simple confirmation body when multiRepoEnabled=true but no inherited repos", () => {
    renderModal({
      multiRepoEnabled: true,
      initialAdditionalRepos: undefined,
    });

    // No picker (no inherited repos means no MultiRepoExecuteBody)
    expect(
      screen.queryByRole("button", { name: ADD_REPO_REGEX })
    ).not.toBeInTheDocument();
    // No flag-off banner either
    expect(screen.queryByText(FLAG_OFF_BANNER_REGEX)).not.toBeInTheDocument();
    // Execute button still present
    expect(
      screen.getByRole("button", { name: EXECUTE_BUTTON_REGEX })
    ).toBeInTheDocument();
  });

  // Case 6: flag-on repos complete: onConfirm called with repos
  it("calls onConfirm with repos when multiRepoEnabled=true and repos are complete", () => {
    const { onConfirm } = renderModal({
      multiRepoEnabled: true,
      initialAdditionalRepos: [
        { fullName: "org/secondary-repo", branch: "main" },
      ],
    });

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
    const { onConfirm } = renderModal({
      multiRepoEnabled: false,
      initialAdditionalRepos: [
        { fullName: "org/secondary-repo", branch: "main" },
      ],
    });

    const executeButton = screen.getByRole("button", {
      name: EXECUTE_BUTTON_REGEX,
    });
    fireEvent.click(executeButton);

    expect(onConfirm).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  // Cancel button renders
  it("renders Cancel button", () => {
    renderModal();

    expect(
      screen.getByRole("button", { name: CANCEL_BUTTON_REGEX })
    ).toBeInTheDocument();
  });
});
