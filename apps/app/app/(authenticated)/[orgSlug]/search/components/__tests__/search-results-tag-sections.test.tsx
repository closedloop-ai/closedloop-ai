import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import type {
  DocumentSearchResult,
  GlobalSearchResponse,
  ProjectSearchResult,
} from "@repo/api/src/types/search";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { PRIORITY_LABEL_NONE } from "@repo/design-system/lib/priority-order";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SearchResults } from "../search-results";

// This file covers the tag-filtered (`?tagId=`) legacy grouped table — the
// three artifact/feature/project sections and the loading/no-data edges of
// TagSearchResults. The sibling `search-results.test.tsx` already covers the
// unified FTS panel and the tag-search zero/error/clear paths with EMPTY
// documents/projects arrays, so none of those arrays ever held a row and the
// three grouped sections, TitleCell's href branch, and their per-row label
// fallbacks were never exercised. Kept as its own file rather than edits to
// that existing suite (ISS-9169: one worker per file).

const routerReplaceMock = vi.fn();
const useGlobalSearchMock = vi.fn();

let searchParams = new URLSearchParams("tagId=tag-123");

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/search",
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: routerReplaceMock,
  }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

const mockUseFeatureFlagEnabledOptional = vi.fn();

// Key-aware: a mock answering every key alike would let one gate decide another.
vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/shared/feature-flags/use-feature-flag-enabled")
    >()),
    useFeatureFlagEnabledOptional: (key: string) =>
      mockUseFeatureFlagEnabledOptional(key),
  })
);

// Only `useGlobalSearch` (the tag-search hook) needs a seam here — every test
// in this file renders with a `tagId`, so `UnifiedSearchPanel` (and its
// `useSearchPanelState`) never mounts.
vi.mock("@repo/app/search/hooks/use-search", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/search/hooks/use-search")
  >("@repo/app/search/hooks/use-search");
  return {
    ...actual,
    useGlobalSearch: (...args: unknown[]) => useGlobalSearchMock(...args),
  };
});

