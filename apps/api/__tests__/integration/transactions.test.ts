import { database } from "@repo/database";
import {
  buildArtifactScopeCondition,
  prepareArtifactVersion,
} from "@/app/artifacts/artifact-utils";
import {
  cleanupTestDatabase,
  createTestOrganization,
  createTestProject,
  disconnectTestDatabase,
  setupTestDatabase,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const hasDatabase = !!process.env.DATABASE_URL;

// Top-level regex for timeout error matching
const TIMEOUT_REGEX = /timeout/i;

describe.skipIf(!hasDatabase)("Artifact Transaction Integration", () => {
  // Cache fixtures at suite level (OPTIMIZATION)
  let testOrgId: string;
  let testProjectId: string;

  beforeAll(async () => {
    await setupTestDatabase();
    // Create fixtures ONCE for entire suite
    testOrgId = await createTestOrganization();
    testProjectId = await createTestProject(testOrgId);
  });

  afterEach(async () => {
    // ONLY clean artifacts - keep org/project cached
    await database.artifact.deleteMany({});
    // 1 query instead of 5 = 5x faster
  });

  afterAll(async () => {
    // Full cleanup only at end
    await cleanupTestDatabase();
    await disconnectTestDatabase();
  });

  it("creates first artifact with version 1", async () => {
    const artifact = await database.$transaction(async (tx) => {
      const scopeCondition = buildArtifactScopeCondition({
        projectId: testProjectId,
        type: "PRD",
        documentSlug: "test-doc",
      });

      const version = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          projectId: testProjectId,
          type: "PRD",
          title: "Test PRD",
          documentSlug: "test-doc",
          version,
          isLatest: true,
        },
      });
    });

    expect(artifact.version).toBe(1);
    expect(artifact.isLatest).toBe(true);
  });

  it("increments version and marks old as not latest", async () => {
    // Create first artifact
    const first = await database.artifact.create({
      data: {
        projectId: testProjectId,
        type: "PRD",
        title: "Test PRD v1",
        documentSlug: "test-doc",
        version: 1,
        isLatest: true,
      },
    });

    // Create second artifact with versioning
    const second = await database.$transaction(async (tx) => {
      const scopeCondition = buildArtifactScopeCondition({
        projectId: testProjectId,
        type: "PRD",
        documentSlug: "test-doc",
      });

      const version = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          projectId: testProjectId,
          type: "PRD",
          title: "Test PRD v2",
          documentSlug: "test-doc",
          version,
          isLatest: true,
        },
      });
    });

    expect(second.version).toBe(2);
    expect(second.isLatest).toBe(true);

    // Verify first artifact is no longer latest
    const updatedFirst = await database.artifact.findUnique({
      where: { id: first.id },
    });
    expect(updatedFirst?.isLatest).toBe(false);
  });

  it("rolls back transaction on error", async () => {
    // Create initial artifact
    await database.artifact.create({
      data: {
        projectId: testProjectId,
        type: "PRD",
        title: "Original",
        documentSlug: "rollback-test",
        version: 1,
        isLatest: true,
      },
    });

    // Attempt transaction that will fail (simulate database error by throwing)
    await expect(
      database.$transaction(async (tx) => {
        const scopeCondition = buildArtifactScopeCondition({
          projectId: testProjectId,
          type: "PRD",
          documentSlug: "rollback-test",
        });

        await prepareArtifactVersion(tx, scopeCondition);

        // Simulate a database constraint error
        throw new Error("Simulated database constraint error");
      })
    ).rejects.toThrow();

    // Verify original artifact is still marked as latest
    const artifacts = await database.artifact.findMany({
      where: { documentSlug: "rollback-test" },
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].isLatest).toBe(true);
    expect(artifacts[0].version).toBe(1);
  });

  it("preserves version history across multiple creates", async () => {
    // Create three versions sequentially
    const v1 = await database.artifact.create({
      data: {
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        title: "Version 1",
        documentSlug: "version-test",
        version: 1,
        isLatest: true,
      },
    });

    const v2 = await database.$transaction(async (tx) => {
      const scopeCondition = buildArtifactScopeCondition({
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        documentSlug: "version-test",
      });
      const version = await prepareArtifactVersion(tx, scopeCondition);
      return tx.artifact.create({
        data: {
          projectId: testProjectId,
          type: "IMPLEMENTATION_PLAN",
          title: "Version 2",
          documentSlug: "version-test",
          version,
          isLatest: true,
        },
      });
    });

    const v3 = await database.$transaction(async (tx) => {
      const scopeCondition = buildArtifactScopeCondition({
        projectId: testProjectId,
        type: "IMPLEMENTATION_PLAN",
        documentSlug: "version-test",
      });
      const version = await prepareArtifactVersion(tx, scopeCondition);
      return tx.artifact.create({
        data: {
          projectId: testProjectId,
          type: "IMPLEMENTATION_PLAN",
          title: "Version 3",
          documentSlug: "version-test",
          version,
          isLatest: true,
        },
      });
    });

    // Verify version numbers
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);

    // Verify only v3 is latest
    const allVersions = await database.artifact.findMany({
      where: { documentSlug: "version-test" },
      orderBy: { version: "asc" },
    });
    expect(allVersions[0].isLatest).toBe(false);
    expect(allVersions[1].isLatest).toBe(false);
    expect(allVersions[2].isLatest).toBe(true);
  });

  // EDGE CASES (added per test-strategist feedback)
  it("verifies transaction isolation prevents dirty reads", async () => {
    // Create artifact in transaction but wait before committing
    const txPromise = database.$transaction(async (tx) => {
      const artifact = await tx.artifact.create({
        data: {
          projectId: testProjectId,
          type: "PRD",
          title: "Isolation Test",
          documentSlug: "isolation-test",
          version: 1,
          isLatest: true,
        },
      });

      // Wait before committing
      await new Promise((resolve) => setTimeout(resolve, 200));
      return artifact;
    });

    // Immediately try to read from outside transaction
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outsideRead = await database.artifact.findFirst({
      where: { documentSlug: "isolation-test" },
    });

    // Should not see uncommitted data (null before tx commits)
    expect(outsideRead).toBeNull();

    // Wait for transaction to complete
    await txPromise;

    // Now should see committed data
    const afterCommit = await database.artifact.findFirst({
      where: { documentSlug: "isolation-test" },
    });
    expect(afterCommit).not.toBeNull();
    expect(afterCommit?.title).toBe("Isolation Test");
  });

  it("handles concurrent transactions on same record", async () => {
    // Create initial artifact
    await database.artifact.create({
      data: {
        projectId: testProjectId,
        type: "PRD",
        title: "Concurrent Test",
        documentSlug: "concurrent-test",
        version: 1,
        isLatest: true,
      },
    });

    // Simulate two concurrent updates
    const update1 = database.$transaction(async (tx) => {
      const artifact = await tx.artifact.findFirst({
        where: { documentSlug: "concurrent-test", isLatest: true },
      });

      // Simulate processing delay
      await new Promise((resolve) => setTimeout(resolve, 100));

      return tx.artifact.update({
        where: { id: artifact?.id },
        data: { title: "Updated by Transaction 1" },
      });
    });

    const update2 = database.$transaction(async (tx) => {
      const artifact = await tx.artifact.findFirst({
        where: { documentSlug: "concurrent-test", isLatest: true },
      });

      return tx.artifact.update({
        where: { id: artifact?.id },
        data: { title: "Updated by Transaction 2" },
      });
    });

    // Both transactions should complete without deadlock
    const results = await Promise.all([update1, update2]);
    expect(results).toHaveLength(2);

    // Verify final state (one of the updates won)
    const final = await database.artifact.findFirst({
      where: { documentSlug: "concurrent-test", isLatest: true },
    });
    expect(["Updated by Transaction 1", "Updated by Transaction 2"]).toContain(
      final?.title
    );
  });

  it("handles transaction timeout for slow operations", async () => {
    await expect(
      database.$transaction(
        async (tx) => {
          // Simulate slow operation exceeding timeout
          await new Promise((resolve) => setTimeout(resolve, 6000));
          return tx.artifact.create({
            data: {
              projectId: testProjectId,
              type: "PRD",
              title: "Timeout Test",
              documentSlug: "timeout-test",
              version: 1,
              isLatest: true,
            },
          });
        },
        { timeout: 5000 } // 5 second timeout
      )
    ).rejects.toThrow(TIMEOUT_REGEX);
  });
});
