import type { CreateRoutineInput } from "@repo/api/src/types/routine";
import {
  createRoutineInputSchema,
  RoutineProvider,
  RoutineRunStatus,
  RoutineStatus,
  recordRoutineRunInputSchema,
} from "@repo/api/src/types/routine";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
} from "@/__tests__/utils/db-helpers";
import { routinesService } from "@/app/routines/service";

/**
 * FEA-4365 / PRD-566 — cross-tenant isolation for the cloud Routines store.
 *
 * Two orgs A/B each own an identically-named routine. Every org-A read must see
 * ONLY org-A rows, and a deep-link / mutation probe carrying org B's routine id
 * must resolve to nothing (route → 404) rather than leak or mutate org B's data.
 * Real Postgres because it exercises the actual query predicates the service
 * uses — an org-scoping regression fails HERE, not in a mock.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const SHARED_NAME = "Open PRs summary";

function routineInput(): CreateRoutineInput {
  return createRoutineInputSchema.parse({
    name: SHARED_NAME,
    provider: RoutineProvider.Claude,
    modelId: "opus-4-8",
    status: RoutineStatus.Active,
  });
}

async function seedTwoOrgs() {
  const orgA = await createTestOrganization();
  const orgB = await createTestOrganization();
  const routineA = await routinesService.createRoutine(orgA, routineInput());
  const routineB = await routinesService.createRoutine(orgB, routineInput());
  if (!(routineA && routineB)) {
    throw new Error("seed failed: createRoutine returned null");
  }
  return { orgA, orgB, routineA, routineB };
}

describeIfDb(
  "routines org-scope isolation across two tenants (FEA-4365)",
  () => {
    it("lists only the caller org's routine even when the other org's is identically named", async () => {
      await autoRollbackTransaction(async () => {
        const { orgA, routineA, routineB } = await seedTwoOrgs();

        const listA = await routinesService.listRoutines({
          organizationId: orgA,
        });
        const idsA = listA.items.map((item) => item.id);
        expect(idsA).toEqual([routineA.id]);
        expect(idsA).not.toContain(routineB.id);
        expect(listA.total).toBe(1);
      });
    });

    it("returns null reading a routine deep link carrying the other org's id", async () => {
      await autoRollbackTransaction(async () => {
        const { orgA, routineA, routineB } = await seedTwoOrgs();

        await expect(
          routinesService.getRoutine(orgA, routineB.id)
        ).resolves.toBeNull();
        const own = await routinesService.getRoutine(orgA, routineA.id);
        expect(own?.id).toBe(routineA.id);
      });
    });

    it("refuses to update or delete the other org's routine", async () => {
      await autoRollbackTransaction(async () => {
        const { orgA, routineB } = await seedTwoOrgs();

        // Cross-org update → nothing matched → null, and org B's row is untouched.
        await expect(
          routinesService.updateRoutine(orgA, routineB.id, {
            status: RoutineStatus.Paused,
          })
        ).resolves.toBeNull();
        const bStillActive = await routinesService.getRoutine(
          // Read as org B to confirm no mutation leaked across.
          routineB.organizationId,
          routineB.id
        );
        expect(bStillActive?.status).toBe(RoutineStatus.Active);

        // Cross-org delete → no row removed.
        await expect(
          routinesService.deleteRoutine(orgA, routineB.id)
        ).resolves.toBe(false);
        expect(
          await routinesService.getRoutine(routineB.organizationId, routineB.id)
        ).not.toBeNull();
      });
    });

    it("refuses to record a run against the other org's routine, and isolates run history", async () => {
      await autoRollbackTransaction(async () => {
        const { orgA, orgB, routineA, routineB } = await seedTwoOrgs();

        // Give each org's routine one run.
        await routinesService.recordRun(
          orgA,
          routineA.id,
          recordRoutineRunInputSchema.parse({
            status: RoutineRunStatus.Success,
            summary: "A",
          })
        );
        await routinesService.recordRun(
          orgB,
          routineB.id,
          recordRoutineRunInputSchema.parse({
            status: RoutineRunStatus.Success,
            summary: "B",
          })
        );

        // Org A cannot record against org B's routine.
        await expect(
          routinesService.recordRun(
            orgA,
            routineB.id,
            recordRoutineRunInputSchema.parse({
              status: RoutineRunStatus.Failed,
            })
          )
        ).resolves.toBeNull();

        // Org A cannot list org B's routine's runs (org predicate on listRuns).
        const crossOrg = await routinesService.listRuns({
          organizationId: orgA,
          routineId: routineB.id,
        });
        expect(crossOrg.total).toBe(0);

        const ownRuns = await routinesService.listRuns({
          organizationId: orgA,
          routineId: routineA.id,
        });
        expect(ownRuns.total).toBe(1);
        expect(ownRuns.items[0]?.summary).toBe("A");
      });
    });
  }
);
