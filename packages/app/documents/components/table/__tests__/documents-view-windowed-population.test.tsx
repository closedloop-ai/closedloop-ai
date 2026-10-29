import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import type {
  ProjectTreeResponse,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import {
  buildTableViewPagePlan,
  pageTableView,
} from "@repo/app/documents/lib/table-view-pagination";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PRD-720 acceptance: "A group count and the rows it heads always describe the
 * same population, proven by a test over a windowed server response."
 *
 * The window here is not hand-written. A full population is paged by the same
 * section-aware plan the paged callers use (`buildTableViewPagePlan` +
 * `pageTableView`), and each page is rendered with the plan's own section
 * totals and continued keys. On every page, each band header must state the
 * size of its status over the FULL population, and every row under that header
 * must carry that status — the count and the rows are cut from one population,
 * never the count from the whole corpus and the rows from somewhere else, nor
 * the count from the page's own slice.
 */
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
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
    useFeatureFlagEnabledOptional: mocks.useFeatureFlagEnabledOptional,
  })
);
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: mocks.useSortParams,
}));
vi.mock("@repo/app/shared/hooks/use-group-expansion", async (orig) => ({
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
vi.mock("@repo/app/documents/components/favorite-button", () => ({
  FavoriteButton: () => null,
}));
// The subject is which band each row sits under, so the lead cell reports the
// row's own status; the cell's link and checkbox need app-root providers.
vi.mock("@repo/app/documents/components/table/cells/name-cell", () => ({
  NameCell: ({ item }: { item: { data: { id: string; status: string } } }) => (
    <span data-status={item.data.status} data-testid="grid-lead">
      {item.data.id}
    </span>
  ),
}));
vi.mock(
  "@repo/app/documents/components/table/document-row",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/documents/components/table/document-row")
    >()),
    useDocumentRowHref: () => () => null,
  })
);

import { DocumentsView } from "@repo/app/documents/components/table/documents-view";

const DIGITS_ONLY = /^\d+$/;
const PAGE_SIZE = 4;

/** Uneven populations, so a page-local count can never equal a section total by accident. */
const POPULATION_SIZES: readonly (readonly [DocumentStatus, number])[] = [
  [DocumentStatus.Draft, 6],
  [DocumentStatus.InReview, 3],
  [DocumentStatus.Approved, 5],
];
const POPULATION: Readonly<Record<string, number>> =
  Object.fromEntries(POPULATION_SIZES);

const FULL_POPULATION: DocumentRowData[] = POPULATION_SIZES.flatMap(
  ([status, size]) =>
    Array.from({ length: size }, (_, index) =>
      makeArtifact({ id: `${status}-${index}`, status })
    )
);

const PAGING_INPUT = {
  documents: FULL_POPULATION,
  filterCategory: "all" as const,
  filterText: "",
  groupBy: GroupByMode.Status,
  sortBy: null,
  sortDir: "asc" as const,
  treeData: emptyTree(),
};

function emptyTree(): ProjectTreeResponse {
  return { externalParents: [], nodes: [] };
}

/**
 * The tree case: every document root parents one branch, so the painted rows
 * outnumber the paged roots. Paging, totals and the band count are all in
 * ROOTS; the branch rides along under its root's band.
 */
const TREE_PAGING_INPUT = {
  ...PAGING_INPUT,
  treeData: {
    externalParents: [],
    nodes: FULL_POPULATION.map(documentRootWithBranch),
  } satisfies ProjectTreeResponse,
};

function documentRootWithBranch(document: DocumentRowData): TreeNode {
  return {
    children: [
      {
        ...makeRawArtifact(ArtifactType.Branch, {
          id: `${document.id}-branch`,
          name: `${document.id}-branch`,
        }),
        depth: 1,
        linkType: LinkType.Produces,
        parentId: document.id,
      },
    ],
    root: makeRawArtifact(ArtifactType.Document, {
      id: document.id,
      name: document.id,
      status: document.status,
    }),
  };
}

