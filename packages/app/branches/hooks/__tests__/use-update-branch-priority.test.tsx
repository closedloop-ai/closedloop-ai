import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type BranchesPageData,
  type BranchListResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import { makeBranchDetail } from "@repo/app/branches/__tests__/branch-fixtures";
import type { BranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { branchesKeys } from "@repo/app/branches/hooks/use-branches";
import { useUpdateBranchPriority } from "@repo/app/branches/hooks/use-update-branch-priority";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-9491 — the Branches binding of the shared priority engine writes into
 * the Branch-only client the provider injects (Desktop's `BranchesLiveBridge`
 * host passes one), not the ambient one. Bound to the wrong client, the pick
 * never paints and neither the rollback nor the re-read reaches the rows the
 * grid renders, while every assertion against the engine alone stays green.
 */

const ID = "66666666-6666-4666-8666-666666669491";
const SCOPE = "iss9491-scope";

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

describe("useUpdateBranchPriority", () => {
  it("patches and invalidates the injected Branch client's list, page data and detail, and leaves the ambient client alone", async () => {
    const branchClient = newClient();
    const ambientClient = newClient();
    // Each read in the shape it is cached under: the list response, the page
    // data that nests it under `list`, and the detail, which is the row itself.
    const carried: [QueryKey, (priority: Priority) => unknown][] = [
      [branchesKeys.list(SCOPE, {}), listResponse],
      [
        branchesKeys.pageData(SCOPE, {}),
        (priority): BranchesPageData => ({ list: listResponse(priority) }),
      ],
      [
        branchesKeys.detail(SCOPE, ID),
        (priority) => makeBranchDetail({ id: ID, priority }),
      ],
    ];
    for (const client of [branchClient, ambientClient]) {
      for (const [key, cached] of carried) {
        client.setQueryData(key, cached(Priority.Low));
      }
    }
    const updatePriority = vi.fn().mockResolvedValue(undefined);
    const source = { updatePriority } as unknown as BranchesDataSource;
    const { result } = renderHook(
      () => useUpdateBranchPriority(ArtifactStatusEditSurface.InlineCell),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <AppCoreStoryProviders>
            <QueryClientProvider client={ambientClient}>
              <BranchesDataSourceProvider
                dataSource={source}
                queryClient={branchClient}
              >
                {children}
              </BranchesDataSourceProvider>
            </QueryClientProvider>
          </AppCoreStoryProviders>
        ),
      }
    );

    await act(() =>
      result.current.mutateAsync({ artifactId: ID, priority: Priority.High })
    );

    expect(updatePriority).toHaveBeenCalledTimes(1);
    expect(updatePriority).toHaveBeenCalledWith(ID, {
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
    for (const [key, cached] of carried) {
      expect(branchClient.getQueryData(key)).toEqual(cached(Priority.High));
      expect(branchClient.getQueryState(key)?.isInvalidated).toBe(true);
      expect(ambientClient.getQueryData(key)).toEqual(cached(Priority.Low));
      expect(ambientClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
  });
});

function listResponse(priority: Priority): BranchListResponse {
  return {
    items: [makeBranchDetail({ id: ID, priority })],
    total: 1,
    viewerScope: BranchViewerScope.Organization,
  };
}
