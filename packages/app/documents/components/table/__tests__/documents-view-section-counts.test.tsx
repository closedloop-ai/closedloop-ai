import { DocumentStatus } from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ISS-4704: a paged caller hands this view only one page of the board, so the
// number beside a group header cannot come from the rows on screen — that
// number claims to be the status's population. These tests drive the real
// grouped render and read the header the user actually sees.
const mocks = vi.hoisted(() => ({
  useProjectTree: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagEnabledOptional: vi.fn(),
  useSortParams: vi.fn(),
  useGroupExpansion: vi.fn(),
  useMergeDocuments: vi.fn(),
  useStackRanking: vi.fn(),
  useContextGroupExpansion: vi.fn(),
}));

vi.mock("@repo/app/projects/hooks/use-project-tree", () => ({
  useProjectTree: mocks.useProjectTree,
  useProjectTreeExpansionBatch: vi.fn(() => []),
}));
vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    // Partial: this module gained exports (ISS-9726) the surface under test now
    // reaches through, and a total mock silently drops them.
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
    useFeatureFlagEnabledOptional: mocks.useFeatureFlagEnabledOptional,
  })
);
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: mocks.useSortParams,
}));
vi.mock("@repo/app/shared/hooks/use-group-expansion", async (orig) => ({
  // Partial, not total: the surface under test reaches through MORE of this
  // module than the keys overridden below (ISS-9726), and a total factory drops
  // every export it does not name.
  ...(await orig<Record<string, unknown>>()),
  useGroupExpansion: mocks.useGroupExpansion,
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useMergeDocuments: mocks.useMergeDocuments,
}));
vi.mock("@repo/app/documents/hooks/use-stack-ranking", () => ({
  useStackRanking: mocks.useStackRanking,
}));
vi.mock("@repo/app/documents/hooks/use-context-group-expansion", () => ({
  useContextGroupExpansion: mocks.useContextGroupExpansion,
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));
// The subject is the section HEADER, not the row beneath it. `DocumentRow`
// pulls in the auth, api-client and navigation providers an app root supplies;
// stub the row so the grouped body mounts, and leave the grouping pipeline and
// the header itself real.
vi.mock(
  "@repo/app/documents/components/table/document-row",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/documents/components/table/document-row")
      >();
    return {
      ...actual,
      DocumentRow: ({ item }: { item: { data: { id: string } } }) => (
        <div data-testid="document-row">{item.data.id}</div>
      ),
    };
  }
);

vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));
vi.mock("@repo/app/documents/components/table/cells/name-cell", () => ({
  NameCell: ({ item }: { item: { data: { id: string } } }) => (
    <div data-testid="document-row">{item.data.id}</div>
  ),
}));

import { DocumentsView } from "@repo/app/documents/components/table/documents-view";

/**
 * One page of a larger board: 1 Draft row and 2 In Review rows. The section
 * populations upstream are 4 and 7 — literals, so neither can be re-derived
 * from what this page renders.
 */
const PAGE_DOCUMENTS = [
  makeArtifact({ id: "draft-a", status: DocumentStatus.Draft }),
  makeArtifact({ id: "review-a", status: DocumentStatus.InReview }),
  makeArtifact({ id: "review-b", status: DocumentStatus.InReview }),
];
const DRAFT_TOTAL = 4;
const IN_REVIEW_TOTAL = 7;

const SECTION_TOTALS: ReadonlyMap<string, number> = new Map([
  [DocumentStatus.Draft, DRAFT_TOTAL],
  [DocumentStatus.InReview, IN_REVIEW_TOTAL],
]);

const DIGITS_ONLY = /^\d+$/;
const CONTINUED_MARKER = "(continued)";

const BASE_PROPS = {
  filterText: "",
  filterCategory: "all" as const,
  visibleColumns: [DocumentColumn.Type],
  storageKey: "test",
  groupBy: GroupByMode.Status,
  documents: PAGE_DOCUMENTS,
};

function emptyTree(): ProjectTreeResponse {
  return { nodes: [], externalParents: [] };
}

