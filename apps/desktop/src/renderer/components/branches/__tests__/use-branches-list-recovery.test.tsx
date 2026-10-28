import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBranchesListRecovery } from "../use-branches-list-recovery";

describe("useBranchesListRecovery Retry", () => {
  it("does not reissue a read while one is still pending", async () => {
    const refetch = vi.fn(() => Promise.resolve("settled"));

    const { result } = renderHook(() =>
      useBranchesListRecovery({
        isBlockingLoad: true,
        refetch,
      })
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(refetch).not.toHaveBeenCalled();
  });

  it("does not refetch until Retry is pressed", () => {
    const refetch = vi.fn(() => Promise.resolve("settled"));

    renderHook(() =>
      useBranchesListRecovery({
        isBlockingLoad: true,
        refetch,
      })
    );

    expect(refetch).not.toHaveBeenCalled();
  });

  it("issues the read synchronously on the press, not a microtask later", async () => {
    // A caller that observes the press in its own turn — the errored empty's
    // wiring, and the dead-end telemetry wrapper around it — has to see the
    // read. Deferring it behind a microtask made that caller see nothing.
    const refetch = vi.fn(() => Promise.resolve("settled"));

    const { result } = renderHook(() =>
      useBranchesListRecovery({
        isBlockingLoad: false,
        refetch,
      })
    );

    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = result.current.handleRetry();
    });

    // Asserted BEFORE awaiting: a microtask-deferred read would still be
    // unissued at this point, which is exactly the regression.
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await pending;
    });
  });

  it("survives a refetch that rejects, so a failed retry cannot go unhandled", async () => {
    const refetch = vi.fn(() => Promise.reject(new Error("wedged")));

    const { result } = renderHook(() =>
      useBranchesListRecovery({
        isBlockingLoad: false,
        refetch,
      })
    );

    await act(async () => {
      await expect(result.current.handleRetry()).resolves.toBeUndefined();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("coalesces repeated retries until the failed read's replacement settles", async () => {
    let settle: () => void = () => undefined;
    const response = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const refetch = vi.fn(() => response);
    const { result } = renderHook(() =>
      useBranchesListRecovery({
        isBlockingLoad: false,
        refetch,
      })
    );
    await act(async () => {
      const first = result.current.handleRetry();
      const second = result.current.handleRetry();
      await Promise.resolve();
      expect(refetch).toHaveBeenCalledTimes(1);
      settle();
      await Promise.all([first, second]);
    });
  });
});
