/**
 * Unit tests for prompts integration in loop command handlers.
 *
 * Tests cover:
 * - downloadPlanArtifacts(): markdown entries under agents-snapshot/ are parsed as primary source
 * - downloadPlanArtifacts(): returns promptsSnapshot: null when markdown entries are absent
 * - downloadPlanArtifacts(): null inputs return promptsSnapshot: null without failing
 * - ingestPlanArtifacts(): upsertFromSnapshot called before judgesReport writes
 * - ingestExecutionArtifacts(): upsertFromSnapshot called before code judges report writes
 * - null snapshot: upsertFromSnapshot is called with null and does not throw
 */

import type { Loop } from "@repo/api/src/types/loop";
import { vi } from "vitest";

// --- Mocks (must come before imports of the module under test) ---

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import("../fixtures/mock-modules");
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import("../fixtures/mock-modules");
  return createLogMockModule();
});

vi.mock("@/lib/prompts-service", async () => {
  const { createPromptsServiceMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createPromptsServiceMockModule();
});

vi.mock("@/app/documents/document-version-service", () => ({
  documentVersionService: {
    createVersion: vi.fn().mockResolvedValue({ id: "version-1", version: 2 }),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/app/documents/room-utils", () => ({
  resetDocumentRoom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/judge-score-fanout", () => ({
  fanOutJudgeScores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
  downloadPromptSnapshotMarkdownEntries: vi.fn(),
}));

vi.mock("@/lib/pr-linkage", async () => {
  const { createPrLinkageMockModule } = await import(
    "../fixtures/mock-modules"
  );
  return createPrLinkageMockModule();
});

vi.mock("@/lib/entity-validation", () => ({
  assertEntityInOrganization: vi.fn().mockResolvedValue(undefined),
}));

// --- Imports (after mocks) ---

import { EntityType } from "@repo/api/src/types/entity-link";
import { withDb } from "@repo/database";
import type { Mock } from "vitest";
import { assertEntityInOrganization } from "@/lib/entity-validation";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import {
  downloadExecutionArtifacts,
  executionArtifactsFromUpload,
  ingestExecutionArtifacts,
} from "@/lib/loops/loop-commands/execute-handler";
import {
  downloadPlanArtifacts,
  ingestPlanArtifacts,
} from "@/lib/loops/loop-commands/plan-handler";
import { upsertEvaluationWithJudgeScores } from "@/lib/loops/loop-document-ingestion";
import {
  downloadArtifactFile,
  downloadPromptSnapshotMarkdownEntries,
} from "@/lib/loops/loop-state";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import { makeJudgesReport } from "../fixtures/ingestion-helpers";
import { buildLoop } from "../fixtures/loop";

const mockDownloadArtifactFile = downloadArtifactFile as unknown as Mock;
const mockDownloadPromptSnapshotMarkdownEntries =
  downloadPromptSnapshotMarkdownEntries as unknown as Mock;
const mockFanOutJudgeScores = fanOutJudgeScores as unknown as Mock;
const mockUpsertFromSnapshot = upsertFromSnapshot as unknown as Mock;
const mockWithDb = withDb as unknown as Mock & { tx: Mock };
const mockAssertEvaluationEntityInOrganization =
  assertEntityInOrganization as unknown as Mock;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "org-test-123";
const ARTIFACT_ID = "artifact-test-123";
const LOOP_ID = "loop-test-123";
const WORKSTREAM_ID = "ws-test-123";
const STATE_KEY_PREFIX = `${ORG_ID}/loops/${LOOP_ID}/run-1`;

function makeLoop(overrides: Partial<Loop> = {}): Loop {
  return buildLoop({
    id: LOOP_ID,
    organizationId: ORG_ID,
    documentId: ARTIFACT_ID,
    workstreamId: WORKSTREAM_ID,
    s3StateKey: STATE_KEY_PREFIX,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  });
}

function mockExecutionDownloadArtifacts(
  executionResult: unknown,
  codeJudgesReport: unknown = null
): void {
  mockDownloadArtifactFile.mockImplementation(
    (_stateKeyPrefix: string, artifactName: string) => {
      if (artifactName === "execution-result.json") {
        return Promise.resolve(Buffer.from(JSON.stringify(executionResult)));
      }
      if (artifactName === "code-judges.json" && codeJudgesReport !== null) {
        return Promise.resolve(Buffer.from(JSON.stringify(codeJudgesReport)));
      }
      return Promise.resolve(null);
    }
  );
  mockDownloadPromptSnapshotMarkdownEntries.mockResolvedValue([]);
}

// ---------------------------------------------------------------------------
// downloadPlanArtifacts — prompt snapshot parsing
// ---------------------------------------------------------------------------

describe("downloadPlanArtifacts — prompt snapshots", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("parses markdown entries from agents-snapshot as the primary source", async () => {
    const markdownContent = `---
name: my-agent
model: claude-3
description: An agent prompt
tools: bash, read
---

You are a helpful agent.
`;

    mockDownloadArtifactFile.mockResolvedValue(null);
    mockDownloadPromptSnapshotMarkdownEntries.mockResolvedValue([
      {
        name: "agents-snapshot/my-agent.md",
        data: Buffer.from(markdownContent, "utf-8"),
      },
    ]);

    const artifacts = await downloadPlanArtifacts(STATE_KEY_PREFIX);

    expect(artifacts.promptsSnapshot).not.toBeNull();
    expect(artifacts.promptsSnapshot?.prompts).toHaveLength(1);
    expect(artifacts.promptsSnapshot?.prompts[0]).toMatchObject({
      promptType: "AGENT",
      name: "my-agent",
      model: "claude-3",
      tools: ["bash", "read"],
      filePath: "agents-snapshot/my-agent.md",
      content: "You are a helpful agent.\n",
    });
  });

  it("returns promptsSnapshot: null when markdown entries are absent", async () => {
    mockDownloadArtifactFile.mockResolvedValue(null);
    mockDownloadPromptSnapshotMarkdownEntries.mockResolvedValue([]);

    const artifacts = await downloadPlanArtifacts(STATE_KEY_PREFIX);

    expect(artifacts.promptsSnapshot).toBeNull();
    expect(artifacts.planContent).toBeNull();
    expect(artifacts.judgesReport).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// downloadExecutionArtifacts — execution result parsing
// ---------------------------------------------------------------------------

describe("downloadExecutionArtifacts — execution result parsing", () => {
  const primaryRepo = "owner/primary";
  const otherRepo = "owner/other";
  const primaryLoop = makeLoop({
    repo: { fullName: primaryRepo, branch: "main" },
  });
  const primarySuccess = {
    status: "success" as const,
    fullName: primaryRepo,
    prUrl: "https://github.com/owner/primary/pull/42",
    prNumber: 42,
    branchName: "feat/primary",
    baseBranch: "main",
    hasChanges: true,
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("normalizes v1 execution results into a single success repo entry", async () => {
    const v1ExecutionResult = {
      has_changes: true,
      pr_url: "https://github.com/owner/primary/pull/42",
      pr_number: 42,
      pr_title: "Symphony: primary",
      branch_name: "feat/primary",
      base_ref: "main",
      github_id: 123,
      commit_sha: "abc123",
    };
    const codeJudgesReport = makeJudgesReport("code-report");
    mockExecutionDownloadArtifacts(v1ExecutionResult, codeJudgesReport);

    const artifacts = await downloadExecutionArtifacts(
      STATE_KEY_PREFIX,
      primaryLoop
    );

    expect(artifacts.codeJudgesReport).toEqual(codeJudgesReport);
    expect(artifacts.promptsSnapshot).toBeNull();
    expect(artifacts.executionResult).toHaveLength(1);
    expect(artifacts.executionResult?.[0]).toMatchObject({
      status: "success",
      fullName: primaryRepo,
      prNumber: 42,
      prUrl: "https://github.com/owner/primary/pull/42",
      branchName: "feat/primary",
      baseBranch: "main",
      prTitle: "Symphony: primary",
      commitSha: "abc123",
      githubId: 123,
    });
  });

  it("returns every repo entry from v2 execution results", async () => {
    const otherSuccess = {
      status: "success" as const,
      fullName: otherRepo,
      prUrl: "https://github.com/owner/other/pull/7",
      prNumber: 7,
      branchName: "feat/other",
      baseBranch: "main",
      hasChanges: true,
    };
    mockExecutionDownloadArtifacts({
      schemaVersion: 2,
      results: [otherSuccess, primarySuccess],
    });

    const artifacts = await downloadExecutionArtifacts(
      STATE_KEY_PREFIX,
      primaryLoop
    );

    expect(artifacts.executionResult).toEqual([otherSuccess, primarySuccess]);
  });

  it("preserves skipped and failed peer entries from v2 results", async () => {
    const results = [
      primarySuccess,
      {
        status: "skipped" as const,
        fullName: otherRepo,
        reason: "no_changes",
      },
      {
        status: "failed" as const,
        fullName: "owner/peer-c",
        error: "executor crashed",
      },
    ];
    mockExecutionDownloadArtifacts({ schemaVersion: 2, results });

    const artifacts = await downloadExecutionArtifacts(
      STATE_KEY_PREFIX,
      primaryLoop
    );

    expect(artifacts.executionResult).toEqual(results);
  });

  it("returns null executionResult when v2 envelope fails to parse", async () => {
    mockExecutionDownloadArtifacts({
      schemaVersion: 2,
      results: [{ status: "success", fullName: "owner/repo" }],
    });

    const artifacts = await downloadExecutionArtifacts(
      STATE_KEY_PREFIX,
      primaryLoop
    );

    expect(artifacts.executionResult).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executionArtifactsFromUpload — execution result validation
// ---------------------------------------------------------------------------

describe("executionArtifactsFromUpload — execution result validation", () => {
  const uploadLoop = makeLoop({
    repo: { fullName: "owner/repo", branch: "main" },
  });

  it("normalizes legacy v1 uploaded execution results", () => {
    const artifacts = executionArtifactsFromUpload(
      {
        executionResult: {
          has_changes: false,
          pr_url: "",
          pr_number: 0,
          branch_name: "",
          base_ref: "main",
          commit_sha: null,
        },
      },
      uploadLoop
    );

    expect(artifacts.executionResult).toEqual([
      { status: "skipped", fullName: "owner/repo", reason: "no_changes" },
    ]);
    expect(artifacts.codeJudgesReport).toBeNull();
    expect(artifacts.promptsSnapshot).toBeNull();
  });

  it("preserves v2 uploaded execution result entries", () => {
    const results = [
      {
        status: "failed" as const,
        fullName: "owner/repo",
        error: "executor crashed",
      },
    ];

    const artifacts = executionArtifactsFromUpload(
      {
        executionResult: { schemaVersion: 2, results },
      },
      uploadLoop
    );

    expect(artifacts.executionResult).toEqual(results);
  });

  it("fails invalid uploaded execution results before ingestion", () => {
    expect(() =>
      executionArtifactsFromUpload(
        {
          executionResult: {
            schemaVersion: 2,
            results: [{ status: "success" }],
          },
        },
        uploadLoop
      )
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ingestPlanArtifacts — upsertFromSnapshot call ordering
// ---------------------------------------------------------------------------

describe("ingestPlanArtifacts — upsertFromSnapshot ordering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls upsertFromSnapshot before the judgesReport withDb write", async () => {
    const loop = makeLoop();
    const judgesReport = makeJudgesReport("judges-report-plan");

    const callOrder: string[] = [];

    mockUpsertFromSnapshot.mockImplementation(() => {
      callOrder.push("upsertFromSnapshot");
      return Promise.resolve();
    });

    // withDb.tx is used for judgesReport writes.
    const mockArtifactEvaluationUpsert = vi.fn().mockImplementation(() => {
      callOrder.push("documentEvaluation.upsert");
      return Promise.resolve({ id: "eval-1" });
    });

    mockWithDb.tx = vi
      .fn()
      .mockImplementation((callback: (tx: unknown) => unknown) => {
        const tx = {
          documentEvaluation: {
            upsert: mockArtifactEvaluationUpsert,
          },
        };
        return callback(tx);
      });

    // withDb is used for artifact.update and workstreamEvent.
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        document: {
          update: vi.fn().mockResolvedValue({
            slug: "test-slug",
            latestVersion: 2,
          }),
        },
        workstreamEvent: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "event-1" }),
        },
      };
      return callback(db);
    });

    const artifacts = {
      planContent: "# Plan content",
      questionsContent: null,
      judgesReport,
      promptsSnapshot: {
        prompts: [
          {
            promptType: "AGENT" as const,
            name: "planner",
            description: "Planner agent",
            model: "claude-3",
            tools: [],
            filePath: "prompts/planner.md",
            content: "Plan the work.",
          },
        ],
      },
    };

    await ingestPlanArtifacts(loop, ORG_ID, artifacts);

    // upsertFromSnapshot must have been called before judgesReport upsert
    const upsertIdx = callOrder.indexOf("upsertFromSnapshot");
    const evalIdx = callOrder.indexOf("documentEvaluation.upsert");
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(evalIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeLessThan(evalIdx);
  });

  it("calls upsertFromSnapshot with null snapshot and does not throw", async () => {
    const loop = makeLoop();

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        document: {
          update: vi.fn().mockResolvedValue({
            slug: null,
            latestVersion: 2,
          }),
        },
        workstreamEvent: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "event-1" }),
        },
      };
      return callback(db);
    });

    const artifacts = {
      planContent: "# Plan content",
      questionsContent: null,
      judgesReport: null,
      promptsSnapshot: null,
    };

    // Should not throw
    await expect(
      ingestPlanArtifacts(loop, ORG_ID, artifacts)
    ).resolves.toBeUndefined();

    expect(mockUpsertFromSnapshot).toHaveBeenCalledWith(ORG_ID, null);
  });
});

// ---------------------------------------------------------------------------
// ingestExecutionArtifacts — upsertFromSnapshot call ordering
// ---------------------------------------------------------------------------

describe("ingestExecutionArtifacts — upsertFromSnapshot ordering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls upsertFromSnapshot before code judges report write", async () => {
    const loop = makeLoop({
      command: "EXECUTE",
      repo: { fullName: "org/repo", branch: "main" },
    });
    const codeJudgesReport = makeJudgesReport("code-judges-report-exec");

    const callOrder: string[] = [];

    mockUpsertFromSnapshot.mockImplementation(() => {
      callOrder.push("upsertFromSnapshot");
      return Promise.resolve();
    });

    const mockArtifactEvaluationUpsert = vi.fn().mockImplementation(() => {
      callOrder.push("documentEvaluation.upsert");
      return Promise.resolve({ id: "eval-exec-1" });
    });

    // withDb (non-tx) used for gitHubInstallationRepository lookup
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-1" }),
        },
      };
      return callback(db);
    });

    // withDb.tx used for the main transaction block
    mockWithDb.tx = vi
      .fn()
      .mockImplementation((callback: (tx: unknown) => unknown) => {
        callOrder.push("withDb.tx.callback");
        const tx = {
          document: {
            findUnique: vi.fn().mockResolvedValue({
              organizationId: ORG_ID,
              projectId: "project-1",
              slug: "test-artifact",
            }),
          },
          documentEvaluation: {
            upsert: mockArtifactEvaluationUpsert,
          },
          gitHubPullRequest: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "pr-1" }),
            upsert: vi
              .fn()
              .mockResolvedValue({ id: "pr-1", documentId: ARTIFACT_ID }),
          },
          externalLink: {
            create: vi.fn().mockResolvedValue({ id: "ext-link-1" }),
          },
          entityLink: {
            create: vi.fn().mockResolvedValue({ id: "entity-link-1" }),
          },
          workstreamEvent: {
            create: vi.fn().mockResolvedValue({ id: "event-exec-1" }),
          },
        };
        return callback(tx);
      });

    const artifacts = {
      executionResult: [
        {
          status: "success" as const,
          fullName: "org/repo",
          prUrl: "https://github.com/org/repo/pull/10",
          prNumber: 10,
          prTitle: "Symphony: test feature",
          branchName: "symphony/test-feature",
          baseBranch: "main",
          hasChanges: true,
          githubId: 999,
          commitSha: "abc123",
        },
      ],
      codeJudgesReport,
      promptsSnapshot: {
        prompts: [
          {
            promptType: "AGENT" as const,
            name: "executor",
            description: "Executor agent",
            model: "claude-3",
            tools: [],
            filePath: "prompts/executor.md",
            content: "Execute the work.",
          },
        ],
      },
    };

    await ingestExecutionArtifacts(loop, ORG_ID, artifacts);

    expect(mockFanOutJudgeScores).toHaveBeenCalledTimes(1);
    const upsertIdx = callOrder.indexOf("upsertFromSnapshot");
    const evalIdx = callOrder.indexOf("documentEvaluation.upsert");
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(evalIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeLessThan(evalIdx);
  });

  it("calls upsertFromSnapshot with null snapshot for execution artifacts and does not throw", async () => {
    const loop = makeLoop({
      command: "EXECUTE",
      repo: { fullName: "org/repo", branch: "main" },
    });

    // withDb (non-tx) used for gitHubInstallationRepository lookup
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        gitHubInstallationRepository: {
          findFirst: vi.fn().mockResolvedValue({ id: "install-repo-1" }),
        },
      };
      return callback(db);
    });

    mockWithDb.tx = vi
      .fn()
      .mockImplementation((callback: (tx: unknown) => unknown) => {
        const tx = {
          document: {
            findUnique: vi.fn().mockResolvedValue({
              organizationId: ORG_ID,
              projectId: "project-1",
              slug: "test-artifact",
            }),
          },
          gitHubPullRequest: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "pr-1" }),
            upsert: vi
              .fn()
              .mockResolvedValue({ id: "pr-1", documentId: ARTIFACT_ID }),
          },
          externalLink: {
            create: vi.fn().mockResolvedValue({ id: "ext-link-1" }),
          },
          entityLink: {
            create: vi.fn().mockResolvedValue({ id: "entity-link-1" }),
          },
          workstreamEvent: {
            create: vi.fn().mockResolvedValue({ id: "event-exec-1" }),
          },
        };
        return callback(tx);
      });

    const artifacts = {
      executionResult: [
        {
          status: "success" as const,
          fullName: "org/repo",
          prUrl: "https://github.com/org/repo/pull/11",
          prNumber: 11,
          prTitle: "Symphony: null snapshot test",
          branchName: "symphony/null-snapshot",
          baseBranch: "main",
          hasChanges: true,
          githubId: 1000,
          commitSha: "def456",
        },
      ],
      codeJudgesReport: null,
      promptsSnapshot: null,
    };

    // Should not throw
    await expect(
      ingestExecutionArtifacts(loop, ORG_ID, artifacts)
    ).resolves.toBeUndefined();

    expect(mockUpsertFromSnapshot).toHaveBeenCalledWith(ORG_ID, null);
  });
});

