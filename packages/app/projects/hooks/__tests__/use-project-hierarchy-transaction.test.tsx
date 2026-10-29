// @vitest-environment jsdom

import { ProjectArtifactPlacementSource } from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectHierarchyOperation,
  ProjectHierarchyPlacement,
  ProjectHierarchySource,
} from "@repo/api/src/types/project-hierarchy-transaction";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import { useProjectHierarchyTransaction } from "@repo/app/projects/hooks/use-project-hierarchy-transaction";
import {
  ARTIFACT_PLACEMENT_MOVED_MESSAGE,
  ARTIFACT_PLACEMENT_UNDO_LABEL,
} from "@repo/app/projects/lib/artifact-placement-copy";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiClient, toastSuccess } = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
  toastSuccess: vi.fn(),
}));
vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => apiClient,
}));
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}));

const sourceProjectId = "00000000-0000-4000-8000-000000000001";
const destinationProjectId = "00000000-0000-4000-8000-000000000002";
const firstId = "00000000-0000-4000-8000-000000000003";
const secondId = "00000000-0000-4000-8000-000000000004";
const transactionId = "00000000-0000-4000-8000-000000000005";

const intent = {
  artifactIds: [firstId, secondId],
  targetProjectId: destinationProjectId,
  placement: "end" as const,
  source: ProjectArtifactPlacementSource.Api,
  sourceRevision: "rendered-source:v1",
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockImplementation((path: string) => {
    const projectId = path.includes(destinationProjectId)
      ? destinationProjectId
      : sourceProjectId;
    return Promise.resolve({ projectId, revision: `${projectId}:v1` });
  });
  apiClient.post.mockResolvedValue({
    transactionId,
    changedArtifactIds: [firstId, secondId],
    descendantCount: 0,
    projectRevisions: [
      { projectId: sourceProjectId, revision: "source:v2" },
      { projectId: destinationProjectId, revision: "destination:v2" },
    ],
    inverse: { transactionId },
    replayed: false,
  });
});

