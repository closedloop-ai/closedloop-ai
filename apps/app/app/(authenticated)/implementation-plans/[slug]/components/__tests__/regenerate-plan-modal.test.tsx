import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegeneratePlanModal } from "../regenerate-plan-modal";

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: vi.fn(() => ({ key: "multi-repo-plan", enabled: true })),
}));

vi.mock("@/hooks/queries/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({
    data: { connected: false },
    isLoading: false,
  }),
  useGitHubRepositories: () => ({ data: [], isLoading: false }),
  useGitHubBranches: () => ({ data: undefined, isLoading: false }),
}));

const REGENERATE_BUTTON_REGEX = /regenerate plan/i;
const CANCEL_BUTTON_REGEX = /cancel/i;
const LOADING_REGEX = /loading previously selected repositories/i;
const REPOSITORY_1_REGEX = /repository 1/i;
const REGENERATE_FROM_SOURCE_REGEX = /regenerate the implementation plan/i;

type RenderOverrides = Partial<Parameters<typeof RegeneratePlanModal>[0]>;

function renderModal(overrides: RenderOverrides = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <RegeneratePlanModal
      initialAdditionalRepos={undefined}
      isLoadingInitialRepos={false}
      isSubmitting={false}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={true}
      targetRepo="org/primary-repo"
      {...overrides}
    />
  );
  return { onConfirm, onOpenChange };
}

describe("RegeneratePlanModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("disables the confirm button while initial repos are loading", () => {
    renderModal({ isLoadingInitialRepos: true });

    expect(screen.getByText(LOADING_REGEX)).toBeInTheDocument();
    const confirmButtons = screen.getAllByRole("button", {
      name: REGENERATE_BUTTON_REGEX,
    });
    // The dialog title also matches; find the actual button
    const confirmButton = confirmButtons.find(
      (btn) => btn.tagName === "BUTTON"
    );
    expect(confirmButton).toBeDefined();
    expect(confirmButton).toBeDisabled();
  });

  it("calls onConfirm with the previously saved repos on confirm", () => {
    const initial: AdditionalRepoRef[] = [
      { fullName: "org/repo-one", branch: "main" },
      { fullName: "org/repo-two", branch: "feature" },
    ];
    const { onConfirm, onOpenChange } = renderModal({
      initialAdditionalRepos: initial,
    });

    const confirmButtons = screen.getAllByRole("button", {
      name: REGENERATE_BUTTON_REGEX,
    });
    const confirmButton = confirmButtons.find(
      (btn) => btn.tagName === "BUTTON"
    );
    fireEvent.click(confirmButton as HTMLButtonElement);

    expect(onConfirm).toHaveBeenCalledWith(initial);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onConfirm with undefined when no repos are selected", () => {
    const { onConfirm } = renderModal({ initialAdditionalRepos: [] });

    const confirmButtons = screen.getAllByRole("button", {
      name: REGENERATE_BUTTON_REGEX,
    });
    const confirmButton = confirmButtons.find(
      (btn) => btn.tagName === "BUTTON"
    );
    fireEvent.click(confirmButton as HTMLButtonElement);

    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("closes without firing onConfirm when Cancel is clicked", () => {
    const { onConfirm, onOpenChange } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: CANCEL_BUTTON_REGEX }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("omits the picker when the multi-repo-plan feature flag is disabled", async () => {
    const analytics = await import("@repo/analytics/client");
    const mocked = vi.mocked(analytics.useFeatureFlag);
    mocked.mockReturnValueOnce({
      key: "multi-repo-plan",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });

    renderModal({
      initialAdditionalRepos: [{ fullName: "org/repo-one", branch: "main" }],
    });

    expect(screen.queryByText(REPOSITORY_1_REGEX)).toBeNull();
    expect(screen.getByText(REGENERATE_FROM_SOURCE_REGEX)).toBeInTheDocument();
  });
});