// ---------------------------------------------------------------------------
// upsertEvaluationWithJudgeScores — direct unit tests (PRD SS8.1)
// ---------------------------------------------------------------------------

describe("upsertEvaluationWithJudgeScores", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAssertEvaluationEntityInOrganization.mockResolvedValue(undefined);
  });

  function makeUpsertParams(overrides: Record<string, unknown> = {}) {
    const mockTx = {
      documentEvaluation: {
        upsert: vi.fn().mockResolvedValue({ id: "eval-upsert-1" }),
      },
    };
    return {
      params: {
        entityId: ARTIFACT_ID,
        entityType: EntityType.Document,
        documentId: ARTIFACT_ID,
        loopId: LOOP_ID,
        organizationId: ORG_ID,
        reportType: "PLAN",
        report: makeJudgesReport("report-direct-1"),
        tx: mockTx,
        ...overrides,
      },
      mockTx,
    };
  }

  it("create block has correct entityId, entityType, organizationId, and artifactId", async () => {
    const { params, mockTx } = makeUpsertParams();

    await upsertEvaluationWithJudgeScores(
      params as unknown as Parameters<typeof upsertEvaluationWithJudgeScores>[0]
    );

    expect(mockTx.documentEvaluation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          entityId: ARTIFACT_ID,
          entityType: EntityType.Document,
          organizationId: ORG_ID,
          documentId: ARTIFACT_ID,
        }),
      })
    );
  });

  it("where clause uses entityId_reportId composite key", async () => {
    const report = makeJudgesReport("report-where-key");
    const { params, mockTx } = makeUpsertParams({ report });

    await upsertEvaluationWithJudgeScores(
      params as unknown as Parameters<typeof upsertEvaluationWithJudgeScores>[0]
    );

    expect(mockTx.documentEvaluation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityId_reportId: {
            entityId: ARTIFACT_ID,
            reportId: report.report_id,
          },
        },
      })
    );
  });

  it("re-upsert with same entityId and reportId updates without duplicate (idempotent)", async () => {
    const report = makeJudgesReport("report-idempotent");
    const mockUpsert = vi.fn().mockResolvedValue({ id: "eval-idempotent-1" });
    const mockTx = { documentEvaluation: { upsert: mockUpsert } };
    const sharedParams = {
      entityId: ARTIFACT_ID,
      entityType: EntityType.Document,
      documentId: ARTIFACT_ID,
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      reportType: "PLAN",
      report,
      tx: mockTx,
    };

    await upsertEvaluationWithJudgeScores(
      sharedParams as unknown as Parameters<
        typeof upsertEvaluationWithJudgeScores
      >[0]
    );
    await upsertEvaluationWithJudgeScores(
      sharedParams as unknown as Parameters<
        typeof upsertEvaluationWithJudgeScores
      >[0]
    );

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    const [firstArgs, secondArgs] = mockUpsert.mock.calls;
    // Both calls carry the same entityId + reportId where key
    expect(firstArgs[0].where).toEqual(secondArgs[0].where);
    expect(firstArgs[0].where).toEqual({
      entityId_reportId: {
        entityId: ARTIFACT_ID,
        reportId: report.report_id,
      },
    });
  });

  it("create block includes organizationId from params", async () => {
    const customOrgId = "org-custom-456";
    const { params, mockTx } = makeUpsertParams({
      organizationId: customOrgId,
    });

    await upsertEvaluationWithJudgeScores(
      params as unknown as Parameters<typeof upsertEvaluationWithJudgeScores>[0]
    );

    expect(mockTx.documentEvaluation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          organizationId: customOrgId,
        }),
      })
    );
  });

  it("calls fanOutJudgeScores with correct evaluationId, organizationId, report, and tx", async () => {
    const report = makeJudgesReport("report-fanout");
    const mockUpsert = vi.fn().mockResolvedValue({ id: "eval-fanout-1" });
    const mockTx = { documentEvaluation: { upsert: mockUpsert } };
    const params = {
      entityId: ARTIFACT_ID,
      entityType: EntityType.Document,
      documentId: ARTIFACT_ID,
      loopId: LOOP_ID,
      organizationId: ORG_ID,
      reportType: "PLAN",
      report,
      tx: mockTx,
    };

    await upsertEvaluationWithJudgeScores(
      params as unknown as Parameters<typeof upsertEvaluationWithJudgeScores>[0]
    );

    expect(mockFanOutJudgeScores).toHaveBeenCalledWith({
      evaluationId: "eval-fanout-1",
      organizationId: ORG_ID,
      report,
      tx: mockTx,
    });
  });
});
