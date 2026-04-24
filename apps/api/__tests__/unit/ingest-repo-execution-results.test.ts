/**
 * Unit tests for ingestRepoExecutionResults in
 * apps/api/lib/loops/ingest-repo-execution-results.ts
 *
 * Tests are expressed as scenarios driven through a single harness
 * ({@link runScenario}) that wires repo lookups and per-entry transactions,
 * invokes the ingester, and asserts on the observable side effects
 * (tx count, linkage count + args, evaluation report, prompts snapshot,
 * relative call ordering).
 */

import type { RepoExecutionResult } from "@closedloop-ai/loops-api/execution-result";
import { vi } from "vitest";
import { getMockWithDb } from "../utils/db-helpers";

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

import type { Mock } from "vitest";
import { ingestRepoExecutionResults } from "@/lib/loops/ingest-repo-execution-results";
import { upsertEvaluationWithJudgeScores } from "@/lib/loops/loop-document-ingestion";
import { ensurePrLinkageRecords } from "@/lib/pr-linkage";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import {
  makeCodeJudgesReport,
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
const mockUpsertEvaluationWithJudgeScores =
  upsertEvaluationWithJudgeScores as unknown as Mock;
const mockEnsurePrLinkageRecords = ensurePrLinkageRecords as unknown as Mock;
const mockUpsertFromSnapshot = upsertFromSnapshot as unknown as Mock;

// ---------------------------------------------------------------------------
// Scenario harness
// ---------------------------------------------------------------------------

type TxBehavior =
  | { kind: "success" }
  | { kind: "missingArtifact" }
  | { kind: "throw"; error: string };

type ScenarioExpect = {
  txCalls?: number;
  linkageCalls?: number;
  /** Matched against the Nth call via objectContaining. */
  linkageArgs?: Record<string, unknown>[];
  evaluationCalls?: number;
  evaluationArgs?: Record<string, unknown>;
  promptsSnapshotArgs?: [string, unknown];
  /** Assert upsertEvaluation ran before the per-repo workstreamEvent.create. */
  assertEvalBeforeWorkstreamEvent?: boolean;
};

type Scenario = {
  name: string;
  results: RepoExecutionResult[];
  /** One entry per withDb() call in order. null = repo not found. */
  repoLookups?: Array<null | { id: string }>;
  /** One entry per withDb.tx() call in order. Defaults to all "success". */
  txBehaviors?: TxBehavior[];
  options?: Parameters<typeof ingestRepoExecutionResults>[2];
  expect: ScenarioExpect;
};

type HarnessResult = { callOrder: readonly string[] };

async function invokeScenario(s: Scenario): Promise<HarnessResult> {
  const ctx = makeIngestionCtx();

  const lookups =
    s.repoLookups ??
    s.results
      .filter((r) => r.status === "success")
      .map((_, i) => ({ id: `install-repo-${i + 1}` }));
  let dbIdx = 0;
  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      gitHubInstallationRepository: {
        findFirst: vi.fn().mockResolvedValue(lookups[dbIdx++] ?? null),
      },
    })
  );

  const behaviors = s.txBehaviors ?? [];
  const callOrder: string[] = [];
  let txIdx = 0;

  mockWithDb.tx = vi
    .fn()
    .mockImplementation((callback: (tx: unknown) => unknown) => {
      const behavior = behaviors[txIdx++] ?? { kind: "success" as const };
      if (behavior.kind === "throw") {
        throw new Error(behavior.error);
      }
      const tx = makeIngestionSuccessMockTx();
      if (behavior.kind === "missingArtifact") {
        tx.document.findUnique.mockResolvedValue(null);
      }
      if (s.expect.assertEvalBeforeWorkstreamEvent) {
        const originalCreate = tx.workstreamEvent.create;
        tx.workstreamEvent.create = vi.fn((...args: unknown[]) => {
          callOrder.push("workstreamEvent.create");
          return originalCreate(...args);
        });
      }
      return callback(tx);
    });

  if (s.expect.assertEvalBeforeWorkstreamEvent) {
    mockUpsertEvaluationWithJudgeScores.mockImplementation(() => {
      callOrder.push("upsertEvaluation");
      return Promise.resolve(undefined);
    });
  }

  await ingestRepoExecutionResults(ctx, s.results, s.options);
  return { callOrder };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const codeJudgesReport = makeCodeJudgesReport();

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

