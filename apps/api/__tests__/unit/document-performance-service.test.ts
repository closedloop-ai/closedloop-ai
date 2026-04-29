/**
 * Unit tests for `documentPerformanceService`.
 *
 * Covers:
 *  - `getPerformanceData` — returns the most recent perfRecord for a
 *    document, scoped via the documentDetail → artifact relation; null when
 *    no record exists.
 *  - `getExecutionLog` — happy path (downloads + parses agent logs), early
 *    exit when no workstream / no successful run / no symphony artifact,
 *    and graceful empty-trace fallback when an error occurs.
 */

import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

vi.mock("@repo/github", () => ({
  downloadWorkflowArtifacts: vi.fn(),
}));

vi.mock("@repo/github/execution-log-parser", () => ({
  createEmptyExecutionTrace: () => ({ steps: [], _empty: true }),
  parseExecutionLogs: vi.fn(),
}));

vi.mock("@repo/github/zip-utils", () => ({
  SYMPHONY_RUN_ARTIFACT_PREFIXES: ["symphony-run-"],
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { withDb } from "@repo/database";
import { downloadWorkflowArtifacts } from "@repo/github";
import { parseExecutionLogs } from "@repo/github/execution-log-parser";
import { documentPerformanceService } from "@/app/documents/performance-service";

const mockWithDb = withDb as unknown as Mock;
const mockDownloadArtifacts = downloadWorkflowArtifacts as Mock;
const mockParseExecutionLogs = parseExecutionLogs as Mock;

function mockDb(db: Record<string, unknown>) {
  mockWithDb.mockImplementation(
    async (fn: (db: Record<string, unknown>) => unknown) => fn(db)
  );
}

describe("documentPerformanceService.getPerformanceData", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the perf summary when a record exists", async () => {
    const summaryData = { totalDurationMs: 12_345, steps: [] };
    mockDb({
      gitHubActionRunPerformance: {
        findFirst: vi.fn().mockResolvedValue({
          id: "perf-1",
          summaryData,
          createdAt: new Date(),
        }),
      },
    });

    const result = await documentPerformanceService.getPerformanceData(
      "doc-1",
      "org-1"
    );
    expect(result).toEqual(summaryData);
  });

  it("returns null when no perf record exists", async () => {
    mockDb({
      gitHubActionRunPerformance: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await documentPerformanceService.getPerformanceData(
      "doc-1",
      "org-1"
    );
    expect(result).toBeNull();
  });

  it("scopes the query through documentDetail.artifact for org isolation", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    mockDb({ gitHubActionRunPerformance: { findFirst } });

    await documentPerformanceService.getPerformanceData("doc-1", "org-1");

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          artifactId: "doc-1",
          documentDetail: { artifact: { organizationId: "org-1" } },
        }),
        orderBy: { createdAt: "desc" },
      })
    );
  });
});

describe("documentPerformanceService.getExecutionLog", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns an empty trace when the document has no workstream", async () => {
    mockDb({
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ workstreamId: null }),
      },
    });

    const result = await documentPerformanceService.getExecutionLog(
      "doc-1",
      "org-1"
    );
    expect(result).toEqual({ steps: [], _empty: true });
    expect(mockDownloadArtifacts).not.toHaveBeenCalled();
  });

  it("returns an empty trace when no successful action run exists for the document", async () => {
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findFirst: vi.fn().mockResolvedValue({ workstreamId: "ws-1" }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({ gitHubActionRun: { findFirst: vi.fn().mockResolvedValue(null) } })
      );

    const result = await documentPerformanceService.getExecutionLog(
      "doc-1",
      "org-1"
    );
    expect(result).toEqual({ steps: [], _empty: true });
    expect(mockDownloadArtifacts).not.toHaveBeenCalled();
  });

  it("returns an empty trace when no symphony-run artifact is found in the workflow", async () => {
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findFirst: vi.fn().mockResolvedValue({ workstreamId: "ws-1" }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          gitHubActionRun: {
            findFirst: vi.fn().mockResolvedValue({ runId: 42 }),
          },
        })
      );
    mockDownloadArtifacts.mockResolvedValue([
      { name: "other-artifact", data: Buffer.from("x") },
    ]);

    const result = await documentPerformanceService.getExecutionLog(
      "doc-1",
      "org-1"
    );
    expect(result).toEqual({ steps: [], _empty: true });
    expect(mockParseExecutionLogs).not.toHaveBeenCalled();
  });

  it("parses and returns the execution trace when the symphony-run artifact is present", async () => {
    mockWithDb
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          artifact: {
            findFirst: vi.fn().mockResolvedValue({ workstreamId: "ws-1" }),
          },
        })
      )
      .mockImplementationOnce((fn: (db: object) => unknown) =>
        fn({
          gitHubActionRun: {
            findFirst: vi.fn().mockResolvedValue({ runId: 42 }),
          },
        })
      );
    const buf = Buffer.from("zip-bytes");
    mockDownloadArtifacts.mockResolvedValue([
      { name: "symphony-run-abc.zip", data: buf },
    ]);
    const trace = { steps: [{ id: "s1" }] };
    mockParseExecutionLogs.mockReturnValue(trace);

    const result = await documentPerformanceService.getExecutionLog(
      "doc-1",
      "org-1"
    );
    expect(mockParseExecutionLogs).toHaveBeenCalledWith(buf);
    expect(result).toBe(trace);
  });

  it("returns an empty trace and logs when an error is thrown", async () => {
    mockWithDb.mockImplementation(() => {
      throw new Error("db down");
    });

    const result = await documentPerformanceService.getExecutionLog(
      "doc-1",
      "org-1"
    );
    expect(result).toEqual({ steps: [], _empty: true });
  });
});
