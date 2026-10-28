// @vitest-environment jsdom

import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactBoardGroup,
  type ProjectArtifactBoardPageResponse,
} from "@repo/api/src/types/project-artifact-board-page";
import {
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import {
  projectArtifactPlacementCapabilityKey,
  useArtifactPlacement,
  useArtifactPlacementCapability,
} from "@repo/app/projects/hooks/use-artifact-placement";
import { projectArtifactBoardPageKeys } from "@repo/app/projects/hooks/use-project-artifact-board-page";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiClient, manualOrdering, toastError, toastSuccess } = vi.hoisted(
  () => ({
    apiClient: { get: vi.fn(), post: vi.fn() },
    manualOrdering: { enabled: true },
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  })
);

vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => apiClient,
}));
vi.mock("@repo/app/shared/feature-flags/use-manual-artifact-ordering", () => ({
  useManualArtifactOrderingEnabled: () => manualOrdering.enabled,
}));
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const PROJECT_ID = "00000000-0000-4000-8000-000000000010";
const DESTINATION_ID = "00000000-0000-4000-8000-000000000020";

function node(id: string) {
  return {
    root: makeRawArtifact(ArtifactType.Document, {
      id,
      name: id,
      projectId: PROJECT_ID,
    }),
    children: [],
  };
}

function tree(...ids: string[]): ProjectTreeResponse {
  return {
    nodes: ids.map(node),
    externalParents: [],
    projectVersion: "source-v1",
  };
}

