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

import { EvalStatus, type JudgesReport } from "@repo/api/src/types/evaluation";
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
  resetArtifactRoom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/judge-score-fanout", () => ({
  fanOutJudgeScores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
  downloadPromptSnapshotMarkdownEntries: vi.fn(),
}));

vi.mock("@/lib/pr-linkage", () => ({
  ensurePrLinkageRecords: vi.fn().mockResolvedValue(undefined),
}));

// --- Imports (after mocks) ---

import { withDb } from "@repo/database";
import type { Mock } from "vitest";
import { fanOutJudgeScores } from "@/lib/judge-score-fanout";
import { ingestExecutionArtifacts } from "@/lib/loops/loop-commands/execute-handler";
import {
  downloadPlanArtifacts,
  ingestPlanArtifacts,
} from "@/lib/loops/loop-commands/plan-handler";
import {
  downloadArtifactFile,
  downloadPromptSnapshotMarkdownEntries,
} from "@/lib/loops/loop-state";
import { upsertFromSnapshot } from "@/lib/prompts-service";
import { buildLoop } from "../fixtures/loop";

const mockDownloadArtifactFile = downloadArtifactFile as unknown as Mock;
const mockDownloadPromptSnapshotMarkdownEntries =
  downloadPromptSnapshotMarkdownEntries as unknown as Mock;
const mockFanOutJudgeScores = fanOutJudgeScores as unknown as Mock;
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
  return buildLoop({
    id: LOOP_ID,
    organizationId: ORG_ID,
    artifactId: ARTIFACT_ID,
    workstreamId: WORKSTREAM_ID,
    s3StateKey: STATE_KEY_PREFIX,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  });
}

function makeJudgesReport(reportId = "report-1"): JudgesReport {
  return {
    report_id: reportId,
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
  };
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
      callOrder.push("artifactEvaluation.upsert");
      return Promise.resolve({ id: "eval-1" });
    });

    mockWithDb.tx = vi
      .fn()
      .mockImplementation((callback: (tx: unknown) => unknown) => {
        const tx = {
          artifactEvaluation: {
            upsert: mockArtifactEvaluationUpsert,
          },
        };
        return callback(tx);
      });

    // withDb is used for artifact.update and workstreamEvent.
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const db = {
        artifact: {
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

    expect(mockFanOutJudgeScores).toHaveBeenCalledTimes(1);
    const upsertIdx = callOrder.indexOf("upsertFromSnapshot");
    const evalIdx = callOrder.indexOf("artifactEvaluation.upsert");
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
        return callback(tx);
      });

    const artifacts = {
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
      codeJudgesReport: null,
      promptsSnapshot: null,
    };

    // Should not throw
    await expect(
      ingestExecutionArtifacts(loop, artifacts)
    ).resolves.toBeUndefined();

    expect(mockUpsertFromSnapshot).toHaveBeenCalledWith(ORG_ID, null);
  });
});
