/**
 * Unit tests for `documentGenerationStatusService`.
 *
 * Covers:
 *  - `getGenerationStatus` — returns null for missing/non-DOCUMENT artifacts,
 *    delegates to the helpers for status reconciliation + dismissal
 *    suppression.
 *  - `dismissGenerationStatus` — only dismisses when the current status is
 *    FAILURE, the runKey is non-null, and the caller's `expectedRunKey`
 *    matches (or is null). Persists the dismissal and returns NONE_STATUS.
 */

import type { GenerationStatus } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

vi.mock("@/app/documents/generation-status-helpers", () => ({
  fetchBestGenerationStatusForDocument: vi.fn(),
  getDismissedFailureRunKey: vi.fn(),
  suppressDismissedFailure: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  fetchBestGenerationStatusForDocument,
  getDismissedFailureRunKey,
  suppressDismissedFailure,
} from "@/app/documents/generation-status-helpers";
import { documentGenerationStatusService } from "@/app/documents/generation-status-service";

const mockWithDb = withDb as unknown as Mock;
const mockFetchBest = fetchBestGenerationStatusForDocument as Mock;
const mockGetDismissed = getDismissedFailureRunKey as Mock;
const mockSuppress = suppressDismissedFailure as Mock;

function mockDb(db: Record<string, unknown>) {
  mockWithDb.mockImplementation(
    async (fn: (db: Record<string, unknown>) => unknown) => fn(db)
  );
}

const FAILURE_STATUS: GenerationStatus = {
  status: "FAILURE",
  command: "plan",
  htmlUrl: null,
  startedAt: new Date(),
  completedAt: new Date(),
  correlationId: "corr-1",
  runKey: "run-abc",
};

describe("documentGenerationStatusService.getGenerationStatus", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null when the artifact doesn't exist in the org", async () => {
    mockDb({
      artifact: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    const result = await documentGenerationStatusService.getGenerationStatus(
      "doc-1",
      "org-1"
    );
    expect(result).toBeNull();
    expect(mockFetchBest).not.toHaveBeenCalled();
  });

  it("returns null when the artifact is not a DOCUMENT", async () => {
    mockDb({
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "art-1",
          type: "BRANCH",
        }),
      },
    });

    const result = await documentGenerationStatusService.getGenerationStatus(
      "doc-1",
      "org-1"
    );
    expect(result).toBeNull();
  });

  it("delegates to helpers and returns the suppressed status", async () => {
    mockDb({
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "doc-1",
          type: "DOCUMENT",
        }),
      },
    });
    mockFetchBest.mockResolvedValue(FAILURE_STATUS);
    mockGetDismissed.mockResolvedValue("run-abc");
    mockSuppress.mockReturnValue({ status: "NONE", command: null });

    const result = await documentGenerationStatusService.getGenerationStatus(
      "doc-1",
      "org-1"
    );

    expect(mockFetchBest).toHaveBeenCalledWith("doc-1");
    expect(mockGetDismissed).toHaveBeenCalledWith("doc-1");
    expect(mockSuppress).toHaveBeenCalledWith(FAILURE_STATUS, "run-abc");
    expect(result?.status).toBe("NONE");
  });
});

describe("documentGenerationStatusService.dismissGenerationStatus", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null when the artifact is missing or not DOCUMENT", async () => {
    mockDb({
      artifact: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    const result =
      await documentGenerationStatusService.dismissGenerationStatus(
        "doc-1",
        "org-1",
        "user-1",
        null
      );
    expect(result).toBeNull();
  });

  it("does not dismiss when status is not FAILURE", async () => {
    const upsert = vi.fn();
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findUnique: vi.fn().mockResolvedValue({
              id: "doc-1",
              type: "DOCUMENT",
              workstreamId: "ws-1",
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ documentGenerationStatusDismissal: { upsert } })
      );

    mockFetchBest.mockResolvedValue({
      status: "RUNNING",
      command: "plan",
      htmlUrl: null,
      startedAt: new Date(),
      completedAt: null,
      correlationId: null,
      runKey: "run-running",
    });
    mockGetDismissed.mockResolvedValue(null);
    mockSuppress.mockImplementation((s: GenerationStatus) => s);

    const result =
      await documentGenerationStatusService.dismissGenerationStatus(
        "doc-1",
        "org-1",
        "user-1",
        null
      );

    expect(upsert).not.toHaveBeenCalled();
    expect(result?.status).toBe("RUNNING");
  });

  it("does not dismiss when expectedRunKey is provided and doesn't match", async () => {
    const upsert = vi.fn();
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findUnique: vi.fn().mockResolvedValue({
              id: "doc-1",
              type: "DOCUMENT",
              workstreamId: "ws-1",
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ documentGenerationStatusDismissal: { upsert } })
      );

    mockFetchBest.mockResolvedValue(FAILURE_STATUS);
    mockGetDismissed.mockResolvedValue(null);
    mockSuppress.mockImplementation((s: GenerationStatus) => s);

    const result =
      await documentGenerationStatusService.dismissGenerationStatus(
        "doc-1",
        "org-1",
        "user-1",
        "different-run-key"
      );

    expect(upsert).not.toHaveBeenCalled();
    expect(result?.status).toBe("FAILURE");
  });

  it("dismisses when status is FAILURE and expectedRunKey matches the current runKey", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findUnique: vi.fn().mockResolvedValue({
              id: "doc-1",
              type: "DOCUMENT",
              workstreamId: "ws-1",
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ documentGenerationStatusDismissal: { upsert } })
      );

    mockFetchBest.mockResolvedValue(FAILURE_STATUS);

    const result =
      await documentGenerationStatusService.dismissGenerationStatus(
        "doc-1",
        "org-1",
        "user-1",
        "run-abc"
      );

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { artifactId: "doc-1" },
        create: expect.objectContaining({
          artifactId: "doc-1",
          dismissedById: "user-1",
          runKey: "run-abc",
        }),
      })
    );
    expect(result?.status).toBe("NONE");
  });

  it("dismisses when status is FAILURE and expectedRunKey is null (caller accepts any)", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findUnique: vi.fn().mockResolvedValue({
              id: "doc-1",
              type: "DOCUMENT",
              workstreamId: "ws-1",
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ documentGenerationStatusDismissal: { upsert } })
      );

    mockFetchBest.mockResolvedValue(FAILURE_STATUS);

    const result =
      await documentGenerationStatusService.dismissGenerationStatus(
        "doc-1",
        "org-1",
        "user-1",
        null
      );

    expect(upsert).toHaveBeenCalled();
    expect(result?.status).toBe("NONE");
  });
});
