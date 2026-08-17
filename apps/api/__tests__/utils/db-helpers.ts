import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import type { User } from "@repo/api/src/types/user";
import { ArtifactType, withDb } from "@repo/database";
import type { TransactionClient } from "@repo/database/generated/internal/prismaNamespace";
import type {
  OrganizationCreateInput,
  ProjectUncheckedCreateInput,
  UserUncheckedCreateInput,
} from "@repo/database/generated/models";
import { type Mock, vi } from "vitest";

/**
 * Wrap test code in a transaction that automatically rolls back.
 * Use this for integration tests to ensure test isolation without manual cleanup.
 *
 * @example
 * it("creates a user", async () => {
 *   await autoRollbackTransaction(async () => {
 *     const orgId = await createTestOrganization();
 *     const user = await usersService.create({ organizationId: orgId, ... });
 *     expect(user.id).toBeDefined();
 *   });
 *   // Transaction rolled back - no data persists
 * });
 *
 * Pass an explicit timeout for intentionally heavy integration cases that can
 * exceed Prisma's 5-second default under coverage instrumentation.
 */
export async function autoRollbackTransaction<T>(
  fn: () => Promise<T>,
  options?: AutoRollbackTransactionOptions
): Promise<T> {
  try {
    return await withDb.tx(async () => {
      const result = await fn();
      throw new TestTransactionRollback(result);
    }, options);
  } catch (e) {
    if (e instanceof TestTransactionRollback) {
      return e.result as T;
    }
    throw e;
  }
}

/**
 * Create test organization and return its ID.
 */
export async function createTestOrganization(
  overrides?: Partial<OrganizationCreateInput>
): Promise<string> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const org = await withDb((db) =>
    db.organization.create({
      data: {
        clerkId: `org_test_${suffix}`,
        name: `Test Organization ${suffix}`,
        slug: `test-org-${suffix}`,
        ...overrides,
      },
    })
  );
  return org.id;
}

/**
 * Create test user and return user object.
 * Returns User type from @repo/api for consistency with route handlers.
 */
export async function createTestUser(
  organizationId: string,
  overrides?: Partial<UserUncheckedCreateInput>
): Promise<User> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const user = await withDb((db) =>
    db.user.create({
      data: {
        organizationId,
        clerkId: `clerk_test_user_${suffix}`,
        email: `test+${suffix}@example.com`,
        firstName: "Test",
        lastName: "User",
        role: "ENGINEER",
        active: true,
        ...overrides,
      },
    })
  );

  return user as User;
}

/**
 * Create test project and return its ID.
 */
export async function createTestProject(
  organizationId: string,
  createdById: string,
  overrides?: Partial<ProjectUncheckedCreateInput>
): Promise<string> {
  const project = await withDb((db) =>
    db.project.create({
      data: {
        organizationId,
        createdById,
        name: "Test Project",
        description: "A test project",
        ...overrides,
      },
    })
  );
  return project.id;
}

/**
 * Custom error for transaction rollback.
 * Not a real error - used to exit transaction and trigger rollback.
 */
class TestTransactionRollback extends Error {
  result: unknown;

