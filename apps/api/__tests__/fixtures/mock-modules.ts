import {
  ExternalCommentProvider,
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
} from "@repo/database/generated/enums";
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
      SESSION: "SESSION",
    },
    // Every member of the generated enum. `DOC` and `ISSUE` were absent, so a
    // spec reading `ArtifactSubtype.ISSUE` through this mock got `undefined` —
    // which silently satisfied an assertion that compared it against another
    // `undefined`, and let a query that had stopped binding `ISSUE` stay green
    // (ISS-10471).
    ArtifactSubtype: {
      PRD: "PRD",
      IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
      TEMPLATE: "TEMPLATE",
      FEATURE: "FEATURE",
      DOC: "DOC",
      ISSUE: "ISSUE",
    },
    GitHubPRState: {
      OPEN: "OPEN",
      CLOSED: "CLOSED",
      MERGED: "MERGED",
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
    ExternalCommentProvider,
    GitHubCommentThreadKind,
    PullRequestCommentLane,
    PullRequestCommentLaneStatus,
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
      JsonNull: null,
      TransactionIsolationLevel: {
        RepeatableRead: "RepeatableRead",
      },
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings,
        values,
      }),
      raw: (value: string) => ({ strings: [value], values: [] }),
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
      flush: vi.fn(async () => undefined),
    },
  };
}

/**
 * Build a mock module for the comment service's realtime thread signal with
 * `emitThreadChangeSignal` stubbed: the signal has its own suite, and the row
 * fakes of the suites that use this are not its subject.
 */
export async function createCommentThreadSignalMockModule(
  importOriginal: <T = unknown>() => Promise<T>
): Promise<MockModule> {
  return {
    ...(await importOriginal<
      typeof import("@/app/comments/service/comment-thread-signal")
    >()),
    emitThreadChangeSignal: vi.fn(),
  };
}