const scenarios: Scenario[] = [
  {
    name: "single success entry → PR upsert + linkage record",
    results: [makeSuccessResult()],
    expect: {
      txCalls: 1,
      linkageCalls: 1,
      linkageArgs: [
        {
          organizationId: "org-1",
          workstreamId: "ws-1",
          documentId: "doc-1",
          prUrl: "https://github.com/org/repo/pull/42",
          prNumber: 42,
        },
      ],
    },
  },
  {
    name: "multi-repo success → one tx + linkage per entry",
    results: [
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
    ],
    expect: {
      txCalls: 2,
      linkageCalls: 2,
      linkageArgs: [
        { prNumber: 10, prUrl: "https://github.com/org/repo-a/pull/10" },
        { prNumber: 20, prUrl: "https://github.com/org/repo-b/pull/20" },
      ],
    },
  },
  {
    name: "mixed outcomes → only success entries touch the DB",
    results: [
      makeSuccessResult({
        fullName: "org/repo-ok",
        prNumber: 5,
        prUrl: "https://github.com/org/repo-ok/pull/5",
      }),
      makeFailedResult("org/repo-bad", "exec error"),
      makeSkippedResult("org/repo-skip", "no_changes"),
    ],
    expect: { txCalls: 1, linkageCalls: 1 },
  },
  {
    name: "repo lookup returns null → skip entry, continue with next",
    results: [
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
    ],
    repoLookups: [null, { id: "install-repo-found" }],
    expect: { txCalls: 1, linkageCalls: 1 },
  },
  {
    name: "artifact missing in tx → no linkage, continue with next entry",
    results: [
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
    ],
    txBehaviors: [{ kind: "missingArtifact" }, { kind: "success" }],
    expect: {
      txCalls: 2,
      linkageCalls: 1,
      linkageArgs: [
        { prNumber: 2, prUrl: "https://github.com/org/repo-ok/pull/2" },
      ],
    },
  },
  {
    name: "tx throws for one entry → remaining entries still processed",
    results: [
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
    ],
    txBehaviors: [
      { kind: "throw", error: "DB transaction failed" },
      { kind: "success" },
    ],
    expect: { txCalls: 2, linkageCalls: 1 },
  },
  {
    name: "code judges report → persisted once regardless of repo count",
    results: [
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
    ],
    options: { codeJudgesReport },
    expect: {
      evaluationCalls: 1,
      evaluationArgs: {
        documentId: "doc-1",
        organizationId: "org-1",
        loopId: "loop-1",
        actionRunId: "action-run-1",
        report: codeJudgesReport,
      },
    },
  },
  {
    name: "code judges report null → no evaluation persisted",
    results: [makeSuccessResult()],
    options: { codeJudgesReport: null },
    expect: { evaluationCalls: 0 },
  },
  {
    name: "code judges report persisted before per-repo workstreamEvent",
    results: [makeSuccessResult()],
    options: { codeJudgesReport },
    expect: { assertEvalBeforeWorkstreamEvent: true },
  },
  {
    name: "prompts snapshot: null when not provided",
    results: [],
    expect: { promptsSnapshotArgs: ["org-1", null] },
  },
  {
    name: "prompts snapshot: passed through when provided",
    results: [],
    options: { promptsSnapshot },
    expect: { promptsSnapshotArgs: ["org-1", promptsSnapshot] },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestRepoExecutionResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(scenarios)("$name", async (s) => {
    const { callOrder } = await invokeScenario(s);
    const e = s.expect;

    if (e.txCalls !== undefined) {
      expect(mockWithDb.tx).toHaveBeenCalledTimes(e.txCalls);
    }
    if (e.linkageCalls !== undefined) {
      expect(mockEnsurePrLinkageRecords).toHaveBeenCalledTimes(e.linkageCalls);
    }
    if (e.linkageArgs) {
      e.linkageArgs.forEach((args, i) => {
        expect(mockEnsurePrLinkageRecords).toHaveBeenNthCalledWith(
          i + 1,
          expect.anything(),
          expect.objectContaining(args)
        );
      });
    }
    if (e.evaluationCalls !== undefined) {
      expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledTimes(
        e.evaluationCalls
      );
    }
    if (e.evaluationArgs) {
      expect(mockUpsertEvaluationWithJudgeScores).toHaveBeenCalledWith(
        expect.objectContaining(e.evaluationArgs)
      );
    }
    if (e.promptsSnapshotArgs) {
      expect(mockUpsertFromSnapshot).toHaveBeenCalledWith(
        ...e.promptsSnapshotArgs
      );
    }
    if (e.assertEvalBeforeWorkstreamEvent) {
      const evalIdx = callOrder.indexOf("upsertEvaluation");
      const eventIdx = callOrder.indexOf("workstreamEvent.create");
      expect(evalIdx).toBeGreaterThanOrEqual(0);
      expect(eventIdx).toBeGreaterThanOrEqual(0);
      expect(evalIdx).toBeLessThan(eventIdx);
    }
  });
});
