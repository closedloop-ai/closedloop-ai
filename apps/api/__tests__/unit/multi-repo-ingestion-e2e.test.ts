/**
 * Integration-level tests for the end-to-end chain:
 *   parseExecutionResultFile (v2 payload) → ingestRepoExecutionResults
 *
 * Tests:
 * - parseExecutionResultFile with a v2 multi-repo payload returns ok, schemaVersion 2, repoCount 3
 * - result.results from v2 parse fed into ingestRepoExecutionResults: only the
 *   success entry triggers DB writes; failed/skipped entries do not
 * - DB operations flow correctly through the full chain (findFirst, PR upsert, linkage records)
 */

import type { RepoExecutionResult } from "@closedloop-ai/loops-api/execution-result";
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

import { parseExecutionResultFile } from "@closedloop-ai/loops-api/execution-result";
import type { Mock } from "vitest";
import type { IngestionContext } from "@/lib/loops/ingest-repo-execution-results";
import { ingestRepoExecutionResults } from "@/lib/loops/ingest-repo-execution-results";
import { ensurePrLinkageRecords } from "@/lib/pr-linkage";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockWithDb = getMockWithDb();
const mockEnsurePrLinkageRecords = ensurePrLinkageRecords as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<IngestionContext> = {}): IngestionContext {
  return {
    organizationId: "org-e2e",
    workstreamId: "ws-e2e",
    documentId: "doc-e2e",
    loopId: "loop-e2e",
    correlationId: "corr-e2e",
    actionRunId: "action-run-e2e",
    ...overrides,
  };
}

/**
 * Build the mock TX object used inside withDb.tx for ingestSuccessEntry.
 */
function makeSuccessMockTx(documentId = "doc-e2e") {
  return {
    document: {
      findUnique: vi.fn().mockResolvedValue({
        organizationId: "org-e2e",
        projectId: "project-e2e",
        slug: "my-artifact",
      }),
    },
    gitHubPullRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "pr-e2e-1", documentId }),
      update: vi.fn().mockResolvedValue({ id: "pr-e2e-1", documentId }),
    },
    workstreamEvent: {
      create: vi.fn().mockResolvedValue({ id: "event-e2e-1" }),
    },
  };
}

/**
 * Build a v2 multi-repo execution result payload with three entries:
 * one success, one failed, one skipped.
 */
function makeV2Payload() {
  return {
    schemaVersion: 2,
    results: [
      {
        status: "success",
        fullName: "org/repo-success",
        prUrl: "https://github.com/org/repo-success/pull/100",
        prNumber: 100,
        prTitle: "Symphony: success feature",
        branchName: "symphony/success-feature",
        baseBranch: "main",
        hasChanges: true,
        commitSha: "abc123def456",
        githubId: 9001,
      },
      {
        status: "failed",
        fullName: "org/repo-failed",
        error: "Execution failed: command exited with code 1",
      },
      {
        status: "skipped",
        fullName: "org/repo-skipped",
        reason: "no_changes",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseExecutionResultFile + ingestRepoExecutionResults (end-to-end chain)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // parseExecutionResultFile v2 payload assertions
  // -------------------------------------------------------------------------

  describe("parseExecutionResultFile with v2 payload", () => {
    it("returns ok=true, schemaVersion=2, repoCount=3 for a valid v2 payload", () => {
      const payload = makeV2Payload();
      const result = parseExecutionResultFile(payload);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.schemaVersion).toBe(2);
      expect(result.repoCount).toBe(3);
    });

    it("returns three entries with correct statuses in results", () => {
      const payload = makeV2Payload();
      const result = parseExecutionResultFile(payload);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const statuses = result.results.map((r) => r.status);
      expect(statuses).toEqual(["success", "failed", "skipped"]);
    });

    it("normalizes the success entry fields correctly from v2 payload", () => {
      const payload = makeV2Payload();
      const result = parseExecutionResultFile(payload);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const successEntry = result.results[0] as RepoExecutionResult & {
        status: "success";
      };
      expect(successEntry.status).toBe("success");
      expect(successEntry.fullName).toBe("org/repo-success");
      expect(successEntry.prNumber).toBe(100);
      expect(successEntry.prUrl).toBe(
        "https://github.com/org/repo-success/pull/100"
      );
      expect(successEntry.branchName).toBe("symphony/success-feature");
      expect(successEntry.baseBranch).toBe("main");
      expect(successEntry.commitSha).toBe("abc123def456");
      expect(successEntry.githubId).toBe(9001);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end chain: v2 parse → ingestRepoExecutionResults
  // -------------------------------------------------------------------------

  describe("full chain: v2 parse → ingest", () => {
    it("only the success entry triggers DB writes; failed/skipped entries do not", async () => {
      const payload = makeV2Payload();
      const parsed = parseExecutionResultFile(payload);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }

      const ctx = makeCtx();

      // withDb (non-tx) returns the installation repo for the success entry
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-success" }),
        },
      });

      // withDb.tx runs the per-entry transaction for the success entry
      const mockTx = makeSuccessMockTx();
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, parsed.results);

      // Only the success entry triggers a transaction and PR upsert
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.gitHubPullRequest.upsert).toHaveBeenCalledTimes(1);
    });

    it("success entry produces linkage records with correct PR details from v2 payload", async () => {
      const payload = makeV2Payload();
      const parsed = parseExecutionResultFile(payload);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }

      const ctx = makeCtx();

      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-success" }),
        },
      });

      const mockTx = makeSuccessMockTx();
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, parsed.results);

      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          organizationId: "org-e2e",
          workstreamId: "ws-e2e",
          documentId: "doc-e2e",
          prUrl: "https://github.com/org/repo-success/pull/100",
          prNumber: 100,
        })
      );
    });

    it("failed and skipped entries do not trigger DB calls (withDb.tx not called for them)", async () => {
      const payload = makeV2Payload();
      const parsed = parseExecutionResultFile(payload);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }

      const ctx = makeCtx();

      // Only one DB lookup for the single success entry
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-success" }),
        },
      });

      const mockTx = makeSuccessMockTx();
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, parsed.results);

      // withDb (non-tx) called exactly once — only the success entry triggers a lookup
      expect(mockWithDb).toHaveBeenCalledTimes(1);
      // withDb.tx called exactly once — only the success entry gets a transaction
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      // Linkage records created exactly once — only for the success entry
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
    });

    it("workstream event is created for the success entry with correct data", async () => {
      const payload = makeV2Payload();
      const parsed = parseExecutionResultFile(payload);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }

      const ctx = makeCtx();

      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-success" }),
        },
      });

      const mockTx = makeSuccessMockTx();
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, parsed.results);

      expect(mockTx.workstreamEvent.create).toHaveBeenCalledTimes(1);
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workstreamId: "ws-e2e",
            type: "GITHUB_PR_CREATED",
            data: expect.objectContaining({
              prNumber: 100,
              prUrl: "https://github.com/org/repo-success/pull/100",
              fullName: "org/repo-success",
            }),
          }),
        })
      );
    });
  });
});
