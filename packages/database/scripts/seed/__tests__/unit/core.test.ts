/**
 * TS-U.3, TS-U.5: Unit tests for seed/core.ts
 *
 * Covers:
 *  TS-U.3  seedCoreEntities — upserts one Team, at least 2 Projects,
 *          and one SlugCounter per prefix (PRO, PRD, PLN, FEA)
 *  TS-U.5  seedArtifacts (called internally) — covers all ArtifactType values
 *          (DOCUMENT, BRANCH, DEPLOYMENT) and all DocumentStatus values
 *
 * TS-U.4 (seedWorkstreams covers all WorkstreamState values) was removed in
 * PLN-787 — workstream seeding is gone.
 *
 * All Prisma calls are mocked; no database connection is required.
 */

import { describe, expect, it } from "vitest";
import {
  ArtifactSubtype,
  ArtifactType,
  DocumentStatus,
} from "../../../../generated/client";
import { seedCoreEntities } from "../../core";
import {
  DEFAULT_SEED_PROFILE,
  getSeedTargetRanges,
  resolveSeedRunPlan,
  SEED_PROFILES,
  SeedProfileName,
} from "../../profiles";
import { baselineContext } from "../fixtures/baseline-org";
import { countBy } from "../fixtures/count-by";
import { createMockPrisma } from "../fixtures/mock-prisma";

// Shorthand: access the mock's call records without fighting Prisma's fluent types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDelegate = any;

function buildReadyMock() {
  const prisma = createMockPrisma();
  const p = prisma as AnyDelegate;

  p.team.findUnique.mockResolvedValue(null);
  p.teamMember.findUnique.mockResolvedValue(null);
  p.project.findUnique.mockResolvedValue(null);
  p.slugCounter.findUnique.mockResolvedValue(null);
  p.artifact.findUnique.mockResolvedValue(null);
  p.gitHubInstallation.findUnique.mockResolvedValue(null);
  p.gitHubInstallationRepository.findUnique.mockResolvedValue(null);

  p.team.upsert.mockImplementation((args: AnyDelegate) =>
    Promise.resolve({ id: args.create.id as string })
  );
  p.teamMember.upsert.mockResolvedValue({ id: "tm1" });
  p.project.upsert.mockImplementation((args: AnyDelegate) =>
    Promise.resolve({ id: args.create.id as string })
  );
  p.slugCounter.upsert.mockResolvedValue({ id: "sc1" });
  p.artifact.upsert.mockImplementation((args: AnyDelegate) =>
    Promise.resolve({ id: args.create.id as string })
  );
  p.gitHubInstallation.upsert.mockResolvedValue({ id: "gh-inst" });
  p.gitHubInstallationRepository.upsert.mockResolvedValue({ id: "gh-repo" });

  return { prisma, p };
}

// TS-U.3: Team, Projects, SlugCounters
describe("seedCoreEntities — Team, Projects, SlugCounters (TS-U.3)", () => {
  it("upserts exactly one Team row", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);
    expect(p.team.upsert).toHaveBeenCalledOnce();
  });

  it("upserts at least 2 Project rows", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);
    expect(p.project.upsert.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("upserts a SlugCounter for every required prefix", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);

    const requiredPrefixes = ["PRO", "PRD", "PLN", "FEA"];
    const calledPrefixes = (
      p.slugCounter.upsert.mock.calls as AnyDelegate[]
    ).map((call: AnyDelegate) => call[0].create.typePrefix as string);

    for (const prefix of requiredPrefixes) {
      expect(calledPrefixes).toContain(prefix);
    }
  });

  it("scopes all Team and Project rows to the baseline organizationId", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);

    for (const call of p.team.upsert.mock.calls as AnyDelegate[]) {
      expect(call[0].create.organizationId).toBe(
        baselineContext.organizationId
      );
    }
    for (const call of p.project.upsert.mock.calls as AnyDelegate[]) {
      expect(call[0].create.organizationId).toBe(
        baselineContext.organizationId
      );
    }
  });

  it("returns teamId and local profile projectIds by default", async () => {
    const { prisma } = buildReadyMock();
    const result = await seedCoreEntities(prisma as any, baselineContext);
    expect(result.teamId).toBeDefined();
    expect(result.projectIds).toHaveLength(
      SEED_PROFILES[DEFAULT_SEED_PROFILE].projects
    );
    expect(result.projectIds[0]).not.toBe(result.projectIds[1]);
  });

  it("creates exactly one project for the minimal profile", async () => {
    const { prisma } = buildReadyMock();
    const result = await seedCoreEntities(
      prisma as any,
      baselineContext,
      resolveSeedRunPlan({ profile: SeedProfileName.Minimal })
    );
    expect(result.projectIds).toHaveLength(1);
  });
});