/** One page of the windowed response, exactly as a paged caller receives it. */
function windowedPage(pageIndex: number, input = PAGING_INPUT) {
  const plan = buildTableViewPagePlan(input, PAGE_SIZE);
  if (plan === null) {
    throw new Error("a grouped board always has a page plan");
  }
  const planPage = plan.pages[pageIndex];
  if (!planPage) {
    throw new Error(`no page ${pageIndex} in the plan`);
  }
  const page = pageTableView({
    ...input,
    page: pageIndex,
    pageIds: planPage.ids,
    pageSize: PAGE_SIZE,
  });
  return {
    continuedSectionKeys: planPage.continuedSectionKeys,
    documents: page.pagedDocuments,
    pageCount: plan.pages.length,
    sectionTotals: plan.sectionTotals,
    treeData: page.pagedTreeData,
  };
}

function pageCount(input = PAGING_INPUT): number {
  return windowedPage(0, input).pageCount;
}

type RenderedBand = {
  label: string;
  count: number | null;
  rowStatuses: string[];
};

/**
 * Walk the grid's rows in order: a band header opens a band, and each data row
 * after it belongs to that band until the next header.
 */
function renderedBands(): RenderedBand[] {
  const bands: RenderedBand[] = [];
  for (const row of screen.getAllByRole("row")) {
    // The column header row carries menu triggers of its own.
    if (within(row).queryAllByRole("columnheader").length > 0) {
      continue;
    }
    const header = within(row)
      .queryAllByRole("button")
      .find((button) => button.getAttribute("aria-expanded") !== null);
    const lead = within(row).queryByTestId("grid-lead");
    if (header && lead === null) {
      const countText = within(header).queryByText(DIGITS_ONLY)?.textContent;
      bands.push({
        count: countText === undefined ? null : Number(countText),
        label: header.textContent ?? "",
        rowStatuses: [],
      });
    } else if (lead !== null) {
      bands.at(-1)?.rowStatuses.push(lead.getAttribute("data-status") ?? "");
    }
  }
  return bands;
}

function statusOfBand(band: RenderedBand): string {
  const status = Object.keys(POPULATION).find((candidate) =>
    band.label.includes(ARTIFACT_STATUS_LABELS[candidate] ?? candidate)
  );
  if (status === undefined) {
    throw new Error(`band "${band.label}" names no status in the population`);
  }
  return status;
}

const BASE_PROPS = {
  filterCategory: "all" as const,
  filterText: "",
  groupBy: GroupByMode.Status,
  storageKey: "windowed",
  visibleColumns: [DocumentColumn.Type],
};

