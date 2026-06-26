import { afterEach, beforeEach, describe, it } from "vitest";
import { runSeed } from "../../index";
import {
  resolveSeedRunPlan,
  SeedProfileName,
  type SeedRunPlan,
} from "../../profiles";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../fixtures/ephemeral-db";

const DATABASE_URL_SET = Boolean(process.env.DATABASE_URL);

async function countProfileModels(ctx: EphemeralDbContext) {
  const { prisma, organizationId } = ctx;
  return {
    projects: await prisma.project.count({ where: { organizationId } }),
    artifacts: await prisma.artifact.count({ where: { organizationId } }),
    comments: await prisma.comment.count({
      where: { thread: { organizationId } },
    }),
    loops: await prisma.loop.count({ where: { organizationId } }),
  };
}

function expectCountsInRange(
  counts: Awaited<ReturnType<typeof countProfileModels>>,
  plan: SeedRunPlan
) {
  for (const key of Object.keys(plan.targets) as Array<keyof typeof counts>) {
    const count = counts[key];
    const range = plan.targetRanges[key];
    if (count < range.min || count > range.max) {
      throw new Error(
        `${key} count ${count} was outside expected range ${range.min}-${range.max}`
      );
    }
  }
}

describe.skipIf(!DATABASE_URL_SET)(
  "seed profile counts on real Postgres",
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
    ])("seeds %s within audited target ranges", async (profile) => {
      const plan = resolveSeedRunPlan({ profile });
      await runSeed(
        ctx.prisma,
        { organizationId: ctx.organizationId, userId: ctx.userId },
        plan
      );
      expectCountsInRange(await countProfileModels(ctx), plan);
    });
  }
);
