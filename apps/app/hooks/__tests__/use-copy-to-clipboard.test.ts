import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("useCopyToClipboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps copied true until the latest copy reset expires", async () => {
    const { result } = renderHook(() => useCopyToClipboard(2000));

    await act(async () => {
      await result.current[1]("first");
    });
    expect(result.current[0]).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await result.current[1]("second");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(result.current[0]).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current[0]).toBe(false);
  });

  it("cleans up the pending reset timer on unmount", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { result, unmount } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current[1]("command");
    });
    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
