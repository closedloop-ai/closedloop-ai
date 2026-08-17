import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FEA-3927: the My Tasks page must render responsively at a phone width. This
// mounts the real page (list view, with a row) at 375px and asserts it renders
// without throwing and keeps the filter-category control accessible. The data
// hooks are stubbed so the page renders its own layout without a live API.

const mobileDocument: DocumentRowData = makeArtifact({
  id: "doc-1",
  assigneeId: "user-1",
});

// apps/app shims the @repo/navigation port hooks onto next/navigation
// (vitest.setup.ts), so the page's useNavigation/usePath/useSearchParamsValue
// need a next/navigation factory rather than a live App Router context.
vi.mock("next/navigation", () => ({
  usePathname: () => "/org-test/my-tasks",
  useParams: () => ({ orgSlug: "org-test" }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

// `useOrgSlug` reads the Clerk org port directly; the tree source reads
// `useUser` to confirm PostHog is keyed on the signed-in user before it trusts
// a flag value (FEA-1651).
vi.mock("@repo/auth/client", () => ({
  useAuth: () => ({ isSignedIn: true }),
  useUser: () => ({ user: { id: "user-clerk-1" }, isLoaded: true }),
  useOrganization: () => ({
    organization: { slug: "org-test" },
    isLoaded: true,
  }),
}));

vi.mock("@repo/analytics/client", () => ({
  // These drive the anonymous-bootstrap -> identify() handshake, which only
  // exists in a build that has a PostHog key.
  postHogFeatureFlagsEnabled: true,
  useFeatureFlagsLoaded: () => true,
  usePostHogDistinctId: () => "user-clerk-1",
  useFeatureFlag: () => undefined,
}));

const emptyQuery = { data: undefined, isLoading: false } as const;
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({
    data: { id: "user-1", firstName: "Ada" },
    isLoading: false,
  }),
}));
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => ({ data: [], isLoading: false }),
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocuments: () => ({ data: [mobileDocument], isLoading: false }),
  // ISS-4576: the board reads the paged envelope, not the bare array.
  useDocumentsPage: () => ({
    data: {
      items: [mobileDocument],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    },
    isLoading: false,
  }),
  documentsPageQueryKey: (params: unknown) => ["documents", "list", params],
  useUpdateDocument: () => ({ mutate: vi.fn() }),
  useMergeDocuments: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));
// Force the FEA-3866 narrow-container card fallback in the Documents tree so
// the mobile-only render path executes (jsdom's ResizeObserver otherwise
// reports a wide box and the grid path always wins).
vi.mock("@repo/design-system/hooks/use-container-width", () => ({
  useContainerWidth: () => ({ ref: { current: null }, width: 375 }),
}));
vi.mock("@repo/app/branches/hooks/use-branches", () => ({
  useBranchList: () => ({
    data: { items: [] },
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => emptyQuery,
  useIsFavoriteArtifact: () => false,
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn() }),
}));
vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: () => vi.fn(),
}));
vi.mock("@repo/app/projects/hooks/use-merged-project-trees", () => ({
  useMergedProjectTrees: () => ({
    data: null,
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@repo/app/projects/hooks/use-assigned-artifact-tree", () => ({
  useAssignedArtifactTree: () => ({
    data: null,
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersAsPopoverUsers: () => [],
}));

import MyTasksPage from "../page";

const MAX_WIDTH_QUERY = /max-width/;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <AppCoreStoryProviders>
      <SidebarProvider>{children}</SidebarProvider>
    </AppCoreStoryProviders>
  );
}

const MOBILE_WINDOW_PROPS = [
  "innerWidth",
  "innerHeight",
  "matchMedia",
] as const;

describe("MyTasksPage — mobile width (FEA-3927)", () => {
  // Capture the original window descriptors so the mobile-width overrides below
  // are torn down after each test and cannot leak into unrelated suites.
  const originalDescriptors = new Map<
    (typeof MOBILE_WINDOW_PROPS)[number],
    PropertyDescriptor | undefined
  >();

  beforeEach(() => {
    for (const prop of MOBILE_WINDOW_PROPS) {
      originalDescriptors.set(
        prop,
        Object.getOwnPropertyDescriptor(globalThis.window, prop)
      );
    }
    for (const [prop, value] of [
      ["innerWidth", 375],
      ["innerHeight", 667],
    ] as const) {
      Object.defineProperty(globalThis.window, prop, {
        configurable: true,
        value,
        writable: true,
      });
    }
    Object.defineProperty(globalThis.window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList =>
        ({
          matches: MAX_WIDTH_QUERY.test(query),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
  });

  afterEach(() => {
    for (const prop of MOBILE_WINDOW_PROPS) {
      const descriptor = originalDescriptors.get(prop);
      if (descriptor) {
        Object.defineProperty(globalThis.window, prop, descriptor);
      } else {
        Reflect.deleteProperty(globalThis.window, prop);
      }
    }
    originalDescriptors.clear();
  });

  it("renders the toolbar + list view at 375px without throwing", () => {
    expect(() => render(<MyTasksPage />, { wrapper: Wrapper })).not.toThrow();
  });

  it("keeps the filter-category control accessible at mobile width", () => {
    render(<MyTasksPage />, { wrapper: Wrapper });
    for (const label of ["All", "PRDs", "Issues", "Plans", "Branches"]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Filter items")).toBeInTheDocument();
  });
});
