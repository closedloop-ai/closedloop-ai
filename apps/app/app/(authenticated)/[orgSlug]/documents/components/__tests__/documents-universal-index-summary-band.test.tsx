import { DocumentType } from "@repo/api/src/types/document";
import {
  resolveLegalTablePageSize,
  TABLE_PAGE_SIZE_OPTIONS,
} from "@repo/design-system/components/ui/table-page-size-select";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FEA-4140: DocumentsIndexView lists DOC artifacts at org scope,
// composing the shared DocumentsView + toolbar. The data hooks are mocked so
// this test asserts the container's contract — it requests DOC
// documents and hands them to the shared table — without a query/DB provider.
const mocks = vi.hoisted(() => ({
  useFeatureFlagGate: vi.fn(),
  useDocuments: vi.fn(),
  useDocumentsPage: vi.fn(),
  useUpdateDocument: vi.fn(),
  useDeleteRowItem: vi.fn(),
  useOrgUsersAsPopoverUsers: vi.fn(),
  useColumnVisibility: vi.fn(),
  useScrollRestore: vi.fn(),
  useViewStatePersistence: vi.fn(),
  documentsViewProps: vi.fn(),
  // Assigned in `beforeEach`: a hoisted factory cannot read an import.
  sort: { sortBy: null as string | null, sortDir: "asc" },
}));
/**
 * ISS-9157: the paged read as every case in this file sees it — mounted with
 * its gate CLOSED and resolved, so it issues nothing and hands back nothing.
 * Set after each `clearAllMocks` beside the unbounded read's own default.
 */
function pagedReadDisabled() {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (orig) => ({
    // Partial, not total: the surface under test reaches through MORE of this
    // module than the keys overridden below (ISS-9726), and a total factory
    // drops every export it does not name.
    ...(await orig<Record<string, unknown>>()),
    useFeatureFlagGate: mocks.useFeatureFlagGate,
  })
);
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocuments: mocks.useDocuments,
  useDocumentsPage: mocks.useDocumentsPage,
  useUpdateDocument: mocks.useUpdateDocument,
}));
vi.mock("@repo/app/documents/hooks/use-delete-row-item", () => ({
  useDeleteRowItem: mocks.useDeleteRowItem,
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  useOrgUsersAsPopoverUsers: mocks.useOrgUsersAsPopoverUsers,
}));
vi.mock("@repo/app/shared/hooks/use-column-visibility", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, useColumnVisibility: mocks.useColumnVisibility };
});
vi.mock("@repo/app/shared/hooks/use-scroll-restore", () => ({
  useScrollRestore: mocks.useScrollRestore,
}));
// ISS-9157: the container reads the table's sort for its cursor reset. The
// real hook needs the app router; the shipped default sort is what it would
// resolve to with no URL and no persisted choice.
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => ({
    ...mocks.sort,
    setSort: vi.fn(),
    clearSort: vi.fn(),
    clearPersistedSort: vi.fn(),
  }),
}));
// ISS-9157: the ladder resolves closed and ready, as it does with no provider.
vi.mock("@repo/app/shared/hooks/use-table-page-size-options", () => ({
  useTablePageSizeOptions: (requested: number) => ({
    isExtendedLadderEnabled: false,
    isReady: true,
    options: TABLE_PAGE_SIZE_OPTIONS,
    pageSize: resolveLegalTablePageSize(requested, TABLE_PAGE_SIZE_OPTIONS),
  }),
}));
// ISS-9726 wiring: a sentinel namespace, so the assertions below fail if this
// surface ever addresses its raw base literals again.
vi.mock("@repo/app/shared/hooks/use-view-state-key", () => ({
  useViewStateKey: (baseKey: string) => `ns::${baseKey}`,
}));
vi.mock("@repo/app/shared/hooks/use-view-state-persistence", () => ({
  useViewStatePersistence: mocks.useViewStatePersistence,
}));

// Leaf surfaces → markers so no navigation/DnD/query providers are needed.
vi.mock("@repo/app/documents/components/table/document-table-toolbar", () => ({
  DocumentTableToolbar: () => <div data-testid="toolbar" />,
}));
vi.mock("@repo/app/artifacts/components/artifact-list", async () => {
  const { DocumentsPrototypeHostProbe } = await import(
    "./documents-prototype-host-probe"
  );
  return {
    ArtifactList: (
      props: Parameters<typeof DocumentsPrototypeHostProbe>[0]
    ) => (
      <DocumentsPrototypeHostProbe
        {...props}
        observe={mocks.documentsViewProps}
      />
    ),
  };
});

import { DocumentsUniversalIndexView as DocumentsIndexView } from "@repo/app/documents/components/index/documents-universal-index-view";

const PAST_THE_DEBOUNCE_MS = 400;

const DOC = {
  id: "doc-1",
  type: DocumentType.Doc,
  title: "Runbook",
  projectId: null,
};

describe("Documents index summary population", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDocumentsPage.mockReturnValue(pagedReadDisabled());
    mocks.useFeatureFlagGate.mockReturnValue({ enabled: false, isReady: true });
    mocks.useDocuments.mockReturnValue({
      data: [DOC],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    });
    mocks.useUpdateDocument.mockReturnValue({ mutate: vi.fn() });
    mocks.useDeleteRowItem.mockReturnValue(vi.fn());
    mocks.useOrgUsersAsPopoverUsers.mockReturnValue([]);
    mocks.useViewStatePersistence.mockReturnValue(["", vi.fn(), vi.fn()]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the unpaged matching search to the shared summary", () => {
    mocks.useViewStatePersistence.mockReturnValue([
      "Runbook",
      vi.fn(),
      vi.fn(),
    ]);
    render(<DocumentsIndexView />);
    expect(mocks.documentsViewProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        searchParams: {
          recencyDays: 30,
          types: [
            DocumentType.Prd,
            DocumentType.ImplementationPlan,
            DocumentType.Doc,
          ],
          search: "Runbook",
        },
        isSummaryUnsettled: false,
      })
    );
  });

  it("keeps page and summary populations aligned when only recency changes", () => {
    render(<DocumentsIndexView />);
    const props = mocks.documentsViewProps.mock.calls.at(-1)?.[0] as {
      onRecencyDaysChange: (days: number | undefined) => void;
    };
    act(() => props.onRecencyDaysChange(90));
    expect(
      mocks.documentsViewProps.mock.calls.at(-1)?.[0].searchParams.recencyDays
    ).toBe(90);
    act(() => props.onRecencyDaysChange(undefined));
    expect(
      mocks.documentsViewProps.mock.calls.at(-1)?.[0].searchParams
    ).not.toHaveProperty("recencyDays");
  });

  it("holds the summary while a client-side term is settling", () => {
    vi.useFakeTimers();
    const { rerender } = render(<DocumentsIndexView />);
    mocks.useViewStatePersistence.mockReturnValue([
      "Runbook",
      vi.fn(),
      vi.fn(),
    ]);
    rerender(<DocumentsIndexView />);
    expect(mocks.documentsViewProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ isSummaryUnsettled: true })
    );
    act(() => {
      vi.advanceTimersByTime(PAST_THE_DEBOUNCE_MS);
    });
    expect(mocks.documentsViewProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ isSummaryUnsettled: false })
    );
  });
});
