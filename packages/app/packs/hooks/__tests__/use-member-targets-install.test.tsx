/**
 * @file use-member-targets-install.test.tsx
 * @description Behavioral coverage for the ISS-5125 web dispatch half. The
 * assertion that matters most is the WIRE one: this hook is the only caller of
 * `POST /compute-targets/{id}/member-installs`, a route that shipped in FEA-4082
 * with no consumer at all, so the exact path and body are pinned here. The rest
 * cover the two honesty rules the hook exists to enforce — a resolved POST is
 * not an installed pack (no cache invalidation, no state rewrite), and outcomes
 * are per cell so two machines never share one answer.
 */

import {
  MemberPackInstallDispatchReason,
  MemberPackInstallDispatchState,
} from "@repo/api/src/types/member-pack-install";
import { ApiError } from "@repo/app/shared/api/api-error";
import { createWrapper } from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memberInstallCellKey } from "../../components/member-targets-block";
import { MemberInstallDispatchTone } from "../../lib/member-install-dispatch-copy";
import { useMemberTargetsInstall } from "../use-member-targets-install";

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

function renderInstall(packId: string | null, enabled: boolean) {
  return renderHook(() => useMemberTargetsInstall({ packId, enabled }), {
    wrapper: createWrapper(),
  });
}

describe("useMemberTargetsInstall (ISS-5125)", () => {
  it("returns null when the affordance is disabled, so the block stays read-only", () => {
    const { result } = renderInstall("pack-1", false);
    expect(result.current).toBeNull();
  });

  it("returns null with nothing selected — there is no pack to install", () => {
    const { result } = renderInstall(null, true);
    expect(result.current).toBeNull();
  });

  it("POSTs the FEA-4082 member-install route with the pack and harness", async () => {
    mockApiClient.post.mockResolvedValue({
      packId: "pack-1",
      harness: "codex",
      state: MemberPackInstallDispatchState.Dispatched,
    });
    const { result } = renderInstall("pack-1", true);

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-9",
        computeTargetName: "Desktop",
        harness: "codex",
        action: "install",
      })
    );

    await waitFor(() => expect(mockApiClient.post).toHaveBeenCalledTimes(1));
    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/compute-targets/target-9/member-installs",
      { packId: "pack-1", harness: "codex" }
    );
  });

  it("records the dispatch outcome against the clicked cell only", async () => {
    mockApiClient.post.mockResolvedValue({
      packId: "pack-1",
      harness: "claude",
      state: MemberPackInstallDispatchState.TargetOffline,
    });
    const { result } = renderInstall("pack-1", true);

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "ci-runner",
        harness: "claude",
        action: "install",
      })
    );

    const key = memberInstallCellKey("target-1", "claude");
    await waitFor(() =>
      expect(result.current?.dispatchByCellKey?.[key]).toBeDefined()
    );
    const outcome = result.current?.dispatchByCellKey?.[key];
    expect(outcome?.message).toContain("ci-runner is offline");
    expect(outcome?.tone).toBe(MemberInstallDispatchTone.Danger);
    expect(outcome?.retryable).toBe(true);
    // No other cell picked up this machine's answer.
    expect(Object.keys(result.current?.dispatchByCellKey ?? {})).toStrictEqual([
      key,
    ]);
    expect(result.current?.pendingCellKeys).toStrictEqual([]);
  });

  it("carries a named failure reason through to the member's sentence", async () => {
    mockApiClient.post.mockResolvedValue({
      packId: "pack-1",
      harness: "claude",
      state: MemberPackInstallDispatchState.Failed,
      reason: MemberPackInstallDispatchReason.OperationNotSupported,
    });
    const { result } = renderInstall("pack-1", true);

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "Laptop",
        harness: "claude",
        action: "install",
      })
    );

    const key = memberInstallCellKey("target-1", "claude");
    await waitFor(() =>
      expect(result.current?.dispatchByCellKey?.[key]?.message).toContain(
        "too old"
      )
    );
  });

  it("calls a request that never got an answer UNCONFIRMED, and withholds the retry", async () => {
    // No response ever arrived, so the client cannot know whether the server
    // created and dispatched the command before the connection died. Offering
    // Retry here is what would install the pack onto the node twice.
    mockApiClient.post.mockRejectedValue(new Error("network down"));
    const { result } = renderInstall("pack-1", true);

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "Laptop",
        harness: "claude",
        action: "install",
      })
    );

    const key = memberInstallCellKey("target-1", "claude");
    await waitFor(() =>
      expect(result.current?.dispatchByCellKey?.[key]).toBeDefined()
    );
    const outcome = result.current?.dispatchByCellKey?.[key];
    expect(outcome?.message).toContain("may still be running");
    expect(outcome?.message).not.toContain("Nothing was installed");
    expect(outcome?.retryable).toBe(false);
    expect(result.current?.pendingCellKeys).toStrictEqual([]);
  });

  it("says nothing was installed when the SERVER rejected the request (4xx)", async () => {
    // The positive control for the assertion above: a 4xx is an answer, and the
    // route's 4xx paths return before any command exists. Only here may the
    // block state that nothing was installed.
    mockApiClient.post.mockRejectedValue(new ApiError("nope", 404));
    const { result } = renderInstall("pack-1", true);

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "Laptop",
        harness: "claude",
        action: "install",
      })
    );

    const key = memberInstallCellKey("target-1", "claude");
    await waitFor(() =>
      expect(result.current?.dispatchByCellKey?.[key]).toBeDefined()
    );
    const outcome = result.current?.dispatchByCellKey?.[key];
    expect(outcome?.message).toContain("Nothing was installed");
    expect(outcome?.retryable).toBe(false);
  });

  it("settles the FIRST cell when a second install starts before it resolves", async () => {
    // The per-call `mutate(vars, { onSuccess })` callbacks do not survive a
    // second dispatch: `MutationObserver.mutate` overwrites `#mutateOptions`
    // and detaches the observer from the prior mutation, so cell A's key would
    // stick in `pendingCellKeys` forever with no outcome. Both cells must
    // settle.
    const resolvers: Array<(value: unknown) => void> = [];
    mockApiClient.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );
    const { result } = renderInstall("pack-1", true);

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "Laptop",
        harness: "claude",
        action: "install",
      })
    );
    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-2",
        computeTargetName: "Desktop",
        harness: "claude",
        action: "install",
      })
    );

    const keyA = memberInstallCellKey("target-1", "claude");
    const keyB = memberInstallCellKey("target-2", "claude");
    expect(result.current?.pendingCellKeys).toStrictEqual([keyA, keyB]);

    // Both requests must actually be in flight before either is answered;
    // `mutationFn` runs in a microtask, so the resolvers arrive after `act`.
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // Settle the SECOND dispatch first — the ordering that detaches the first.
    await act(async () => {
      resolvers[1]?.({
        packId: "pack-1",
        harness: "claude",
        state: MemberPackInstallDispatchState.Dispatched,
      });
      resolvers[0]?.({
        packId: "pack-1",
        harness: "claude",
        state: MemberPackInstallDispatchState.Dispatched,
      });
      // Flush the mutation promise chain inside `act` so both settlements are
      // applied before React is allowed to leave this batch.
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current?.pendingCellKeys).toStrictEqual([])
    );
    expect(result.current?.dispatchByCellKey?.[keyA]).toBeDefined();
    expect(result.current?.dispatchByCellKey?.[keyB]).toBeDefined();
  });

  it("keeps both machines' outcomes when a member installs onto two", async () => {
    mockApiClient.post
      .mockResolvedValueOnce({
        packId: "pack-1",
        harness: "claude",
        state: MemberPackInstallDispatchState.Dispatched,
      })
      .mockResolvedValueOnce({
        packId: "pack-1",
        harness: "claude",
        state: MemberPackInstallDispatchState.TargetOffline,
      });
    const { result } = renderInstall("pack-1", true);

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "Laptop",
        harness: "claude",
        action: "install",
      })
    );
    const first = memberInstallCellKey("target-1", "claude");
    await waitFor(() =>
      expect(result.current?.dispatchByCellKey?.[first]).toBeDefined()
    );

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-2",
        computeTargetName: "ci-runner",
        harness: "claude",
        action: "install",
      })
    );
    const second = memberInstallCellKey("target-2", "claude");
    await waitFor(() =>
      expect(result.current?.dispatchByCellKey?.[second]).toBeDefined()
    );

    // The first machine's answer survives the second dispatch — a single
    // "last result" slot would have silently overwritten it.
    expect(result.current?.dispatchByCellKey?.[first]?.message).toContain(
      "Install started on Laptop"
    );
    expect(result.current?.dispatchByCellKey?.[second]?.message).toContain(
      "ci-runner is offline"
    );
  });

  it("clears only the retried cell's stale outcome when it is dispatched again", async () => {
    mockApiClient.post.mockResolvedValue({
      packId: "pack-1",
      harness: "claude",
      state: MemberPackInstallDispatchState.TargetOffline,
    });
    const { result } = renderInstall("pack-1", true);
    const key = memberInstallCellKey("target-1", "claude");

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "ci-runner",
        harness: "claude",
        action: "install",
      })
    );
    await waitFor(() =>
      expect(result.current?.dispatchByCellKey?.[key]).toBeDefined()
    );

    // Never resolve the retry: the stale sentence must be gone while the new
    // attempt is pending, so the row cannot show last attempt's failure next to
    // this attempt's spinner.
    mockApiClient.post.mockReturnValue(new Promise(() => undefined));
    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "ci-runner",
        harness: "claude",
        action: "retry",
      })
    );

    await waitFor(() =>
      expect(result.current?.pendingCellKeys).toStrictEqual([key])
    );
    expect(result.current?.dispatchByCellKey?.[key]).toBeUndefined();
  });

  // Both cases below are code-review regressions (ISS-5125). Each one ended in
  // the same place: a second install dispatched onto a node that was already
  // installing that pack.

  it("keeps BOTH cells pending while two installs are in flight", async () => {
    // Neither dispatch resolves, so both are genuinely outstanding at once.
    mockApiClient.post.mockReturnValue(new Promise(() => undefined));
    const { result } = renderInstall("pack-1", true);
    const first = memberInstallCellKey("target-1", "claude");
    const second = memberInstallCellKey("target-2", "codex");

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "Laptop",
        harness: "claude",
        action: "install",
      })
    );
    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-2",
        computeTargetName: "Desktop",
        harness: "codex",
        action: "install",
      })
    );

    // A single scalar slot would have dropped `first` here, re-enabling its
    // button while its dispatch was still outstanding.
    await waitFor(() =>
      expect([...(result.current?.pendingCellKeys ?? [])].sort()).toStrictEqual(
        [first, second].sort()
      )
    );
  });

  it("does not dispatch twice for a cell that is already in flight", async () => {
    mockApiClient.post.mockReturnValue(new Promise(() => undefined));
    const { result } = renderInstall("pack-1", true);
    const input = {
      computeTargetId: "target-1",
      computeTargetName: "Laptop",
      harness: "claude",
      action: "install",
    } as const;

    act(() => result.current?.onInstall(input));
    await waitFor(() => expect(mockApiClient.post).toHaveBeenCalledTimes(1));
    act(() => result.current?.onInstall(input));

    // The disabled button is an affordance, not a concurrency control — the
    // hook itself must refuse the second dispatch.
    expect(mockApiClient.post).toHaveBeenCalledTimes(1);
  });

  it("does not carry one pack's outcome onto another pack's identical rows", async () => {
    mockApiClient.post.mockResolvedValue({
      packId: "pack-1",
      harness: "claude",
      state: MemberPackInstallDispatchState.Dispatched,
    });
    const key = memberInstallCellKey("target-1", "claude");
    const { result, rerender } = renderHook(
      ({ packId }: { packId: string }) =>
        useMemberTargetsInstall({ packId, enabled: true }),
      { wrapper: createWrapper(), initialProps: { packId: "pack-1" } }
    );

    act(() =>
      result.current?.onInstall({
        computeTargetId: "target-1",
        computeTargetName: "Laptop",
        harness: "claude",
        action: "install",
      })
    );
    await waitFor(() =>
      expect(result.current?.dispatchByCellKey?.[key]).toBeDefined()
    );

    rerender({ packId: "pack-2" });

    // The machine set is identical for every pack, so an unscoped map would
    // show pack-1's "Install started" on pack-2's row — and, because a
    // Dispatched outcome is non-retryable, withdraw pack-2's Install button.
    expect(result.current?.dispatchByCellKey?.[key]).toBeUndefined();
    expect(result.current?.pendingCellKeys).toStrictEqual([]);
  });
});
