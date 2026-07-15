import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { autoRollbackTransaction } from "@/__tests__/utils/db-helpers";
import { seedTwoOrgFixture } from "@/__tests__/utils/two-org-fixture";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { branchReadService } from "@/app/branches/branch-read-service";

/**
 * FEA-2734 Phase 4 — cross-tenant read isolation over the PRD-510 read surfaces.
 *
 * Two orgs A/B share IDENTICAL repo full name, branch name, session external id,
 * and commit sha (the adversarial D2/Q10 dedup-key case). Every org-A read must
 * see ONLY org-A rows, and a deep-link probe carrying org B's id must resolve to
 * nothing (404) rather than leak org B's data. Real Postgres because it exercises
 * the actual query boundaries the routes call.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const LIST_QUERY = { limit: 50, offset: 0 } as const;

describeIfDb("org-scope read isolation across two tenants (FEA-2734)", () => {
  it("lists only the caller org's branch even when the other org's branch is identically named", async () => {
    await autoRollbackTransaction(async () => {
      const { orgA, orgB } = await seedTwoOrgFixture();

      const listA = await branchReadService.listBranches(
        orgA.organizationId,
        LIST_QUERY
      );
      const idsA = listA.items.map((item) => item.id);
      expect(idsA).toEqual([orgA.branchArtifactId]);
      expect(idsA).not.toContain(orgB.branchArtifactId);
      expect(listA.total).toBe(1);
    });
  });

  it("returns null for a branch-detail deep link carrying the other org's id", async () => {
    await autoRollbackTransaction(async () => {
      const { orgA, orgB } = await seedTwoOrgFixture();

      // Cross-org probe → not owned → null (the route maps this to 404).
      await expect(
        branchReadService.getBranchDetail(
          orgA.organizationId,
          orgB.branchArtifactId
        )
      ).resolves.toBeNull();
      // Same-org control resolves.
      const own = await branchReadService.getBranchDetail(
        orgA.organizationId,
        orgA.branchArtifactId
      );
      expect(own?.id).toBe(orgA.branchArtifactId);
    });
  });

  it("counts only the caller org's branches in the usage aggregate", async () => {
    await autoRollbackTransaction(async () => {
      const { orgA } = await seedTwoOrgFixture();

      const usageA = await branchReadService.getBranchUsage(
        orgA.organizationId,
        LIST_QUERY
      );
      // Never 2 — org B's identically-keyed branch must not be aggregated in.
      expect(usageA.totalBranches).toBe(1);
    });
  });

  it("returns null for a session deep link carrying the other org's id and isolates its token events", async () => {
    await autoRollbackTransaction(async () => {
      const { orgA, orgB } = await seedTwoOrgFixture();

      await expect(
        agentSessionsService.findSessionDetail({
          id: orgB.sessionArtifactId,
          organizationId: orgA.organizationId,
        })
      ).resolves.toBeNull();
      const own = await agentSessionsService.findSessionDetail({
        id: orgA.sessionArtifactId,
        organizationId: orgA.organizationId,
      });
      expect(own?.id).toBe(orgA.sessionArtifactId);

      // Token analytics accessor is join-reached (session → artifact → org):
      // org A cannot read org B's session's token events.
      const crossOrgEvents = await agentSessionsService.getSessionTokenEvents({
        organizationId: orgA.organizationId,
        sessionArtifactId: orgB.sessionArtifactId,
      });
      expect(crossOrgEvents).toHaveLength(0);
      const ownEvents = await agentSessionsService.getSessionTokenEvents({
        organizationId: orgA.organizationId,
        sessionArtifactId: orgA.sessionArtifactId,
      });
      expect(ownEvents).toHaveLength(1);
    });
  });
});
