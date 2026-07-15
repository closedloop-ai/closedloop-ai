/**
 * mock-prisma.ts
 *
 * Factory for a typed mock PrismaClient suitable for unit tests.
 * Uses vitest's `vi.fn()` to stub every model delegate method so tests
 * can assert on calls without a real database connection.
 *
 * Usage:
 * ```ts
 * import { createMockPrisma } from "../fixtures/mock-prisma";
 *
 * const prisma = createMockPrisma();
 * prisma.project.upsert.mockResolvedValue({ id: "...", ... });
 * ```
 */

import { vi } from "vitest";
import type { PrismaClient } from "../../../../generated/client";

/**
 * Creates a fresh mock delegate for a single Prisma model.
 * All CRUD methods are stubbed with `vi.fn()` so tests can override
 * individual method implementations with `.mockResolvedValue(...)`.
 */
function createMockDelegate() {
  return {
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    // Default findMany to an empty array — real Prisma always returns an
    // array, so calling `.map()` / `.filter()` on the result should never
    // crash. Tests that need specific rows override via .mockResolvedValue.
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    createMany: vi.fn(),
    createManyAndReturn: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    updateManyAndReturn: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    // Real Prisma .count returns a number; default to 0 so unscoped uses
    // (e.g. row-count verification in tests that don't pre-populate) don't
    // produce `undefined`.
    //
    // WARNING (PR #1244): this 0 default can mask a zero-row regression — a
    // unit test that asserts on seeded counts WITHOUT explicitly stubbing
    // `.count` passes trivially (0 === 0) even if the seed produced nothing.
    // Any test that verifies population MUST either stub the relevant
    // `.count` mocks (see buildRunSeedMock) or construct the client via
    // createMockPrismaWithCounts() below. Real non-zero verification lives in
    // the integration suite, which runs against a database and never relies
    // on these defaults.
    count: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  };
}

/**
 * Creates a mock PrismaClient with all model delegates stubbed.
 * The `$transaction` method executes the callback synchronously so
 * seed functions that wrap operations in a transaction work in tests
 * without a real DB.
 *
 * @returns A typed mock that satisfies `PrismaClient` for test purposes.
 */
export function createMockPrisma(): PrismaClient {
  const mock = {
    // Core transaction / connection stubs
    $transaction: vi.fn().mockImplementation((fn: unknown) => {
      if (typeof fn === "function") {
        return fn(mock);
      }
      return Promise.all(fn as Promise<unknown>[]);
    }),
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),

    // Model delegates — one per Prisma model.
    // Add new models here as the schema evolves.
    previewSchema: createMockDelegate(),
    organization: createMockDelegate(),
    user: createMockDelegate(),
    userPublicKey: createMockDelegate(),
    computeTarget: createMockDelegate(),
    computeTargetHealthCheck: createMockDelegate(),
    sessionDetail: createMockDelegate(),
    agentSessionEvent: createMockDelegate(),
    agentSessionTokenUsage: createMockDelegate(),
    desktopCommand: createMockDelegate(),
    loopExecutionCredentialConsumption: createMockDelegate(),
    desktopCommandEvent: createMockDelegate(),
    project: createMockDelegate(),
    team: createMockDelegate(),
    teamMember: createMockDelegate(),
    teamRepository: createMockDelegate(),
    projectTeam: createMockDelegate(),
    favoriteArtifact: createMockDelegate(),
    favoriteProject: createMockDelegate(),
    documentGenerationStatusDismissal: createMockDelegate(),
    documentVersion: createMockDelegate(),
    artifact: createMockDelegate(),
    documentDetail: createMockDelegate(),
    branchDetail: createMockDelegate(),
    pullRequestDetail: createMockDelegate(),
    branchFileChange: createMockDelegate(),
    branchStatusCheck: createMockDelegate(),
    deploymentDetail: createMockDelegate(),
    artifactLink: createMockDelegate(),
    artifactEvaluation: createMockDelegate(),
    judgeScore: createMockDelegate(),
    judgeHumanScore: createMockDelegate(),
    artifactRating: createMockDelegate(),
    fileAttachment: createMockDelegate(),
    slugCounter: createMockDelegate(),
    chatSession: createMockDelegate(),
    commentThread: createMockDelegate(),
    gitHubCommentThreadProjection: createMockDelegate(),
    comment: createMockDelegate(),
    gitHubCommentProjection: createMockDelegate(),
    externalCommentAuthor: createMockDelegate(),
    commentAttachment: createMockDelegate(),
    commentReaction: createMockDelegate(),
    loop: createMockDelegate(),
    loopEvent: createMockDelegate(),
    loopTokenRefresh: createMockDelegate(),
    prompt: createMockDelegate(),
    linearIntegration: createMockDelegate(),
    linearSubtask: createMockDelegate(),
    gitHubInstallation: createMockDelegate(),
    gitHubInstallationRepository: createMockDelegate(),
    gitHubUserConnection: createMockDelegate(),
    publicRepository: createMockDelegate(),
    gitHubPRReview: createMockDelegate(),
    slackIntegration: createMockDelegate(),
    apiKey: createMockDelegate(),
    oAuthRevokedToken: createMockDelegate(),
    oAuthRateLimit: createMockDelegate(),
    oAuthAuthorizationCode: createMockDelegate(),
    oAuthRefreshToken: createMockDelegate(),
    localGatewayChallengeJti: createMockDelegate(),
    desktopOnboardingAttempt: createMockDelegate(),
    desktopOnboardingDeviceSession: createMockDelegate(),
    customField: createMockDelegate(),
    customFieldEnumOption: createMockDelegate(),
    customFieldSetting: createMockDelegate(),
    customFieldValue: createMockDelegate(),
    tag: createMockDelegate(),
    tagProject: createMockDelegate(),
    tagWorkstream: createMockDelegate(),
    tagArtifact: createMockDelegate(),
    tagLoop: createMockDelegate(),
    googleIntegration: createMockDelegate(),
    agent: createMockDelegate(),
    agentVersion: createMockDelegate(),
    repoBootstrapConfig: createMockDelegate(),
    // CatalogItem supersedes Agent (T-21.1)
    catalogItem: createMockDelegate(),
    catalogItemVersion: createMockDelegate(),
  } as unknown as PrismaClient;

  return mock;
}

/**
 * Like {@link createMockPrisma} but every model delegate's `.count` resolves
 * to `defaultCount` (>= 1) instead of 0.
 *
 * Use this as the base for any unit test that asserts a seed function
 * populated rows. With the plain {@link createMockPrisma}, an unstubbed
 * `.count` returns 0, so a "rows were created" assertion can pass even when
 * nothing was seeded (PR #1244). Starting from a non-zero default makes that
 * regression visible unless a test deliberately stubs a 0.
 *
 * @param defaultCount - The value every delegate's `.count` resolves to.
 *   Defaults to 1.
 */
export function createMockPrismaWithCounts(defaultCount = 1): PrismaClient {
  const mock = createMockPrisma();
  for (const delegate of Object.values(
    mock as unknown as Record<string, unknown>
  )) {
    if (
      delegate &&
      typeof delegate === "object" &&
      "count" in delegate &&
      typeof (delegate as { count?: unknown }).count === "function"
    ) {
      (
        delegate as { count: { mockResolvedValue: (value: number) => unknown } }
      ).count.mockResolvedValue(defaultCount);
    }
  }
  return mock;
}
