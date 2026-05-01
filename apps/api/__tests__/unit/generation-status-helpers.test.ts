/**
 * Unit tests for `generation-status-helpers`.
 *
 * Covers the three reconciliation primitives shared between the
 * single-document path (`documentGenerationStatusService`) and the batch
 * path (`documentService.findAll`):
 *
 *  - `fetchBestGenerationStatusForDocument` — combines GH Actions + Loop
 *    sources via `pickBestStatus`.
 *  - `getDismissedFailureRunKey` — reads the dismissal row.
 *  - `suppressDismissedFailure` — replaces a dismissed FAILURE with NONE.
 *  - `suppressDismissedFailuresForDocumentMap` — batch variant; mutates the
 *    map in place.
 *  - `mergeLoopStatuses` — merges Loop rows into the batch map.
 */

import type { GenerationStatus } from "@repo/api/src/types/document";
import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import { withDb } from "@repo/database";
import {
  fetchBestGenerationStatusForDocument,
  getDismissedFailureRunKey,
  mergeLoopStatuses,
  suppressDismissedFailure,
  suppressDismissedFailuresForDocumentMap,
  withRunKey,
} from "@/app/documents/generation-status-helpers";

const mockWithDb = withDb as unknown as Mock;

function mockDb(db: Record<string, unknown>) {
  mockWithDb.mockImplementation(
    async (fn: (db: Record<string, unknown>) => unknown) => fn(db)
  );
}

function makeFailureStatus(
  overrides?: Partial<GenerationStatus>
): GenerationStatus {
  return withRunKey({
    status: "FAILURE",
    command: "plan",
    htmlUrl: null,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:01:00Z"),
    correlationId: "corr-1",
    source: "github_actions",
    ...overrides,
  });
}

describe("suppressDismissedFailure", () => {
  it("replaces FAILURE with NONE_STATUS when runKey matches dismissal", () => {
    const status = makeFailureStatus();
    const result = suppressDismissedFailure(status, status.runKey ?? null);
    expect(result.status).toBe("NONE");
  });

  it("passes through FAILURE when runKey doesn't match dismissal", () => {
    const status = makeFailureStatus();
    const result = suppressDismissedFailure(status, "different-run-key");
    expect(result.status).toBe("FAILURE");
  });

  it("passes through non-FAILURE statuses unchanged", () => {
    const success = withRunKey({
      status: "SUCCESS",
      command: "plan",
      htmlUrl: null,
      startedAt: new Date(),
      completedAt: new Date(),
      correlationId: "corr-1",
      source: "github_actions",
    });
    expect(suppressDismissedFailure(success, success.runKey ?? null)).toBe(
      success
    );
  });

  it("passes through FAILURE when no dismissal recorded (null runKey)", () => {
    const status = makeFailureStatus();
    expect(suppressDismissedFailure(status, null)).toBe(status);
  });
});

describe("getDismissedFailureRunKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the runKey when a dismissal exists", async () => {
    mockDb({
      documentGenerationStatusDismissal: {
        findUnique: vi.fn().mockResolvedValue({ runKey: "run-abc" }),
      },
    });
    const key = await getDismissedFailureRunKey("doc-1");
    expect(key).toBe("run-abc");
  });

  it("returns null when no dismissal exists", async () => {
    mockDb({
      documentGenerationStatusDismissal: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    });
    const key = await getDismissedFailureRunKey("doc-1");
    expect(key).toBeNull();
  });
});

