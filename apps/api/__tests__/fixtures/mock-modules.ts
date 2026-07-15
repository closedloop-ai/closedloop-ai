import { vi } from "vitest";

type MockModule = Record<string, unknown>;

export function createDatabaseMockModule(
  overrides: Record<string, unknown> = {}
): MockModule {
  return {
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",
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
    LoopStatus: {
      PENDING: "PENDING",
      RUNNING: "RUNNING",
      COMPLETED: "COMPLETED",
      FAILED: "FAILED",
      CANCELLED: "CANCELLED",
      TIMED_OUT: "TIMED_OUT",
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
      join: (values: unknown[], separator = ",") => ({
        separator,
        strings: [""],
        values,
      }),
      empty: { strings: [""], values: [] },
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
      flush: vi.fn().mockResolvedValue(undefined),
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

/**
 * Build a mock module for `@repo/auth/loop-runner-jwt`.
 *
 * Pass the `importOriginal` callback provided by `vi.mock(..., async (importOriginal) => …)`
 * so the helper can spread the real module and read `DEFAULT_TTL_MS` for the
 * stubbed `expiresAt`. Override the token literal when a specific test needs
 * to assert on it.
 */
export async function createLoopRunnerJwtMockModule(
  importOriginal: <T = unknown>() => Promise<T>,
  options: { token?: string; tokenId?: string } = {}
): Promise<MockModule> {
  const actual =
    await importOriginal<typeof import("@repo/auth/loop-runner-jwt")>();
  return {
    ...actual,
    issueLoopRunnerToken: vi.fn().mockResolvedValue({
      token: options.token ?? "mock-runner-token",
      tokenId: options.tokenId ?? "mock-token-id",
      expiresAt: new Date(Date.now() + actual.DEFAULT_TTL_MS),
    }),
  };
}
