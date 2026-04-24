/**
 * Unit tests for ingestRepoExecutionResults in
 * apps/api/lib/loops/ingest-repo-execution-results.ts
 *
 * Tests:
 * - single-repo length-1 success array: PR + linkage records are created
 * - all-success multi-repo scenario: each entry produces a PR + linkage record
 * - mixed-outcome array (success + failed + skipped): success entries produce
 *   records; failed/skipped entries only produce log calls
 * - repo lookup failure for a success entry: logs error, continues to next
 *   entry, does not abort
 * - code judges report is processed once outside the per-repo loop
 */

import type { RepoExecutionResult } from "@closedloop-ai/loops-api/execution-result";
import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { EvalStatus } from "@repo/api/src/types/evaluation";
import { vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

// ---------------------------------------------------------------------------
// Mocks — must be declared before module imports
// ---------------------------------------------------------------------------

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  EntityType: {
    DOCUMENT: "DOCUMENT",
    FEATURE: "FEATURE",
    WORKSTREAM: "WORKSTREAM",
  },
  GitHubPRState: {
    OPEN: "OPEN",
  },
  WorkstreamEventType: {
    GITHUB_PR_CREATED: "GITHUB_PR_CREATED",
  },
  EvaluationReportType: {
    PLAN: "PLAN",
    CODE: "CODE",
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/loops/loop-document-ingestion", () => ({
  upsertEvaluationWithJudgeScores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pr-linkage", () => ({
  ensurePrLinkageRecords: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prompts-service", () => ({
  upsertFromSnapshot: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import type { Mock } from "vitest";
import { ingestRepoExecutionResults } from "@/lib/loops/ingest-repo-execution-results";
import { upsertEvaluationWithJudgeScores } from "@/lib/loops/loop-document-ingestion";
import { ensurePrLinkageRecords } from "@/lib/pr-linkage";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import {
  makeIngestionCtx,
  makeIngestionSuccessMockTx,
} from "../fixtures/ingestion-helpers";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockWithDb = getMockWithDb();
const mockUpsertEvaluationWithJudgeScores =
  upsertEvaluationWithJudgeScores as unknown as Mock;
const mockEnsurePrLinkageRecords = ensurePrLinkageRecords as unknown as Mock;
const mockUpsertFromSnapshot = upsertFromSnapshot as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSuccessResult(
  overrides: Partial<RepoExecutionResult & { status: "success" }> = {}
): RepoExecutionResult & { status: "success" } {
  return {
    status: "success",
    fullName: "org/repo",
    prUrl: "https://github.com/org/repo/pull/42",
    prNumber: 42,
    prTitle: "Symphony: feature",
    branchName: "symphony/feature",
    baseBranch: "main",
    hasChanges: true,
    commitSha: "abc123",
    githubId: 999,
    ...overrides,
  };
}

function makeFailedResult(
  fullName = "org/repo-failed",
  error = "execution failed"
): RepoExecutionResult & { status: "failed" } {
  return { status: "failed", fullName, error };
}

function makeSkippedResult(
  fullName = "org/repo-skipped",
  reason = "no_changes"
): RepoExecutionResult & { status: "skipped" } {
  return { status: "skipped", fullName, reason };
}

function makeCodeJudgesReport(): JudgesReport {
  return {
    report_id: "report-code-1",
    timestamp: "2026-01-01T00:00:00Z",
    stats: [
      {
        type: "case_score",
        case_id: "security-judge",
        final_status: EvalStatus.Passed,
        metrics: [
          {
            metric_name: "security",
            threshold: 0.9,
            score: 0.95,
            justification: "No issues found.",
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestRepoExecutionResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Single-repo length-1 array (success)
  // -------------------------------------------------------------------------

  describe("single-repo success array", () => {
    it("creates PR record and linkage records for a single success entry", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [makeSuccessResult()];
      const mockTx = makeIngestionSuccessMockTx();

      // withDb (non-tx) returns the installation repo
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-1" }),
        },
      });

      // withDb.tx runs the per-entry transaction
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, results);

      expect(mockTx.gitHubPullRequest.upsert).toHaveBeenCalledTimes(1);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          organizationId: "org-1",
          workstreamId: "ws-1",
          documentId: "doc-1",
          prUrl: "https://github.com/org/repo/pull/42",
          prNumber: 42,
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // All-success multi-repo scenario
  // -------------------------------------------------------------------------

  describe("all-success multi-repo scenario", () => {
    it("processes each success entry independently and creates PR + linkage for each", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [
        makeSuccessResult({
          fullName: "org/repo-a",
          prUrl: "https://github.com/org/repo-a/pull/10",
          prNumber: 10,
          branchName: "symphony/feature-a",
        }),
        makeSuccessResult({
          fullName: "org/repo-b",
          prUrl: "https://github.com/org/repo-b/pull/20",
          prNumber: 20,
          branchName: "symphony/feature-b",
        }),
      ];

      // withDb (non-tx) is called once per success entry for repo lookup
      let callCount = 0;
      mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
        callCount++;
        return callback({
          gitHubInstallationRepository: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: `install-repo-${callCount}` }),
          },
        });
      });

      // withDb.tx is called once per success entry
      const mockTxA = makeIngestionSuccessMockTx();
      const mockTxB = makeIngestionSuccessMockTx();
      let txCallCount = 0;
      mockWithDb.tx = vi
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) => {
          txCallCount++;
          const tx = txCallCount === 1 ? mockTxA : mockTxB;
          return callback(tx);
        });

      await ingestRepoExecutionResults(ctx, results);

      expect(mockWithDb.tx).toHaveBeenCalledTimes(2);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(2);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledWith(
        mockTxA,
        expect.objectContaining({
          prNumber: 10,
          prUrl: "https://github.com/org/repo-a/pull/10",
        })
      );
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledWith(
        mockTxB,
        expect.objectContaining({
          prNumber: 20,
          prUrl: "https://github.com/org/repo-b/pull/20",
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Mixed-outcome array (success + failed + skipped)
  // -------------------------------------------------------------------------

  describe("mixed-outcome array", () => {
    it("success entries produce PR + linkage; failed/skipped entries do not call DB helpers", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [
        makeSuccessResult({
          fullName: "org/repo-ok",
          prNumber: 5,
          prUrl: "https://github.com/org/repo-ok/pull/5",
        }),
        makeFailedResult("org/repo-bad", "exec error"),
        makeSkippedResult("org/repo-skip", "no_changes"),
      ];

      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-ok" }),
        },
      });

      const mockTx = makeIngestionSuccessMockTx();
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, results);

      // Only the success entry triggers a transaction and linkage
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Repo lookup failure for a success entry
  // -------------------------------------------------------------------------

  describe("repo lookup failure", () => {
    it("continues to the next entry when installation repo is not found for a success entry", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [
        makeSuccessResult({
          fullName: "org/repo-missing",
          prNumber: 1,
          prUrl: "https://github.com/org/repo-missing/pull/1",
        }),
        makeSuccessResult({
          fullName: "org/repo-found",
          prNumber: 2,
          prUrl: "https://github.com/org/repo-found/pull/2",
        }),
      ];

      // First call: repo not found; second call: repo found
      let callCount = 0;
      mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
        callCount++;
        const found = callCount === 1 ? null : { id: "install-repo-found" };
        return callback({
          gitHubInstallationRepository: {
            findFirst: vi.fn().mockResolvedValue(found),
          },
        });
      });

      const mockTx = makeIngestionSuccessMockTx();
      mockWithDbTx(mockTx);

      // Should not throw
      await expect(
        ingestRepoExecutionResults(ctx, results)
      ).resolves.toBeUndefined();

      // Only the second entry should have triggered a transaction
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
    });

    it("does not call ensurePrLinkageRecords when the artifact is not found for a success entry", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [
        makeSuccessResult({
          fullName: "org/repo-artifact-missing",
          prNumber: 1,
          prUrl: "https://github.com/org/repo-artifact-missing/pull/1",
        }),
        makeSuccessResult({
          fullName: "org/repo-ok",
          prNumber: 2,
          prUrl: "https://github.com/org/repo-ok/pull/2",
        }),
      ];

      let repoLookupCount = 0;
      mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
        repoLookupCount++;
        return callback({
          gitHubInstallationRepository: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: `install-repo-${repoLookupCount}` }),
          },
        });
      });

      const missingArtifactTx = makeIngestionSuccessMockTx();
      missingArtifactTx.document.findUnique.mockResolvedValue(null);
      const successTx = makeIngestionSuccessMockTx();

      let txCallCount = 0;
      mockWithDb.tx = vi
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) => {
          txCallCount++;
          const tx = txCallCount === 1 ? missingArtifactTx : successTx;
          return callback(tx);
        });

      await expect(
        ingestRepoExecutionResults(ctx, results)
      ).resolves.toBeUndefined();

      expect(mockWithDb.tx).toHaveBeenCalledTimes(2);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledWith(
        successTx,
        expect.objectContaining({
          prNumber: 2,
          prUrl: "https://github.com/org/repo-ok/pull/2",
        })
      );
      expect(missingArtifactTx.workstreamEvent.create).not.toHaveBeenCalled();
    });

    it("does not abort remaining entries when ingestSuccessEntry throws for one entry", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [
        makeSuccessResult({
          fullName: "org/repo-throws",
          prNumber: 1,
          prUrl: "https://github.com/org/repo-throws/pull/1",
        }),
        makeSuccessResult({
          fullName: "org/repo-ok",
          prNumber: 2,
          prUrl: "https://github.com/org/repo-ok/pull/2",
        }),
      ];

      let callCount = 0;
      mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
        callCount++;
        return callback({
          gitHubInstallationRepository: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: `install-${callCount}` }),
          },
        });
      });

      let txCallCount = 0;
      mockWithDb.tx = vi
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) => {
          txCallCount++;
          if (txCallCount === 1) {
            throw new Error("DB transaction failed");
          }
          return callback(makeIngestionSuccessMockTx());
        });

      // Should not throw despite the first entry failing
      await expect(
        ingestRepoExecutionResults(ctx, results)
      ).resolves.toBeUndefined();

      // Second entry still processed
      expect(mockWithDb.tx).toHaveBeenCalledTimes(2);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Code judges report processed once outside the per-repo loop
  // -------------------------------------------------------------------------

  describe("code judges report", () => {
    it("calls upsertEvaluationWithJudgeScores exactly once regardless of repo count", async () => {
      const ctx = makeIngestionCtx();
      const codeJudgesReport = makeCodeJudgesReport();
      const results: RepoExecutionResult[] = [
        makeSuccessResult({
          fullName: "org/repo-a",
          prUrl: "https://github.com/org/repo-a/pull/1",
          prNumber: 1,
        }),
        makeSuccessResult({
          fullName: "org/repo-b",
          prUrl: "https://github.com/org/repo-b/pull/2",
          prNumber: 2,
        }),
      ];

      // withDb (non-tx) for repo lookups — two repos found
      let dbCallCount = 0;
      mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
        dbCallCount++;
        return callback({
          gitHubInstallationRepository: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: `install-repo-${dbCallCount}` }),
          },
        });
      });

      // withDb.tx for per-entry transactions and code judges report persistence
      mockWithDb.tx = vi
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) =>
          callback(makeIngestionSuccessMockTx())
        );

      await ingestRepoExecutionResults(ctx, results, { codeJudgesReport });

      // upsertEvaluationWithJudgeScores must be called exactly once
      expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledTimes(1);
      expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "doc-1",
          organizationId: "org-1",
          loopId: "loop-1",
          actionRunId: "action-run-1",
          report: codeJudgesReport,
        })
      );
    });

    it("does not call upsertEvaluationWithJudgeScores when codeJudgesReport is null", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [makeSuccessResult()];

      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-1" }),
        },
      });
      mockWithDbTx(makeIngestionSuccessMockTx());

      await ingestRepoExecutionResults(ctx, results, {
        codeJudgesReport: null,
      });

      expect(mockUpsertEvaluationWithJudgeScores).not.toHaveBeenCalled();
    });

    it("persists code judges report before per-repo loop when report is supplied", async () => {
      const ctx = makeIngestionCtx();
      const codeJudgesReport = makeCodeJudgesReport();
      const results: RepoExecutionResult[] = [makeSuccessResult()];

      const callOrder: string[] = [];

      mockUpsertEvaluationWithJudgeScores.mockImplementation(() => {
        callOrder.push("upsertEvaluation");
        return Promise.resolve(undefined);
      });

      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-1" }),
        },
      });

      const mockTx = makeIngestionSuccessMockTx();
      const originalCreate = mockTx.workstreamEvent.create;
      mockTx.workstreamEvent.create = vi.fn().mockImplementation((...args) => {
        callOrder.push("workstreamEvent.create");
        return originalCreate(...args);
      });

      // withDb.tx is invoked twice:
      //  1. By ingestRepoExecutionResults itself to persist the code judges
      //     report (when opts.tx is not provided).
      //     upsertEvaluationWithJudgeScores is mocked here and does NOT
      //     call withDb.tx — it accepts tx as a parameter in real code.
      //  2. By ingestSuccessEntry for the per-repo PR/linkage writes.
      mockWithDb.tx = vi
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) => {
          return callback(mockTx);
        });

      await ingestRepoExecutionResults(ctx, results, { codeJudgesReport });

      const evalIdx = callOrder.indexOf("upsertEvaluation");
      const eventIdx = callOrder.indexOf("workstreamEvent.create");

      expect(evalIdx).toBeGreaterThanOrEqual(0);
      expect(eventIdx).toBeGreaterThanOrEqual(0);
      // Code judges report must be processed before the per-repo workstream event
      expect(evalIdx).toBeLessThan(eventIdx);
    });
  });

  // -------------------------------------------------------------------------
  // upsertFromSnapshot is always called (even with empty/null snapshot)
  // -------------------------------------------------------------------------

  describe("prompts snapshot", () => {
    it("calls upsertFromSnapshot with organizationId and null when no snapshot is provided", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [];

      await ingestRepoExecutionResults(ctx, results);

      expect(mockUpsertFromSnapshot).toHaveBeenCalledWith("org-1", null);
    });

    it("calls upsertFromSnapshot with the provided snapshot", async () => {
      const ctx = makeIngestionCtx();
      const results: RepoExecutionResult[] = [];
      const promptsSnapshot = {
        prompts: [
          {
            promptType: "AGENT" as const,
            name: "executor",
            description: "Executor agent",
            model: "claude-opus-4-6",
            tools: ["bash"],
            filePath: "agents-snapshot/executor.md",
            content: "Execute the given tasks.",
          },
        ],
      };

      await ingestRepoExecutionResults(ctx, results, { promptsSnapshot });

      expect(mockUpsertFromSnapshot).toHaveBeenCalledWith(
        "org-1",
        promptsSnapshot
      );
    });
  });
});