function intent() {
  return {
    sourceArtifactIds: ["source"],
    destinationProjectId: PROJECT_ID,
    position: ProjectArtifactPlacementPosition.Before,
    targetArtifactId: "target",
    source: ProjectArtifactPlacementSource.Pointer,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("useArtifactPlacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation((path: string) =>
      Promise.resolve({
        projectId: path.includes(DESTINATION_ID) ? DESTINATION_ID : PROJECT_ID,
        projectVersion: path.includes(DESTINATION_ID)
          ? "destination-v1"
          : "source-v1",
      })
    );
  });

  it("AC-010 previews one bounded tree move then invalidates every authoritative project", async () => {
    const pending = deferred<{
      placed: true;
      transactionId: string;
      affectedArtifactIds: string[];
      affectedProjectIds: string[];
      projectVersions: Record<string, string>;
      placement: ReturnType<typeof intent>;
      replayed: boolean;
      undoAvailable: boolean;
    }>();
    apiClient.post.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      placed: true,
      transactionId: "00000000-0000-4000-8000-000000000031",
      affectedArtifactIds: ["source"],
      affectedProjectIds: [PROJECT_ID, DESTINATION_ID],
      projectVersions: {
        [PROJECT_ID]: "source-v3",
        [DESTINATION_ID]: "destination-v3",
      },
      placement: intent(),
      replayed: false,
      undoAvailable: false,
    });
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    queryClient.setQueryData(
      projectTreeKeys.detail(PROJECT_ID),
      tree("target", "source")
    );
    queryClient.setQueryData(
      projectTreeKeys.detail(DESTINATION_ID),
      tree("destination")
    );
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => result.current.mutate(intent()));

    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<ProjectTreeResponse>(projectTreeKeys.detail(PROJECT_ID))
          ?.nodes.map(({ root }) => root.id)
      ).toEqual(["source", "target"])
    );
    expect(apiClient.post).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/artifacts/placement`,
      expect.objectContaining({
        ...intent(),
        expectedProjectVersions: {
          [PROJECT_ID]: "source-v1",
        },
      })
    );

    pending.resolve({
      placed: true,
      transactionId: "00000000-0000-4000-8000-000000000030",
      affectedArtifactIds: ["source"],
      affectedProjectIds: [PROJECT_ID, DESTINATION_ID],
      projectVersions: {
        [PROJECT_ID]: "source-v2",
        [DESTINATION_ID]: "destination-v2",
      },
      placement: intent(),
      replayed: false,
      undoAvailable: true,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      queryClient.getQueryState(projectTreeKeys.detail(PROJECT_ID))
        ?.isInvalidated
    ).toBe(true);
    expect(
      queryClient.getQueryState(projectTreeKeys.detail(DESTINATION_ID))
        ?.isInvalidated
    ).toBe(true);
    expect(toastSuccess).toHaveBeenCalledWith(
      "Moved",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo" }),
      })
    );
    const undoAction = toastSuccess.mock.calls[0]?.[1]?.action?.onClick;
    if (!undoAction) {
      throw new Error("Expected an undo action");
    }
    act(() => undoAction());
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    expect(apiClient.post).toHaveBeenLastCalledWith(
      `/projects/${PROJECT_ID}/artifacts/placement`,
      expect.objectContaining({
        kind: "undo",
        source: ProjectArtifactPlacementSource.Undo,
        undoOfTransactionId: "00000000-0000-4000-8000-000000000030",
      })
    );
  });

  it("AC-010 rolls back only the optimistic value owned by the failed mutation", async () => {
    const pending = deferred<never>();
    apiClient.post.mockReturnValue(pending.promise);
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const original = tree("source", "target");
    queryClient.setQueryData(projectTreeKeys.detail(PROJECT_ID), original);
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => result.current.mutate(intent()));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    const newer = tree("newer");
    queryClient.setQueryData(projectTreeKeys.detail(PROJECT_ID), newer);
    pending.reject(new Error("stale"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    const settled = queryClient.getQueryData(
      projectTreeKeys.detail(PROJECT_ID)
    );
    expect(settled).toStrictEqual(newer);
    expect(settled).not.toStrictEqual(original);
    expect(toastError).toHaveBeenCalledWith(
      "Failed to move items. Please try again."
    );
  });

  it("PRD-724 previews and rolls back the canonical board-page cache", async () => {
    const pending = deferred<never>();
    apiClient.post.mockReturnValue(pending.promise);
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const boardKey = projectArtifactBoardPageKeys.detail(
      PROJECT_ID,
      ProjectArtifactBoardGroup.Status
    );
    const original = boardData();
    queryClient.setQueryData(boardKey, original);
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() =>
      result.current.mutate({
        sourceArtifactIds: ["source"],
        destinationProjectId: PROJECT_ID,
        position: ProjectArtifactPlacementPosition.Root,
        source: ProjectArtifactPlacementSource.Pointer,
        expectedProjectVersions: { [PROJECT_ID]: "acted-on-v1" },
        lanePatch: {
          field: ProjectArtifactPlacementGroupField.Status,
          value: IssueStatus.InProgress,
        },
      })
    );
    await waitFor(() => {
      const current =
        queryClient.getQueryData<ReturnType<typeof boardData>>(boardKey);
      expect(current?.pages[0]?.lanes[0]?.cards).toHaveLength(0);
      expect(current?.pages[0]?.lanes[1]?.cards[0]?.artifact.id).toBe("source");
    });

    pending.reject(new Error("stale"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(boardKey)).toEqual(original);
  });

  it("ISS-12908 previews distinct raw targets for one selected board move and rolls them back together", async () => {
    const pending = deferred<never>();
    apiClient.post.mockReturnValue(pending.promise);
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const boardKey = projectArtifactBoardPageKeys.detail(
      PROJECT_ID,
      ProjectArtifactBoardGroup.Status
    );
    const original = boardData();
    const page = original.pages[0]!;
    const backlog = page.lanes[0]!.cards[0]!;
    backlog.artifact.status = IssueStatus.Backlog;
    page.lanes[0]!.id = IssueStatus.Backlog;
    const progress = {
      ...backlog,
      artifact: {
        ...backlog.artifact,
        id: "second",
        status: IssueStatus.InProgress,
      },
    };
    page.lanes[1]!.cards = [progress];
    page.lanes[1]!.count = 1;
    page.lanes.push({
      cards: [],
      complete: true,
      count: 0,
      id: IssueStatus.Todo,
      label: "Todo",
    });
    page.rootIds = ["source", "second"];
    queryClient.setQueryData(boardKey, original);
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() =>
      result.current.mutate({
        ...intent(),
        // A lane drop always targets a loaded root or the lane end (Root).
        position: ProjectArtifactPlacementPosition.Root,
        targetArtifactId: undefined,
        sourceArtifactIds: ["source", "second"],
        expectedProjectVersions: { [PROJECT_ID]: "acted-on-v1" },
        lanePatch: {
          field: ProjectArtifactPlacementGroupField.Status,
          value: IssueStatus.Backlog,
          valuesByRootId: {
            source: IssueStatus.Backlog,
            second: IssueStatus.Todo,
          },
        },
      })
    );
    await waitFor(() => {
      const current =
        queryClient.getQueryData<ReturnType<typeof boardData>>(boardKey);
      expect(current?.pages[0]?.lanes[0]?.cards[0]?.artifact.status).toBe(
        IssueStatus.Backlog
      );
      expect(current?.pages[0]?.lanes[2]?.cards[0]?.artifact).toMatchObject({
        id: "second",
        status: IssueStatus.Todo,
      });
    });

    pending.reject(new Error("stale"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(boardKey)).toEqual(original);
  });

  it.each([
    [
      "before",
      ProjectArtifactPlacementPosition.Before,
      "first",
      ["moved-a", "moved-b", "first", "last"],
    ],
    [
      "after",
      ProjectArtifactPlacementPosition.After,
      "last",
      ["first", "last", "moved-a", "moved-b"],
    ],
  ] as const)(
    "inserts a same-lane multi-row optimistic move %s its stable target",
    async (_case, position, targetArtifactId, expectedOrder) => {
      const pending = deferred<never>();
      apiClient.post.mockReturnValue(pending.promise);
      const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
      const boardKey = projectArtifactBoardPageKeys.detail(
        PROJECT_ID,
        ProjectArtifactBoardGroup.Status
      );
      queryClient.setQueryData(
        boardKey,
        boardData("first", "moved-b", "moved-a", "last")
      );
      const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
        wrapper: createWrapperWithClient(queryClient),
      });

      act(() =>
        result.current.mutate({
          ...intent(),
          expectedProjectVersions: { [PROJECT_ID]: "acted-on-v1" },
          position,
          sourceArtifactIds: ["moved-a", "moved-b"],
          targetArtifactId,
        })
      );

      await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
      const optimistic =
        queryClient.getQueryData<ReturnType<typeof boardData>>(boardKey);
      expect(
        optimistic?.pages[0]?.lanes[0]?.cards.map((card) => card.artifact.id)
      ).toEqual(expectedOrder);
      expect(optimistic?.pages[0]?.rootIds).toEqual(expectedOrder);
    }
  );

  it("restores the exact prior card and root-id order after a rejected targeted move", async () => {
    const pending = deferred<never>();
    apiClient.post.mockReturnValue(pending.promise);
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const boardKey = projectArtifactBoardPageKeys.detail(
      PROJECT_ID,
      ProjectArtifactBoardGroup.Status
    );
    const original = boardData("first", "moved-b", "moved-a", "last");
    queryClient.setQueryData(boardKey, original);
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() =>
      result.current.mutate({
        ...intent(),
        expectedProjectVersions: { [PROJECT_ID]: "acted-on-v1" },
        position: ProjectArtifactPlacementPosition.After,
        sourceArtifactIds: ["moved-a", "moved-b"],
        targetArtifactId: "last",
      })
    );
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    pending.reject(new Error("rejected"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(boardKey)).toStrictEqual(original);
  });

  it("moves cards and root ids onto the loaded page containing the stable target", async () => {
    const pending = deferred<never>();
    apiClient.post.mockReturnValue(pending.promise);
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const boardKey = projectArtifactBoardPageKeys.detail(
      PROJECT_ID,
      ProjectArtifactBoardGroup.Status
    );
    const firstPage = boardData("moved", "first").pages[0];
    const targetPage = boardData("target", "last").pages[0];
    if (!(firstPage && targetPage)) {
      throw new Error("Expected board page fixtures");
    }
    firstPage.lanes[0].count = 4;
    targetPage.lanes[0].count = 4;
    queryClient.setQueryData(boardKey, {
      pageParams: [null, "next"],
      pages: [firstPage, targetPage],
    });
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() =>
      result.current.mutate({
        ...intent(),
        expectedProjectVersions: { [PROJECT_ID]: "acted-on-v1" },
        sourceArtifactIds: ["moved"],
        targetArtifactId: "target",
      })
    );

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    const optimistic =
      queryClient.getQueryData<ReturnType<typeof boardData>>(boardKey);
    expect(optimistic?.pages[0]?.rootIds).toEqual(["first"]);
    expect(optimistic?.pages[1]?.rootIds).toEqual(["moved", "target", "last"]);
    expect(
      optimistic?.pages[1]?.lanes[0]?.cards.map((card) => card.artifact.id)
    ).toEqual(["moved", "target", "last"]);
    expect(optimistic?.pages.map((page) => page.lanes[0]?.count)).toEqual([
      4, 4,
    ]);
  });

  it.each([
    [
      "the last loaded page once its lane is complete",
      true,
      ["first"],
      ["last", "moved"],
    ],
    [
      "nowhere while the lane still has pages to load",
      false,
      ["moved", "first"],
      ["last"],
    ],
  ] as const)(
    "ISS-12929 previews a Root move on %s",
    async (_case, lastLaneComplete, expectedFirst, expectedLast) => {
      const pending = deferred<never>();
      apiClient.post.mockReturnValue(pending.promise);
      const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
      const boardKey = projectArtifactBoardPageKeys.detail(
        PROJECT_ID,
        ProjectArtifactBoardGroup.Status
      );
      const firstPage = boardData("moved", "first").pages[0];
      const lastPage = boardData("last").pages[0];
      if (!(firstPage && lastPage)) {
        throw new Error("Expected board page fixtures");
      }
      firstPage.lanes[0].complete = false;
      lastPage.lanes[0].complete = lastLaneComplete;
      queryClient.setQueryData(boardKey, {
        pageParams: [null, "next"],
        pages: [firstPage, lastPage],
      });
      const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
        wrapper: createWrapperWithClient(queryClient),
      });

      act(() =>
        result.current.mutate({
          ...intent(),
          expectedProjectVersions: { [PROJECT_ID]: "acted-on-v1" },
          position: ProjectArtifactPlacementPosition.Root,
          sourceArtifactIds: ["moved"],
          targetArtifactId: undefined,
        })
      );

      await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
      const optimistic =
        queryClient.getQueryData<ReturnType<typeof boardData>>(boardKey);
      expect(optimistic?.pages[0]?.rootIds).toEqual(expectedFirst);
      expect(optimistic?.pages[1]?.rootIds).toEqual(expectedLast);
    }
  );

  it("posts the acted-on intent and restores the tree when placement fails offline", async () => {
    apiClient.get.mockRejectedValue(new Error("offline"));
    apiClient.post.mockRejectedValue(new Error("offline"));
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const original = tree("source", "target");
    queryClient.setQueryData(projectTreeKeys.detail(PROJECT_ID), original);
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() =>
      result.current.mutate({
        ...intent(),
        expectedProjectVersions: { [PROJECT_ID]: "acted-on-v1" },
      })
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(apiClient.post).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/artifacts/placement`,
      expect.objectContaining({
        expectedProjectVersions: { [PROJECT_ID]: "acted-on-v1" },
      })
    );
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))
    ).toStrictEqual(original);
    expect(toastError).toHaveBeenCalledWith(
      "Failed to move items. Please try again."
    );
  });

  it("skips infinite root pages while previewing and restoring a placement", async () => {
    const pending = deferred<never>();
    apiClient.post.mockReturnValue(pending.promise);
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const original = tree("target", "source");
    const rootPages = { pages: [original], pageParams: [undefined] };
    const rootPagesKey = [
      ...projectTreeKeys.withDetails(PROJECT_ID),
      "root-pages",
    ] as const;
    queryClient.setQueryData(projectTreeKeys.detail(PROJECT_ID), original);
    queryClient.setQueryData(rootPagesKey, rootPages);
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    act(() => result.current.mutate(intent()));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(
      queryClient
        .getQueryData<ProjectTreeResponse>(projectTreeKeys.detail(PROJECT_ID))
        ?.nodes.map(({ root }) => root.id)
    ).toEqual(["source", "target"]);
    expect(queryClient.getQueryData(rootPagesKey)).toBe(rootPages);

    pending.reject(new Error("offline"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))
    ).toStrictEqual(original);
    expect(queryClient.getQueryData(rootPagesKey)).toBe(rootPages);
  });
});

