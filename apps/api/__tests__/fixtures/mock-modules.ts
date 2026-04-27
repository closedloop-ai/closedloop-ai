import { vi } from "vitest";

type MockModule = Record<string, unknown>;

export function createDatabaseMockModule(
  overrides: Record<string, unknown> = {}
): MockModule {
  return {
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      PULL_REQUEST: "PULL_REQUEST",
      DEPLOYMENT: "DEPLOYMENT",
    },
    ArtifactSubtype: {
      PRD: "PRD",
      IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
      TEMPLATE: "TEMPLATE",
      FEATURE: "FEATURE",
    },
    GitHubPRState: {
      OPEN: "OPEN",
      CLOSED: "CLOSED",
      MERGED: "MERGED",
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
    WorkstreamEventType: {
      GITHUB_PR_CREATED: "GITHUB_PR_CREATED",
    },
    EvaluationReportType: {
      PLAN: "PLAN",
      CODE: "CODE",
    },
    PromptType: {
      AGENT: "AGENT",
      JUDGE: "JUDGE",
    },
    Prisma: {
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings,
        values,
      }),
    },
    ...overrides,
  };
}

export function createLogMockModule(): MockModule {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

export function createLoopDocumentIngestionMockModule(): MockModule {
  return {
    upsertEvaluationWithJudgeScores: vi.fn().mockResolvedValue(undefined),
  };
}

export function createPrLinkageMockModule(): MockModule {
  return {
    ensurePrLinkageRecords: vi.fn().mockResolvedValue(undefined),
  };
}

export function createPromptsServiceMockModule(): MockModule {
  return {
    upsertFromSnapshot: vi.fn().mockResolvedValue(undefined),
  };
}
