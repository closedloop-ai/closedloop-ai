/**
 * TS-U.6 & TS-U.7: Unit tests for seed/execution.ts
 *
 * Covers:
 *  TS-U.6  seedExecutionEntities — creates loops spanning all LoopStatus values
 *          with at least 4 distinct LoopCommand types
 *  TS-U.7  Active loops (PENDING, CLAIMED, RUNNING) each have a unique
 *          (artifactId, command, artifactVersion) combination — the partial
 *          unique index constraint is respected
 *
 * All Prisma calls are mocked; no database connection is required.
 */

import { describe, expect, it } from "vitest";
import { type LoopCommand, LoopStatus } from "../../../../generated/enums";
import type { CoreSeedResult } from "../../core";
import { seedExecutionEntities } from "../../execution";
import { deterministicUuid } from "../../helpers";
import {
  getSeedTargetRanges,
  resolveSeedRunPlan,
  SeedProfileName,
} from "../../profiles";
import { BASELINE_ORG_ID, baselineContext } from "../fixtures/baseline-org";
import { countBy } from "../fixtures/count-by";
import { createMockPrisma } from "../fixtures/mock-prisma";

// Shorthand to access mock call records without fighting Prisma's fluent types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDelegate = any;

const ACTIVE_STATUSES: LoopStatus[] = [
  LoopStatus.PENDING,
  LoopStatus.CLAIMED,
  LoopStatus.RUNNING,
];

/** Builds a CoreSeedResult-compatible fixture with enough artifactIds for all loop definitions. */
function buildCoreSeedResult(): CoreSeedResult {
  const artifactIds = Array.from({ length: 10 }, (_, i) =>
    deterministicUuid(`artifact:fixture:${i}`)
  );
  return {
    teamId: deterministicUuid("team:fixture"),
    projectIds: [
      deterministicUuid("project:fixture:0"),
      deterministicUuid("project:fixture:1"),
    ],
    artifactIds,
    githubInstallationId: deterministicUuid("github-installation:fixture"),
    githubRepositoryId: deterministicUuid("github-repository:fixture"),
    branchArtifactId: deterministicUuid("artifact:branch:fixture"),
  };
}

function buildReadyMock() {
  const prisma = createMockPrisma();
  const p = prisma as AnyDelegate;

  p.loop.findUnique.mockResolvedValue(null);
  p.loop.upsert.mockImplementation((args: AnyDelegate) =>
    Promise.resolve({ id: args.create.id as string })
  );

  return { prisma, p };
}

// TS-U.6: all LoopStatus values and >=4 LoopCommand types
describe("seedExecutionEntities — LoopStatus and LoopCommand coverage (TS-U.6)", () => {
  it("creates loop upserts covering every LoopStatus value", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    await seedExecutionEntities(prisma as any, baselineContext, coreResult);

    const allStatuses = Object.values(LoopStatus);
    const seededStatuses = (p.loop.upsert.mock.calls as AnyDelegate[]).map(
      (call: AnyDelegate) => call[0].create.status as LoopStatus
    );
    const seededStatusSet = new Set(seededStatuses);

    for (const status of allStatuses) {
      expect(seededStatusSet.has(status)).toBe(true);
    }
  });

  it("creates loop upserts with at least 4 distinct LoopCommand types", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    await seedExecutionEntities(prisma as any, baselineContext, coreResult);

    const seededCommands = (p.loop.upsert.mock.calls as AnyDelegate[]).map(
      (call: AnyDelegate) => call[0].create.command as LoopCommand
    );
    const distinctCommands = new Set(seededCommands);

    expect(distinctCommands.size).toBeGreaterThanOrEqual(4);
  });

  it("scopes all loop rows to the baseline organizationId", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    await seedExecutionEntities(prisma as any, baselineContext, coreResult);

    for (const call of p.loop.upsert.mock.calls as AnyDelegate[]) {
      expect(call[0].create.organizationId).toBe(BASELINE_ORG_ID);
    }
  });

  it("creates at least one loop per active LoopStatus (PENDING, CLAIMED, RUNNING)", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    await seedExecutionEntities(prisma as any, baselineContext, coreResult);

    const seededStatuses = (p.loop.upsert.mock.calls as AnyDelegate[]).map(
      (call: AnyDelegate) => call[0].create.status as LoopStatus
    );

    expect(seededStatuses).toContain(LoopStatus.PENDING);
    expect(seededStatuses).toContain(LoopStatus.CLAIMED);
    expect(seededStatuses).toContain(LoopStatus.RUNNING);
  });

  it("creates at least one loop per terminal LoopStatus (COMPLETED, FAILED, CANCELLED, TIMED_OUT)", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    await seedExecutionEntities(prisma as any, baselineContext, coreResult);

    const seededStatuses = (p.loop.upsert.mock.calls as AnyDelegate[]).map(
      (call: AnyDelegate) => call[0].create.status as LoopStatus
    );

    expect(seededStatuses).toContain(LoopStatus.COMPLETED);
    expect(seededStatuses).toContain(LoopStatus.FAILED);
    expect(seededStatuses).toContain(LoopStatus.CANCELLED);
    expect(seededStatuses).toContain(LoopStatus.TIMED_OUT);
  });
});

