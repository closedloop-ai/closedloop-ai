import { describe, expect, it, vi } from "vitest";
import { importWithRetry } from "../lazy-with-retry";

// A no-op sleep keeps the retry/backoff logic under test without waiting on
// real timers.
const noSleep = () => Promise.resolve();

describe("importWithRetry", () => {
  it("resolves when the factory succeeds on the first attempt", async () => {
    const factory = vi.fn(() => Promise.resolve({ default: "ok" }));

    const result = await importWithRetry(factory, { sleep: noSleep });

    expect(result).toEqual({ default: "ok" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retries and resolves when the factory fails before succeeding", async () => {
    let calls = 0;
    const factory = vi.fn(() => {
      calls += 1;
      if (calls < 3) {
        return Promise.reject(new Error(`transient ${calls}`));
      }
      return Promise.resolve({ default: "loaded" });
    });

    const result = await importWithRetry(factory, {
      retries: 2,
      sleep: noSleep,
    });

    expect(result).toEqual({ default: "loaded" });
    // 2 failures + 1 success = 3 attempts (the default retry budget).
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("rejects with the last error after exhausting all attempts", async () => {
    const factory = vi.fn(() =>
      Promise.reject(new Error("permanently broken"))
    );

    await expect(
      importWithRetry(factory, { retries: 2, sleep: noSleep })
    ).rejects.toThrow("permanently broken");
    // retries: 2 → 3 total attempts.
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it("honors a custom retry count for the attempt total", async () => {
    const factory = vi.fn(() => Promise.reject(new Error("nope")));

    await expect(
      importWithRetry(factory, { retries: 4, sleep: noSleep })
    ).rejects.toThrow("nope");
    expect(factory).toHaveBeenCalledTimes(5);
  });

  it("applies linear backoff between attempts via the injected sleep", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const factory = vi.fn(() => Promise.reject(new Error("nope")));

    await expect(
      importWithRetry(factory, { retries: 2, baseDelayMs: 100, sleep })
    ).rejects.toThrow("nope");

    // Sleeps only between attempts (not after the final failure): 100, 200.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });
});
