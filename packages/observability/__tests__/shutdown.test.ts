import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushLogsWithDeadline } from "../shutdown";

const { flush } = vi.hoisted(() => ({ flush: vi.fn() }));

vi.mock("../log.ts", () => ({
  log: {
    flush,
  },
}));

describe("flushLogsWithDeadline", () => {
  beforeEach(() => {
    flush.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delegates to log.flush", async () => {
    flush.mockResolvedValueOnce(undefined);

    await flushLogsWithDeadline();

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("returns when log.flush rejects", async () => {
    flush.mockRejectedValueOnce(new Error("flush failed"));

    await expect(flushLogsWithDeadline()).resolves.toBeUndefined();

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("returns when the deadline wins", async () => {
    vi.useFakeTimers();
    flush.mockReturnValueOnce(new Promise<void>(() => undefined));

    const pending = flushLogsWithDeadline(100);
    await vi.advanceTimersByTimeAsync(100);
    await pending;

    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("unrefs the deadline timer when supported", async () => {
    flush.mockResolvedValueOnce(undefined);
    const unref = vi.fn();
    const setTimeoutMock = (
      ...args: Parameters<typeof setTimeout>
    ): ReturnType<typeof setTimeout> => {
      expect(args[1]).toBe(100);
      return { unref } as unknown as ReturnType<typeof setTimeout>;
    };
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(setTimeoutMock);

    await flushLogsWithDeadline(100);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
