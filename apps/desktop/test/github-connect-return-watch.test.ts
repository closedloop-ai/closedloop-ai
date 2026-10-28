import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubConnectReturnWatch } from "../src/main/github/github-connect-return-watch.js";

const POLL_MS = 1000;
const TIMEOUT_MS = 5000;

function watchWith(answers: (boolean | undefined)[]) {
  const account = { current: "account-a" };
  const readConnected = vi.fn(() =>
    Promise.resolve(answers.length > 1 ? answers.shift() : answers[0])
  );
  const bringWindowToFront = vi.fn();
  const watch = createGitHubConnectReturnWatch({
    readConnected,
    captureAccount: () => {
      const captured = account.current;
      return () => account.current === captured;
    },
    bringWindowToFront,
    pollIntervalMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
  });
  return { account, watch, readConnected, bringWindowToFront };
}

describe("createGitHubConnectReturnWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("brings Desktop forward when the connection lands", async () => {
    const { watch, bringWindowToFront } = watchWith([false, false, true]);

    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(bringWindowToFront).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(bringWindowToFront).toHaveBeenCalledTimes(1);
  });

  it("stops polling once it has brought Desktop forward", async () => {
    const { watch, readConnected } = watchWith([false, true]);

    watch.start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);

    expect(readConnected).toHaveBeenCalledTimes(2);
  });

  it("activates when linking finishes before the first status read", async () => {
    const { watch, readConnected, bringWindowToFront } = watchWith([true]);

    watch.start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(bringWindowToFront).toHaveBeenCalledTimes(1);
    expect(readConnected).toHaveBeenCalledTimes(1);
  });

  it("activates when a delayed first status response reports the completed link", async () => {
    const { watch, readConnected, bringWindowToFront } = watchWith([false]);
    let resolveRead!: (connected: boolean) => void;
    readConnected.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRead = resolve;
        })
    );

    watch.start();
    expect(bringWindowToFront).not.toHaveBeenCalled();
    resolveRead(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(bringWindowToFront).toHaveBeenCalledTimes(1);
  });

  it("treats failed reads as no answer either way", async () => {
    const { watch, bringWindowToFront } = watchWith([
      undefined,
      false,
      undefined,
      true,
    ]);

    watch.start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(bringWindowToFront).toHaveBeenCalledTimes(1);
  });

  // A first read that fails is not evidence the connection was already there:
  // the caller only asks while the reader is not connected.
  it("still activates when the first read failed", async () => {
    const { watch, bringWindowToFront } = watchWith([undefined, true]);

    watch.start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(bringWindowToFront).toHaveBeenCalledTimes(1);
  });

  it("ends without activating when the signed-in account changes", async () => {
    const { account, watch, readConnected, bringWindowToFront } = watchWith([
      false,
      true,
    ]);

    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    account.current = "account-b";
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(bringWindowToFront).not.toHaveBeenCalled();
    expect(readConnected).toHaveBeenCalledTimes(2);
  });

  it("gives up at the timeout", async () => {
    const { watch, readConnected } = watchWith([false]);

    watch.start();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    const readsAtTimeout = readConnected.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(readConnected).toHaveBeenCalledTimes(readsAtTimeout);
    expect(readsAtTimeout).toBeLessThanOrEqual(TIMEOUT_MS / POLL_MS + 1);
  });

  it("stop() cancels a pending activation", async () => {
    const { watch, bringWindowToFront } = watchWith([false, true]);

    watch.start();
    await vi.advanceTimersByTimeAsync(0);
    watch.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    expect(bringWindowToFront).not.toHaveBeenCalled();
  });

  it("a second start replaces the first watch instead of running two", async () => {
    const { watch, readConnected } = watchWith([false]);

    watch.start();
    watch.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Two immediate reads (one per start), then ONE poll — not two.
    expect(readConnected).toHaveBeenCalledTimes(3);
  });
});
