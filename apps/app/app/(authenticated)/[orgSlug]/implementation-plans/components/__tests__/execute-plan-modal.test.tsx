import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { useDocument } from "@repo/app/documents/hooks/use-documents";
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
import { ExecutePlanModal } from "../execute-plan-modal";

// ---- Module-level mocks ----

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocument: vi.fn(() => ({
    data: { targetRepo: "org/primary-repo", projectId: "project-1" },
    isLoading: false,
  })),
}));

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

const EXECUTE_BUTTON_REGEX = /execute plan/i;
const CANCEL_BUTTON_REGEX = /cancel/i;
const SECTION_TEST_ID = "job-repositories-section";

const mockedUseDocument = vi.mocked(useDocument);

type ModalScenario = {
  resolvedAdditional?: { id: string; fullName: string }[];
};

function setupScenario({ resolvedAdditional = [] }: ModalScenario = {}) {
  mockUseResolvedJobRepos.mockReturnValue({
    primary: {
      id: "repo-primary",
      fullName: "org/primary-repo",
      source: RepoSource.ProjectOverride,
      inPool: true,
    },
    additional: resolvedAdditional.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      source: RepoSource.PriorLoop,
      inPool: true,
    })),
    pool: [],
    isLoading: false,
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

describe("ExecutePlanModal", () => {
  beforeEach(() => {
    sectionSnapshots.length = 0;
    mockedUseDocument.mockReturnValue({
      data: {
        projectId: "project-1",
        repositorySnapshot: {
          repositories: [
            {
              fullName: "org/primary-repo",
              role: "primary",
              position: 0,
            },
          ],
          source: "project_defaults",
        },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useDocument>);
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

  it("calls onConfirm with the section's additional repos", () => {
    setupScenario();
    const { onConfirm } = renderModal();

    const additional: AdditionalRepoRef[] = [
      { fullName: "org/secondary-repo", branch: "main" },
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

    fireEvent.click(screen.getByRole("button", { name: EXECUTE_BUTTON_REGEX }));

    expect(onConfirm).toHaveBeenCalledWith(additional, expect.any(Function));
  });

  it("calls onConfirm with undefined additionalRepos when none are selected", () => {
    setupScenario();
    const { onConfirm } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: EXECUTE_BUTTON_REGEX }));

    expect(onConfirm).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  it("renders Cancel button", () => {
    setupScenario();
    renderModal();
    expect(
      screen.getByRole("button", { name: CANCEL_BUTTON_REGEX })
    ).toBeInTheDocument();
  });
});
