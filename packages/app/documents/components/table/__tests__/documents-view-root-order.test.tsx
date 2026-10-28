import { ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { DocumentStatus } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import {
  ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY,
  ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  makeArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9437 production wiring — `DocumentsView` reads the ordering keys ITSELF
 * and threads the result through every pipeline call it makes.
 *
 * Three cases, one per call site: `buildFlatItems` (a flat category tab),
 * `buildSortedGroups` (the ungrouped "all" tree), and `buildDocumentGridGroups`
 * (the section headers). Dropping the `ordering` argument from any one of them
 * leaves that case rendering today's order while the flag is on, which is what
 * these assert against.
 */
const mocks = vi.hoisted(() => ({
  useProjectTree: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useFeatureFlagEnabledOptional: vi.fn(),
  useFeatureFlagGateOptional: vi.fn(),
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
    // Partial: the surface reaches through more of this module than the three
    // reads overridden here, and a total factory drops them.
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
    useFeatureFlagEnabledOptional: mocks.useFeatureFlagEnabledOptional,
    useFeatureFlagGateOptional: mocks.useFeatureFlagGateOptional,
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
// The subject is row ORDER, not the row's own chrome; a real `DocumentRow`
// pulls in the auth, api-client and navigation providers an app root supplies.
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
 * `GARBAGE` is in no status vocabulary, which is the routine case for the branch
 * and session rows this table also mixes. Today it ranks with every other miss;
 * root-first puts it last, behind the `done` band.
 */
function statusRow(id: string, status: string): DocumentWithProject {
  return {
    ...makeArtifact({ id, title: id, slug: id }),
    status,
  } as DocumentWithProject;
}

const ROWS = [
  statusRow("row-garbage", "GARBAGE"),
  statusRow("row-executed", DocumentStatus.Executed),
  statusRow("row-draft", DocumentStatus.Draft),
];

/**
 * Descending is where the two orders separate: today the unranked row floats to
 * the TOP, and root-first parks it last in both directions.
 */
const FLAG_OFF_DESC_ORDER = ["row-garbage", "row-executed", "row-draft"];
const ROOT_FIRST_DESC_ORDER = ["row-executed", "row-draft", "row-garbage"];

const SECTION_ROWS = [
  statusRow("row-obsolete", DocumentStatus.Obsolete),
  statusRow("row-executed", DocumentStatus.Executed),
];

/** One branch tree root whose `MERGED` status is in no document vocabulary. */
function mergedBranchTree(): ProjectTreeResponse {
  return {
    nodes: [
      {
        root: makeRawArtifact(ArtifactType.Branch, {
          id: "branch-merged",
          name: "branch-merged",
          status: GitHubPRState.Merged,
        }),
        children: [],
      },
    ],
    externalParents: [],
  };
}

const BASE_PROPS = {
  filterText: "",
  visibleColumns: [DocumentColumn.Type],
  storageKey: "test",
  documents: ROWS,
};

function emptyTree(): ProjectTreeResponse {
  return { nodes: [], externalParents: [] };
}

function setFlags({ rootOrder }: { rootOrder: boolean }): void {
  mocks.useFeatureFlagGateOptional.mockImplementation((key: string) => {
    if (key === ARTIFACT_STATUS_ROOT_ORDER_FEATURE_FLAG_KEY) {
      return { enabled: rootOrder, isReady: true };
    }
    if (key === ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY) {
      return { enabled: false, isReady: true };
    }
    return { enabled: false, isReady: true };
  });
}

function renderedRowIds(): string[] {
  return screen
    .getAllByTestId("document-row")
    .map((node) => node.textContent ?? "");
}

describe("DocumentsView reads the root-order keys itself", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectTree.mockReturnValue({ data: undefined, isLoading: false });
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    mocks.useFeatureFlagEnabledOptional.mockReturnValue(false);
    mocks.useSortParams.mockReturnValue({
      sortBy: SortKey.Status,
      sortDir: "desc",
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
    setFlags({ rootOrder: false });
  });

  it("orders a flat category tab by today's rank while the key is OFF", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        filterCategory="documents"
        groupBy={GroupByMode.None}
        treeData={emptyTree()}
      />
    );
    expect(renderedRowIds()).toEqual(FLAG_OFF_DESC_ORDER);
  });

  it("orders a flat category tab root-first once the key is ON", () => {
    // Pins the `buildFlatItems` call site.
    setFlags({ rootOrder: true });
    render(
      <DocumentsView
        {...BASE_PROPS}
        filterCategory="documents"
        groupBy={GroupByMode.None}
        treeData={emptyTree()}
      />
    );
    expect(renderedRowIds()).toEqual(ROOT_FIRST_DESC_ORDER);
  });

  it("defers to the ordering the server NAMED over its own key", () => {
    // ISS-10472 (whitlockk, PR #9091): a server-paged caller hands down the
    // ordering the response carried, because the server resolved its own
    // PostHog read and packed the page that way. With the browser key ON and
    // the response naming `vocabulary`, the rows read the server's plan — the
    // caller's section totals were keyed in it, and a view ordering by its own
    // answer bands rows under keys no total was computed for.
    setFlags({ rootOrder: true });
    render(
      <DocumentsView
        {...BASE_PROPS}
        filterCategory="documents"
        groupBy={GroupByMode.None}
        sectionOrdering={ArtifactSectionOrdering.Vocabulary}
        treeData={emptyTree()}
      />
    );
    expect(renderedRowIds()).toEqual(FLAG_OFF_DESC_ORDER);
  });

  it("orders the ungrouped 'all' tree root-first once the key is ON", () => {
    // Pins the `buildSortedGroups` call site, which the flat tab never reaches.
    setFlags({ rootOrder: true });
    render(
      <DocumentsView
        {...BASE_PROPS}
        filterCategory="all"
        groupBy={GroupByMode.None}
        treeData={emptyTree()}
      />
    );
    expect(renderedRowIds()).toEqual(ROOT_FIRST_DESC_ORDER);
  });

  it("orders the ungrouped 'all' tree by today's rank while the key is OFF", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        filterCategory="all"
        groupBy={GroupByMode.None}
        treeData={emptyTree()}
      />
    );
    expect(renderedRowIds()).toEqual(FLAG_OFF_DESC_ORDER);
  });

  it("orders the section HEADERS root-first once the key is ON", () => {
    // Pins the `buildDocumentGridGroups` call site. A branch row is needed here:
    // every DOCUMENT status already ranks in root order, so only a row from
    // another vocabulary can separate the two section orders at all.
    setFlags({ rootOrder: true });
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={SECTION_ROWS}
        filterCategory="all"
        groupBy={GroupByMode.Status}
        treeData={mergedBranchTree()}
      />
    );
    // `MERGED` is a raw-rank miss inside the `done` band, so it sits beside
    // `Executed` and ahead of the `canceled` band.
    expect(sectionLabels()).toEqual(["Executed", "MERGED", "Obsolete"]);
  });

  it("orders the section headers by today's rank while the key is OFF", () => {
    render(
      <DocumentsView
        {...BASE_PROPS}
        documents={SECTION_ROWS}
        filterCategory="all"
        groupBy={GroupByMode.Status}
        treeData={mergedBranchTree()}
      />
    );
    // Today the miss ranks after every named status, so it trails `Obsolete`.
    expect(sectionLabels()).toEqual(["Executed", "Obsolete", "MERGED"]);
  });
});

const SECTION_LABELS = ["Executed", "Obsolete", "MERGED"];

/**
 * The section header labels the reader sees, in render order.
 *
 * Matched by label rather than by `aria-expanded` alone: the sortable Name
 * column header is also a disclosure button, so the attribute by itself picks it
 * up too. The caller asserts the full expected sequence, so a section this
 * predicate failed to match would shorten the list and fail there.
 */
function sectionLabels(): string[] {
  return screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-expanded") !== null)
    .flatMap((button) => {
      const text = button.textContent ?? "";
      const label = SECTION_LABELS.find((candidate) =>
        text.includes(candidate)
      );
      return label === undefined ? [] : [label];
    });
}
