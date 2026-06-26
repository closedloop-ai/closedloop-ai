import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { RepoSource } from "@repo/app/loops/hooks/use-resolved-job-repos";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRepoSelection } from "@/app/(authenticated)/components/job-repositories/selection";
import { RegeneratePlanModal } from "../regenerate-plan-modal";

// ---- Module-level mocks ----

const mockUseResolvedJobRepos = vi.fn();

vi.mock("@repo/app/loops/hooks/use-resolved-job-repos", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/loops/hooks/use-resolved-job-repos")
  >("@repo/app/loops/hooks/use-resolved-job-repos");
  return {
    ...actual,
    useResolvedJobRepos: (...args: unknown[]) =>
      mockUseResolvedJobRepos(...args),
  };
});

type SectionSnapshot = {
  onChange: (selection: JobRepoSelection | null) => void;
};
const sectionSnapshots: SectionSnapshot[] = [];

vi.mock("@/app/(authenticated)/components/job-repositories-section", () => ({
  JobRepositoriesSection: ({
    onChange,
  }: {
    onChange: (selection: JobRepoSelection | null) => void;
  }) => {
    sectionSnapshots.push({ onChange });
    return <div data-testid="job-repositories-section" />;
  },
}));

const REGENERATE_BUTTON_REGEX = /regenerate plan/i;
const CANCEL_BUTTON_REGEX = /cancel/i;
const SECTION_TEST_ID = "job-repositories-section";

function setupScenario({ isLoading = false }: { isLoading?: boolean } = {}) {
  mockUseResolvedJobRepos.mockReturnValue({
    primary: {
      id: "repo-primary",
      fullName: "org/primary-repo",
      source: RepoSource.ProjectOverride,
      inPool: true,
    },
    additional: [],
    pool: [],
    isLoading,
  });
}

type ModalOverrides = Partial<React.ComponentProps<typeof RegeneratePlanModal>>;

function renderModal(overrides: ModalOverrides = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <RegeneratePlanModal
      isSubmitting={false}
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
      open={true}
      planId="plan-1"
      projectId="project-1"
      targetRepo="org/primary-repo"
      {...overrides}
    />
  );
  return { onConfirm, onOpenChange };
}

describe("RegeneratePlanModal", () => {
  beforeEach(() => {
    sectionSnapshots.length = 0;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the JobRepositoriesSection", () => {
    setupScenario();
    renderModal();
    expect(screen.getByTestId(SECTION_TEST_ID)).toBeInTheDocument();
  });

  it("disables the confirm button while the resolver is loading", () => {
    setupScenario({ isLoading: true });
    renderModal();
    expect(
      screen.getByRole("button", { name: REGENERATE_BUTTON_REGEX })
    ).toBeDisabled();
  });

  it("calls onConfirm with the section's additional repos on confirm", () => {
    setupScenario();
    const { onConfirm, onOpenChange } = renderModal();

    const additional: AdditionalRepoRef[] = [
      { fullName: "org/repo-one", branch: "main" },
      { fullName: "org/repo-two", branch: "feature" },
    ];
    act(() => {
      sectionSnapshots.at(-1)?.onChange({
        primary: {
          id: "repo-primary",
          fullName: "org/primary-repo",
          branch: "main",
        },
        additional,
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: REGENERATE_BUTTON_REGEX })
    );

    expect(onConfirm).toHaveBeenCalledWith(additional);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onConfirm with undefined when no additional repos are selected", () => {
    setupScenario();
    const { onConfirm } = renderModal();

    fireEvent.click(
      screen.getByRole("button", { name: REGENERATE_BUTTON_REGEX })
    );

    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("closes without firing onConfirm when Cancel is clicked", () => {
    setupScenario();
    const { onConfirm, onOpenChange } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: CANCEL_BUTTON_REGEX }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
