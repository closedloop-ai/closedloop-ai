import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { TagColor } from "@repo/api/src/types/tag";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { makeFilterItem } from "@repo/app/documents/hooks/__tests__/table-filter-fixtures";
import { useTableFilters } from "@repo/app/documents/hooks/use-table-filters";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { NO_PRIORITY_LABEL } from "@repo/app/documents/lib/group-by";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY,
  ARTIFACT_TAGS_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentTableFilterUi } from "../use-document-table-filter-ui";

const mockGet = vi.fn();

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: (...args: unknown[]) => mockGet(...args),
  }),
}));

const ITEMS = [
  makeFilterItem("a", { assigneeId: "user-ada", priority: Priority.High }),
  makeFilterItem("b", { assigneeId: null, priority: null }),
  makeFilterItem("c", { assigneeId: null, priority: Priority.High }),
];

const TEAM_MEMBERS = [
  { id: "user-ada", name: "Ada Lovelace", avatarUrl: "https://a.test/ada.png" },
  { id: "user-grace", name: "Grace Hopper" },
];

function renderFilterUi(
  options: {
    enabledFlags?: readonly string[];
    hideAssignee?: boolean;
    items?: DocumentRowItem[];
    persistenceKey?: string;
    supportsUnknownStatusFacet?: boolean;
  } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const adapter = createStaticFeatureFlagAdapter({
    enabledFlags: options.enabledFlags ?? [],
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <QueryClientProvider client={queryClient}>
        <FeatureFlagAdapterProvider adapter={adapter}>
          {children}
        </FeatureFlagAdapterProvider>
      </QueryClientProvider>
    );
  }
  return renderHook(
    () => {
      const filtersReturn = useTableFilters({
        items: options.items ?? ITEMS,
        persistenceKey: options.persistenceKey ?? null,
        supportsUnknownStatusFacet: options.supportsUnknownStatusFacet,
      });
      return {
        filtersReturn,
        ui: useDocumentTableFilterUi({
          filtersReturn,
          hideAssignee: options.hideAssignee,
          teamMembers: TEAM_MEMBERS,
          teamMembersError: null,
          teamMembersLoading: false,
        }),
      };
    },
    { wrapper: Wrapper }
  );
}

