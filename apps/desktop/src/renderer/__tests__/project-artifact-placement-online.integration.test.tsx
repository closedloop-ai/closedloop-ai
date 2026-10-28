// @vitest-environment jsdom

import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import { useArtifactPlacement } from "@repo/app/projects/hooks/use-artifact-placement";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../../../test/cloud-api-fetch-ipc-test-harness";
import { createDesktopCloudApiAdapter } from "../shared-agent-sessions/cloud-api-adapter";
import type { DesktopApi } from "../types/desktop-api";

const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE_ID = "00000000-0000-4000-8000-000000000003";
const TARGET_ID = "00000000-0000-4000-8000-000000000004";

function tree(): ProjectTreeResponse {
  return {
    nodes: [TARGET_ID, SOURCE_ID].map((id) => ({
      root: makeRawArtifact(ArtifactType.Document, {
        id,
        name: id,
        projectId: PROJECT_ID,
      }),
      children: [],
    })),
    externalParents: [],
    projectVersion: "source-v1",
  };
}

describe("Desktop online artifact placement", () => {
  it("restores the prior row order when the hierarchy API request fails", async () => {
    let rejectFetch!: (reason: Error) => void;
    const fetchResult = new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    });
    const fetchImpl = vi.fn((_url: URL, _init: RequestInit) => fetchResult);
    const main = createHarness({ fetchImpl });
    const desktopApi = { cloudApiFetch: main.invoke } as DesktopApi;
    const adapter = createDesktopCloudApiAdapter(desktopApi);
    const queryClient = makeQueryClient({ gcTime: Number.POSITIVE_INFINITY });
    const original = tree();
    queryClient.setQueryData(projectTreeKeys.detail(PROJECT_ID), original);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
        <ApiAdapterProvider adapter={adapter}>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </ApiAdapterProvider>
      </AuthAdapterProvider>
    );
    const { result } = renderHook(() => useArtifactPlacement(PROJECT_ID), {
      wrapper,
    });

    act(() =>
      result.current.mutate({
        sourceArtifactIds: [SOURCE_ID],
        destinationProjectId: PROJECT_ID,
        position: ProjectArtifactPlacementPosition.Before,
        targetArtifactId: TARGET_ID,
        source: ProjectArtifactPlacementSource.Keyboard,
      })
    );

    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<ProjectTreeResponse>(projectTreeKeys.detail(PROJECT_ID))
          ?.nodes.map(({ root }) => root.id)
      ).toEqual([SOURCE_ID, TARGET_ID])
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0]?.[0].pathname).toBe(
      `/projects/${PROJECT_ID}/artifacts/placement`
    );

    rejectFetch(new Error("offline"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData(projectTreeKeys.detail(PROJECT_ID))
    ).toStrictEqual(original);
  });
});
