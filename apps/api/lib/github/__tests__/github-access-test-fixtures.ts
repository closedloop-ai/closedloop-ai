import type { Result } from "@repo/api/src/types/result";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import { vi } from "vitest";
import type { GitHubAccessError } from "@/lib/github/github-access";
import {
  GitHubAccessIntent,
  GitHubSyncHealthState,
} from "@/lib/github/github-access";
import type { GitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import { decryptIntegrationToken } from "@/lib/integration-encryption";

/**
 * Shared harness for the PLN-1525 github-access test suites (resolver,
 * sync pool, observations). Every consumer MUST `vi.mock` the modules these
 * fixtures touch (`@repo/database`, `@/lib/integration-encryption`,
 * `@repo/github/installation-auth`, `@repo/observability/log`) before
 * importing — the mock casts below are only real at runtime under those
 * mocks. The `withDb` mock itself is cast in each test file (`*.test.ts` is
 * exempt from the no-double-cast gate; this helper module is not) and passed
 * into `wireDb`.
 */

type MockFn = ReturnType<typeof vi.fn>;

export type WithDbMock = MockFn & {
  tx: MockFn;
};

/** The db-delegate stub shape both families' `makeDb` factories return. */
export type GitHubAccessDbStub = {
  gitHubUserConnection: Record<string, MockFn>;
  gitHubAccessCapability: {
    updateMany: MockFn;
    create: MockFn;
    deleteMany: MockFn;
  };
  gitHubInstallation: { findUnique: MockFn };
};

export const mockDecrypt = decryptIntegrationToken as ReturnType<typeof vi.fn>;
export const mockGetInstallationOctokit = getInstallationOctokit as ReturnType<
  typeof vi.fn
>;

export const NOW = new Date("2026-07-30T12:00:00.000Z");
export const FUTURE_RESET = new Date("2026-07-30T12:40:00.000Z");

export function wireDb<T>(mockWithDb: WithDbMock, db: T): void {
  mockWithDb.mockImplementation((fn: (client: T) => unknown) => fn(db));
  mockWithDb.tx.mockImplementation((fn: (client: T) => unknown) => fn(db));
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: HeadersInit
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

export function okFetch() {
  return vi.fn((_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
    Promise.resolve(jsonResponse(200, { id: 1 }))
  );
}

// ---------------------------------------------------------------------------
// Interactive resolver family (github-client-resolver*.test.ts)
// ---------------------------------------------------------------------------

export type ResolverConnectionFixture = {
  id: string;
  organizationId: string;
  userId: string;
  githubUserId: string;
  login: string;
  accessTokenEncrypted: string;
  revokedAt: Date | null;
  tokenExpiresAt: Date | null;
  scopes: string[];
  rateLimitTier: number | null;
  lastUsedAt: Date | null;
  capabilities: Array<{
    credentialKind: string;
    denialReason: string | null;
    installationId: string | null;
    checkedAt: Date;
    expiresAt: Date;
  }>;
};

export const APP_USER_CONNECTION: ResolverConnectionFixture = {
  id: "connection-1",
  organizationId: "org-1",
  userId: "user-1",
  githubUserId: "9001",
  login: "octocat",
  accessTokenEncrypted: "encrypted-token",
  revokedAt: null,
  tokenExpiresAt: null,
  // GitHub App user-to-server tokens report no OAuth scopes.
  scopes: [],
  rateLimitTier: 15_000,
  lastUsedAt: null,
  capabilities: [],
};

export const USER_TARGET_INPUT = {
  organizationId: "org-1",
  userId: "user-1",
  target: { owner: "Acme", repo: "Widgets" },
  intent: GitHubAccessIntent.ReadAsUser,
} as const;

export function makeResolverDb(
  connection: ResolverConnectionFixture | null
): GitHubAccessDbStub {
  return {
    gitHubUserConnection: {
      findUnique: vi.fn().mockResolvedValue(connection),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    gitHubAccessCapability: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    gitHubInstallation: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

// ---------------------------------------------------------------------------
// Sync pool family (github-sync-client-pool.test.ts,
// github-sync-pool-observations.test.ts)
// ---------------------------------------------------------------------------

export type PoolConnectionFixture = {
  id: string;
  organizationId: string;
  userId: string;
  githubUserId: string;
  login: string;
  accessTokenEncrypted: string;
  scopes: string[];
  rateLimitTier: number | null;
  observedLimit: number | null;
  observedRemaining: number | null;
  observedResetAt: Date | null;
  windowSpend: number;
  backoffUntil: Date | null;
  healthState: string;
  lastUsedAt: Date | null;
  tokenExpiresAt: Date | null;
  revokedAt: Date | null;
  capabilities: Array<{ credentialKind: string; denialReason: string | null }>;
};

export const POOL_INPUT = {
  organizationId: "org-1",
  target: { owner: "Acme", repo: "Widgets" },
} as const;

export function poolConnectionFixture(
  overrides: Partial<PoolConnectionFixture> & { id: string; login: string }
): PoolConnectionFixture {
  return {
    organizationId: "org-1",
    userId: `user-${overrides.id}`,
    githubUserId: `gh-${overrides.id}`,
    accessTokenEncrypted: `encrypted-${overrides.id}`,
    scopes: [],
    rateLimitTier: null,
    observedLimit: 10_000,
    observedRemaining: 9000,
    observedResetAt: FUTURE_RESET,
    windowSpend: 0,
    backoffUntil: null,
    healthState: GitHubSyncHealthState.Healthy,
    lastUsedAt: null,
    tokenExpiresAt: null,
    revokedAt: null,
    capabilities: [],
    ...overrides,
  };
}

export function makePoolDb(
  connections: PoolConnectionFixture[]
): GitHubAccessDbStub {
  return {
    gitHubUserConnection: {
      findMany: vi.fn().mockResolvedValue(connections),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    gitHubAccessCapability: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    gitHubInstallation: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

export function drawnLogin(
  result: Result<GitHubSyncClient, GitHubAccessError>
): string {
  if (!result.ok) {
    throw new Error("expected a drawn client");
  }
  const actingAs = result.value.actingAs;
  if ("login" in actingAs) {
    return actingAs.login;
  }
  throw new Error("expected a user-lane client");
}