describe("useDocumentTableFilterUi", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("leads the assignee facet with Unassigned and counts rows per member", () => {
    const { result } = renderFilterUi();
    const { teamMembers, hideAssignee } = result.current.ui.viewModel;

    expect(hideAssignee).toBeUndefined();
    expect(
      teamMembers.map(({ id, label, count, avatarUrl, searchText }) => ({
        id,
        label,
        count,
        avatarUrl,
        searchText,
      }))
    ).toEqual([
      {
        id: "__unassigned__",
        label: UNASSIGNED_ASSIGNEE_LABEL,
        count: 2,
        avatarUrl: undefined,
        searchText: "unassigned",
      },
      {
        id: "user-ada",
        label: "Ada Lovelace",
        count: 1,
        avatarUrl: "https://a.test/ada.png",
        searchText: "Ada Lovelace",
      },
      {
        id: "user-grace",
        label: "Grace Hopper",
        count: 0,
        avatarUrl: undefined,
        searchText: "Grace Hopper",
      },
    ]);
  });

  it("offers no assignee options when the assignee facet is hidden", () => {
    const { result } = renderFilterUi({ hideAssignee: true });

    expect(result.current.ui.viewModel.teamMembers).toEqual([]);
    expect(result.current.ui.viewModel.hideAssignee).toBe(true);
  });

  it("offers a status shared by both vocabularies once, under the Document section", () => {
    const { result } = renderFilterUi();
    const { statusOptions } = result.current.ui.viewModel;

    const inReview = statusOptions.filter(
      (option) => option.id === DocumentStatus.InReview
    );
    expect(inReview).toHaveLength(1);
    expect(inReview[0].sectionLabel).toBe("Document Status");

    const triage = statusOptions.find(
      (option) => option.id === IssueStatus.Triage
    );
    expect(triage?.sectionLabel).toBe("Issue Status");
    expect(triage?.count).toBe(0);

    const draft = statusOptions.find(
      (option) => option.id === DocumentStatus.Draft
    );
    expect(draft?.count).toBe(ITEMS.length);
    expect(new Set(statusOptions.map((option) => option.id)).size).toBe(
      statusOptions.length
    );
  });

  it("offers one canonical Unknown option for all future tokens and excludes null", () => {
    const items = [
      rawFilterItem("future-1", "FUTURE_ONE"),
      rawFilterItem("future-2", "FUTURE_TWO"),
      rawFilterItem("null", null),
    ];
    const { result } = renderFilterUi({
      enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      items,
    });

    const unknown = result.current.ui.viewModel.statusOptions.filter(
      (option) => option.id === DISPLAYED_ARTIFACT_STATUS.Unknown
    );
    expect(unknown).toHaveLength(1);
    expect(result.current.ui.viewModel.statusOptions[0]?.id).toBe(
      DISPLAYED_ARTIFACT_STATUS.Unknown
    );
    expect(unknown[0]).toMatchObject({
      count: 2,
      label: "Unknown",
      searchText: "Unknown",
    });
    expect(
      result.current.ui.viewModel.statusOptions.some((option) =>
        option.label.includes("FUTURE")
      )
    ).toBe(false);
  });

  it("keeps Unknown absent at zero when it is not selected", () => {
    const { result } = renderFilterUi({
      enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      items: [
        rawFilterItem("known", DocumentStatus.Draft),
        rawFilterItem("null", null),
      ],
    });

    expect(result.current.ui.viewModel.statusOptions).not.toContainEqual(
      expect.objectContaining({ id: DISPLAYED_ARTIFACT_STATUS.Unknown })
    );
    expect(result.current.filtersReturn.filters.statuses).toEqual([]);
  });

  it("keeps selected Unknown removable after its count falls to zero", () => {
    const options = {
      enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      items: [rawFilterItem("future", "FUTURE_STATUS")],
    };
    const { result, rerender } = renderFilterUi(options);

    act(() => {
      result.current.ui.controller.toggleStatus(
        DISPLAYED_ARTIFACT_STATUS.Unknown
      );
    });
    expect(
      result.current.filtersReturn.applyFilters(options.items)
    ).toHaveLength(1);

    options.items = [rawFilterItem("future", DocumentStatus.Draft)];
    rerender();

    const unknown = result.current.ui.viewModel.statusOptions.filter(
      (option) => option.id === DISPLAYED_ARTIFACT_STATUS.Unknown
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({
      count: 0,
      label: "Unknown",
      searchText: "Unknown",
    });
    expect(unknown[0]?.content).toBeDefined();
    expect(unknown[0]?.sectionLabel).toBeUndefined();
    expect(result.current.ui.controller.filters.statuses).toEqual([
      DISPLAYED_ARTIFACT_STATUS.Unknown,
    ]);
    expect(result.current.filtersReturn.applyFilters(options.items)).toEqual(
      []
    );
    expect(result.current.ui.controller.activeChips).toContainEqual({
      category: "status",
      label: "Status: 1",
    });

    act(() => {
      result.current.ui.controller.toggleStatus(
        DISPLAYED_ARTIFACT_STATUS.Unknown
      );
    });
    expect(result.current.ui.controller.filters.statuses).toEqual([]);
    expect(result.current.filtersReturn.applyFilters(options.items)).toEqual(
      options.items
    );
    expect(
      result.current.ui.controller.activeChips.some(
        (chip) => chip.category === "status"
      )
    ).toBe(false);
    expect(result.current.ui.viewModel.statusOptions).not.toContainEqual(
      expect.objectContaining({ id: DISPLAYED_ARTIFACT_STATUS.Unknown })
    );
  });

  it("neither offers nor applies Unknown on a server-filtered surface", () => {
    const persistenceKey = "test:my-tasks-all-tab-statuses";
    localStorage.setItem(
      persistenceKey,
      JSON.stringify({
        savedAt: Date.now(),
        data: {
          assigneeIds: [],
          assignToMe: false,
          date: null,
          favoritesOnly: false,
          hideCompletedItems: false,
          priorities: [],
          statuses: [DISPLAYED_ARTIFACT_STATUS.Unknown],
          tagIds: [],
        },
      })
    );
    const { result } = renderFilterUi({
      enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      items: [rawFilterItem("future", "FUTURE_STATUS")],
      persistenceKey,
      supportsUnknownStatusFacet: false,
    });

    expect(result.current.ui.viewModel.statusOptions).not.toContainEqual(
      expect.objectContaining({ id: DISPLAYED_ARTIFACT_STATUS.Unknown })
    );
    expect(result.current.filtersReturn.filters.statuses).toEqual([]);
    // Left in storage, as the flag-off path leaves it: the selection is
    // unexpressible here, not retracted.
    expect(
      JSON.parse(localStorage.getItem(persistenceKey) ?? "{}").data.statuses
    ).toEqual([DISPLAYED_ARTIFACT_STATUS.Unknown]);
  });

  it("offers Unknown on a surface that filters in the browser", () => {
    const { result } = renderFilterUi({
      enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      items: [rawFilterItem("future", "FUTURE_STATUS")],
      supportsUnknownStatusFacet: true,
    });

    expect(result.current.ui.viewModel.statusOptions).toContainEqual(
      expect.objectContaining({ id: DISPLAYED_ARTIFACT_STATUS.Unknown })
    );
  });

  it("does not offer Unknown through the flag-off filter path", () => {
    const { result } = renderFilterUi({
      items: [rawFilterItem("future", "FUTURE_STATUS")],
    });

    expect(result.current.ui.viewModel.statusOptions).not.toContainEqual(
      expect.objectContaining({ id: DISPLAYED_ARTIFACT_STATUS.Unknown })
    );
    expect(
      result.current.filtersReturn.statusCounts.get(DocumentStatus.Draft)
    ).toBe(1);
  });

  it("lists priorities lowest-first with no unset facet while both flags are off", () => {
    const { result } = renderFilterUi();
    const { priorityOptions } = result.current.ui.viewModel;

    expect(priorityOptions.map((option) => option.id)).toEqual([
      Priority.Low,
      Priority.Medium,
      Priority.High,
      Priority.Urgent,
    ]);
    expect(
      priorityOptions.find((option) => option.id === Priority.High)?.count
    ).toBe(2);
  });

  it("lists priorities highest-first and appends the counted unset facet when both flags are on", () => {
    const { result } = renderFilterUi({
      enabledFlags: [
        ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY,
        ARTIFACT_PRIORITY_UNSET_FLAG_KEY,
      ],
    });
    const { priorityOptions } = result.current.ui.viewModel;

    expect(priorityOptions.map((option) => option.id)).toEqual([
      Priority.Urgent,
      Priority.High,
      Priority.Medium,
      Priority.Low,
      PRIORITY_UNSET_VALUE,
    ]);
    const unset = priorityOptions.at(-1);
    expect(unset?.label).toBe(NO_PRIORITY_LABEL);
    expect(unset?.searchText).toBe(NO_PRIORITY_LABEL);
    expect(unset?.count).toBe(1);
  });

  it("builds tag options from the org tags and shows them only behind the tags flag", async () => {
    mockGet.mockResolvedValue([
      {
        id: "tag-1",
        organizationId: "org-1",
        name: "backend",
        color: TagColor.Blue,
        createdById: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const off = renderFilterUi();
    // Nothing is offered until the org tags actually arrive.
    expect(off.result.current.ui.viewModel.tagOptions).toEqual([]);
    await waitFor(() =>
      expect(off.result.current.ui.viewModel.tagOptions).toEqual([
        {
          id: "tag-1",
          label: "backend",
          color: TagColor.Blue,
          searchText: "backend",
        },
      ])
    );
    expect(mockGet).toHaveBeenCalledWith("/tags");
    expect(off.result.current.ui.viewModel.showTags).toBe(false);
    off.unmount();

    const on = renderFilterUi({
      enabledFlags: [ARTIFACT_TAGS_FEATURE_FLAG_KEY],
    });
    expect(on.result.current.ui.viewModel.showTags).toBe(true);
  });

  it("exposes the filter state's own actions and chips on the controller", () => {
    const { result } = renderFilterUi();
    const { controller } = result.current.ui;
    const { filtersReturn } = result.current;

    expect(controller.filters).toBe(filtersReturn.filters);
    expect(controller.activeChips).toBe(filtersReturn.activeChips);
    expect(controller.toggleStatus).toBe(filtersReturn.toggleStatus);

    act(() => {
      result.current.filtersReturn.toggleStatus(DocumentStatus.Draft);
    });

    // The controller tracks the filter state; it does not freeze the first one.
    expect(result.current.ui.controller.filters.statuses).toEqual([
      DocumentStatus.Draft,
    ]);
    expect(result.current.ui.controller.filters).toBe(
      result.current.filtersReturn.filters
    );
  });
});

function rawFilterItem(id: string, rawStatus: string | null): DocumentRowItem {
  const item = makeFilterItem(id);
  if (item.kind !== "document") {
    throw new Error("filter fixture must be a document row");
  }
  return {
    children: item.children,
    data: { ...item.data, rawStatus } as DocumentRowData,
    kind: "document",
  };
}