describe("seedExecutionEntities — perf loop density", () => {
  it("uses long-tail artifact placement for terminal perf loops", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    const basePlan = resolveSeedRunPlan({ profile: SeedProfileName.Perf });
    const targets = {
      ...basePlan.targets,
      loops: 40,
    };
    const plan = {
      ...basePlan,
      targets,
      targetRanges: getSeedTargetRanges(targets),
      transaction: { ...basePlan.transaction, batchSize: 10 },
    };

    await seedExecutionEntities(
      prisma as any,
      baselineContext,
      coreResult,
      plan
    );

    const terminalCreates = (p.loop.upsert.mock.calls as AnyDelegate[])
      .map((call: AnyDelegate) => call[0].create)
      .filter(
        (create: AnyDelegate) =>
          !ACTIVE_STATUSES.includes(create.status as LoopStatus)
      );
    const artifactCounts = countBy(
      terminalCreates.map((create: AnyDelegate) => create.artifactId as string)
    );

    expect(artifactCounts.get(coreResult.artifactIds[0]) ?? 0).toBeGreaterThan(
      artifactCounts.get(coreResult.artifactIds.at(-1) ?? "") ?? 0
    );
  });
});

// TS-U.7: partial unique index constraint for active loops
describe("seedExecutionEntities — active loop uniqueness constraint (TS-U.7)", () => {
  it("each active loop has a unique (artifactId, command, artifactVersion) combination", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    await seedExecutionEntities(prisma as any, baselineContext, coreResult);

    const activeLoopCreates = (p.loop.upsert.mock.calls as AnyDelegate[])
      .map((call: AnyDelegate) => call[0].create)
      .filter((create: AnyDelegate) =>
        ACTIVE_STATUSES.includes(create.status as LoopStatus)
      );

    const keys = activeLoopCreates.map(
      (create: AnyDelegate) =>
        `${String(create.artifactId)}:${String(create.command)}:${String(create.artifactVersion)}`
    );
    const uniqueKeys = new Set(keys);

    expect(uniqueKeys.size).toBe(activeLoopCreates.length);
  });

  it("active loops with non-null artifactId all reference distinct artifacts", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    await seedExecutionEntities(prisma as any, baselineContext, coreResult);

    const activeLoopCreates = (p.loop.upsert.mock.calls as AnyDelegate[])
      .map((call: AnyDelegate) => call[0].create)
      .filter(
        (create: AnyDelegate) =>
          ACTIVE_STATUSES.includes(create.status as LoopStatus) &&
          create.artifactId !== null
      );

    const artifactIds = activeLoopCreates.map((create: AnyDelegate) =>
      String(create.artifactId)
    );
    const uniqueArtifactIds = new Set(artifactIds);

    expect(uniqueArtifactIds.size).toBe(activeLoopCreates.length);
  });

  it("preserves the shared active loop artifactVersion assignment", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    await seedExecutionEntities(prisma as any, baselineContext, coreResult);

    const activeLoopCreates = (p.loop.upsert.mock.calls as AnyDelegate[])
      .map((call: AnyDelegate) => call[0].create)
      .filter((create: AnyDelegate) =>
        ACTIVE_STATUSES.includes(create.status as LoopStatus)
      );

    expect(
      activeLoopCreates.map((create: AnyDelegate) => create.artifactVersion)
    ).toEqual([1, 1, 2]);
  });
});

describe("seedExecutionEntities — perf loop density", () => {
  it("uses long-tail artifact placement for terminal perf loops", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    const basePlan = resolveSeedRunPlan({ profile: SeedProfileName.Perf });
    const targets = {
      ...basePlan.targets,
      loops: 40,
    };
    const plan = {
      ...basePlan,
      targets,
      targetRanges: getSeedTargetRanges(targets),
      transaction: { ...basePlan.transaction, batchSize: 10 },
    };

    await seedExecutionEntities(
      prisma as any,
      baselineContext,
      coreResult,
      plan
    );

    const terminalCreates = (p.loop.upsert.mock.calls as AnyDelegate[])
      .map((call: AnyDelegate) => call[0].create)
      .filter(
        (create: AnyDelegate) =>
          !ACTIVE_STATUSES.includes(create.status as LoopStatus)
      );
    const artifactCounts = countBy(
      terminalCreates.map((create: AnyDelegate) => create.artifactId as string)
    );

    expect(artifactCounts.get(coreResult.artifactIds[0]) ?? 0).toBeGreaterThan(
      artifactCounts.get(coreResult.artifactIds.at(-1) ?? "") ?? 0
    );
  });
});
