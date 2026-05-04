/**
 * Unit tests for useDocumentRunLoop hook.
 *
 * Covers:
 * - prepareConflictRefs captures additionalRepos in the baseParams closure
 * - selectTarget replay passes additionalRepos through to runLoop.mutate
 * - prepareConflictRefs with no additionalRepos does not include the field in retry
 */

import { RunLoopCommand } from "@repo/api/src/types/loop";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapperWithClient } from "@/hooks/queries/__tests__/test-utils";
import {
  PreLoopCommand,
  type PreLoopMetadata,
} from "@/lib/system-check/pre-loop-health-check";
import { useDocumentRunLoop } from "../use-document-run-loop";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
const mockRunWithPreLoopSystemCheck = vi.fn();
const mockCancelPendingPreLoopAttempt = vi.fn();
const mockUseOptionalPreLoopSystemCheckGate = vi.fn();

vi.mock("@/hooks/queries/use-loops", () => ({
  useRunLoop: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

vi.mock("@/lib/system-check/pre-loop-system-check-provider", () => ({
  useOptionalPreLoopSystemCheckGate: () =>
    mockUseOptionalPreLoopSystemCheckGate(),
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

describe("useDocumentRunLoop", () => {
  let queryClient: QueryClient;
  const createPreLoopGate = (
    overrides: Partial<{
      runWithPreLoopSystemCheck: typeof mockRunWithPreLoopSystemCheck;
      cancelPendingPreLoopAttempt: typeof mockCancelPendingPreLoopAttempt;
      isChecking: boolean;
      isDialogOpen: boolean;
      pendingOwnerKey: string | null;
      pendingCommand: PreLoopMetadata["command"] | null;
    }> = {}
  ) => ({
    runWithPreLoopSystemCheck: mockRunWithPreLoopSystemCheck,
    cancelPendingPreLoopAttempt: mockCancelPendingPreLoopAttempt,
    isChecking: false,
    isDialogOpen: false,
    pendingOwnerKey: null,
    pendingCommand: null,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOptionalPreLoopSystemCheckGate.mockReturnValue(null);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  describe("prepareConflictRefs + selectTarget — additionalRepos closure", () => {
    test("selectTarget replay passes additionalRepos from baseParams to mutate", async () => {
      const additionalRepos = [
        { fullName: "org/extra-repo", branch: "main" },
        { fullName: "org/secondary-repo", branch: "feature" },
      ];

      const { result } = renderHook(
        () => useDocumentRunLoop({ documentId: "artifact-123" }),
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
      // selectTarget is synchronous; the pendingActionRef fires immediately.
      act(() => {
        result.current.selectTarget("target-abc");
      });

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledOnce();
      });

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "artifact-123",
          command: RunLoopCommand.Plan,
          computeTargetId: "target-abc",
          additionalRepos,
        }),
        expect.objectContaining({ onError: expect.any(Function) })
      );
    });

    test("selectTarget replay does not include additionalRepos when none were in baseParams", async () => {
      const { result } = renderHook(
        () => useDocumentRunLoop({ documentId: "artifact-789" }),
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
        expect(mockMutate).toHaveBeenCalledOnce();
      });

      const callArgs = mockMutate.mock.calls[0][0];
      expect(callArgs).toMatchObject({
        documentId: "artifact-789",
        command: RunLoopCommand.RequestChanges,
        computeTargetId: "target-111",
      });
      // additionalRepos should be undefined (not present in baseParams)
      expect(callArgs.additionalRepos).toBeUndefined();
    });

    test("selectTarget replay runs Execute through the pre-loop check for the selected target", async () => {
      const additionalRepos = [{ fullName: "org/extra-repo", branch: "main" }];
      const executeOwnerKey = `run-loop:${RunLoopCommand.Execute}:artifact-123`;

      mockRunWithPreLoopSystemCheck.mockImplementation((_metadata, execute) => {
        execute();
        return Promise.resolve({
          status: "skipped_no_local_target",
          attemptId: "attempt-1",
        });
      });
      mockUseOptionalPreLoopSystemCheckGate.mockReturnValue(
        createPreLoopGate()
      );

      const { result } = renderHook(
        () => useDocumentRunLoop({ documentId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.prepareConflictRefs({
          command: RunLoopCommand.Execute,
          additionalRepos,
        });
      });

      act(() => {
        result.current.selectTarget("target-abc");
      });

      await waitFor(() => {
        expect(mockRunWithPreLoopSystemCheck).toHaveBeenCalledOnce();
      });
      expect(mockRunWithPreLoopSystemCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          command: PreLoopCommand.ExecutePlan,
          computeTargetId: "target-abc",
          documentId: "artifact-123",
          documentType: "implementation_plan",
          ownerKey: executeOwnerKey,
        }),
        expect.any(Function)
      );

      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledOnce();
      });
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "artifact-123",
          command: RunLoopCommand.Execute,
          computeTargetId: "target-abc",
          additionalRepos,
        }),
        expect.objectContaining({ onError: expect.any(Function) })
      );
    });

    test("backend mismatch replay preserves explicit Cloud target through the pre-loop check", () => {
      mockRunWithPreLoopSystemCheck.mockImplementation((_metadata, execute) => {
        execute();
        return Promise.resolve({
          status: "skipped_no_local_target",
          attemptId: "attempt-2",
        });
      });
      mockUseOptionalPreLoopSystemCheckGate.mockReturnValue(
        createPreLoopGate()
      );

      const { result } = renderHook(
        () => useDocumentRunLoop({ documentId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      act(() => {
        result.current.prepareConflictRefs({
          command: RunLoopCommand.Execute,
        });
      });

      act(() => {
        result.current.pendingMismatchActionRef.current?.(null, true);
      });

      expect(mockRunWithPreLoopSystemCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          command: PreLoopCommand.ExecutePlan,
          computeTargetId: null,
          documentId: "artifact-123",
          documentType: "implementation_plan",
          ownerKey: `run-loop:${RunLoopCommand.Execute}:artifact-123`,
        }),
        expect.any(Function)
      );
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "artifact-123",
          command: RunLoopCommand.Execute,
          computeTargetId: null,
          backendOverride: true,
        }),
        expect.objectContaining({ onError: expect.any(Function) })
      );
    });
  });

  describe("isPreLoopExecutePending", () => {
    test("only reports pending for this document's Execute owner", () => {
      mockUseOptionalPreLoopSystemCheckGate.mockReturnValue(
        createPreLoopGate({
          isChecking: true,
          pendingOwnerKey: "other-owner",
          pendingCommand: PreLoopCommand.ExecutePlan,
        })
      );

      const unrelated = renderHook(
        () => useDocumentRunLoop({ documentId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      expect(unrelated.result.current.isPreLoopExecutePending).toBe(false);
      unrelated.unmount();

      mockUseOptionalPreLoopSystemCheckGate.mockReturnValue(
        createPreLoopGate({
          isChecking: true,
          pendingOwnerKey: `run-loop:${RunLoopCommand.Execute}:artifact-123`,
          pendingCommand: PreLoopCommand.ExecutePlan,
        })
      );

      const matching = renderHook(
        () => useDocumentRunLoop({ documentId: "artifact-123" }),
        { wrapper: createWrapperWithClient(queryClient) }
      );

      expect(matching.result.current.isPreLoopExecutePending).toBe(true);
    });
  });
});