describe("DocumentsView group section headers (ISS-4704)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectTree.mockReturnValue({ data: undefined, isLoading: false });
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    mocks.useFeatureFlagEnabledOptional.mockReturnValue(false);
    mocks.useSortParams.mockReturnValue({
      sortBy: null,
      sortDir: "asc",
      setSort: vi.fn(),
      clearSort: vi.fn(),
      clearPersistedSort: vi.fn(),
    });
    mocks.useGroupExpansion.mockReturnValue({
      isExpanded: () => true,
      toggleGroup: vi.fn(),
    });
    mocks.useMergeDocuments.mockReturnValue({ mutateAsync: vi.fn() });
    mocks.useStackRanking.mockReturnValue({
      rankInteractionMode: "disabled",
      isDndEnabled: false,
      rankItemIds: [],
      isRankableMenuItem: () => false,
      moveToTop: vi.fn(),
      moveToBottom: vi.fn(),
      handleDragEnd: vi.fn(),
    });
    mocks.useContextGroupExpansion.mockReturnValue({
      isTreeGroupExpanded: () => true,
      toggleTreeGroup: vi.fn(),
    });
  });

  /**
   * The collapsible section header for a status band. Located by its rendered
   * label rather than by accessible name: the section icon repeats the label
   * for screen readers, so the computed name doubles it and would encode that
   * quirk into every assertion below.
   */
  function sectionHeader(label: string): HTMLElement {
    const header = screen
      .getAllByRole("button")
      .find(
        (button) =>
          button.getAttribute("aria-expanded") !== null &&
          button.textContent?.includes(label) === true
      );
    if (!header) {
      throw new Error(`No group section header rendered for "${label}"`);
    }
    return header;
  }

  it("states the section's full population, not the rows this page holds", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        sectionTotalsByKey={SECTION_TOTALS}
        treeData={emptyTree()}
      />
    );

    expect(
      within(sectionHeader("In Review")).getByText(String(IN_REVIEW_TOTAL))
    ).toBeVisible();
    expect(
      within(sectionHeader("Draft")).getByText(String(DRAFT_TOTAL))
    ).toBeVisible();
    // 2 and 1 are the page-local counts the defect published.
    expect(within(sectionHeader("In Review")).queryByText("2")).toBeNull();
    expect(within(sectionHeader("Draft")).queryByText("1")).toBeNull();
  });

  it("falls back to the page-local count for an unpaged caller that passes no totals", () => {
    render(<DocumentsView {...BASE_PROPS} treeData={emptyTree()} />);

    // No totals map: the rendered rows ARE the population, so the count is honest.
    expect(within(sectionHeader("In Review")).getByText("2")).toBeVisible();
    expect(within(sectionHeader("Draft")).getByText("1")).toBeVisible();
  });

  it("renders no number for a section the supplied totals do not cover", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        sectionTotalsByKey={new Map([[DocumentStatus.Draft, DRAFT_TOTAL]])}
        treeData={emptyTree()}
      />
    );

    // Draft is covered and states its population; In Review is not, so it
    // states nothing rather than publishing this page's 2 as the section size.
    expect(
      within(sectionHeader("Draft")).getByText(String(DRAFT_TOTAL))
    ).toBeVisible();
    expect(
      within(sectionHeader("In Review")).queryByText(DIGITS_ONLY)
    ).toBeNull();
  });

  it("marks a section whose rows began on an earlier page, and only that one", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        continuedSectionKeys={new Set([DocumentStatus.InReview])}
        sectionTotalsByKey={SECTION_TOTALS}
        treeData={emptyTree()}
      />
    );

    expect(
      within(sectionHeader("In Review")).getByText(CONTINUED_MARKER)
    ).toBeVisible();
    expect(
      within(sectionHeader("Draft")).queryByText(CONTINUED_MARKER)
    ).toBeNull();
  });

  it("marks nothing when no section continues from an earlier page", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        continuedSectionKeys={new Set<string>()}
        sectionTotalsByKey={SECTION_TOTALS}
        treeData={emptyTree()}
      />
    );

    // The sibling above proves this locator matches when a section continues.
    expect(
      within(sectionHeader("In Review")).queryByText(CONTINUED_MARKER)
    ).toBeNull();
    expect(
      within(sectionHeader("In Review")).getByText(String(IN_REVIEW_TOTAL))
    ).toBeVisible();
  });
});
