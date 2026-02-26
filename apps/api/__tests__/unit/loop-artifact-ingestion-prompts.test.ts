/**
 * Unit tests for prompts integration in loop-artifact-ingestion.ts.
 *
 * Tests cover:
 * - downloadLoopArtifacts(): markdown entries under agents-snapshot/ are parsed as primary source
 * - downloadLoopArtifacts(): returns promptsSnapshot: null when markdown entries are absent
 * - downloadLoopArtifacts(): null inputs return promptsSnapshot: null without failing
 * - ingestPlanArtifacts(): upsertFromSnapshot called before judgesReport writes
 * - ingestExecutionArtifacts(): upsertFromSnapshot called before code judges report writes
 * - null snapshot: upsertFromSnapshot is called with null and does not throw
 */

import type { JudgesReport } from "@repo/api/src/types/evaluation";
import type { Loop } from "@repo/api/src/types/loop";
import { vi } from "vitest";

// --- Mocks (must come before imports of the module under test) ---

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  EvaluationReportType: {
    PLAN: "PLAN",
    CODE: "CODE",
  },
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
  PromptType: {
    AGENT: "AGENT",
    JUDGE: "JUDGE",
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/prompts-service", () => ({
  upsertFromSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/artifacts/artifact-version-service", () => ({
  artifactVersionService: {
    createVersion: vi.fn().mockResolvedValue({ id: "version-1", version: 2 }),
  },
}));

vi.mock("@/app/artifacts/room-utils", () => ({
  updateArtifactRoomVersion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
  downloadPromptSnapshotMarkdownEntries: vi.fn(),
}));

// --- Imports (after mocks) ---

import { withDb } from "@repo/database";
import type { Mock } from "vitest";
import {
  downloadLoopArtifacts,
  ingestExecutionArtifacts,
  ingestPlanArtifacts,
} from "@/lib/loop-artifact-ingestion";
import {
  downloadArtifactFile,
  downloadPromptSnapshotMarkdownEntries,
} from "@/lib/loop-state";
import { upsertFromSnapshot } from "@/lib/prompts-service";

const mockDownloadArtifactFile = downloadArtifactFile as unknown as Mock;
const mockDownloadPromptSnapshotMarkdownEntries =
  downloadPromptSnapshotMarkdownEntries as unknown as Mock;
const mockUpsertFromSnapshot = upsertFromSnapshot as unknown as Mock;
const mockWithDb = withDb as unknown as Mock & { tx: Mock };

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const ORG_ID = "org-test-123";
const ARTIFACT_ID = "artifact-test-123";
const LOOP_ID = "loop-test-123";
const WORKSTREAM_ID = "ws-test-123";
const STATE_KEY_PREFIX = `${ORG_ID}/loops/${LOOP_ID}/run-1`;

