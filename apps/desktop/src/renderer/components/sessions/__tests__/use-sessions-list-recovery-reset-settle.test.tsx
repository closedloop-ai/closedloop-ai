/**
 * @description ISS-7249: when the errored empty's "Clear filters and reload"
 * recovery counts as a retry, its SETTLE has to be the read answering — not the
 * click.
 *
 * `handleClearFilters` has no `refetch()` to await by design: the reload is the
 * query-key change the filter reset produces. So `handleClearFiltersAndReload`
 * resolves off the list read's own fetch state, and these tests pin the two
 * branches that decision creates. Resolving eagerly instead would ship a
 * `retry_settled` reporting a recovery the instant the user clicked, which is
 * the confident wrong number this ticket exists to stop.
 */
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessionsListRecovery } from "../use-sessions-list-recovery";

function renderRecovery(
  initialFetching: boolean,
  options: { isListScopeDefault?: boolean } = {}
) {
  const replaceListParams = vi.fn();
  const setFacetFilters = vi.fn();
  const setDateRange = vi.fn();
  const cancelPageDataRead = vi.fn();
  const refetchPageData = vi.fn(() => Promise.resolve());
  const isListScopeDefault = options.isListScopeDefault ?? false;
  let clearAndReload: () => Promise<void> = () => Promise.resolve();
  let retry: () => Promise<unknown> = () => Promise.resolve();

  function Harness({ isPageDataFetching }: { isPageDataFetching: boolean }) {
    const recovery = useSessionsListRecovery({
      cancelPageDataRead,
      isBlockingLoad: false,
      isListScopeDefault,
      isPageDataFetching,
      recheckLocalSource: () => undefined,
      refetchPageData,
      replaceListParams,
      searchParam: "search",
      setDateRange,
      setFacetFilters,
    });
    clearAndReload = recovery.handleClearFiltersAndReload;
    retry = recovery.handleRetry;
    return null;
  }

  const view = render(<Harness isPageDataFetching={initialFetching} />);
  return {
    cancelPageDataRead,
    clearAndReload: () => clearAndReload(),
    refetchPageData,
    replaceListParams,
    retry: () => retry(),
    setFetching: (isPageDataFetching: boolean) => {
      view.rerender(<Harness isPageDataFetching={isPageDataFetching} />);
    },
  };
}

/** Resolved-or-not, without racing a real timer. */
function settleState(promise: Promise<void>) {
  const state = { settled: false };
  promise
    .then(() => {
      state.settled = true;
    })
    .catch(() => undefined);
  return state;
}

describe("useSessionsListRecovery reset settle (ISS-7249)", () => {
  it("waits for the read the reset kicked off, rather than resolving on the click", async () => {
    const { clearAndReload, setFetching, replaceListParams } =
      renderRecovery(false);

    let reset: Promise<void> = Promise.resolve();
    act(() => {
      reset = clearAndReload();
    });
    const state = settleState(reset);
    // The reset really ran — this is the behavior the telemetry wraps.
    expect(replaceListParams).toHaveBeenCalled();

    // The key change starts the read.
    await act(async () => {
      setFetching(true);
      await Promise.resolve();
    });
    // Still outstanding: a settle here would report an outcome for a read that
    // has not answered.
    expect(state.settled).toBe(false);

    await act(async () => {
      setFetching(false);
      await Promise.resolve();
    });
    expect(state.settled).toBe(true);
  });

  it("settles a reset whose read answered from cache, so the attempt is never stranded", async () => {
    // No fetch ever starts (the unfiltered scope was already cached). Waiting
    // for a fetch that will not come would leave a `retry_attempted` with no
    // settled sibling forever, which the contract reads as a retry that never
    // came back.
    const { clearAndReload, setFetching } = renderRecovery(false);

    let reset: Promise<void> = Promise.resolve();
    act(() => {
      reset = clearAndReload();
    });
    const state = settleState(reset);

    await act(async () => {
      setFetching(false);
      await Promise.resolve();
    });
    await act(async () => {
      setFetching(false);
      await Promise.resolve();
    });
    expect(state.settled).toBe(true);
  });

  it("settles a superseded reset when the later one settles", async () => {
    // Two presses: the second replaces the pending slot. The first must not be
    // left permanently unsettled.
    const { clearAndReload, setFetching } = renderRecovery(false);

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = clearAndReload();
    });
    act(() => {
      second = clearAndReload();
    });
    const firstState = settleState(first);
    const secondState = settleState(second);

    await act(async () => {
      setFetching(true);
      await Promise.resolve();
    });
    expect(firstState.settled).toBe(false);

    await act(async () => {
      setFetching(false);
      await Promise.resolve();
    });
    expect(secondState.settled).toBe(true);
    expect(firstState.settled).toBe(true);
  });

  it("reloads and settles when the scope was already clean and no key can change", async () => {
    // whitlockk review: the unavailable treatment on an unfiltered first page IS the
    // common case, and there the reset writes the values it already held — React
    // bails out, no commit, no key change, no fetch. The commit-counting settle
    // above can never fire, so `retry_settled` was missing indefinitely. The
    // press must issue the read its own label promises.
    const { clearAndReload, refetchPageData, cancelPageDataRead } =
      renderRecovery(false, { isListScopeDefault: true });

    let reset: Promise<void> = Promise.resolve();
    act(() => {
      reset = clearAndReload();
    });
    const state = settleState(reset);
    expect(refetchPageData).toHaveBeenCalledTimes(1);
    // Same wedged-read hazard as Retry: without the cancel, query-core hands
    // back the in-flight retryer promise on a read that holds no data.
    expect(cancelPageDataRead).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
    });
    expect(state.settled).toBe(true);
  });

  it("does not refetch the pre-clear key when there are filters to escape", () => {
    // The reason the reset never refetched in the first place: re-running the
    // narrowed scope the user is trying to leave.
    const { clearAndReload, refetchPageData } = renderRecovery(false, {
      isListScopeDefault: false,
    });

    let reset: Promise<void> = Promise.resolve();
    act(() => {
      reset = clearAndReload();
    });
    const state = settleState(reset);

    expect(refetchPageData).not.toHaveBeenCalled();
    // And the attempt is genuinely outstanding, waiting on the read the key
    // change will kick off. Resolving on the click instead would report a
    // recovery before anything answered.
    expect(state.settled).toBe(false);
  });

  it("does not cancel or duplicate a pending read when Retry is invoked", async () => {
    const { retry, cancelPageDataRead, refetchPageData } = renderRecovery(true);
    await act(async () => {
      await retry();
    });
    expect(cancelPageDataRead).not.toHaveBeenCalled();
    expect(refetchPageData).not.toHaveBeenCalled();
  });
});
