import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { artifactLinkKeys } from "@repo/app/documents/hooks/use-artifact-links";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDeleteBranch } from "../use-delete-branch";

const mockApiClient = { delete: vi.fn() };

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

describe("useDeleteBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient.delete.mockResolvedValue({ deleted: true });
  });

  it("deletes only the platform Branch and invalidates every live projection", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData(
      artifactLinkKeys.list({
        artifactId: "issue-1",
        direction: "both",
        resolved: true,
      }),
      [{ id: "link-1", sourceId: "issue-1", targetId: "branch-1" }]
    );
    const { result } = renderHook(() => useDeleteBranch(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await act(() => result.current.mutateAsync("branch-1"));

    expect(mockApiClient.delete).toHaveBeenCalledWith("/branches/branch-1");
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: projectTreeKeys.all,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: documentKeys.all,
      });
    });
  });
});
