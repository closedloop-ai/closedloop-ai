// @vitest-environment jsdom

import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import { useArtifactPlacement } from "@repo/app/projects/hooks/use-artifact-placement";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { createWrapperWithClient } from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiClient, toastError } = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
  toastError: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => apiClient,
}));
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: toastError },
}));

const SOURCE_PROJECT_ID = "00000000-0000-4000-8000-000000000010";
const DESTINATION_PROJECT_ID = "00000000-0000-4000-8000-000000000020";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000030";

const sourceTree: ProjectTreeResponse = {
  nodes: [
    {
      root: makeRawArtifact(ArtifactType.Document, {
        id: ARTIFACT_ID,
        projectId: SOURCE_PROJECT_ID,
      }),
      children: [],
    },
  ],
  externalParents: [],
  projectVersion: "source-v1",
};
const destinationTree: ProjectTreeResponse = {
  nodes: [],
  externalParents: [],
  projectVersion: "destination-cached-stale-v1",
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockResolvedValue({
    projectId: DESTINATION_PROJECT_ID,
    projectVersion: "destination-authoritative-v2",
    canPlaceArtifacts: true,
  });
  apiClient.post.mockResolvedValue({
    placed: true,
    transactionId: "00000000-0000-4000-8000-000000000040",
    affectedArtifactIds: [ARTIFACT_ID],
    affectedProjectIds: [SOURCE_PROJECT_ID, DESTINATION_PROJECT_ID],
    projectVersions: {
      [SOURCE_PROJECT_ID]: "source-v2",
      [DESTINATION_PROJECT_ID]: "destination-v3",
    },
    placement: {
      sourceArtifactIds: [ARTIFACT_ID],
      destinationProjectId: DESTINATION_PROJECT_ID,
      position: ProjectArtifactPlacementPosition.Root,
    },
    replayed: false,
    undoAvailable: false,
  });
});

describe("cross-project placement version", () => {
  it("reads the destination's authoritative version before submitting either-project preconditions", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      projectTreeKeys.detail(SOURCE_PROJECT_ID),
      sourceTree
    );
    queryClient.setQueryData(
      projectTreeKeys.detail(DESTINATION_PROJECT_ID),
      destinationTree
    );
    const { result } = renderHook(
      () => useArtifactPlacement(SOURCE_PROJECT_ID),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    act(() =>
      result.current.mutate({
        sourceArtifactIds: [ARTIFACT_ID],
        destinationProjectId: DESTINATION_PROJECT_ID,
        position: ProjectArtifactPlacementPosition.Root,
        expectedProjectVersions: { [SOURCE_PROJECT_ID]: "source-acted-on-v1" },
        source: ProjectArtifactPlacementSource.Api,
      })
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.get).toHaveBeenCalledWith(
      `/projects/${DESTINATION_PROJECT_ID}/artifacts/placement`
    );
    expect(apiClient.post).toHaveBeenCalledWith(
      `/projects/${SOURCE_PROJECT_ID}/artifacts/placement`,
      expect.objectContaining({
        expectedProjectVersions: {
          [SOURCE_PROJECT_ID]: "source-acted-on-v1",
          [DESTINATION_PROJECT_ID]: "destination-authoritative-v2",
        },
      })
    );
  });

  it("aborts before the POST and restores the preview when the destination read fails", async () => {
    apiClient.get.mockRejectedValue(new Error("offline"));
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      projectTreeKeys.detail(SOURCE_PROJECT_ID),
      sourceTree
    );
    queryClient.setQueryData(
      projectTreeKeys.detail(DESTINATION_PROJECT_ID),
      destinationTree
    );
    const { result } = renderHook(
      () => useArtifactPlacement(SOURCE_PROJECT_ID),
      { wrapper: createWrapperWithClient(queryClient) }
    );

    act(() =>
      result.current.mutate({
        sourceArtifactIds: [ARTIFACT_ID],
        destinationProjectId: DESTINATION_PROJECT_ID,
        position: ProjectArtifactPlacementPosition.Root,
        expectedProjectVersions: { [SOURCE_PROJECT_ID]: "source-v1" },
        source: ProjectArtifactPlacementSource.Api,
      })
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(SOURCE_PROJECT_ID))
    ).toStrictEqual(sourceTree);
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(DESTINATION_PROJECT_ID))
    ).toStrictEqual(destinationTree);
    expect(toastError).toHaveBeenCalled();
  });
});
