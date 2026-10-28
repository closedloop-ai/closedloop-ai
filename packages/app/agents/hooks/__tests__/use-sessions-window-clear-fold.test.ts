import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionCustomDateWindow } from "../../lib/session-custom-date-window";
import { useSessionsWindowClearFold } from "../use-sessions-window-clear-fold";

/**
 * ISS-9822 — the fold that turns the v2 surface's window-clear callback into ONE
 * scope write, for every host that mounts that surface.
 *
 * The mutation worth killing is the reset: a flag spent by the FIRST read rather
 * than by the microtask reads correct in isolation and puts `?from=`/`?to=`
 * straight back on a real "Clear all", because `ActiveFiltersBar` fires
 * `clearAllFilters()` and then one `onToggle` per selected value synchronously
 * and only the LAST write survives. So the assertion is on every read inside one
 * synchronous event, not on one read.
 */

const PICKED_WINDOW: SessionCustomDateWindow = {
  from: "2026-01-01",
  to: "2026-01-31",
};

describe("useSessionsWindowClearFold", () => {
  it("passes a PICK through to the host and spends any pending clear", () => {
    const onCustomDateWindowChange = vi.fn();
    const { result } = renderHook(() =>
      useSessionsWindowClearFold(onCustomDateWindowChange)
    );

    // Raised first, so the last assertion is a real reset rather than the
    // initial value. A pick that left a stale clear standing would add a strip
    // to the following view change and drop the window the reader just chose.
    result.current.onSurfaceCustomWindowChange?.(null);
    result.current.onSurfaceCustomWindowChange?.(PICKED_WINDOW);

    expect(onCustomDateWindowChange).toHaveBeenCalledTimes(1);
    expect(onCustomDateWindowChange).toHaveBeenCalledWith(PICKED_WINDOW);
    expect(result.current.readPendingWindowClear()).toBe(false);
  });

  it("writes nothing for a CLEAR and raises the pending clear instead", () => {
    const onCustomDateWindowChange = vi.fn();
    const { result } = renderHook(() =>
      useSessionsWindowClearFold(onCustomDateWindowChange)
    );

    result.current.onSurfaceCustomWindowChange?.(null);

    // The surface always reports a view change after a window change, and that
    // one write carries the strip. A write here would be the second
    // `replaceListParams` off the same pre-click snapshot.
    expect(onCustomDateWindowChange).not.toHaveBeenCalled();
    expect(result.current.readPendingWindowClear()).toBe(true);
  });

  it("holds the pending clear across EVERY read in one synchronous event", () => {
    const { result } = renderHook(() => useSessionsWindowClearFold(vi.fn()));

    result.current.onSurfaceCustomWindowChange?.(null);
    const readsInOneClick = [
      result.current.readPendingWindowClear(),
      result.current.readPendingWindowClear(),
      result.current.readPendingWindowClear(),
    ];

    expect(readsInOneClick).toStrictEqual([true, true, true]);
  });

  it("reports a PICK for its own interaction and no later one", async () => {
    const { result } = renderHook(() => useSessionsWindowClearFold(vi.fn()));

    result.current.onSurfaceCustomWindowChange?.(PICKED_WINDOW);
    const readInTheSameClick = result.current.readPendingWindowPick();
    await Promise.resolve();

    // The host skips its trailing page write on this record, because the pick
    // already wrote the page reset carrying the new `?from=`/`?to=`. Left
    // standing past the click it would swallow the reader's NEXT page click
    // instead — which is why the record is a microtask long, not a click long.
    expect(readInTheSameClick).toBe(true);
    expect(result.current.readPendingWindowPick()).toBe(false);
  });

  it("drops the pending clear on the next microtask", async () => {
    const { result } = renderHook(() => useSessionsWindowClearFold(vi.fn()));

    result.current.onSurfaceCustomWindowChange?.(null);
    await Promise.resolve();

    expect(result.current.readPendingWindowClear()).toBe(false);
  });

  it("withholds the surface callback when the host holds no handler", () => {
    const { result } = renderHook(() => useSessionsWindowClearFold(undefined));

    // The v2 toolbar keys the Custom control off this prop's PRESENCE, so a
    // wrapped no-op here would mount a control the host cannot serve.
    expect(result.current.onSurfaceCustomWindowChange).toBeUndefined();
    expect(result.current.readPendingWindowClear()).toBe(false);
  });
});
