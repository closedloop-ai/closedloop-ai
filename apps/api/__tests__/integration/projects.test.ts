import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { projectsService } from "@/app/projects/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = !!keys().DATABASE_URL;

describe.skipIf(!hasDatabase)("projectsService.findBySlug Integration", () => {
  it("returns project when slug matches within organization", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      const projectId = await createTestProject(orgId, user.id, {
        slug: "PROJ-1",
      });

      const found = await projectsService.findBySlug("PROJ-1", orgId);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(projectId);
      expect(found?.slug).toBe("PROJ-1");
    });
  });

  it("returns null when slug does not exist in organization", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();

      const found = await projectsService.findBySlug("PROJ-nonexistent", orgId);

      expect(found).toBeNull();
    });
  });

  it("returns null for empty slug without querying the database", async () => {
    await autoRollbackTransaction(async () => {
      const orgId = await createTestOrganization();
      const user = await createTestUser(orgId);
      await createTestProject(orgId, user.id, { slug: "PROJ-1" });

      const found = await projectsService.findBySlug("", orgId);

      expect(found).toBeNull();
    });
  });

  it("does not return project belonging to a different organization", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await createTestOrganization({
        clerkId: "org_a",
        slug: "org-a",
      });
      const orgB = await createTestOrganization({
        clerkId: "org_b",
        slug: "org-b",
      });
      const userA = await createTestUser(orgA, {
        clerkId: "clerk_a",
        email: "a@example.com",
      });

      await createTestProject(orgA, userA.id, { slug: "PROJ-1" });

      const found = await projectsService.findBySlug("PROJ-1", orgB);

      expect(found).toBeNull();
    });
  });
});