describe("fetchBestGenerationStatusForDocument", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns NONE_STATUS when no GH Actions run and no Loop record exists", async () => {
    // sequence of withDb calls: ghActionRun.findFirst (null), loop.findMany ([])
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ gitHubActionRun: { findFirst: vi.fn().mockResolvedValue(null) } })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ loop: { findMany: vi.fn().mockResolvedValue([]) } })
      );

    const result = await fetchBestGenerationStatusForDocument("doc-1", "ws-1");
    expect(result.status).toBe("NONE");
  });

  it("returns the GH Actions status when only GH Actions has a run", async () => {
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          gitHubActionRun: {
            findFirst: vi.fn().mockResolvedValue({
              status: "SUCCESS",
              triggerData: {
                documentId: "doc-1",
                command: "plan",
                correlationId: "corr-1",
              },
              htmlUrl: "https://github.com/run",
              startedAt: new Date(),
              completedAt: new Date(),
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ loop: { findMany: vi.fn().mockResolvedValue([]) } })
      );

    const result = await fetchBestGenerationStatusForDocument("doc-1", "ws-1");
    expect(result.status).toBe("SUCCESS");
    expect(result.source).toBe("github_actions");
  });

  it("filters out GH Actions runs whose triggerData.documentId doesn't match", async () => {
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          gitHubActionRun: {
            findFirst: vi.fn().mockResolvedValue({
              status: "RUNNING",
              triggerData: { documentId: "different-doc" },
              htmlUrl: null,
              startedAt: new Date(),
              completedAt: null,
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ loop: { findMany: vi.fn().mockResolvedValue([]) } })
      );

    const result = await fetchBestGenerationStatusForDocument("doc-1", "ws-1");
    expect(result.status).toBe("NONE");
  });

  it("prefers an active loop status over a terminal GH Actions status", async () => {
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          gitHubActionRun: {
            findFirst: vi.fn().mockResolvedValue({
              status: "SUCCESS",
              triggerData: { documentId: "doc-1", command: "plan" },
              htmlUrl: null,
              startedAt: new Date("2026-01-01"),
              completedAt: new Date("2026-01-01"),
            }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          loop: {
            findMany: vi.fn().mockResolvedValue([
              {
                id: "loop-1",
                status: "RUNNING",
                command: "PLAN",
                startedAt: new Date("2025-12-01"),
                completedAt: null,
                user: null,
              },
            ]),
          },
        })
      );

    const result = await fetchBestGenerationStatusForDocument("doc-1", "ws-1");
    // Active (RUNNING) should win even though GH SUCCESS is more recent.
    expect(result.status).toBe("RUNNING");
    expect(result.source).toBe("loop");
  });

  it("skips GH Actions lookup when workstreamId is null", async () => {
    const ghFindFirst = vi.fn();
    mockDb({
      loop: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubActionRun: { findFirst: ghFindFirst },
    });

    const result = await fetchBestGenerationStatusForDocument("doc-1", null);
    expect(result.status).toBe("NONE");
    // The helper short-circuits with Promise.resolve(null) when workstreamId is null —
    // it should never reach gitHubActionRun.findFirst.
    expect(ghFindFirst).not.toHaveBeenCalled();
  });
});

describe("suppressDismissedFailuresForDocumentMap", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns early when documentIds is empty", async () => {
    const map = new Map<string, GenerationStatus>();
    await suppressDismissedFailuresForDocumentMap([], map);
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("returns early when generationStatusMap is empty", async () => {
    await suppressDismissedFailuresForDocumentMap(["doc-1"], new Map());
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("removes dismissed FAILURE entries from the map", async () => {
    const failure = makeFailureStatus();
    const map = new Map<string, GenerationStatus>([["doc-1", failure]]);

    mockDb({
      documentGenerationStatusDismissal: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ artifactId: "doc-1", runKey: failure.runKey }]),
      },
    });

    await suppressDismissedFailuresForDocumentMap(["doc-1"], map);
    expect(map.has("doc-1")).toBe(false);
  });

  it("retains entries whose runKey doesn't match a dismissal", async () => {
    const failure = makeFailureStatus();
    const map = new Map<string, GenerationStatus>([["doc-1", failure]]);

    mockDb({
      documentGenerationStatusDismissal: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { artifactId: "doc-1", runKey: "different-run-key" },
          ]),
      },
    });

    await suppressDismissedFailuresForDocumentMap(["doc-1"], map);
    expect(map.get("doc-1")?.status).toBe("FAILURE");
  });
});

describe("mergeLoopStatuses", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns early when documentIds is empty", async () => {
    await mergeLoopStatuses([], new Map());
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("merges Loop rows into the map keyed by artifactId", async () => {
    mockDb({
      loop: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "loop-1",
            artifactId: "doc-1",
            status: "RUNNING",
            command: "PLAN",
            startedAt: new Date(),
            completedAt: null,
            user: null,
          },
        ]),
      },
    });

    const map = new Map<string, GenerationStatus>();
    await mergeLoopStatuses(["doc-1"], map);

    expect(map.get("doc-1")?.status).toBe("RUNNING");
    expect(map.get("doc-1")?.source).toBe("loop");
  });

  it("skips loops with null artifactId or unmappable status", async () => {
    mockDb({
      loop: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "loop-1",
            artifactId: null,
            status: "RUNNING",
            command: "PLAN",
            startedAt: new Date(),
            completedAt: null,
            user: null,
          },
          {
            id: "loop-2",
            artifactId: "doc-2",
            status: "UNKNOWN_STATUS",
            command: "PLAN",
            startedAt: new Date(),
            completedAt: null,
            user: null,
          },
        ]),
      },
    });

    const map = new Map<string, GenerationStatus>();
    await mergeLoopStatuses(["doc-1", "doc-2"], map);
    expect(map.size).toBe(0);
  });
});