describe("useArtifactPlacementCapability", () => {
  beforeEach(() => {
    apiClient.get.mockReset();
    manualOrdering.enabled = true;
  });

  it.each([
    ["explicit grant", true, true],
    ["explicit denial", false, false],
    ["omitted permission", undefined, false],
  ])(
    "fails closed unless the server returns %s",
    async (_case, permission, expected) => {
      apiClient.get.mockResolvedValue({
        projectId: PROJECT_ID,
        projectVersion: "source-v1",
        ...(permission === undefined ? {} : { canPlaceArtifacts: permission }),
      });
      const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
      const { result } = renderHook(
        () => useArtifactPlacementCapability(PROJECT_ID),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      await waitFor(() =>
        expect(
          queryClient.getQueryState(
            projectArtifactPlacementCapabilityKey(PROJECT_ID)
          )?.status
        ).toBe("success")
      );
      expect(apiClient.get).toHaveBeenCalledWith(
        `/projects/${PROJECT_ID}/artifacts/placement`
      );
      expect(result.current).toBe(expected);
    }
  );

  it("keeps permission closed while loading and after a failed read", async () => {
    const pending = deferred<never>();
    apiClient.get.mockReturnValue(pending.promise);
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const { result } = renderHook(
      () => useArtifactPlacementCapability(PROJECT_ID),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    expect(result.current).toBe(false);
    pending.reject(new Error("permission unavailable"));
    await waitFor(() =>
      expect(
        queryClient.getQueryState(
          projectArtifactPlacementCapabilityKey(PROJECT_ID)
        )?.status
      ).toBe("error")
    );
    expect(result.current).toBe(false);
  });

  it("does not read placement capability while manual ordering is disabled", () => {
    manualOrdering.enabled = false;
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const { result } = renderHook(
      () => useArtifactPlacementCapability(PROJECT_ID),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    expect(result.current).toBe(false);
    expect(apiClient.get).not.toHaveBeenCalled();
  });
});

function boardData(...artifactIds: string[]) {
  const ids = artifactIds.length > 0 ? artifactIds : ["source"];
  const timestamp = new Date("2026-10-19T00:00:00.000Z");
  const page: ProjectArtifactBoardPageResponse = {
    lanes: [
      {
        cards: ids.map((id, index) => ({
          artifact: {
            assignee: null,
            assigneeId: null,
            createdAt: timestamp,
            createdById: null,
            dueDate: null,
            externalUrl: null,
            id,
            name: id,
            organizationId: "organization",
            priority: null,
            projectId: PROJECT_ID,
            slug: `ISS-${index + 1}`,
            sortOrder: index,
            status: IssueStatus.Todo,
            subtype: ArtifactSubtype.Feature,
            type: ArtifactType.Document,
            updatedAt: timestamp,
          },
          descendantCount: 0,
        })),
        complete: true,
        count: ids.length,
        id: IssueStatus.Todo,
        label: "Todo",
      },
      {
        cards: [],
        complete: true,
        count: 0,
        id: IssueStatus.InProgress,
        label: "In Progress",
      },
    ],
    populationRevision: "a".repeat(64),
    rootIds: ids,
  };
  return { pageParams: [null], pages: [page] };
}
