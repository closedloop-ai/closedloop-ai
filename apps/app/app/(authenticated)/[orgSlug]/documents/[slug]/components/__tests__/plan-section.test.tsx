import {
  type DocumentDetail,
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { installPointerCaptureShims } from "@/__tests__/helpers/pointer-capture-shims";

const RE_PLAN_NOT_GENERATED = /plan hasn't been generated/i;

const mocks = vi.hoisted(() => ({
  useIssueState: vi.fn(),
  useDocument: vi.fn(),
  deleteLinkMutate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/acme/issues/ship-the-thing",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme", slug: "ship-the-thing" }),
}));

vi.mock("@repo/app/documents/editors/issues/detail/use-issue-state", () => ({
  useIssueState: mocks.useIssueState,
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocument: mocks.useDocument,
}));

vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useDeleteArtifactLink: () => ({ mutate: mocks.deleteLinkMutate }),
}));

vi.mock(
  "@repo/app/documents/editors/issues/detail/components/select-plan-dialog",
  () => ({
    SelectPlanDialog: () => null,
  })
);

import { PlanSection } from "@repo/app/documents/editors/issues/detail/components/plan-section";

installPointerCaptureShims();

function makeFeature(overrides: Partial<DocumentDetail> = {}): DocumentDetail {
  const document = createMockDocument({
    id: "feature-1",
    type: DocumentType.Feature,
    title: "Ship the thing",
    slug: "FEA-1",
    status: IssueStatus.Todo,
  });
  return {
    ...document,
    version: {
      id: "version-1",
      documentId: document.id,
      version: 1,
      content: "Some description content",
      createdById: "user-1",
      createdAt: new Date("2024-01-15T10:00:00Z"),
    },
    latestVersionContent: "Some description content",
    ...overrides,
  };
}

function renderPlanSection() {
  return render(<PlanSection feature={makeFeature()} />);
}

describe("PlanSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDocument.mockReturnValue({ data: undefined, isLoading: false });
  });

  test("shows the linked plan's ArtifactRow and hides the empty state when a plan is linked", () => {
    mocks.useIssueState.mockReturnValue({
      linkedPlanLink: { id: "link-1" },
      linkedPlanId: "plan-1",
      hasPlan: true,
    });
    mocks.useDocument.mockReturnValue({
      data: createMockDocument({
        id: "plan-1",
        type: DocumentType.ImplementationPlan,
        title: "Plan One",
        slug: "PLN-1",
        status: DocumentStatus.Draft,
      }),
      isLoading: false,
    });

    renderPlanSection();

    expect(screen.getByText("Plan One")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Select Existing Plan" })
    ).not.toBeInTheDocument();
  });

  test("shows the empty sentence and Select Existing Plan when no plan is linked", () => {
    mocks.useIssueState.mockReturnValue({
      linkedPlanLink: null,
      linkedPlanId: null,
      hasPlan: false,
    });

    renderPlanSection();

    expect(screen.getByText(RE_PLAN_NOT_GENERATED)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select Existing Plan" })
    ).toBeInTheDocument();
    // PRD-795: plan generation is gone, so the section offers one control.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  test("shows no empty state while the linked plan is still loading", () => {
    mocks.useIssueState.mockReturnValue({
      linkedPlanLink: { id: "link-1" },
      linkedPlanId: "plan-1",
      hasPlan: true,
    });
    mocks.useDocument.mockReturnValue({ data: undefined, isLoading: true });

    renderPlanSection();

    expect(
      screen.queryByRole("button", { name: "Select Existing Plan" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(RE_PLAN_NOT_GENERATED)).not.toBeInTheDocument();
  });

  test("collapses the section body when the header is toggled", async () => {
    const user = userEvent.setup();
    mocks.useIssueState.mockReturnValue({
      linkedPlanLink: null,
      linkedPlanId: null,
      hasPlan: false,
    });

    renderPlanSection();

    const header = screen.getByRole("button", { name: "Plan" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Select Existing Plan" })
    ).toBeInTheDocument();

    await user.click(header);

    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "Select Existing Plan" })
    ).not.toBeInTheDocument();
  });

  test("unlinking the plan calls deleteLink.mutate with the link id", async () => {
    const user = userEvent.setup();
    mocks.useIssueState.mockReturnValue({
      linkedPlanLink: { id: "link-1" },
      linkedPlanId: "plan-1",
      hasPlan: true,
    });
    mocks.useDocument.mockReturnValue({
      data: createMockDocument({
        id: "plan-1",
        type: DocumentType.ImplementationPlan,
        title: "Plan One",
        slug: "PLN-1",
        status: DocumentStatus.Draft,
      }),
      isLoading: false,
    });

    renderPlanSection();

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Detach Association" })
    );

    expect(mocks.deleteLinkMutate).toHaveBeenCalledWith(
      "link-1",
      expect.any(Object)
    );
  });
});