// TS-U.5: seedArtifacts (called inside seedCoreEntities)
describe("seedCoreEntities — Artifacts (TS-U.5)", () => {
  it("creates artifact upserts covering every ArtifactType value", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);

    const allTypes = Object.values(ArtifactType);
    const seededTypes = (p.artifact.upsert.mock.calls as AnyDelegate[]).map(
      (call: AnyDelegate) => call[0].create.type as ArtifactType
    );
    const seededTypeSet = new Set(seededTypes);

    for (const type of allTypes) {
      expect(seededTypeSet.has(type)).toBe(true);
    }
  });

  it("creates DOCUMENT artifacts covering every DocumentStatus value", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);

    const allStatuses = Object.values(DocumentStatus);
    const documentCalls = (
      p.artifact.upsert.mock.calls as AnyDelegate[]
    ).filter(
      (call: AnyDelegate) => call[0].create.type === ArtifactType.DOCUMENT
    );
    const seededStatuses = documentCalls.map(
      (call: AnyDelegate) => call[0].create.status as DocumentStatus
    );
    const seededStatusSet = new Set(seededStatuses);

    for (const status of allStatuses) {
      expect(seededStatusSet.has(status)).toBe(true);
    }
  });

  it("creates DOCUMENT artifacts covering every ArtifactSubtype value", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);

    const allSubtypes = Object.values(ArtifactSubtype);
    const documentCalls = (
      p.artifact.upsert.mock.calls as AnyDelegate[]
    ).filter(
      (call: AnyDelegate) => call[0].create.type === ArtifactType.DOCUMENT
    );
    const seededSubtypes = documentCalls.map(
      (call: AnyDelegate) => call[0].create.subtype as ArtifactSubtype
    );
    const seededSubtypeSet = new Set(seededSubtypes);

    for (const subtype of allSubtypes) {
      expect(seededSubtypeSet.has(subtype)).toBe(true);
    }
  });

  it("creates at least one BRANCH artifact", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);

    const branchCalls = (p.artifact.upsert.mock.calls as AnyDelegate[]).filter(
      (call: AnyDelegate) => call[0].create.type === ArtifactType.BRANCH
    );
    expect(branchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("creates at least one DEPLOYMENT artifact", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);

    const deploymentCalls = (
      p.artifact.upsert.mock.calls as AnyDelegate[]
    ).filter(
      (call: AnyDelegate) => call[0].create.type === ArtifactType.DEPLOYMENT
    );
    expect(deploymentCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("scopes all artifact rows to the baseline organizationId", async () => {
    const { prisma, p } = buildReadyMock();
    await seedCoreEntities(prisma as any, baselineContext);

    for (const call of p.artifact.upsert.mock.calls as AnyDelegate[]) {
      expect(call[0].create.organizationId).toBe(
        baselineContext.organizationId
      );
    }
  });

  it("uses perf long-tail placement for scaled document project links", async () => {
    const { prisma, p } = buildReadyMock();
    const basePlan = resolveSeedRunPlan({ profile: SeedProfileName.Perf });
    const targets = {
      ...basePlan.targets,
      projects: 4,
      artifacts: 120,
    };
    const plan = {
      ...basePlan,
      targets,
      targetRanges: getSeedTargetRanges(targets),
      transaction: { ...basePlan.transaction, batchSize: 25 },
    };
    const result = await seedCoreEntities(prisma as any, baselineContext, plan);

    const documentCreates = (p.artifact.upsert.mock.calls as AnyDelegate[])
      .map((call: AnyDelegate) => call[0].create)
      .filter((create: AnyDelegate) => create.type === ArtifactType.DOCUMENT);
    const projectCounts = countBy(
      documentCreates.map((create: AnyDelegate) => create.projectId as string)
    );

    expect(projectCounts.get(result.projectIds[0]) ?? 0).toBeGreaterThan(
      projectCounts.get(result.projectIds.at(-1) ?? "") ?? 0
    );
  });
});
