import type { User } from "@repo/api/src/types/organization";
import { withDb, withImplicitTransaction } from "@repo/database";
import type {
  OrganizationCreateInput,
  ProjectUncheckedCreateInput,
  UserUncheckedCreateInput,
} from "@repo/database/generated/models";

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
    return await withImplicitTransaction(async () => {
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
  const org = await withDb((db) =>
    db.organization.create({
      data: {
        clerkId: "org_test",
        name: "Test Organization",
        slug: "test-org",
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
  const user = await withDb((db) =>
    db.user.create({
      data: {
        organizationId,
        clerkId: "clerk_test_user",
        email: "test@example.com",
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
  overrides?: Partial<ProjectUncheckedCreateInput>
): Promise<string> {
  const project = await withDb((db) =>
    db.project.create({
      data: {
        organizationId,
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