describe("SearchResults tag search — grouped sections", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("tagId=tag-123");
    routerReplaceMock.mockClear();
    useGlobalSearchMock.mockReset();
    mockUseFeatureFlagEnabledOptional.mockReset();
    mockUseFeatureFlagEnabledOptional.mockReturnValue(false);
  });

  test("shows a loading spinner while the tag search is in flight, not a premature result line", () => {
    useGlobalSearchMock.mockReturnValue({ data: undefined, isLoading: true });

    const { container } = render(<SearchResults />);

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  test("treats an unresolved (undefined) response as zero results rather than throwing", () => {
    useGlobalSearchMock.mockReturnValue({ data: undefined, isLoading: false });

    render(<SearchResults />);

    expect(screen.getByText('0 results tagged with ""')).toBeInTheDocument();
    expect(screen.queryAllByRole("table")).toHaveLength(0);
  });

  test("uses the singular noun and an empty tag name when the response omits tagName", () => {
    useGlobalSearchMock.mockReturnValue({
      data: globalResponse({
        projects: [projectSearchResult({ name: "Solo Project" })],
      }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(screen.getByText('1 result tagged with ""')).toBeInTheDocument();
  });

  test("renders the Artifacts section with a routable known type and a legacy unmapped type", () => {
    useGlobalSearchMock.mockReturnValue({
      data: globalResponse({
        documents: [
          documentSearchResult({
            id: "doc-1",
            title: "Alpha PRD",
            slug: "alpha-prd",
            type: DocumentType.Prd,
            status: DocumentStatus.Draft,
            projectName: "Alpha Project",
          }),
          documentSearchResult({
            id: "doc-2",
            title: "Legacy Doc",
            slug: "legacy-doc",
            // Pins current behavior, and it looks wrong: DocumentSearchResult.type
            // is typed as the closed DocumentType union, but useGlobalSearch never
            // validates the response against a schema (no zod .parse, unlike
            // useUnifiedSearch), so a legacy/version-skewed server value reaches
            // this cell verbatim. Cast to simulate that cross-repo boundary case.
            type: "LEGACY_TYPE" as DocumentType,
            status: DocumentStatus.Approved,
            projectName: null,
          }),
        ],
      }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(
      screen.getByRole("columnheader", { name: "Type" })
    ).toBeInTheDocument();

    const routableLink = screen.getByRole("link", { name: "Alpha PRD" });
    expect(routableLink).toHaveAttribute("href", "/acme/documents/alpha-prd");
    expect(screen.getByText("PRD")).toBeInTheDocument();
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();

    // The legacy type has no route prefix, so its title renders as plain text
    // (not a link) and its type label falls back to the raw stored value.
    expect(screen.queryByRole("link", { name: "Legacy Doc" })).toBeNull();
    expect(screen.getByText("Legacy Doc")).toBeInTheDocument();
    expect(screen.getByText("LEGACY_TYPE")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  test("renders the Issues section with and without a priority or project", () => {
    useGlobalSearchMock.mockReturnValue({
      data: globalResponse({
        documents: [
          documentSearchResult({
            id: "feat-1",
            title: "Ship it",
            slug: "ship-it",
            type: DocumentType.Feature,
            status: IssueStatus.InProgress,
            priority: Priority.High,
            projectName: "Beta Project",
          }),
          documentSearchResult({
            id: "feat-2",
            title: "No priority feature",
            slug: "no-priority",
            type: DocumentType.Feature,
            status: IssueStatus.Backlog,
            priority: null,
            projectName: null,
          }),
        ],
      }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(screen.getByRole("link", { name: "Ship it" })).toHaveAttribute(
      "href",
      "/acme/documents/ship-it"
    );
    expect(screen.getByText("Beta Project")).toBeInTheDocument();
    // Exactly one priority badge exists — proving the second feature (null
    // priority) rendered no badge, not merely that the first feature's did.
    expect(screen.getAllByText("High")).toHaveLength(1);

    expect(
      screen.getByRole("link", { name: "No priority feature" })
    ).toHaveAttribute("href", "/acme/documents/no-priority");
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  test("renders the Projects section with and without a team, and falls back an unrecognized status", () => {
    useGlobalSearchMock.mockReturnValue({
      data: globalResponse({
        projects: [
          projectSearchResult({
            id: "proj-1",
            name: "Team Project",
            teamId: "team-1",
            teamName: "Core Team",
            status: ProjectStatus.InProgress,
            priority: Priority.Urgent,
          }),
          projectSearchResult({
            id: "proj-2",
            name: "Unassigned Project",
            teamId: null,
            teamName: null,
            // Same cross-repo-drift rationale as the legacy document type above:
            // ProjectStatus is a closed union but this response is unvalidated.
            status: "LEGACY_STATUS" as ProjectStatus,
            priority: null,
          }),
        ],
      }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(
      screen.getByRole("columnheader", { name: "Name" })
    ).toBeInTheDocument();

    const teamLink = screen.getByRole("link", { name: "Team Project" });
    expect(teamLink).toHaveAttribute(
      "href",
      "/acme/teams/team-1/projects/proj-1"
    );
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.getByText("Core Team")).toBeInTheDocument();

    // No teamId means no route to a team-scoped project page, so the title
    // must fall back to plain (non-link) text.
    expect(
      screen.queryByRole("link", { name: "Unassigned Project" })
    ).toBeNull();
    expect(screen.getByText("Unassigned Project")).toBeInTheDocument();
    expect(screen.getByText("LEGACY_STATUS")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  test("flag off: an unset project priority still shows Medium, as it did before a project could hold none", () => {
    useGlobalSearchMock.mockReturnValue({
      data: globalResponse({
        projects: [
          projectSearchResult({ name: "Unset Project", priority: null }),
        ],
      }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(
      screen.getByText(PRIORITY_LABELS[Priority.Medium])
    ).toBeInTheDocument();
    expect(screen.queryByText(PRIORITY_LABEL_NONE)).toBeNull();
  });

  test("flag on: an unset project priority says No priority instead of showing a Medium badge", () => {
    mockUseFeatureFlagEnabledOptional.mockImplementation(
      (key: string) => key === ARTIFACT_PRIORITY_UNSET_FLAG_KEY
    );
    useGlobalSearchMock.mockReturnValue({
      data: globalResponse({
        projects: [
          projectSearchResult({ name: "Unset Project", priority: null }),
        ],
      }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(screen.getByText(PRIORITY_LABEL_NONE)).toBeInTheDocument();
    expect(screen.queryByText(PRIORITY_LABELS[Priority.Medium])).toBeNull();
  });
});

function globalResponse(
  overrides: Partial<GlobalSearchResponse> = {}
): GlobalSearchResponse {
  return {
    query: "",
    documents: [],
    projects: [],
    ...overrides,
  };
}

function documentSearchResult(
  overrides: Partial<DocumentSearchResult> = {}
): DocumentSearchResult {
  return {
    id: "doc-id",
    title: "Doc title",
    slug: "doc-slug",
    type: DocumentType.Doc,
    status: DocumentStatus.Draft,
    priority: null,
    projectName: null,
    assignee: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function projectSearchResult(
  overrides: Partial<ProjectSearchResult> = {}
): ProjectSearchResult {
  return {
    id: "project-id",
    name: "Project name",
    slug: null,
    status: ProjectStatus.NotStarted,
    priority: null,
    teamName: null,
    teamId: null,
    assignee: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
