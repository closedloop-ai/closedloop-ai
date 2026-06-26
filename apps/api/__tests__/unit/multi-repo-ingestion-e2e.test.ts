/**
 * Integration-level tests for the end-to-end chain:
 *   parseExecutionResultFile (v2 payload) → ingestRepoExecutionResults
 *
 * Tests:
 * - result.results from v2 parse fed into ingestRepoExecutionResults: only the
 *   success entry triggers DB writes; failed/skipped entries do not
 * - DB operations flow correctly through the full chain (findFirst, PR upsert, linkage records)
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

// ---------------------------------------------------------------------------
// Mocks — must be declared before module imports
// ---------------------------------------------------------------------------

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import("../fixtures/mock-modules");
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import("../fixtures/mock-modules");
  return createLogMockModule();
});

vi.mock("@/lib/loops/loop-document-ingestion", async () => {
  const { createLoopDocumentIngestionMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createLoopDocumentIngestionMockModule();
});

vi.mock("@/lib/pr-linkage", async () => {
  const { createPrLinkageMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createPrLinkageMockModule();
});

vi.mock("@/lib/prompts-service", async () => {
  const { createPromptsServiceMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createPromptsServiceMockModule();
});

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { parseExecutionResultFile } from "@repo/api/src/types/loop";
import { ingestRepoExecutionResults } from "@/lib/loops/ingest-repo-execution-results";
import { ensurePrLinkageRecords } from "@/lib/pr-linkage";
import {
  e2eIngestionCtxDefaults,
  makeFailedResult,
  makeIngestionCtx,
  makeIngestionSuccessMockTx,
  makeSkippedResult,
  makeSuccessResult,
} from "../fixtures/ingestion-helpers";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockWithDb = getMockWithDb();
const mockEnsurePrLinkageRecords = ensurePrLinkageRecords as unknown as Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a v2 multi-repo execution result payload with three entries:
 * one success, one failed, one skipped.
 */
function makeV2Payload() {
  return {
    schemaVersion: 2,
    results: [
      makeSuccessResult({
        fullName: "org/repo-success",
        prUrl: "https://github.com/org/repo-success/pull/100",
        prNumber: 100,
        prTitle: "Closedloop: success feature",
        branchName: "symphony/success-feature",
        commitSha: "abc123def456",
        githubId: 9001,
      }),
      makeFailedResult(
        "org/repo-failed",
        "Execution failed: command exited with code 1"
      ),
      makeSkippedResult("org/repo-skipped"),
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
  // End-to-end chain: v2 parse → ingestRepoExecutionResults
  // -------------------------------------------------------------------------

  describe("full chain: v2 parse → ingest", () => {
    it("only the success entry triggers DB writes; failed/skipped entries do not", async () => {
      const payload = makeV2Payload();
      const parsed = parseExecutionResultFile(payload);

      expect(parsed.ok).toBe(true);
      if (parsed.ok !== true) {
        return;
      }

      const ctx = makeIngestionCtx({}, e2eIngestionCtxDefaults);

      // withDb (non-tx) returns the installation repo for the success entry
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-success" }),
        },
      });

      // withDb.tx runs the per-entry transaction for the success entry
      const mockTx = makeIngestionSuccessMockTx({ preset: "e2e" });
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, parsed.results);

      // Only the success entry triggers a transaction and a linkage write
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
    });

    it("success entry produces linkage records with correct PR details from v2 payload", async () => {
      const payload = makeV2Payload();
      const parsed = parseExecutionResultFile(payload);

      expect(parsed.ok).toBe(true);
      if (parsed.ok !== true) {
        return;
      }

      const ctx = makeIngestionCtx({}, e2eIngestionCtxDefaults);

      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-success" }),
        },
      });

      const mockTx = makeIngestionSuccessMockTx({ preset: "e2e" });
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, parsed.results);

      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          organizationId: "org-e2e",
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
      if (parsed.ok !== true) {
        return;
      }

      const ctx = makeIngestionCtx({}, e2eIngestionCtxDefaults);

      // Only one DB lookup for the single success entry
      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-success" }),
        },
      });

      const mockTx = makeIngestionSuccessMockTx({ preset: "e2e" });
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, parsed.results);

      // withDb (non-tx) called exactly once — only the success entry triggers a lookup
      expect(mockWithDb).toHaveBeenCalledTimes(1);
      // withDb.tx called exactly once — only the success entry gets a transaction
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      // Linkage records created exactly once — only for the success entry
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(1);
    });

    it("does not emit a workstream event for the success entry", async () => {
      const payload = makeV2Payload();
      const parsed = parseExecutionResultFile(payload);

      expect(parsed.ok).toBe(true);
      if (parsed.ok !== true) {
        return;
      }

      const ctx = makeIngestionCtx({}, e2eIngestionCtxDefaults);

      mockWithDbCall({
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-success" }),
        },
      });

      const mockTx = makeIngestionSuccessMockTx({ preset: "e2e" });
      mockWithDbTx(mockTx);

      await ingestRepoExecutionResults(ctx, parsed.results);

      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });
});
