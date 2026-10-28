import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORE_FAILED_EVENT,
  STORE_RETRY_DELAYS_MS,
  STORE_RETRY_EVENT,
  storeWithRetry,
} from "../storage/store-with-retry";

const DOCUMENT = "org-1:PRD-7";
/** Stands in for state bytes: it must never reach a log. */
const STATE_MARKER = "state-bytes-must-not-be-logged";

function pgError(code: string): Error {
  return Object.assign(new Error(`failed near ${STATE_MARKER}`), { code });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("storeWithRetry", () => {
  it("succeeds on the second attempt after one backoff, logging one retry", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(pgError("40001"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(() => Promise.resolve());

    await storeWithRetry(save, DOCUMENT, { sleep });

    expect(save).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(STORE_RETRY_DELAYS_MS[0]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      event: STORE_RETRY_EVENT,
      documentName: DOCUMENT,
      attempt: 1,
      code: "40001",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("retries three times with 250 ms, 1 s and 4 s backoff, then logs doc_sync.store_failed and rethrows", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const failure = pgError("08006");
    const save = vi.fn(() => Promise.reject(failure));

    const stored = storeWithRetry(save, DOCUMENT);
    const settled = stored.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(250 + 1000 + 4000 - 1);
    expect(save).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    expect(await settled).toBe(failure);
    expect(save).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), {
      event: STORE_FAILED_EVENT,
      documentName: DOCUMENT,
      attempt: 4,
      code: "08006",
    });
    const logged = JSON.stringify([warn.mock.calls, error.mock.calls]);
    expect(logged).not.toContain(STATE_MARKER);
  });
});
