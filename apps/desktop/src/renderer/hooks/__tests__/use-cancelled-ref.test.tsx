import { cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useCancelledRef } from "../use-cancelled-ref";

afterEach(() => {
  cleanup();
});

describe("useCancelledRef", () => {
  it("reads false while the component is mounted", () => {
    const { result } = renderHook(() => useCancelledRef());

    expect(result.current.current).toBe(false);
  });

  it("flips to true on unmount so a settled read can see it", () => {
    const { result, unmount } = renderHook(() => useCancelledRef());
    // The consumer holds the ref OBJECT across the await, not a snapshot of the
    // boolean, which is the whole reason this is a ref and not state.
    const held = result.current;

    unmount();

    expect(held.current).toBe(true);
  });

  it("re-arms on a StrictMode remount rather than staying cancelled", () => {
    // Dev double-invoke mounts, unmounts, then mounts again. A flag that were
    // only ever set true in cleanup would leave every read cancelled for the
    // life of the component.
    const { result } = renderHook(() => useCancelledRef(), {
      wrapper: StrictMode,
    });

    expect(result.current.current).toBe(false);
  });

  it("returns the same ref object across re-renders", () => {
    const { result, rerender } = renderHook(() => useCancelledRef());
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
