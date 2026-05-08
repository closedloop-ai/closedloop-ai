import { randomUUID } from "node:crypto";
import type { User } from "@repo/api/src/types/user";
import { withDb } from "@repo/database";
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
 */
export async function autoRollbackTransaction<T>(
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await withDb.tx(async () => {
      const result = await fn();
      throw new TestTransactionRollback(result);
    });
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
