import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  GITHUB_COMMENT_WRITE_ATTEMPTS,
  isRetryableGitHubCommentWriteError,
  withGitHubCommentWriteRetry,
} from "./github-comment-write-retry";

/** The envelope `@prisma/adapter-pg` raises: no `meta.target` (ISS-7536). */
function adapterError(code: string, originalCode: string) {
  return {
    code,
    meta: {
      driverAdapterError: {
        cause: { originalCode, constraint: { index: "some_key" } },
      },
    },
  };
}

describe("isRetryableGitHubCommentWriteError", () => {
  it.each([
    ["a unique violation with no meta.target", adapterError("P2002", "23505")],
    ["a write conflict or deadlock", adapterError("P2034", "40P01")],
    ["a raw query's deadlock", adapterError("P2010", "40P01")],
    ["a raw query's serialization failure", adapterError("P2010", "40001")],
    ["a bare deadlock SQLSTATE", { code: "40P01" }],
  ])("retries %s", (_, error) => {
    expect(isRetryableGitHubCommentWriteError(error)).toBe(true);
  });

  it.each([
    ["a missing row", { code: "P2025" }],
    ["an aborted transaction", adapterError("P2039", "25P02")],
    ["a raw query's other failure", adapterError("P2010", "55P03")],
    ["a plain error", new Error("boom")],
  ])("does not retry %s", (_, error) => {
    expect(isRetryableGitHubCommentWriteError(error)).toBe(false);
  });
});

describe("withGitHubCommentWriteRetry", () => {
  it("runs the write again once after a retryable failure", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(adapterError("P2002", "23505"))
      .mockResolvedValueOnce("written");

    await expect(withGitHubCommentWriteRetry(write)).resolves.toBe("written");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("rethrows once the attempts are spent", async () => {
    const conflict = adapterError("P2002", "23505");
    const write = vi.fn().mockRejectedValue(conflict);

    await expect(withGitHubCommentWriteRetry(write)).rejects.toBe(conflict);
    expect(write).toHaveBeenCalledTimes(GITHUB_COMMENT_WRITE_ATTEMPTS);
  });

  it("rethrows a failure that is not retryable without running again", async () => {
    const failure = { code: "P2025" };
    const write = vi.fn().mockRejectedValue(failure);

    await expect(withGitHubCommentWriteRetry(write)).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
