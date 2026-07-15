/**
 * Unit tests for attachmentReconcileService.
 *
 * S3 helpers (listObjects/deleteObjects), the bucket key resolver, and the
 * database are all mocked. Tests verify:
 *   - orphaned objects (no backing fileAttachment row) are deleted, referenced
 *     ones are kept
 *   - the orphan lookup is scoped to the swept bucket
 *   - orphans are removed in one batched DeleteObjects call per page
 *   - objects newer than the presigned-upload window are skipped (in-flight)
 *   - the sweep paginates across continuation tokens
 *   - a sweep error yields exitCode 1 (so the cron route alerts + returns 500)
 *   - a missing bucket short-circuits to a successful no-op
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/aws", () => ({
  deleteObjects: vi.fn(),
  listObjects: vi.fn(),
}));

vi.mock("@repo/aws/keys", () => ({
  keys: vi.fn(() => ({ FILE_ATTACHMENTS_BUCKET: "test-bucket" })),
}));

const findMany = vi.fn();
vi.mock("@repo/database", () => ({
  withDb: vi.fn((cb: (db: unknown) => unknown) =>
    cb({ fileAttachment: { findMany } })
  ),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../attachments-service", () => ({
  ATTACHMENT_UPLOAD_SIGNED_URL_EXPIRY_SECONDS: 900,
}));

import { deleteObjects, listObjects } from "@repo/aws";
import { keys as awsKeys } from "@repo/aws/keys";
import { attachmentReconcileService } from "../attachment-reconcile-service";

const NOW = new Date("2026-06-27T12:00:00.000Z");
// Comfortably older than NOW − 900s, so these objects are past the upload window.
const OLD = new Date("2026-06-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(awsKeys).mockReturnValue({
    FILE_ATTACHMENTS_BUCKET: "test-bucket",
  } as ReturnType<typeof awsKeys>);
});

describe("attachmentReconcileService.runReconcileSweep", () => {
  it("deletes orphaned objects and keeps referenced ones", async () => {
    vi.mocked(listObjects).mockResolvedValueOnce({
      objects: [
        { key: "attachments/org/doc/referenced", lastModified: OLD },
        { key: "attachments/org/doc/orphan", lastModified: OLD },
      ],
      nextContinuationToken: undefined,
    });
    findMany.mockResolvedValueOnce([{ key: "attachments/org/doc/referenced" }]);

    const result = await attachmentReconcileService.runReconcileSweep(NOW);

    // Orphan lookup is scoped to the swept bucket (defense-in-depth).
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bucket: "test-bucket" }),
      })
    );
    // Single batched delete carrying only the orphaned key.
    expect(deleteObjects).toHaveBeenCalledTimes(1);
    expect(deleteObjects).toHaveBeenCalledWith(
      ["attachments/org/doc/orphan"],
      "test-bucket"
    );
    expect(result).toMatchObject({
      scanned: 2,
      orphansDeleted: 1,
      exitCode: 0,
    });
  });

  it("skips objects still within the presigned-upload window", async () => {
    vi.mocked(listObjects).mockResolvedValueOnce({
      objects: [
        // 60s before NOW → inside the 900s grace window, must be ignored.
        {
          key: "attachments/org/doc/fresh",
          lastModified: new Date(NOW.getTime() - 60 * 1000),
        },
      ],
      nextContinuationToken: undefined,
    });

    const result = await attachmentReconcileService.runReconcileSweep(NOW);

    expect(findMany).not.toHaveBeenCalled();
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scanned: 1,
      orphansDeleted: 0,
      exitCode: 0,
    });
  });

  it("paginates across continuation tokens", async () => {
    vi.mocked(listObjects)
      .mockResolvedValueOnce({
        objects: [{ key: "attachments/page1/orphan", lastModified: OLD }],
        nextContinuationToken: "token-2",
      })
      .mockResolvedValueOnce({
        objects: [{ key: "attachments/page2/orphan", lastModified: OLD }],
        nextContinuationToken: undefined,
      });
    findMany.mockResolvedValue([]);

    const result = await attachmentReconcileService.runReconcileSweep(NOW);

    expect(listObjects).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listObjects).mock.calls[1][0]).toMatchObject({
      continuationToken: "token-2",
    });
    // One batched delete per page.
    expect(deleteObjects).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      scanned: 2,
      orphansDeleted: 2,
      exitCode: 0,
    });
  });

  it("skips objects with no LastModified (indeterminate age)", async () => {
    vi.mocked(listObjects).mockResolvedValueOnce({
      objects: [
        { key: "attachments/org/doc/no-date", lastModified: undefined },
      ],
      nextContinuationToken: undefined,
    });

    const result = await attachmentReconcileService.runReconcileSweep(NOW);

    expect(findMany).not.toHaveBeenCalled();
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scanned: 1,
      orphansDeleted: 0,
      exitCode: 0,
    });
  });

  it("returns exitCode 1 when the sweep errors", async () => {
    vi.mocked(listObjects).mockRejectedValueOnce(new Error("s3 down"));

    const result = await attachmentReconcileService.runReconcileSweep(NOW);

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("s3 down");
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it("reports partial progress when the sweep fails mid-pagination", async () => {
    vi.mocked(listObjects)
      .mockResolvedValueOnce({
        objects: [{ key: "attachments/page1/orphan", lastModified: OLD }],
        nextContinuationToken: "token-2",
      })
      .mockRejectedValueOnce(new Error("s3 down"));
    findMany.mockResolvedValueOnce([]);

    const result = await attachmentReconcileService.runReconcileSweep(NOW);

    expect(deleteObjects).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      scanned: 1,
      orphansDeleted: 1,
      exitCode: 1,
    });
    expect(result.summary).toContain("s3 down");
  });

  it("short-circuits to a no-op when no bucket is configured", async () => {
    vi.mocked(awsKeys).mockReturnValue({
      FILE_ATTACHMENTS_BUCKET: undefined,
    } as ReturnType<typeof awsKeys>);

    const result = await attachmentReconcileService.runReconcileSweep(NOW);

    expect(listObjects).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exitCode: 0, orphansDeleted: 0 });
  });
});
