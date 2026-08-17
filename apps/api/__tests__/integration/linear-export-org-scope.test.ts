/**
 * FEA-1749 Phase 5 — behavioural org-scoping of the Linear export lookup.
 *
 * The unit suite (`__tests__/unit/linear-service-org-scope.test.ts`) pins the
 * WHERE CLAUSE the service builds. It cannot prove what Postgres does with that
 * clause, because its Prisma is a mock. This suite is the counterpart: real
 * rows, real relation semantics.
 *
 * The fix swapped an authorization predicate (`project: { organizationId }` →
 * `organizationId`). Scoping on `Artifact.organizationId` is strictly more
 * correct — it is non-null and is the org SSOT per PRD-510 FR13 — but "more
 * correct" is an argument, not evidence. The test below is the evidence that it
 * did not widen access.
 *
 * The matching positive case ("an unparented plan resolves") was deferred when
 * Phase 5 shipped: the `artifacts_non_session_project_required` CHECK made a
 * DOCUMENT with `project_id = NULL` literally un-insertable, so the row the test
 * needed could not exist. Phase 1 dropped that CHECK, so it lives here now — it
 * is the case the org-scoping fix was made FOR.
 */

import { randomUUID } from "node:crypto";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linearService } from "@/app/integrations/linear/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// Mock encryption to avoid requiring AWS_REGION / KMS in CI.
vi.mock("@/lib/integration-encryption", () => ({
  encryptIntegrationToken: vi.fn().mockResolvedValue("mock-encrypted-token"),
  decryptIntegrationToken: vi
    .fn()
    .mockImplementation((token: string) => Promise.resolve(token)),
  resolveIntegrationToken: vi
    .fn()
    .mockImplementation(
      (_encrypted: string | null | undefined, plaintext: string | null) =>
        Promise.resolve(plaintext)
    ),
  encryptTokenPair: vi.fn().mockResolvedValue({
    encryptedAccessToken: "mock-encrypted-access",
    encryptedRefreshToken: "mock-encrypted-refresh",
  }),
}));

async function seedApprovedPlan(
  organizationId: string,
  options: { parented?: boolean } = {}
): Promise<string> {
  const user = await createTestUser(organizationId);
  const parented = options.parented ?? true;
  const projectId = parented
    ? await createTestProject(organizationId, user.id)
    : null;

  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        projectId,
        createdById: user.id,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
        name: "Cross-org export probe",
        slug: `PLN-probe-${randomUUID().slice(0, 8)}`,
        // Artifact.status is a freeform column carrying several disjoint
        // vocabularies, so the TS constant is the only contract there is — and
        // it is the one exportImplementationPlan gates on.
        status: DocumentStatus.Approved,
      },
    })
  );

  return artifact.id;
}

describe.skipIf(!hasDatabase)(
  "Linear export org-scoping (FEA-1749 Phase 5)",
  () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it("does not resolve a plan belonging to another organization", async () => {
      await autoRollbackTransaction(async () => {
        const ownerOrgId = await createTestOrganization();
        const attackerOrgId = await createTestOrganization();

        // The plan exists, is APPROVED, and is exportable — but it is owned by
        // ownerOrg. attackerOrg supplying its id must learn nothing.
        const planId = await seedApprovedPlan(ownerOrgId);

        const result = await linearService.exportImplementationPlan(
          planId,
          "team-irrelevant",
          attackerOrgId,
          "user-irrelevant"
        );

        // Not-found, not 403: existence is itself org-scoped information
        // (see lib/org-scope.ts — cross-org and missing collapse to one outcome).
        expect(result).toMatchObject({
          success: false,
          error: "Artifact not found",
          status: 404,
        });
      });
    });

    it("resolves an UNPARENTED plan (project_id IS NULL) — the case the fix was for", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        // Only insertable since Phase 1 dropped
        // artifacts_non_session_project_required.
        const planId = await seedApprovedPlan(orgId, { parented: false });

        const result = await linearService.exportImplementationPlan(
          planId,
          "team-irrelevant",
          orgId,
          "user-irrelevant"
        );

        // The old `where: { project: { organizationId } }` was an implicit inner
        // join: with no Project row to join to, this artifact resolved to null
        // and the route 404'd on a document the org owns. Getting to the NEXT
        // gate is the proof that no longer happens.
        expect(result).not.toMatchObject({ error: "Artifact not found" });
        expect(result).toMatchObject({
          success: false,
          error: "Artifact has no content to export",
          status: 400,
        });
      });
    });

    it("resolves a plan owned by the caller's organization", async () => {
      await autoRollbackTransaction(async () => {
        const orgId = await createTestOrganization();
        const planId = await seedApprovedPlan(orgId);

        const result = await linearService.exportImplementationPlan(
          planId,
          "team-irrelevant",
          orgId,
          "user-irrelevant"
        );

        // Control for the test above: same call shape, same seeded row, only the
        // caller's org differs. It must get PAST the artifact lookup — proving
        // the 404 above is org isolation and not merely a query that never
        // matches anything. Stopping at the NEXT gate (no ArtifactVersion seeded,
        // so there is no content to export) is what "got past" looks like here.
        expect(result).toMatchObject({
          success: false,
          error: "Artifact has no content to export",
          status: 400,
        });
      });
    });
  }
);
