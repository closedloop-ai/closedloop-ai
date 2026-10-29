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

vi.mock(
  "@repo/app/documents/components/document-host-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/components/document-host-context")
    >()),
    useOrgSlug: () => "acme",
  })
);

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

// The breadcrumb parent crumbs route through the surface-agnostic navigation
// Link port; render it as a real anchor so the href is assertable and the crumb
// reads as a role="link" (mirrors header-breadcrumb-navigation.test.tsx).
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { IssueEditorHeader } from "@repo/app/documents/editors/issues/detail/components/issue-editor-header";

const RE_FAVORITES = /favorites/i;

const FEATURE: DocumentWithProject = {
  id: "feature-1",
  title: "Ship the thing",
  slug: "ship-the-thing",
  type: DocumentType.Feature,
  status: DocumentStatus.InReview,
  project: null,
} as unknown as DocumentWithProject;

const TEAM_ID = "team-1";
const PROJECT_ID = "project-1";
const PROJECT_NAME = "Q3 Roadmap";

const FEATURE_WITH_PROJECT: DocumentWithProject = {
  ...FEATURE,
  project: {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    teams: [{ id: TEAM_ID, name: "Platform" }],
  },
} as unknown as DocumentWithProject;

function renderHeader(feature: DocumentWithProject = FEATURE) {
  return render(
    <SidebarProvider>
      <IssueEditorHeader
        displayTitle="Ship the thing"
        feature={feature}
        onDelete={vi.fn()}
        onMoveToProject={vi.fn()}
        onToggleMetadataPanel={vi.fn()}
      />
    </SidebarProvider>
  );
}

describe("IssueEditorHeader action menus (FEA-3962)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders one overflow menu and the header favorite star, and no Actions menu", () => {
    renderHeader();

    // PRD-795 removed every item of the Actions menu, so the menu went whole;
    // the single overflow "More" menu trigger remains.
    expect(
      screen.queryByRole("button", { name: "Actions" })
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "More options" })
    ).toHaveLength(1);
    // The favorite affordance stays a visible header star (afterBreadcrumbs), not
    // folded behind the overflow menu, so favorite state reads at a glance.
    expect(
      screen.getByRole("button", { name: "Add to favorites" })
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

describe("IssueEditorHeader project breadcrumb (ISS-8396)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("links the project crumb to the default All Artifacts view, not a pre-filtered Issues tab", () => {
    renderHeader(FEATURE_WITH_PROJECT);

    const projectCrumb = screen.getByRole("link", { name: PROJECT_NAME });
    // The bare project path lands on the project's default "all" tab. A stale
    // `?tab=issues` (the pre-ISS-8396 bug) would pre-filter the project to
    // Issues on arrival, diverging from the PRD/Plan breadcrumbs.
    expect(projectCrumb.getAttribute("href")).toBe(
      `/acme/teams/${TEAM_ID}/projects/${PROJECT_ID}`
    );
    expect(projectCrumb.getAttribute("href")).not.toContain("tab=");
  });
});
