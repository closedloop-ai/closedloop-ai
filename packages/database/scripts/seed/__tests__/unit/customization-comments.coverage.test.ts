import { describe, expect, it, vi } from "vitest";
import { ThreadSource, ThreadStatus } from "../../../../generated/client";
import type { CoreSeedResult } from "../../core";
import { seedComments } from "../../customization-comments";
import { deterministicUuid } from "../../helpers";
import {
  getSeedTargetRanges,
  SeedAuditMode,
  SeedProfileName,
  SeedRngMode,
  type SeedRunPlan,
  SeedTransactionMode,
} from "../../profiles";
import { BASELINE_ORG_ID, baselineContext } from "../fixtures/baseline-org";
import { createMockPrisma } from "../fixtures/mock-prisma";

function buildCoreSeedResult(): CoreSeedResult {
  const artifactIds = Array.from({ length: 5 }, (_, i) =>
    deterministicUuid(`comments-fixture:artifact:${i}`)
  );
  return {
    teamId: deterministicUuid("comments-fixture:team"),
    projectIds: [deterministicUuid("comments-fixture:project:0")],
    artifactIds,
    githubInstallationId: deterministicUuid(
      "comments-fixture:github-installation"
    ),
    githubRepositoryId: deterministicUuid("comments-fixture:github-repo"),
    branchArtifactId: deterministicUuid("comments-fixture:branch-artifact"),
  };
}

function buildFixedPlan(commentsTarget: number): SeedRunPlan {
  const targets = {
    projects: 1,
    artifacts: 10,
    comments: commentsTarget,
  };
  return {
    profile: SeedProfileName.Minimal,
    targets,
    targetRanges: getSeedTargetRanges(targets),
    multiplier: 1,
    rngMode: SeedRngMode.Fixed,
    rngSeed: "fixed-comments-test",
    clock: { baseDate: new Date("2026-01-01T12:00:00.000Z") },
    auditMode: SeedAuditMode.CleanOrg,
    orgPreflight: { conflicts: [] },
    transaction: {
      mode: SeedTransactionMode.SingleTransaction,
      timeoutMs: 30_000,
      maxWaitMs: 5000,
      batchSize: 1000,
    },
    allowSharedStage: false,
    target: { source: "legacy-default" },
    reset: { requested: false, force: false },
  };
}

function buildPerfPlan(
  commentsTarget: number,
  rngSeed = "perf-comments-test"
): SeedRunPlan {
  const targets = {
    projects: 1,
    artifacts: 10,
    comments: commentsTarget,
  };
  return {
    profile: SeedProfileName.Perf,
    targets,
    targetRanges: getSeedTargetRanges(targets),
    multiplier: 1,
    rngMode: SeedRngMode.Perf,
    rngSeed,
    clock: { baseDate: new Date("2026-01-01T12:00:00.000Z") },
    auditMode: SeedAuditMode.CleanOrg,
    orgPreflight: { conflicts: [] },
    transaction: {
      mode: SeedTransactionMode.SingleTransaction,
      timeoutMs: 30_000,
      maxWaitMs: 5000,
      batchSize: 1000,
    },
    allowSharedStage: false,
    target: { source: "legacy-default" },
    reset: { requested: false, force: false },
  };
}

function buildReadyMock() {
  const prisma = createMockPrisma();
  const p = vi.mocked(prisma, true);
  vi.mocked(prisma.commentThread.upsert, { partial: true }).mockImplementation(
    (args) => Promise.resolve({ id: args.create.id as string })
  );
  vi.mocked(prisma.comment.upsert, { partial: true }).mockImplementation(
    (args) => Promise.resolve({ id: args.create.id as string })
  );
  vi.mocked(prisma.commentReaction.upsert, {
    partial: true,
  }).mockImplementation((args) =>
    Promise.resolve({ id: args.create.id as string })
  );
  vi.mocked(prisma.commentAttachment.upsert, {
    partial: true,
  }).mockImplementation((args) =>
    Promise.resolve({ id: args.create.id as string })
  );
  return { prisma, p };
}

