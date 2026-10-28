import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { tagService } from "@/app/tags/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = !!keys().DATABASE_URL;

/**
 * ISS-7461: `tagService.findByExactName` is raw SQL matched against the
 * `tags_organization_id_name_ci_key` expression index
 * (`(organization_id, lower(name))`) — a unit test with a mocked `$queryRaw`
 * can assert the statement's shape, but only a real Postgres proves the
 * statement actually EXECUTES against that index and that `lower(...)`
 * really does fold case.
 */
describe.skipIf(!hasDatabase)(
  "tagService.findByExactName Integration (ISS-7461)",
  () => {
    it("finds a tag by exact, case-insensitive name", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        const created = await tagService.create(orgId, user.id, {
          name: "DSP",
        });

        const found = await tagService.findByExactName(orgId, "dsp");

        expect(found).not.toBeNull();
        expect(found?.id).toBe(created.id);
        expect(found?.name).toBe("DSP");
      });
    });

    it("returns null when no tag matches the name", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const user = await createTestUser(orgId);
        await tagService.create(orgId, user.id, { name: "DSP" });

        const found = await tagService.findByExactName(orgId, "nope");

        expect(found).toBeNull();
      });
    });

    it("does not return a same-named tag belonging to a different organization", async () => {
      await autoRollbackTransaction(async () => {
        const orgA = await createTestOrganization();
        const orgB = await createTestOrganization();
        const userA = await createTestUser(orgA);
        const userB = await createTestUser(orgB);
        await tagService.create(orgA, userA.id, { name: "DSP" });
        const createdB = await tagService.create(orgB, userB.id, {
          name: "DSP",
        });

        const found = await tagService.findByExactName(orgB, "dsp");

        expect(found?.id).toBe(createdB.id);
        expect(found?.organizationId).toBe(orgB);
      });
    });
  }
);
