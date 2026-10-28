/**
 * This helper runs AFTER the rows carrying the storage keys have been deleted,
 * so a throw would roll a caller back over data that is already gone. Never
 * throwing, and logging the orphaned keys when S3 fails, is the whole contract.
 */

import { deleteTranscriptObjects } from "@repo/aws/transcript-storage";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { purgeTranscriptObjectsBestEffort } from "./transcript-object-purge";

vi.mock("@repo/aws/transcript-storage", () => ({
  deleteTranscriptObjects: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
  },
}));

const KEYS = ["transcripts/a.jsonl", "transcripts/b.jsonl"];
const MESSAGE = "transcript_object_purge_failed";
const CONTEXT = { organizationId: "org-1", agentSessionId: "sess-1" };

describe("purgeTranscriptObjectsBestEffort", () => {
  beforeEach(() => {
    vi.mocked(deleteTranscriptObjects).mockReset();
    vi.mocked(log.error).mockReset();
  });

  it("skips the storage call entirely for an empty key list", async () => {
    await expect(
      purgeTranscriptObjectsBestEffort([], MESSAGE, CONTEXT)
    ).resolves.toBeUndefined();

    expect(deleteTranscriptObjects).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("deletes the exact keys it was handed", async () => {
    vi.mocked(deleteTranscriptObjects).mockResolvedValue(undefined);

    await expect(
      purgeTranscriptObjectsBestEffort(KEYS, MESSAGE, CONTEXT)
    ).resolves.toBeUndefined();

    expect(deleteTranscriptObjects).toHaveBeenCalledTimes(1);
    expect(deleteTranscriptObjects).toHaveBeenCalledWith(KEYS);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("works without a caller-supplied context", async () => {
    vi.mocked(deleteTranscriptObjects).mockResolvedValue(undefined);

    await expect(
      purgeTranscriptObjectsBestEffort(KEYS, MESSAGE)
    ).resolves.toBeUndefined();

    expect(deleteTranscriptObjects).toHaveBeenCalledWith(KEYS);
  });

  it("swallows a storage failure and logs the orphaned keys", async () => {
    vi.mocked(deleteTranscriptObjects).mockRejectedValue(
      new Error("AccessDenied")
    );

    await expect(
      purgeTranscriptObjectsBestEffort(KEYS, MESSAGE, CONTEXT)
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(MESSAGE, {
      ...CONTEXT,
      objectCount: KEYS.length,
      objectStorageKeys: KEYS,
      error: "AccessDenied",
    });
  });

  it("stringifies a non-Error rejection", async () => {
    vi.mocked(deleteTranscriptObjects).mockRejectedValue("throttled");

    await purgeTranscriptObjectsBestEffort(KEYS, MESSAGE, CONTEXT);

    expect(log.error).toHaveBeenCalledWith(
      MESSAGE,
      expect.objectContaining({ error: "throttled" })
    );
  });

  it("lets the caller's context lose to the fields the helper owns", async () => {
    vi.mocked(deleteTranscriptObjects).mockRejectedValue(new Error("boom"));

    await purgeTranscriptObjectsBestEffort(KEYS, MESSAGE, {
      objectCount: 999,
      error: "caller-supplied",
    });

    expect(log.error).toHaveBeenCalledWith(
      MESSAGE,
      expect.objectContaining({ objectCount: KEYS.length, error: "boom" })
    );
  });
});

describe("deferred @repo/aws/transcript-storage import", () => {
  afterEach(() => {
    vi.doUnmock("@repo/aws/transcript-storage");
    vi.resetModules();
  });

  it("does not evaluate @repo/aws/transcript-storage until a key actually needs deleting", async () => {
    vi.resetModules();
    const evaluateAwsModule = vi.fn();
    vi.doMock("@repo/aws/transcript-storage", () => {
      evaluateAwsModule();
      return { deleteTranscriptObjects: vi.fn() };
    });

    // An eager top-level import would evaluate `@repo/aws/transcript-storage`
    // — and with it the `import "server-only"` it begins with — right here,
    // breaking every non-Next consumer of this helper's importers (the desktop
    // gateway socket server, the `server:import-smoke` script).
    const isolated = await import("./transcript-object-purge");
    expect(evaluateAwsModule).not.toHaveBeenCalled();

    await expect(
      isolated.purgeTranscriptObjectsBestEffort([], MESSAGE)
    ).resolves.toBeUndefined();
    expect(evaluateAwsModule).not.toHaveBeenCalled();

    await expect(
      isolated.purgeTranscriptObjectsBestEffort(KEYS, MESSAGE)
    ).resolves.toBeUndefined();
    expect(evaluateAwsModule).toHaveBeenCalledTimes(1);
  });

  it("logs the orphaned keys when @repo/aws/transcript-storage throws on evaluation", async () => {
    vi.resetModules();
    vi.doMock("@repo/aws/transcript-storage", () => {
      throw new Error(
        "server-only: cannot be imported outside a Next.js runtime"
      );
    });

    const { log: isolatedLog } = await import("@repo/observability/log");
    const isolated = await import("./transcript-object-purge");
    // The hoisted `vi.mock` factory result survives `vi.resetModules()`, so the
    // call count still carries the preceding describe block's failures.
    vi.mocked(isolatedLog.error).mockReset();

    await expect(
      isolated.purgeTranscriptObjectsBestEffort(KEYS, MESSAGE, CONTEXT)
    ).resolves.toBeUndefined();

    // Not throwing is only half the contract. The rows that carried these keys
    // are already deleted, so if the S3 client never even loads, the keys have
    // to reach the log or the objects are orphaned with nothing pointing at
    // them. A failure BEFORE `deleteTranscriptObjects` exists must log the same
    // payload as a failure inside it.
    expect(isolatedLog.error).toHaveBeenCalledTimes(1);
    expect(isolatedLog.error).toHaveBeenCalledWith(
      MESSAGE,
      expect.objectContaining({
        ...CONTEXT,
        objectCount: KEYS.length,
        objectStorageKeys: KEYS,
        // Vitest substitutes its own wrapper text for a mock factory's thrown
        // message, so only this field's presence is pinned — asserting the
        // string would pin harness internals. The keys above are the contract.
        error: expect.any(String),
      })
    );
  });
});
