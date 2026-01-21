import type { User } from "@repo/api/src/types/organization";
import type { PrismaClient } from "@repo/database";
import { database, ensureDatabase } from "@repo/database";

// CRITICAL: Track if database is initialized for this test run (singleton pattern)
let isDbInitialized = false;

/**
 * Setup test database connection (singleton pattern).
 * Call in beforeAll() hook - safe to call multiple times.
 */
export async function setupTestDatabase(): Promise<void> {
  if (!isDbInitialized) {
    await ensureDatabase();
    // Verify connection
    await database.$queryRaw`SELECT 1`;
    isDbInitialized = true;
  }
}

/**
 * Clean up all test data from database.
 * DOES NOT disconnect - reuses connection pool.
 * Call in afterEach() hook.
 */
export async function cleanupTestDatabase(): Promise<void> {
  // Option 1: Transaction-based atomic cleanup (FASTEST)
  await database.$transaction([
    database.artifact.deleteMany({}),
    database.workstream.deleteMany({}),
    database.project.deleteMany({}),
    database.user.deleteMany({}),
    database.organization.deleteMany({}),
  ]);

  // Option 2: Disable foreign key checks for parallel cleanup (ALTERNATIVE)
  // await database.$executeRaw`SET session_replication_role = 'replica';`;
  // await Promise.all([
  //   database.artifact.deleteMany({}),
  //   database.workstream.deleteMany({}),
  //   database.project.deleteMany({}),
  //   database.user.deleteMany({}),
  //   database.organization.deleteMany({}),
  // ]);
  // await database.$executeRaw`SET session_replication_role = 'origin';`;
}

/**
 * Disconnect database connection.
 * ONLY call once in global afterAll or process.on('exit').
 */
export async function disconnectTestDatabase(): Promise<void> {
  if (isDbInitialized) {
    await database.$disconnect();
    isDbInitialized = false;
  }
}

// Note: Database cleanup should be done explicitly in test afterAll() hooks
// using disconnectTestDatabase() to avoid async operations in sync handlers

/**
 * Create test organization and return its ID.
 */
export async function createTestOrganization(
  overrides?: Partial<{ clerkId: string; name: string; slug: string }>
): Promise<string> {
  const org = await database.organization.create({
    data: {
      clerkId: overrides?.clerkId ?? "org_test",
      name: overrides?.name ?? "Test Organization",
      slug: overrides?.slug ?? "test-org",
    },
  });
  return org.id;
}

/**
 * Create test user and return user object.
 * Returns User type from @repo/api for consistency with route handlers.
 */
export async function createTestUser(
  organizationId: string,
  overrides?: Partial<{ clerkId: string; email: string }>
): Promise<User> {
  const user = await database.user.create({
    data: {
      organizationId,
      clerkId: overrides?.clerkId ?? "clerk_test_user",
      email: overrides?.email ?? "test@example.com",
      firstName: "Test",
      lastName: "User",
      role: "ENGINEER",
      active: true,
    },
  });

  return user as User;
}

/**
 * Create test project and return its ID.
 */
export async function createTestProject(
  organizationId: string,
  overrides?: Partial<{ name: string; description: string }>
): Promise<string> {
  const project = await database.project.create({
    data: {
      organizationId,
      name: overrides?.name ?? "Test Project",
      description: overrides?.description ?? "A test project",
    },
  });
  return project.id;
}

/**
 * Transaction-based test isolation wrapper (RECOMMENDED for integration tests).
 * Wraps test in transaction and rolls back after test completes.
 * Faster and more reliable than deleteMany() cleanup.
 */
export function withTestTransaction<T>(
  testFn: (
    tx: Omit<
      PrismaClient,
      "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
    >
  ) => Promise<T>
): Promise<T> {
  return database
    .$transaction(async (tx) => {
      const result = await testFn(tx);

      // Rollback transaction after test by throwing
      throw new TestTransactionRollback(result);
    })
    .catch((error) => {
      if (error instanceof TestTransactionRollback) {
        return error.result as T;
      }
      throw error;
    });
}

/**
 * Custom error for transaction rollback.
 * Not a real error - used to exit transaction and trigger rollback.
 */
class TestTransactionRollback extends Error {
  result: any;

  constructor(result: any) {
    super("Test transaction rollback");
    this.name = "TestTransactionRollback";
    this.result = result;
  }
}
