/**
 * @file use-member-pack-install.test.tsx
 * @description Pins the OMISSION this hook exists for (ISS-6700).
 *
 * The hook's 10-line docblock says a resolved dispatch is NOT a completed
 * install, so it deliberately has no `onSuccess` cache invalidation: the node
 * has only TAKEN the command and reports terminal on-device state later over its
 * own event stream. Invalidating on resolve refetches state that provably cannot
 * have changed yet and repaints the row back to `NotInstalled`, telling the
 * member their install did not happen. Nothing enforced that, so the next
 * refactor that "helpfully" adds invalidation ships exactly the regression the
 * comment describes.
 *
 * The route and body are NOT re-asserted here: `useMemberTargetsInstall` is the
 * hook's only caller and `use-member-targets-install.test.tsx` already pins the
 * exact path and the exact body object through this same production path, so a
 * second assertion would be a duplicate, not coverage.
 */

import { MemberPackInstallDispatchState } from "@repo/api/src/types/member-pack-install";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMemberPackInstall } from "../use-member-pack-install";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMemberPackInstall (ISS-6700)", () => {
  it("does NOT invalidate any query when the dispatch resolves", async () => {
    mockApiClient.post.mockResolvedValue({
      packId: "pack-1",
      harness: "codex",
      state: MemberPackInstallDispatchState.Dispatched,
    });
    const queryClient = createTestQueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useMemberPackInstall(), {
      wrapper: createWrapperWithClient(queryClient),
    });
    result.current.mutate({
      computeTargetId: "target-9",
      packId: "pack-1",
      harness: "codex",
    });

    // Guard against the trivial pass: the spy is also uncalled when the
    // mutation never ran, so prove the POST resolved before reading it.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
