/**
 * Integration tests for `artifactBulkRankService` (ISS-8999).
 *
 * Runs against a real Postgres because the properties under test are
 * properties of the database, not of the service's control flow: that a
 * mid-operation failure rolls the claim row back together with the rank
 * rewrite, that the `(organization, project, idempotency key)` unique index
 * decides a single winner between concurrent claimants, that the project rank
 * lock stops two DIFFERENT idempotency keys from overwriting one another, and
 * that the rank rewrite reaches only DOCUMENT roots of the caller's own
 * organization.
 *
 * NOT `autoRollbackTransaction`. That helper wraps a case in an ambient
 * transaction, and `withDb.tx` JOINS an ambient transaction instead of opening
 * a savepoint — so the service's own transaction boundary disappears and the
 * rollback, the isolation level, and the advisory lock this suite exists to
 * prove all become properties of the harness rather than of the service. The
 * partial-failure case measured that directly: it asserted zero surviving claim
 * rows and got one. Each case commits and is cleaned up by
 * `createCommittedTestOrganizationTracker`, which is the shape the repo already
 * uses when the production entry point must own its transaction boundary.
 *
 * The control-flow half — conflict classification, replay routing — is covered
 * without a database in `app/documents/__tests__/artifact-bulk-rank-service.test.ts`.
 */

import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  BulkRankConflictReason,
  BulkRankMutationSource,
} from "@repo/api/src/types/project-artifact-bulk-rank";
import { Status } from "@repo/api/src/types/result";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactBulkRankService } from "@/app/documents/artifact-bulk-rank-service";
import { documentService } from "@/app/documents/document-service";
import { generateSlug } from "@/app/documents/document-utils";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

const IDEMPOTENCY_KEY = "bulk-rank-integration-1";

const organizations = createCommittedTestOrganizationTracker();

type Tenant = {
  organizationId: string;
  projectId: string;
  userId: string;
  rootIds: string[];
};

async function seedTenant(rootCount: number): Promise<Tenant> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  const rootIds: string[] = [];
  for (let index = 0; index < rootCount; index += 1) {
    const artifact = await createArtifact({
      organizationId,
      projectId,
      createdById: user.id,
      name: `Root ${index}`,
      sortOrder: index * 1000,
    });
    rootIds.push(artifact.id);
  }
  return { organizationId, projectId, userId: user.id, rootIds };
}

function createArtifact(input: {
  organizationId: string;
  projectId: string;
  createdById: string;
  name: string;
  sortOrder: number | null;
  type?: ArtifactType;
}): Promise<{ id: string }> {
  return withDb((db) =>
    db.artifact.create({
      data: {
        name: input.name,
        slug: generateSlug(),
        type: input.type ?? ArtifactType.DOCUMENT,
        subtype:
          (input.type ?? ArtifactType.DOCUMENT) === ArtifactType.DOCUMENT
            ? ArtifactSubtype.PRD
            : null,
        status: DocumentStatus.Draft,
        organizationId: input.organizationId,
        createdById: input.createdById,
        projectId: input.projectId,
        sortOrder: input.sortOrder,
      },
      select: { id: true },
    })
  );
}

function readSortOrders(
  ids: readonly string[]
): Promise<Map<string, number | null>> {
  return withDb(async (db) => {
    const rows = await db.artifact.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, sortOrder: true },
    });
    return new Map(rows.map((row) => [row.id, row.sortOrder]));
  });
}

function countRankEvents(projectId: string): Promise<number> {
  return withDb((db) => db.projectRankEvent.count({ where: { projectId } }));
}

function bulkRank(
  tenant: Tenant,
  orderedArtifactIds: string[],
  expectedRankEpoch: string,
  idempotencyKey = IDEMPOTENCY_KEY
) {
  return artifactBulkRankService.bulkRankArtifacts(
    tenant.projectId,
    tenant.organizationId,
    {
      orderedArtifactIds,
      expectedRankEpoch,
      source: BulkRankMutationSource.DependencyRank,
      idempotencyKey,
    },
    tenant.userId
  );
}

