import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/acme/features/ship-the-thing",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ orgSlug: "acme", slug: "ship-the-thing" }),
}));

// The shared Header renders a MobileSearchOverlay that pulls in the auth/API
// provider tree. It is unrelated to the header action-menu structure under
// test, so stub it out to keep the test focused on the consolidated menus.
vi.mock("@/app/(authenticated)/components/mobile-search-overlay", () => ({
  MobileSearchOverlay: () => null,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

// FavoriteButton wraps favorites hooks that reach the API client; stub it so the
// test stays focused on the header's action-menu structure.
vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: ({ artifactId }: { artifactId: string }) => (
    <button
      aria-label="Add to favorites"
      data-testid="favorite-button"
      type="button"
    >
      {artifactId}
    </button>
  ),
}));

import { IssueEditorHeader } from "../issue-editor-header";

const RE_FAVORITES = /favorites/i;

const FEATURE: DocumentWithProject = {
  id: "feature-1",
  title: "Ship the thing",
  slug: "ship-the-thing",
  type: DocumentType.Feature,
  status: DocumentStatus.InReview,
  project: null,
} as unknown as DocumentWithProject;

function renderHeader() {
  return render(
    <SidebarProvider>
      <IssueEditorHeader
        displayTitle="Ship the thing"
        feature={FEATURE}
        hasPlan={true}
        isReady={true}
        onDelete={vi.fn()}
        onEvaluateFeature={vi.fn()}
        onGeneratePlan={vi.fn()}
        onMoveToProject={vi.fn()}
        onStartBuild={vi.fn()}
        onToggleMetadataPanel={vi.fn()}
      />
    </SidebarProvider>
  );
}

describe("IssueEditorHeader consolidated action menus (FEA-3962)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders one primary action menu, one overflow menu, and the header favorite star", () => {
    renderHeader();

    // Single primary action control plus a single overflow "More" menu trigger —
    // no second/third action menu.
    expect(screen.getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "More options" })
    ).toHaveLength(1);
    // The favorite affordance stays a visible header star (afterBreadcrumbs), not
    // folded behind the overflow menu, so favorite state reads at a glance.
    expect(
      screen.getByRole("button", { name: "Add to favorites" })
    ).toBeInTheDocument();
  });

  test("primary menu keeps every workflow action", async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "Actions" }));

    expect(
      screen.getByRole("menuitem", { name: "Generate Plan" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Start Building" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Evaluate Issue" })
    ).toBeInTheDocument();
  });

  test("overflow menu keeps the secondary actions and holds no favorite item", async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "More options" }));

    expect(
      screen.getByRole("menuitem", { name: "Move to Project" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete" })
    ).toBeInTheDocument();
    // Favorite is a header star, not a menu item, so it must not appear here.
    expect(
      screen.queryByRole("menuitem", { name: RE_FAVORITES })
    ).not.toBeInTheDocument();
  });
});
