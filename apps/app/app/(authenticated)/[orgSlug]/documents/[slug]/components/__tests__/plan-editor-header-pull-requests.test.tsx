/** Production Plan header PR-link navigation through More options. */
import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import type {
  DocumentWithProject,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import {
  DocumentStatus,
  DocumentType,
  PullRequestState,
} from "@repo/api/src/types/document";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/acme/implementation-plans/ship-the-thing",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme", slug: "ship-the-thing" }),
}));

vi.mock("@/app/(authenticated)/components/mobile-search-overlay", () => ({
  MobileSearchOverlay: () => null,
}));

vi.mock(
  "@repo/app/documents/components/document-host-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/components/document-host-context")
    >()),
    useOrgSlug: () => "acme",
  })
);

vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));

import { PlanEditorHeader } from "@repo/app/documents/editors/implementation-plans/detail/components/plan-editor-header";

const PULL_REQUEST_MENU_ITEM = /PR #42/;

const PLAN: DocumentWithProject = {
  id: "plan-1",
  title: "Ship the thing",
  slug: "ship-the-thing",
  type: DocumentType.ImplementationPlan,
  status: DocumentStatus.InReview,
  project: null,
} as unknown as DocumentWithProject;

const PULL_REQUEST: PullRequestInfo = {
  id: "pr-1",
  number: 42,
  title: "Ship the thing",
  htmlUrl: "https://github.com/acme/repo/pull/42",
  state: PullRequestState.Open,
  isDraft: false,
  headBranch: "feature/ship-the-thing",
  baseBranch: "main",
  createdAt: new Date("2026-08-18T12:00:00.000Z"),
  checksStatus: null,
  reviewDecision: null,
  externalLinkId: "branch-1",
  repoFullName: "acme/repo",
  hasCompatibilityProviderFallback: true,
  productEligibility: BranchProductEligibility.Eligible,
};

function renderHeader(opts: {
  branchNavigationEnabled?: boolean;
  pullRequests?: PullRequestInfo[];
}) {
  const adapter = {
    useFeatureFlagEnabled: (key: string) =>
      key === ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY &&
      (opts.branchNavigationEnabled ?? false),
  };
  return render(
    <FeatureFlagAdapterProvider adapter={adapter}>
      <SidebarProvider>
        <PlanEditorHeader
          onCopyMarkdown={vi.fn()}
          onDelete={vi.fn()}
          onExportMarkdown={vi.fn()}
          onMove={vi.fn()}
          onToggleMetadataPanel={vi.fn()}
          plan={PLAN}
          pullRequests={opts.pullRequests}
        />
      </SidebarProvider>
    </FeatureFlagAdapterProvider>
  );
}

test("routes an eligible plan PR to canonical Branch Details when rollout is enabled", async () => {
  const user = userEvent.setup();
  renderHeader({
    branchNavigationEnabled: true,
    pullRequests: [PULL_REQUEST],
  });

  await user.click(screen.getByRole("button", { name: "More options" }));

  expect(
    screen.getByRole("menuitem", { name: PULL_REQUEST_MENU_ITEM })
  ).toHaveAttribute("href", "/acme/branches/branch-1");
});

test("keeps an eligible plan PR on the compatibility route while rollout is off", async () => {
  const user = userEvent.setup();
  renderHeader({ pullRequests: [PULL_REQUEST] });

  await user.click(screen.getByRole("button", { name: "More options" }));

  expect(
    screen.getByRole("menuitem", { name: PULL_REQUEST_MENU_ITEM })
  ).toHaveAttribute("href", "/acme/build/branch-1");
});

test("renders an ineligible plan PR as a non-link", async () => {
  const user = userEvent.setup();
  renderHeader({
    branchNavigationEnabled: true,
    pullRequests: [
      {
        ...PULL_REQUEST,
        productEligibility: BranchProductEligibility.Ineligible,
      },
    ],
  });

  await user.click(screen.getByRole("button", { name: "More options" }));

  expect(
    screen.getByRole("menuitem", { name: PULL_REQUEST_MENU_ITEM })
  ).not.toHaveAttribute("href");
});
