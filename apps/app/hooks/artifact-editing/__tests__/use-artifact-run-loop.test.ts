/**
 * Unit tests for useArtifactRunLoop hook.
 *
 * Covers:
 * - prepareConflictRefs captures additionalRepos in the baseParams closure
 * - selectTarget replay passes additionalRepos through to runLoop.mutateAsync
 * - prepareConflictRefs with no additionalRepos does not include the field in retry
 */

import { RunLoopCommand } from "@repo/api/src/types/loop";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapperWithClient } from "@/hooks/queries/__tests__/test-utils";
import { useArtifactRunLoop } from "../use-artifact-run-loop";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockMutateAsync = vi.fn();

vi.mock("@/hooks/queries/use-loops", () => ({
  useRunLoop: () => ({
    mutate: vi.fn(),
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/run-loop-response", () => ({
  handleRunLoopResponse: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useArtifactRunLoop", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  describe("prepareConflictRefs + selectTarget — additionalRepos closure", () => {
    test("selectTarget replay passes additionalRepos from baseParams to mutateAsync", async () => {
      const additionalRepos = [
        { fullName: "org/extra-repo", branch: "main" },
        { fullName: "org/secondary-repo", branch: "feature" },
      ];

      mockMutateAsync.mockResolvedValue({
        loopId: "loop-1",
        status: "PENDING",
      });

      const { result } = renderHook(
        () => useArtifactRunLoop({ artifactId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      // Capture additionalRepos in the closure via prepareConflictRefs
      act(() => {
        result.current.prepareConflictRefs({
          command: RunLoopCommand.Plan,
          additionalRepos,
        });
      });

      // Simulate user resolving the multi-target conflict by selecting a target.
      // selectTarget is synchronous; the async pendingActionRef fires in the background.
      act(() => {
        result.current.selectTarget("target-abc");
      });

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledOnce();
      });

      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactId: "artifact-123",
          command: RunLoopCommand.Plan,
          computeTargetId: "target-abc",
          additionalRepos,
        })
      );
    });

    test("selectTarget replay uses the most recently prepared baseParams", async () => {
      const firstAdditionalRepos = [
        { fullName: "org/first-repo", branch: "main" },
      ];
      const secondAdditionalRepos = [
        { fullName: "org/second-repo", branch: "develop" },
      ];

      mockMutateAsync.mockResolvedValue({
        loopId: "loop-2",
        status: "PENDING",
      });

      const { result } = renderHook(
        () => useArtifactRunLoop({ artifactId: "artifact-456" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      // Prepare once with first set of repos
      act(() => {
        result.current.prepareConflictRefs({
          command: RunLoopCommand.Plan,
          additionalRepos: firstAdditionalRepos,
        });
      });

      // Overwrite with second set of repos
      act(() => {
        result.current.prepareConflictRefs({
          command: RunLoopCommand.EvaluatePlan,
          additionalRepos: secondAdditionalRepos,
        });
      });

      act(() => {
        result.current.selectTarget("target-xyz");
      });

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledOnce();
      });

      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactId: "artifact-456",
          command: RunLoopCommand.EvaluatePlan,
          computeTargetId: "target-xyz",
          additionalRepos: secondAdditionalRepos,
        })
      );
    });

    test("selectTarget replay does not include additionalRepos when none were in baseParams", async () => {
      mockMutateAsync.mockResolvedValue({
        loopId: "loop-3",
        status: "PENDING",
      });

      const { result } = renderHook(
        () => useArtifactRunLoop({ artifactId: "artifact-789" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      // No additionalRepos in baseParams
      act(() => {
        result.current.prepareConflictRefs({
          command: RunLoopCommand.RequestChanges,
          prompt: "Please add more detail",
        });
      });

      act(() => {
        result.current.selectTarget("target-111");
      });

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledOnce();
      });

      const callArgs = mockMutateAsync.mock.calls[0][0];
      expect(callArgs).toMatchObject({
        artifactId: "artifact-789",
        command: RunLoopCommand.RequestChanges,
        computeTargetId: "target-111",
      });
      // additionalRepos should be undefined (not present in baseParams)
      expect(callArgs.additionalRepos).toBeUndefined();
    });

    test("selectTarget does nothing when artifactId is null", async () => {
      mockMutateAsync.mockResolvedValue({
        loopId: "loop-4",
        status: "PENDING",
      });

      const { result } = renderHook(
        () => useArtifactRunLoop({ artifactId: null }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.prepareConflictRefs({
          command: RunLoopCommand.Plan,
          additionalRepos: [{ fullName: "org/repo", branch: "main" }],
        });
      });

      act(() => {
        result.current.selectTarget("target-999");
      });

      // Give any async work time to resolve; mutateAsync should never be called
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });
  });
});