describe("flag-off hierarchy transaction hook", () => {
  it("restores the descendant-count success message for a subtree move", async () => {
    apiClient.post.mockResolvedValue({
      transactionId,
      changedArtifactIds: [firstId, secondId],
      descendantCount: 2,
      projectRevisions: [
        { projectId: sourceProjectId, revision: "source:v2" },
        { projectId: destinationProjectId, revision: "destination:v2" },
      ],
      inverse: { transactionId },
      replayed: false,
    });
    const { result } = renderHook(
      () => useProjectHierarchyTransaction(sourceProjectId),
      { wrapper: createWrapperWithClient(makeQueryClient()) }
    );
    act(() => result.current.mutate(intent));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toastSuccess).toHaveBeenCalledWith(
      "Moved with 2 descendants",
      expect.objectContaining({
        action: expect.objectContaining({
          label: ARTIFACT_PLACEMENT_UNDO_LABEL,
        }),
      })
    );
  });

  it("posts one selected-set write with the rendered source version and authoritative destination version", async () => {
    const queryClient = makeQueryClient();
    const { result } = renderHook(
      () => useProjectHierarchyTransaction(sourceProjectId),
      { wrapper: createWrapperWithClient(queryClient) }
    );
    act(() => result.current.mutate(intent));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(
      `/projects/${destinationProjectId}/artifacts/hierarchy-transactions`
    );
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(
      `/projects/${sourceProjectId}/artifacts/hierarchy-transactions`,
      expect.objectContaining({
        operation: ProjectHierarchyOperation.Move,
        artifactIds: [firstId, secondId],
        targetProjectId: destinationProjectId,
        placement: ProjectHierarchyPlacement.End,
        source: ProjectHierarchySource.Api,
        expectedRevisions: [
          { projectId: sourceProjectId, revision: "rendered-source:v1" },
          {
            projectId: destinationProjectId,
            revision: `${destinationProjectId}:v1`,
          },
        ],
      })
    );
  });

  it("offers Undo through the same route once without a second Moved announcement", async () => {
    const { result } = renderHook(
      () => useProjectHierarchyTransaction(sourceProjectId),
      { wrapper: createWrapperWithClient(makeQueryClient()) }
    );
    act(() => result.current.mutate(intent));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith(
      ARTIFACT_PLACEMENT_MOVED_MESSAGE,
      expect.objectContaining({
        action: expect.objectContaining({
          label: ARTIFACT_PLACEMENT_UNDO_LABEL,
        }),
      })
    );
    const undo = toastSuccess.mock.calls[0]?.[1]?.action?.onClick;
    expect(undo).toBeTypeOf("function");
    act(() => undo());
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(2));
    expect(apiClient.post).toHaveBeenLastCalledWith(
      `/projects/${sourceProjectId}/artifacts/hierarchy-transactions`,
      expect.objectContaining({
        operation: ProjectHierarchyOperation.Undo,
        transactionId,
        expectedRevisions: [
          { projectId: sourceProjectId, revision: "source:v2" },
          { projectId: destinationProjectId, revision: "destination:v2" },
        ],
      })
    );
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("keeps both rendered trees unchanged and persists nothing when the server rejects a member", async () => {
    apiClient.post.mockRejectedValue(new Error("member rejected"));
    const queryClient = makeQueryClient();
    const sourceTree = { nodes: [{ root: { id: firstId }, children: [] }] };
    const destinationTree = { nodes: [] };
    queryClient.setQueryData(
      projectTreeKeys.detail(sourceProjectId),
      sourceTree
    );
    queryClient.setQueryData(
      projectTreeKeys.detail(destinationProjectId),
      destinationTree
    );
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      const { result } = renderHook(
        () => useProjectHierarchyTransaction(sourceProjectId),
        { wrapper: createWrapperWithClient(queryClient) }
      );
      act(() => result.current.mutate(intent));

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(apiClient.post).toHaveBeenCalledTimes(1);
      expect(
        queryClient.getQueryData(projectTreeKeys.detail(sourceProjectId))
      ).toStrictEqual(sourceTree);
      expect(
        queryClient.getQueryData(projectTreeKeys.detail(destinationProjectId))
      ).toStrictEqual(destinationTree);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("keeps a stale rendered source revision through the POST and preserves the 409 failure", async () => {
    apiClient.post.mockRejectedValue(new Error("409 stale hierarchy"));
    const queryClient = makeQueryClient();
    const renderedTree = { nodes: [{ root: { id: firstId }, children: [] }] };
    queryClient.setQueryData(
      projectTreeKeys.detail(sourceProjectId),
      renderedTree
    );
    const { result } = renderHook(
      () => useProjectHierarchyTransaction(sourceProjectId),
      { wrapper: createWrapperWithClient(queryClient) }
    );
    act(() => result.current.mutate(intent));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).not.toHaveBeenCalledWith(
      `/projects/${sourceProjectId}/artifacts/hierarchy-transactions`
    );
    expect(apiClient.post).toHaveBeenCalledWith(
      `/projects/${sourceProjectId}/artifacts/hierarchy-transactions`,
      expect.objectContaining({
        expectedRevisions: expect.arrayContaining([
          { projectId: sourceProjectId, revision: intent.sourceRevision },
        ]),
      })
    );
    expect(result.current.error?.message).toBe("409 stale hierarchy");
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(sourceProjectId))
    ).toStrictEqual(renderedTree);
  });

  it("refuses mismatched revision identity before POST", async () => {
    apiClient.get.mockResolvedValue({
      projectId: sourceProjectId,
      revision: "wrong",
    });
    const { result } = renderHook(
      () => useProjectHierarchyTransaction(sourceProjectId),
      { wrapper: createWrapperWithClient(makeQueryClient()) }
    );
    act(() => result.current.mutate(intent));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