function makeLoop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: LOOP_ID,
    organizationId: ORG_ID,
    userId: "user-1",
    status: "COMPLETED",
    command: "PLAN",
    artifactId: ARTIFACT_ID,
    workstreamId: WORKSTREAM_ID,
    parentLoopId: null,
    prompt: null,
    repo: { fullName: "org/repo", branch: "main" },
    contextRefs: null,
    containerId: null,
    s3StateKey: STATE_KEY_PREFIX,
    prUrl: null,
    prNumber: null,
    branchName: null,
    sessionId: null,
    tokensInput: 0,
    tokensOutput: 0,
    tokensByModel: null,
    estimatedCost: null,
    startedAt: null,
    completedAt: null,
    error: null,
    metadata: {},
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeJudgesReport(reportId = "report-1"): JudgesReport {
  return {
    report_id: reportId,
    timestamp: "2026-01-01T00:00:00Z",
    stats: [
      {
        type: "case_score",
        case_id: "test-judge",
        final_status: 3,
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
  };
}

// ---------------------------------------------------------------------------
// downloadLoopArtifacts — prompt snapshot parsing
// ---------------------------------------------------------------------------

describe("downloadLoopArtifacts — prompt snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const artifacts = await downloadLoopArtifacts(STATE_KEY_PREFIX);

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
    mockDownloadPromptSnapshotMarkdownEntries.mockResolvedValue([]);
    mockDownloadArtifactFile.mockResolvedValue(null);

    const artifacts = await downloadLoopArtifacts(STATE_KEY_PREFIX);

    expect(artifacts.promptsSnapshot).toBeNull();
  });

  it("returns promptsSnapshot: null when markdown snapshots are missing", async () => {
    // All artifact files return null
    mockDownloadArtifactFile.mockResolvedValue(null);
    mockDownloadPromptSnapshotMarkdownEntries.mockResolvedValue([]);

    const artifacts = await downloadLoopArtifacts(STATE_KEY_PREFIX);

    expect(artifacts.promptsSnapshot).toBeNull();
    // Ingestion should not fail — other artifact fields should still be null too
    expect(artifacts.planContent).toBeNull();
    expect(artifacts.judgesReport).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ingestPlanArtifacts — upsertFromSnapshot call ordering
// ---------------------------------------------------------------------------

describe("ingestPlanArtifacts — upsertFromSnapshot ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls upsertFromSnapshot before the judgesReport withDb write", async () => {
    const loop = makeLoop();
    const judgesReport = makeJudgesReport("judges-report-plan");

    const callOrder: string[] = [];

    mockUpsertFromSnapshot.mockImplementation(() => {
      callOrder.push("upsertFromSnapshot");
      return Promise.resolve();
    });

    // withDb is used for artifact.update, workstreamEvent, and judgesReport
    // We need to track when judgesReport upsert is called
    const mockArtifactEvaluationUpsert = vi.fn().mockImplementation(() => {
      callOrder.push("artifactEvaluation.upsert");
      return Promise.resolve({ id: "eval-1" });
    });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        artifact: {
          update: vi.fn().mockResolvedValue({
            slug: "test-slug",
            latestVersion: 2,
          }),
        },
        artifactEvaluation: {
          upsert: mockArtifactEvaluationUpsert,
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
      executionResult: null,
      judgesReport,
      codeJudgesReport: null,
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
    const evalIdx = callOrder.indexOf("artifactEvaluation.upsert");
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(evalIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeLessThan(evalIdx);
  });

  it("calls upsertFromSnapshot with null snapshot and does not throw", async () => {
    const loop = makeLoop();

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        artifact: {
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
      executionResult: null,
      judgesReport: null,
      codeJudgesReport: null,
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
    vi.clearAllMocks();
  });

  it("calls upsertFromSnapshot inside withDb.tx before code judges report write", async () => {
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
      callOrder.push("artifactEvaluation.upsert");
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
          artifact: {
            findUnique: vi.fn().mockResolvedValue({
              organizationId: ORG_ID,
              projectId: "project-1",
              slug: "test-artifact",
            }),
          },
          artifactEvaluation: {
            upsert: mockArtifactEvaluationUpsert,
          },
          gitHubPullRequest: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "pr-1" }),
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
      planContent: null,
      questionsContent: null,
      executionResult: {
        has_changes: true,
        pr_url: "https://github.com/org/repo/pull/10",
        pr_number: 10,
        pr_title: "Symphony: test feature",
        branch_name: "symphony/test-feature",
        base_branch: "main",
        base_ref: "main",
        github_id: 999,
        commit_sha: "abc123",
      },
      judgesReport: null,
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

    await ingestExecutionArtifacts(loop, artifacts);

    const txCallbackIdx = callOrder.indexOf("withDb.tx.callback");
    const upsertIdx = callOrder.indexOf("upsertFromSnapshot");
    const evalIdx = callOrder.indexOf("artifactEvaluation.upsert");
    expect(txCallbackIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(evalIdx).toBeGreaterThanOrEqual(0);
    expect(txCallbackIdx).toBeLessThan(upsertIdx);
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

    // withDb.tx used for the main transaction block
    let capturedTx: unknown = null;

    mockWithDb.tx = vi
      .fn()
      .mockImplementation((callback: (tx: unknown) => unknown) => {
        const tx = {
          artifact: {
            findUnique: vi.fn().mockResolvedValue({
              organizationId: ORG_ID,
              projectId: "project-1",
              slug: "test-artifact",
            }),
          },
          gitHubPullRequest: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "pr-1" }),
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
        capturedTx = tx;
        return callback(tx);
      });

    const artifacts = {
      planContent: null,
      questionsContent: null,
      executionResult: {
        has_changes: true,
        pr_url: "https://github.com/org/repo/pull/11",
        pr_number: 11,
        pr_title: "Symphony: null snapshot test",
        branch_name: "symphony/null-snapshot",
        base_branch: "main",
        base_ref: "main",
        github_id: 1000,
        commit_sha: "def456",
      },
      judgesReport: null,
      codeJudgesReport: null,
      promptsSnapshot: null,
    };

    // Should not throw
    await expect(
      ingestExecutionArtifacts(loop, artifacts)
    ).resolves.toBeUndefined();

    expect(mockUpsertFromSnapshot).toHaveBeenCalledWith(
      ORG_ID,
      null,
      capturedTx
    );
  });
});
