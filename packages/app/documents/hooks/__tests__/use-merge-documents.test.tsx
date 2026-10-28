/**
 * ISS-6774: the merge route awaits a full Anthropic merge generation before it
 * commits, under `maxDuration = 300`. On the default 60s client deadline the
 * surface abandoned a merge the server then went on to commit — the new version
 * landed and the secondary artifact was deleted while the user was shown a
 * failure and the caches were never invalidated. This pins the deadline the
 * hook waits for to the ceiling the route runs under.
 */

import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/api/src/types/long-running-api-timeout";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMergeDocuments } from "../use-documents";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const MERGE_INPUT = {
  primaryDocumentId: "primary-1",
  secondaryDocumentId: "secondary-1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMergeDocuments", () => {
  it("POSTs the merge under the long-running deadline", async () => {
    mockApiClient.post.mockResolvedValueOnce({ id: "primary-1" });
    const queryClient = createTestQueryClient();

    const { result } = renderHook(() => useMergeDocuments(), {
      wrapper: createWrapperWithClient(queryClient),
    });

    result.current.mutate(MERGE_INPUT);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/documents/merge",
      MERGE_INPUT,
      { timeoutMs: LONG_RUNNING_API_TIMEOUT_MS }
    );
  });
});