describe("DocumentsView band counts over a windowed server response (PRD-720)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectTree.mockReturnValue({ data: undefined, isLoading: false });
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    mocks.useFeatureFlagEnabledOptional.mockReturnValue(false);
    mocks.useSortParams.mockReturnValue({
      clearPersistedSort: vi.fn(),
      clearSort: vi.fn(),
      setSort: vi.fn(),
      sortBy: null,
      sortDir: "asc",
    });
    mocks.useGroupExpansion.mockReturnValue({
      isExpanded: () => true,
      toggleGroup: vi.fn(),
    });
    mocks.useMergeDocuments.mockReturnValue({ mutateAsync: vi.fn() });
    mocks.useStackRanking.mockReturnValue({
      handleDragEnd: vi.fn(),
      isDndEnabled: false,
      isRankableMenuItem: () => false,
      moveToBottom: vi.fn(),
      moveToTop: vi.fn(),
      rankItemIds: [],
      rankInteractionMode: "disabledGrouped",
    });
    mocks.useContextGroupExpansion.mockReturnValue({
      isTreeGroupExpanded: () => true,
      toggleTreeGroup: vi.fn(),
    });
  });

  it("windows the population across several pages, so a page holds only part of a band", () => {
    // The premise every case below rests on: without it a page-local count
    // would equal the total and the cases could not tell the two apart.
    expect(pageCount()).toBeGreaterThan(1);
    expect(windowedPage(1).continuedSectionKeys.size).toBeGreaterThan(0);
  });

  it("states each band's full population over exactly the rows of that status, on every page", () => {
    let sawPartialBand = false;
    for (let pageIndex = 0; pageIndex < pageCount(); pageIndex += 1) {
      const page = windowedPage(pageIndex);
      const { unmount } = render(
        <DocumentsView
          {...BASE_PROPS}
          continuedSectionKeys={page.continuedSectionKeys}
          documents={page.documents}
          sectionTotalsByKey={page.sectionTotals}
          treeData={page.treeData}
        />
      );

      const bands = renderedBands();
      expect(bands.length).toBeGreaterThan(0);
      for (const band of bands) {
        const status = statusOfBand(band);
        expect(band.count).toBe(POPULATION[status]);
        expect(band.rowStatuses.length).toBeGreaterThan(0);
        expect(new Set(band.rowStatuses)).toEqual(new Set([status]));
        if (band.rowStatuses.length !== POPULATION[status]) {
          sawPartialBand = true;
        }
      }
      unmount();
    }
    // At least one band was windowed, so a header falling back to the rows on
    // the page would have stated a different number somewhere above.
    expect(sawPartialBand).toBe(true);
  });

  it("counts a tree band by its roots, with descendants painted under it, on every page", () => {
    expect(pageCount(TREE_PAGING_INPUT)).toBeGreaterThan(1);
    const branchStatus = GitHubPRState.Open;
    const rootsSeen = new Map<string, number>();
    let sawPartialBand = false;
    for (
      let pageIndex = 0;
      pageIndex < pageCount(TREE_PAGING_INPUT);
      pageIndex += 1
    ) {
      const page = windowedPage(pageIndex, TREE_PAGING_INPUT);
      const { unmount } = render(
        <DocumentsView
          {...BASE_PROPS}
          continuedSectionKeys={page.continuedSectionKeys}
          documents={page.documents}
          sectionTotalsByKey={page.sectionTotals}
          treeData={page.treeData}
        />
      );

      const bands = renderedBands();
      expect(bands.length).toBeGreaterThan(0);
      for (const band of bands) {
        const status = statusOfBand(band);
        const roots = band.rowStatuses.filter((row) => row === status);
        const descendants = band.rowStatuses.filter(
          (row) => row === branchStatus
        );
        // The header states its ROOT population; the painted descendants
        // never inflate it, and nothing else lands in the band.
        expect(band.count).toBe(POPULATION[status]);
        expect(roots.length).toBeGreaterThan(0);
        expect(descendants).toHaveLength(roots.length);
        expect(roots.length + descendants.length).toBe(band.rowStatuses.length);
        rootsSeen.set(status, (rootsSeen.get(status) ?? 0) + roots.length);
        if (roots.length !== POPULATION[status]) {
          sawPartialBand = true;
        }
      }
      unmount();
    }
    expect(sawPartialBand).toBe(true);
    // Across the pages, the roots under each header add up to the number it
    // stated: every root painted once, none dropped between pages.
    expect(Object.fromEntries(rootsSeen)).toEqual(POPULATION);
  });

  it("states no number for a band whose total the caller did not supply", () => {
    const page = windowedPage(0);
    const [uncoveredKey] = [...page.sectionTotals.keys()];
    const partialTotals = new Map(page.sectionTotals);
    partialTotals.delete(uncoveredKey);

    render(
      <DocumentsView
        {...BASE_PROPS}
        continuedSectionKeys={page.continuedSectionKeys}
        documents={page.documents}
        sectionTotalsByKey={partialTotals}
        treeData={page.treeData}
      />
    );

    const uncovered = renderedBands().find(
      (band) => statusOfBand(band) === uncoveredKey
    );
    expect(uncovered).toBeDefined();
    // The rows are on screen; their page-local tally must not stand in for
    // the population the caller withheld.
    expect(uncovered?.rowStatuses.length).toBeGreaterThan(0);
    expect(uncovered?.count).toBeNull();
  });

  it("counts the rendered rows when the response is not windowed", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={FULL_POPULATION}
        treeData={emptyTree()}
      />
    );

    const bands = renderedBands();
    expect(bands.map(statusOfBand).sort()).toEqual(
      Object.keys(POPULATION).sort()
    );
    for (const band of bands) {
      expect(band.count).toBe(band.rowStatuses.length);
      expect(band.count).toBe(POPULATION[statusOfBand(band)]);
    }
  });
});