describe("seedComments — fixed-RNG scaled threads (one comment per thread)", () => {
  it("cycles through every ThreadSource and reflects it in the scaled thread state", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    // existingCommentCount (5) fixed anchors + 3 scaled comments/threads.
    const plan = buildFixedPlan(8);

    await seedComments(prisma, baselineContext, coreResult, plan);

    const scaledThreadCreates = p.commentThread.upsert.mock.calls
      .map((call) => call[0].create)
      .filter((create) => (create.id ?? "").length > 0)
      .slice(-3);

    expect(scaledThreadCreates.map((c) => c.source)).toEqual([
      ThreadSource.NATIVE,
      ThreadSource.LIVEBLOCKS,
      ThreadSource.GITHUB,
    ]);

    const [nativeCreate, liveblocksCreate, githubCreate] = scaledThreadCreates;
    expect(nativeCreate.status).toBe(ThreadStatus.OPEN);
    expect(nativeCreate.resolvedById).toBeNull();
    expect(nativeCreate.resolvedAt).toBeNull();
    expect(nativeCreate.roomId).toBeNull();

    expect(liveblocksCreate.status).toBe(ThreadStatus.OPEN);
    expect(liveblocksCreate.resolvedById).toBeNull();
    expect(liveblocksCreate.roomId).toContain(
      `seed-room-${BASELINE_ORG_ID.slice(0, 8)}-scaled-`
    );

    expect(githubCreate.status).toBe(ThreadStatus.RESOLVED);
    expect(githubCreate.resolvedById).toBe(baselineContext.userId);
    expect(githubCreate.resolvedAt).toEqual(plan.clock.baseDate);
    expect(githubCreate.roomId).toBeNull();
  });

  it("picks the scaled thread's artifact by cycling comment index, not RNG, in fixed mode", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    const plan = buildFixedPlan(6);

    await seedComments(prisma, baselineContext, coreResult, plan);

    const scaledThreadCreate =
      p.commentThread.upsert.mock.calls.at(-1)?.[0].create;

    // existingCommentCount is 5, so the sole scaled thread's commentIndex is 6;
    // pickRequired wraps that via `index % artifactIds.length` (5 artifacts).
    expect(scaledThreadCreate?.artifactId).toBe(coreResult.artifactIds[1]);
  });
});

describe("seedComments — perf-RNG scaled threads (long-tail comment counts)", () => {
  it("skips a zero-sized thread and gives a multi-comment thread chained parentCommentIds", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    // remainingCommentCount = 8 - 5 = 3, artifactIds.length = 5 → buckets = 2,
    // so distributeLongTail(3, 2) allocates [3, 0]: one thread with 3
    // comments and one thread with none.
    const plan = buildPerfPlan(8);

    await seedComments(prisma, baselineContext, coreResult, plan);

    // 3 fixed anchor threads + 1 scaled thread. Without the
    // `commentsInThread === 0` early return the empty bucket would upsert a
    // 5th thread.
    expect(p.commentThread.upsert).toHaveBeenCalledTimes(4);

    const scaledCommentCreates = p.comment.upsert.mock.calls
      .map((call) => call[0].create)
      .filter((create) =>
        String(create.plainText).startsWith("Scaled seed comment")
      );
    // Only the 3-comment thread produced scaled comments; the 0-comment
    // thread's `commentsInThread === 0` branch returned early with no writes.
    expect(scaledCommentCreates).toHaveLength(3);

    const parentIds = scaledCommentCreates.map((c) => c.parentCommentId);
    expect(parentIds[0]).toBeNull();
    expect(parentIds[1]).not.toBeNull();
    expect(parentIds[2]).not.toBeNull();
    expect(parentIds[1]).not.toBe(parentIds[2]);
  });

  it("uses the seeded RNG (not the comment-index cycle) to pick source and artifact", async () => {
    const { prisma, p } = buildReadyMock();
    const coreResult = buildCoreSeedResult();
    // This seed picks values the comment-index cycle would not: the cycle
    // gives sourceCycle[6 % 3] = NATIVE and artifactIds[6 % 5] = artifactIds[1].
    const plan = buildPerfPlan(8, "perf-comments-a");

    await seedComments(prisma, baselineContext, coreResult, plan);

    // The only scaled thread is the last upsert; the three before it are the
    // fixed anchors.
    const scaledThreadCreate =
      p.commentThread.upsert.mock.calls.at(-1)?.[0].create;

    // Deterministic for a fixed rngSeed — pins current RNG-driven placement.
    expect(scaledThreadCreate?.source).toBe(ThreadSource.GITHUB);
    expect(scaledThreadCreate?.artifactId).toBe(coreResult.artifactIds[4]);
  });
});
