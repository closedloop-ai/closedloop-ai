import { ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { ARTIFACT_PRIORITY_UNSET_FLAG_KEY } from "@repo/app/documents/lib/artifact-priority-unset-flag";
import { DOCUMENTS_INDEX_SEARCH_DEBOUNCE_MS } from "@repo/app/documents/lib/documents-index-paged-read";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useAssignedArtifactTree: vi.fn(),
  useSortParams: vi.fn(),
}));

vi.mock("@repo/app/projects/hooks/use-assigned-artifact-tree", () => ({
  useAssignedArtifactTree: mocks.useAssignedArtifactTree,
}));

// The paginators underneath read the sort from the URL, which needs the app
// router mounted; the subject here is neither sort nor routing.
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: mocks.useSortParams,
}));

import { useMyTasksListData } from "../use-my-tasks-list-data";

const NO_FILTERS = {
  assigneeIds: [],
  assignToMe: false,
  date: null,
  favoritesOnly: false,
  hideCompletedItems: false,
  priorities: [],
  statuses: [],
  tagIds: [],
};

/** One assigned issue whose stored priority is genuinely absent. */
function unsetPriorityTree(): ProjectTreeResponse {
  return {
    externalParents: [],
    nodes: [
      {
        root: {
          assignee: null,
          assigneeId: "user-1",
          createdAt: "2026-10-01T00:00:00.000Z",
          id: "root-1",
          name: "Unset priority issue",
          organizationId: "org-1",
          priority: null,
          projectId: null,
          slug: "ISS-1",
          sortOrder: 0,
          status: IssueStatus.Todo,
          subtype: "FEATURE",
          type: ArtifactType.Document,
          updatedAt: "2026-10-02T00:00:00.000Z",
        },
        children: [],
      },
    ],
    page: {
      limit: 50,
      offset: 0,
      ordering: ArtifactSectionOrdering.Vocabulary,
      total: 1,
    },
  } as unknown as ProjectTreeResponse;
}

function flagWrapper(enabledFlags: readonly string[]) {
  const adapter = createStaticFeatureFlagAdapter({ enabledFlags });
  return ({ children }: Readonly<{ children: ReactNode }>) => (
    <FeatureFlagAdapterProvider adapter={adapter}>
      {children}
    </FeatureFlagAdapterProvider>
  );
}

function renderListData(
  filterText: string,
  enabledFlags: readonly string[] = []
) {
  return renderHook(
    (props: { filterText: string }) =>
      useMyTasksListData({
        applyProjectFilters: (items) => items,
        assignedTotal: 0,
        assigneeId: "user-1",
        documentsHasMore: false,
        filterCategory: "all",
        filters: NO_FILTERS,
        filterText: props.filterText,
        groupBy: GroupByMode.None,
        isFilterActive: false,
        isListView: true,
        isRecencyWindowActive: false,
        isRecencyWindowFlagReady: true,
        projects: [],
        rawArtifacts: [],
        sortPersistenceKey: null,
      }),
    { initialProps: { filterText }, wrapper: flagWrapper(enabledFlags) }
  );
}

/** The `search` the hook last asked the tree read for. */
function lastRequestedSearch(): string | undefined {
  const calls = mocks.useAssignedArtifactTree.mock.calls;
  return calls.at(-1)?.[1]?.search;
}

describe("useMyTasksListData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.useAssignedArtifactTree.mockReturnValue({
      data: unsetPriorityTree(),
      isError: false,
      isLoading: false,
      refetch: vi.fn(),
    });
    mocks.useSortParams.mockReturnValue({
      clearPersistedSort: vi.fn(),
      clearSort: vi.fn(),
      setSort: vi.fn(),
      sortBy: null,
      sortDir: "asc",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ISS-10472 (tamsinb, PR #9091): the term reaches the SERVER now, and that
  // read is the anchor climb plus the `count(*)` beside it. Typing a word used
  // to issue one request per keystroke.
  it("holds the typed term back from the tree read until it settles", () => {
    const { rerender } = renderListData("");
    expect(lastRequestedSearch()).toBe("");

    rerender({ filterText: "m" });
    rerender({ filterText: "mi" });
    rerender({ filterText: "mig" });
    expect(lastRequestedSearch()).toBe("");

    act(() => {
      vi.advanceTimersByTime(DOCUMENTS_INDEX_SEARCH_DEBOUNCE_MS);
    });
    expect(lastRequestedSearch()).toBe("mig");
  });

  // ISS-9665 flag-OFF (whitlockk, PR #9091): the row model carries the `Medium` the
  // serializer used to fold an unset priority to, the same substitution the
  // `/documents` rows get — otherwise one artifact reads two ways on two tabs
  // of one board, and the group header, the sort and the cell all disagree.
  it("folds an unset priority to Medium on the tree rows while the key is off", () => {
    const { result } = renderListData("");

    expect(result.current.documents[0]?.priority).toBe(Priority.Medium);
  });

  it("reports an unset priority honestly once the key is on", () => {
    const { result } = renderListData("", [ARTIFACT_PRIORITY_UNSET_FLAG_KEY]);

    expect(result.current.documents[0]?.priority).toBeNull();
  });

  // ISS-10472 (whitlockk, PR #9091): the renderer is handed the ordering the
  // RESPONSE named, because the server resolved its own PostHog read and packed
  // the page that way.
  it("surfaces the ordering the server named for the page", () => {
    const { result } = renderListData("");

    expect(result.current.sectionOrdering).toBe(
      ArtifactSectionOrdering.Vocabulary
    );
  });
});
