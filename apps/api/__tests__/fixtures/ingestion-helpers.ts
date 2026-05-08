import type { RepoExecutionResult } from "@closedloop-ai/loops-api/execution-result";
import { EvalStatus, type JudgesReport } from "@repo/api/src/types/evaluation";
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { IngestionContext } from "@/lib/loops/ingest-repo-execution-results";

/**
 * Test alias for the production ingestion context.
 */

/** Default IDs for unit tests (ingest-repo-execution-results, etc.) */
export const unitIngestionCtxDefaults: IngestionContext = {
  organizationId: "org-1",
  workstreamId: "ws-1",
  documentId: "doc-1",
  loopId: "loop-1",
  correlationId: "corr-1",
  actionRunId: "action-run-1",
};

/** Default IDs for multi-repo E2E-style tests */
export const e2eIngestionCtxDefaults: IngestionContext = {
  organizationId: "org-e2e",
  workstreamId: "ws-e2e",
  documentId: "doc-e2e",
  loopId: "loop-e2e",
  correlationId: "corr-e2e",
  actionRunId: "action-run-e2e",
};

/**
 * Build an {@link IngestionContext} for tests. Defaults to unit IDs; pass
 * {@link e2eIngestionCtxDefaults} as the second arg for E2E-style fixtures.
 */
export function makeIngestionCtx(
  overrides: Partial<IngestionContext> = {},
  base: IngestionContext = unitIngestionCtxDefaults
): IngestionContext {
  return { ...base, ...overrides };
}

export function makeSuccessResult(
  overrides: Partial<RepoExecutionResult & { status: "success" }> = {}
): RepoExecutionResult & { status: "success" } {
  return {
    status: "success",
    fullName: "org/repo",
    prUrl: "https://github.com/org/repo/pull/42",
    prNumber: 42,
    prTitle: "ClosedLoop: feature",
    branchName: "symphony/feature",
    baseBranch: "main",
    hasChanges: true,
    commitSha: "abc123",
    githubId: 999,
    ...overrides,
  };
}

export function makeFailedResult(
  fullName = "org/repo-failed",
  error = "execution failed"
): RepoExecutionResult & { status: "failed" } {
  return { status: "failed", fullName, error };
}

export function makeSkippedResult(
  fullName = "org/repo-skipped",
  reason = "no_changes"
): RepoExecutionResult & { status: "skipped" } {
  return { status: "skipped", fullName, reason };
}

export function makeJudgesReport(
  overrides: string | Partial<JudgesReport> = {}
): JudgesReport {
  const normalizedOverrides =
    typeof overrides === "string" ? { report_id: overrides } : overrides;
  return {
    report_id: "report-1",
    timestamp: "2026-01-01T00:00:00Z",
    stats: [
      {
        type: "case_score",
        case_id: "test-judge",
        final_status: EvalStatus.Passed,
        metrics: [
          {
            metric_name: "test_score",
            threshold: 0.8,
            score: 0.95,
            justification: "Test passed",
          },
        ],
      },
    ],
    ...normalizedOverrides,
  };
}

export function makeCodeJudgesReport(
  overrides: Partial<JudgesReport> = {}
): JudgesReport {
  return makeJudgesReport({
    report_id: "report-code-1",
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
    ...overrides,
  });
}

type IngestionMockTxValues = {
  documentId: string;
  organizationId: string;
  projectId: string;
  eventId: string;
};

export type IngestionSuccessMockTxOptions = Partial<IngestionMockTxValues> & {
  /** Which ID bundle to use before applying overrides */
  preset?: "unit" | "e2e";
};

const TX_UNIT: IngestionMockTxValues = {
  documentId: "doc-1",
  organizationId: "org-1",
  projectId: "project-1",
  eventId: "event-1",
};

const TX_E2E: IngestionMockTxValues = {
  documentId: "doc-e2e",
  organizationId: "org-e2e",
  projectId: "project-e2e",
  eventId: "event-e2e-1",
};

function txPreset(p: "unit" | "e2e"): IngestionMockTxValues {
  return p === "e2e" ? TX_E2E : TX_UNIT;
}

export type IngestionSuccessMockTx = {
  artifact: { findUnique: Mock };
  workstreamEvent: { create: Mock };
};

/**
 * Mock Prisma client fragment used inside `withDb.tx` for successful repo
 * ingestion. The first parameter may be a `documentId` string (unit preset)
 * or an options object; use `{ preset: "e2e" }` for E2E default IDs.
 *
 * The new ingestion path delegates PR creation to `ensurePrLinkageRecords`
 * (mocked separately by callers), so this mock only needs to cover the
 * source-artifact lookup and the workstream event write.
 */
export function makeIngestionSuccessMockTx(
  arg?: string | IngestionSuccessMockTxOptions
): IngestionSuccessMockTx {
  let v: IngestionMockTxValues;
  if (typeof arg === "string") {
    v = { ...TX_UNIT, documentId: arg };
  } else {
    const preset = arg?.preset ?? "unit";
    const { preset: _p, ...overrides } = arg ?? {};
    v = { ...txPreset(preset), ...overrides };
  }
  const { organizationId, projectId, eventId } = v;

  return {
    artifact: {
      findUnique: vi.fn().mockResolvedValue({
        organizationId,
        projectId,
        slug: "my-artifact",
      }),
    },
    workstreamEvent: {
      create: vi.fn().mockResolvedValue({ id: eventId }),
    },
  };
}
