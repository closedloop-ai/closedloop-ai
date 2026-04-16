import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegeneratePlanModal } from "../regenerate-plan-modal";

type ModalProps = Parameters<typeof RegeneratePlanModal>[0];

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
    expect(
      screen.getByRole("button", { name: REGENERATE_BUTTON_REGEX })
    ).toBeDisabled();
  });

  it("calls onConfirm with the previously saved repos on confirm", () => {
    const initial: AdditionalRepoRef[] = [
      { fullName: "org/repo-one", branch: "main" },
      { fullName: "org/repo-two", branch: "feature" },
    ];
    const { onConfirm, onOpenChange } = renderModal({
      initialAdditionalRepos: initial,
    });

    fireEvent.click(
      screen.getByRole("button", { name: REGENERATE_BUTTON_REGEX })
    );

    expect(onConfirm).toHaveBeenCalledWith(initial);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onConfirm with undefined when no repos are selected", () => {
    const { onConfirm } = renderModal({ initialAdditionalRepos: [] });

    fireEvent.click(
      screen.getByRole("button", { name: REGENERATE_BUTTON_REGEX })
    );

    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("closes without firing onConfirm when Cancel is clicked", () => {
    const { onConfirm, onOpenChange } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: CANCEL_BUTTON_REGEX }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("syncs additionalRepos when initialAdditionalRepos resolves after mount", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const baseProps: ModalProps = {
      initialAdditionalRepos: undefined,
      isLoadingInitialRepos: true,
      isSubmitting: false,
      onConfirm,
      onOpenChange,
      open: true,
      targetRepo: "org/primary-repo",
    };
    const { rerender } = render(<RegeneratePlanModal {...baseProps} />);

    const resolved: AdditionalRepoRef[] = [
      { fullName: "org/repo-one", branch: "main" },
      { fullName: "org/repo-two", branch: "feature" },
    ];
    rerender(
      <RegeneratePlanModal
        {...baseProps}
        initialAdditionalRepos={resolved}
        isLoadingInitialRepos={false}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: REGENERATE_BUTTON_REGEX })
    );

    expect(onConfirm).toHaveBeenCalledWith(resolved);
  });
});