describe.skipIf(!hasDatabase)("artifactBulkRankService (Postgres)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await organizations.cleanup();
  });

  it("commits every rank and one bulk rank event in a single transaction", async () => {
    const tenant = await seedTenant(4);
    const { rankEpoch } = await artifactBulkRankService.getRankState(
      tenant.projectId,
      tenant.organizationId
    );
    const desired = [...tenant.rootIds].reverse();

    const result = await bulkRank(tenant, desired, rankEpoch);

    expect(result.ok).toBe(true);
    const sortOrders = await readSortOrders(desired);
    expect(desired.map((id) => sortOrders.get(id))).toEqual([
      0, 1000, 2000, 3000,
    ]);
    expect(await countRankEvents(tenant.projectId)).toBe(1);
  });

  it("moves no rank and leaves no event behind when the rewrite fails", async () => {
    const tenant = await seedTenant(3);
    const { rankEpoch } = await artifactBulkRankService.getRankState(
      tenant.projectId,
      tenant.organizationId
    );
    const before = await readSortOrders(tenant.rootIds);
    // Fail AFTER the claim row has been inserted, so the assertions below are
    // about Postgres rolling that insert back — not about the service having
    // skipped it.
    vi.spyOn(documentService, "reorder").mockRejectedValueOnce(
      new Error("simulated mid-operation failure")
    );

    await expect(
      bulkRank(tenant, [...tenant.rootIds].reverse(), rankEpoch)
    ).rejects.toThrow("simulated mid-operation failure");

    const after = await readSortOrders(tenant.rootIds);
    for (const id of tenant.rootIds) {
      expect(after.get(id)).toBe(before.get(id));
    }
    expect(await countRankEvents(tenant.projectId)).toBe(0);
  });

  it("lets exactly one concurrent claimant of a key apply the rewrite", async () => {
    const tenant = await seedTenant(3);
    const { rankEpoch } = await artifactBulkRankService.getRankState(
      tenant.projectId,
      tenant.organizationId
    );
    const desired = [...tenant.rootIds].reverse();

    const [first, second] = await Promise.all([
      bulkRank(tenant, desired, rankEpoch),
      bulkRank(tenant, desired, rankEpoch),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!(first.ok && second.ok)) {
      throw new Error("expected both requests to resolve");
    }
    expect(second.value.rankEpoch).toBe(first.value.rankEpoch);
    expect(second.value.orderedArtifactIds).toEqual(
      first.value.orderedArtifactIds
    );
    // The unique index admitted one operation, so the ranks were written once.
    expect(await countRankEvents(tenant.projectId)).toBe(1);
    expect([first.value.replayed, second.value.replayed].sort()).toEqual([
      false,
      true,
    ]);
  });

  it("refuses the loser of a race between two DIFFERENT idempotency keys", async () => {
    // The unique index only serializes callers that share a key. Two keys are
    // two different claims, so before the project rank lock both requests read
    // the same epoch, both validated, both rewrote every root, and BOTH were
    // answered 200 — with the second silently discarding the first. Distinct
    // ORDERS here so a lost update is visible in `sort_order` and not only in
    // the response.
    const tenant = await seedTenant(3);
    const { rankEpoch } = await artifactBulkRankService.getRankState(
      tenant.projectId,
      tenant.organizationId
    );
    const reversed = [...tenant.rootIds].reverse();
    const rotated = [
      tenant.rootIds[1] as string,
      tenant.rootIds[2] as string,
      tenant.rootIds[0] as string,
    ];

    const [first, second] = await Promise.all([
      bulkRank(tenant, reversed, rankEpoch, "race-key-a"),
      bulkRank(tenant, rotated, rankEpoch, "race-key-b"),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    if (!loser || loser.ok) {
      throw new Error("expected exactly one refusal");
    }
    expect(loser.error.status).toBe(Status.Conflict);
    expect(loser.error.conflict?.reason).toBe(
      BulkRankConflictReason.StaleEpoch
    );

    // Only the winner's claim row exists, and the committed order is the
    // winner's — not a blend of the two and not the loser's.
    expect(await countRankEvents(tenant.projectId)).toBe(1);
    const winner = winners[0];
    if (!winner?.ok) {
      throw new Error("expected exactly one success");
    }
    const sortOrders = await readSortOrders(tenant.rootIds);
    expect(
      winner.value.orderedArtifactIds.map((id) => sortOrders.get(id))
    ).toEqual([0, 1000, 2000]);
  });

  it("replays a committed result for a repeated key even from a stale epoch", async () => {
    const tenant = await seedTenant(3);
    const { rankEpoch } = await artifactBulkRankService.getRankState(
      tenant.projectId,
      tenant.organizationId
    );
    const desired = [...tenant.rootIds].reverse();
    const first = await bulkRank(tenant, desired, rankEpoch);

    const retry = await bulkRank(tenant, desired, rankEpoch);

    expect(retry.ok && retry.value.replayed).toBe(true);
    expect(first.ok && retry.ok && retry.value.rankEpoch).toBe(
      first.ok ? first.value.rankEpoch : "unreachable"
    );
    expect(await countRankEvents(tenant.projectId)).toBe(1);
  });

  it("rejects a stale epoch without writing anything", async () => {
    const tenant = await seedTenant(3);
    const before = await readSortOrders(tenant.rootIds);

    const result = await bulkRank(
      tenant,
      [...tenant.rootIds].reverse(),
      "0".repeat(32)
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.status).toBe(Status.Conflict);
    expect(result.error.conflict?.reason).toBe(
      BulkRankConflictReason.StaleEpoch
    );
    const after = await readSortOrders(tenant.rootIds);
    for (const id of tenant.rootIds) {
      expect(after.get(id)).toBe(before.get(id));
    }
    expect(await countRankEvents(tenant.projectId)).toBe(0);
  });

  it("reports a reparented root and leaves the order untouched", async () => {
    const tenant = await seedTenant(3);
    const staleOrder = [...tenant.rootIds];
    const { rankEpoch } = await artifactBulkRankService.getRankState(
      tenant.projectId,
      tenant.organizationId
    );
    const reparented = staleOrder[2] as string;
    await withDb((db) =>
      db.artifactLink.create({
        data: {
          organizationId: tenant.organizationId,
          sourceId: staleOrder[0] as string,
          targetId: reparented,
          linkType: LinkType.Produces,
        },
      })
    );

    const result = await bulkRank(tenant, staleOrder, rankEpoch);

    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.conflict?.reason).toBe(
      BulkRankConflictReason.PopulationMismatch
    );
    expect(result.error.conflict?.reparentedArtifactIds).toEqual([reparented]);
    expect(await countRankEvents(tenant.projectId)).toBe(0);
  });

  it("preserves nested documents and non-DOCUMENT roots", async () => {
    const tenant = await seedTenant(2);
    const nested = await createArtifact({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      createdById: tenant.userId,
      name: "Nested",
      sortOrder: 777,
    });
    const branch = await createArtifact({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      createdById: tenant.userId,
      name: "Branch",
      sortOrder: 888,
      type: ArtifactType.BRANCH,
    });
    await withDb((db) =>
      db.artifactLink.create({
        data: {
          organizationId: tenant.organizationId,
          sourceId: tenant.rootIds[0] as string,
          targetId: nested.id,
          linkType: LinkType.Produces,
        },
      })
    );
    const { rankEpoch } = await artifactBulkRankService.getRankState(
      tenant.projectId,
      tenant.organizationId
    );

    const result = await bulkRank(
      tenant,
      [...tenant.rootIds].reverse(),
      rankEpoch
    );

    expect(result.ok).toBe(true);
    const sortOrders = await readSortOrders([nested.id, branch.id]);
    expect(sortOrders.get(nested.id)).toBe(777);
    expect(sortOrders.get(branch.id)).toBe(888);
  });

  it("cannot rank another organization's roots", async () => {
    // BOTH tenants are seeded: an empty answer for tenant B would otherwise
    // be indistinguishable from an empty fixture.
    const tenantA = await seedTenant(3);
    const tenantB = await seedTenant(3);
    const beforeB = await readSortOrders(tenantB.rootIds);
    const stateB = await artifactBulkRankService.getRankState(
      tenantB.projectId,
      tenantB.organizationId
    );
    expect(stateB.orderedRootIds).toEqual(tenantB.rootIds);

    // Tenant A's organization, tenant B's project and ids.
    const result = await artifactBulkRankService.bulkRankArtifacts(
      tenantB.projectId,
      tenantA.organizationId,
      {
        orderedArtifactIds: [...tenantB.rootIds].reverse(),
        expectedRankEpoch: stateB.rankEpoch,
        source: BulkRankMutationSource.DependencyRank,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
      tenantA.userId
    );

    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.status).toBe(Status.Conflict);
    expect(result.error.conflict?.removedArtifactIds).toEqual(
      [...tenantB.rootIds].reverse()
    );
    const afterB = await readSortOrders(tenantB.rootIds);
    for (const id of tenantB.rootIds) {
      expect(afterB.get(id)).toBe(beforeB.get(id));
    }
    expect(await countRankEvents(tenantB.projectId)).toBe(0);
  });
});