  constructor(result: unknown) {
    super();
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// Unit test mock helpers — for tests that vi.mock("@repo/database")
// ---------------------------------------------------------------------------

/**
 * Returns `withDb` cast as a Vitest Mock with a `.tx` Mock property.
 * Call once after `vi.mock("@repo/database")` and the subsequent import.
 *
 * @example
 * const mockWithDb = getMockWithDb();
 * // later: mockWithDb.mockClear();
 */
export function getMockWithDb() {
  return withDb as unknown as Mock & { tx: Mock };
}

/**
 * Cast a plain mock object to a TransactionClient so it can be passed to
 * handler functions that accept `TransactionClient` as their first argument.
 *
 * @example
 * const mockTx = { workstream: { findUnique: vi.fn().mockResolvedValue(...) } };
 * await handleWorkflowSuccess(asTx(mockTx), ctx, true);
 */
export function asTx<T extends Record<string, unknown>>(mock: T) {
  return mock as unknown as TransactionClient;
}

/**
 * Set up the mocked `withDb.tx` to invoke its callback with the given mock
 * object as the transaction client.
 *
 * @example
 * mockWithDbTx(mockTx);
 * await processWorkflowCompletion(event, correlationId, true);
 */
export function mockWithDbTx(mockDb: Record<string, unknown>) {
  // Provide a default `$queryRaw`/`$executeRaw` so services that issue raw
  // statements inside the transaction (e.g. `SELECT ... FOR UPDATE` row locks or
  // `pg_advisory_xact_lock` guards) don't blow up when the test only stubbed
  // model methods. Tests can still supply their own.
  if (!("$queryRaw" in mockDb)) {
    mockDb.$queryRaw = vi.fn().mockResolvedValue([]);
  }
  if (!("$executeRaw" in mockDb)) {
    mockDb.$executeRaw = vi.fn().mockResolvedValue(0);
  }
  getMockWithDb().tx = vi
    .fn()
    .mockImplementation((callback: (tx: unknown) => unknown) =>
      callback(mockDb)
    );
}

/**
 * Set up the mocked `withDb` (non-transactional) to invoke its callback with
 * the given mock object as the database client.
 *
 * @example
 * mockWithDbCall(mockDb);
 * await handleExecutionSuccess(ctx, executionResult);
 */
export function mockWithDbCall(mockDb: Record<string, unknown>) {
  getMockWithDb().mockImplementation((callback: (db: unknown) => unknown) =>
    callback(mockDb)
  );
}

/**
 * Route BOTH `withDb` and `withDb.tx` at one mock database.
 *
 * Services routinely mix pooled reads with a transaction in the same call, so
 * stubbing only one of the two silently exercises a half-mocked path. Prefer
 * this over calling `mockWithDbCall` and `mockWithDbTx` in sequence.
 */
export function mockWithDbAll(mockDb: Record<string, unknown>) {
  mockWithDbCall(mockDb);
  mockWithDbTx(mockDb);
}

/**
 * Link a VALID agent session to a branch artifact.
 *
 * FEA-4225 made "≥1 valid linked session" a server-side ELIGIBILITY requirement
 * for the Branches corpus: remote evidence (a push webhook or PR) may enrich a
 * session-derived branch but is no longer sufficient provenance to place it in
 * the list, its counts, or its detail read. "Valid" is load-bearing — an
 * `ArtifactLink` whose source SESSION artifact has no `SessionDetail` row is an
 * orphaned/half-synced link and still does not count (FEA-4263).
 *
 * So an integration test that asserts a branch is VISIBLE must give it a
 * session. Tests that specifically exercise the orphaned-link case build the
 * link inline instead — see `branch-requires-session.integration.test.ts`.
 *
 * Safe to call inside `autoRollbackTransaction`; every write goes through the
 * ambient transaction and rolls back with it.
 *
 * @returns the id of the session artifact now linked to the branch
 */
export async function linkValidSessionToBranch(params: {
  organizationId: string;
  userId: string;
  branchArtifactId: string;
  /** Short label woven into the seeded record names to aid debugging. */
  label: string;
  sessionTimestamp?: Date;
  /**
   * Which session→target relationship the link records. Defaults to
   * `SessionBranch` (the session wrote the branch). Pass `SessionPr` for a
   * session→PR link — the kind the delivery/attribution readers select on.
   */
  linkKind?: SessionArtifactLinkKind;
}): Promise<string> {
  const { organizationId, userId, branchArtifactId, label } = params;
  const timestamp = params.sessionTimestamp ?? new Date("2026-05-15T00:00:00Z");
  // Unique-constraint safety across repeated calls within one test.
  const unique = randomUUID().slice(0, 8);

  return await withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: `session-${label}-${unique}`,
        // `Artifact.status` is a freeform column carrying several disjoint
        // vocabularies (PRD-495); branch eligibility never reads it. Mirrors the
        // sibling fixture in branch-requires-session.integration.test.ts.
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: `machine-${label}-${unique}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    // The SessionDetail row is what makes the link count as a real session.
    await db.sessionDetail.create({
      data: {
        artifactId: session.id,
        userId,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${label}-${unique}`,
        harness: "claude",
        sessionStartedAt: timestamp,
        sessionUpdatedAt: timestamp,
      },
    });
    await db.artifactLink.create({
      data: {
        organizationId,
        sourceId: session.id,
        targetId: branchArtifactId,
        linkType: LinkType.RelatesTo,
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: {
          linkKind: params.linkKind ?? SessionArtifactLinkKind.SessionBranch,
        },
      },
    });
    return session.id;
  });
}

type AutoRollbackTransactionOptions = {
  maxWait?: number;
  timeout?: number;
};
