import { keys } from "@repo/database/keys";
import { workstreamsService } from "@/app/workstreams/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

// Skip integration tests if no DATABASE_URL is configured
const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)("Workstreams Service Integration", () => {
  it("updates stateChangedAt when state changes", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);
      const testUser = await createTestUser(testOrgId);

      // Create workstream with initial state
      const workstream = await workstreamsService.create(testUser.id, {
        projectId: testProjectId,
        title: "Test Workstream",
        description: "Test description",
        type: "FEATURE_DELIVERY",
      });

      const originalStateChangedAt = workstream.stateChangedAt;
      expect(workstream.state).toBe("INITIATED"); // Default state

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update state to trigger stateChangedAt update
      const updated = await workstreamsService.update(workstream.id, {
        state: "IMPLEMENTATION_IN_PROGRESS",
      });

      expect(updated.state).toBe("IMPLEMENTATION_IN_PROGRESS");
      expect(updated.stateChangedAt).not.toEqual(originalStateChangedAt);
      expect(updated.stateChangedAt.getTime()).toBeGreaterThan(
        originalStateChangedAt.getTime()
      );
    });
  });

  it("does not update stateChangedAt when state is not changed", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);
      const testUser = await createTestUser(testOrgId);

      // Create workstream
      const workstream = await workstreamsService.create(testUser.id, {
        projectId: testProjectId,
        title: "Test Workstream",
        description: "Original description",
      });

      const originalStateChangedAt = workstream.stateChangedAt;

      // Wait a bit to ensure timestamp difference would be visible
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update other fields but not state
      const updated = await workstreamsService.update(workstream.id, {
        title: "Updated Title",
        description: "Updated description",
      });

      expect(updated.title).toBe("Updated Title");
      expect(updated.description).toBe("Updated description");
      // stateChangedAt should not change when state is not updated
      expect(updated.stateChangedAt.getTime()).toBe(
        originalStateChangedAt.getTime()
      );
    });
  });

  it("finds workstreams by project with filters", async () => {
    await autoRollbackTransaction(async () => {
      const testOrgId = await createTestOrganization();
      const testProjectId = await createTestProject(testOrgId);
      const testUser = await createTestUser(testOrgId);

      // Create multiple workstreams
      await workstreamsService.create(testUser.id, {
        projectId: testProjectId,
        title: "Feature A",
        description: "First feature",
      });

      const ws2 = await workstreamsService.create(testUser.id, {
        projectId: testProjectId,
        title: "Feature B",
        description: "Second feature",
      });

      // Update one to IMPLEMENTATION_IN_PROGRESS state
      await workstreamsService.update(ws2.id, {
        state: "IMPLEMENTATION_IN_PROGRESS",
      });

      await workstreamsService.create(testUser.id, {
        projectId: testProjectId,
        title: "Bug Fix C",
        description: "Third item",
      });

      // Find all workstreams
      const all = await workstreamsService.findByProject({
        projectId: testProjectId,
      });
      expect(all).toHaveLength(3);

      // Find only IMPLEMENTATION_IN_PROGRESS workstreams
      const inProgress = await workstreamsService.findByProject({
        projectId: testProjectId,
        state: "IMPLEMENTATION_IN_PROGRESS",
      });
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0].title).toBe("Feature B");

      // Search by title
      const searchResults = await workstreamsService.findByProject({
        projectId: testProjectId,
        search: "Feature",
      });
      expect(searchResults).toHaveLength(2);
      expect(
        searchResults.map((ws) => ws.title).sort((a, b) => a.localeCompare(b))
      ).toEqual(["Feature A", "Feature B"]);

      // Limit results
      const limited = await workstreamsService.findByProject({
        projectId: testProjectId,
        limit: 2,
      });
      expect(limited).toHaveLength(2);
    });
  });
});
