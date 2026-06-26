import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadSource, ThreadStatus } from "../../../../generated/client";
import { deterministicUuid } from "../../helpers";
import { runSeed } from "../../index";
import {
  resolveSeedRunPlan,
  SeedAuditMode,
  SeedProfileName,
  type SeedRunPlan,
} from "../../profiles";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../fixtures/ephemeral-db";

const DATABASE_URL_SET = Boolean(process.env.DATABASE_URL);

async function collectDeterministicProjection(ctx: EphemeralDbContext) {
  const { prisma, organizationId } = ctx;
  const nativeThreadId = deterministicUuid(
    `comment-thread:${organizationId}:native`
  );
  return {
    counts: {
      projects: await prisma.project.count({ where: { organizationId } }),
      artifacts: await prisma.artifact.count({ where: { organizationId } }),
      comments: await prisma.comment.count({
        where: { thread: { organizationId } },
      }),
      loops: await prisma.loop.count({ where: { organizationId } }),
    },
    nativeThread: await prisma.commentThread.findUnique({
      where: { id: nativeThreadId },
      select: {
        id: true,
        organizationId: true,
        source: true,
        roomId: true,
        status: true,
      },
    }),
  };
}

function getCountsOutOfRange(
  counts: Awaited<ReturnType<typeof collectDeterministicProjection>>["counts"],
  plan: SeedRunPlan
): string[] {
  const failures: string[] = [];
  for (const key of Object.keys(plan.targets) as Array<keyof typeof counts>) {
    const count = counts[key];
    const range = plan.targetRanges[key];
    if (count < range.min || count > range.max) {
      failures.push(
        `${key} count ${count} should be within ${range.min}-${range.max}`
      );
    }
  }
  return failures;
}

describe.skipIf(!DATABASE_URL_SET)(
  "seed profile deterministic reproducibility on real Postgres",
  () => {
    let ctx: EphemeralDbContext;

    beforeEach(async () => {
      ctx = await setupEphemeralDb();
    });

    afterEach(async () => {
      if (ctx) {
        await teardownEphemeralDb(ctx);
      }
    });

    it.each([
      SeedProfileName.Minimal,
      SeedProfileName.Local,
      SeedProfileName.E2e,
      SeedProfileName.CiPreview,
    ])("recreates the same persisted projection across clean %s runs", async (profile) => {
      const plan = resolveSeedRunPlan({
        profile,
        auditMode: SeedAuditMode.IdempotentSeedOrg,
      });

      await runSeed(
        ctx.prisma,
        { organizationId: ctx.organizationId, userId: ctx.userId },
        plan
      );
      const firstProjection = await collectDeterministicProjection(ctx);

      await teardownEphemeralDb(ctx);
      ctx = null as unknown as EphemeralDbContext;
      ctx = await setupEphemeralDb();

      await runSeed(
        ctx.prisma,
        { organizationId: ctx.organizationId, userId: ctx.userId },
        plan
      );
      const secondProjection = await collectDeterministicProjection(ctx);

      expect(getCountsOutOfRange(secondProjection.counts, plan)).toEqual([]);
      expect(secondProjection).toEqual(firstProjection);
      expect(secondProjection.nativeThread).toMatchObject({
        source: ThreadSource.NATIVE,
        roomId: null,
        status: ThreadStatus.OPEN,
      });
    });
  }
);
