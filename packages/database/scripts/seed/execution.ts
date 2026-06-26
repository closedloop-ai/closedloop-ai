import { LoopCommand, LoopStatus } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { buildActiveLoopAssignments, pickOptional } from "./allocations";
import type { CoreSeedResult } from "./core";
import {
  createSeedBatchTransactionRunner,
  createUpsertCounts,
  deterministicUuid,
  forEachSeedBatch,
  logUpsertSummary,
  seedLog,
  upsertRow,
} from "./helpers";
import type { SeedContext } from "./index";
import { resolveSeedRunPlan, SeedRngMode, type SeedRunPlan } from "./profiles";
import { buildLongTailIndexSequence, createSeedRng, seedDate } from "./rng";

/**
 * Seeds Loop rows covering all 7 LoopStatus values and at least 4 distinct
 * LoopCommand types (PLAN, EXECUTE, CHAT, EVALUATE_PRD).
 *
 * Partial unique index constraint:
 *   Only one active loop (status PENDING/CLAIMED/RUNNING) is allowed per
 *   (artifactId, command, artifactVersion) combination when both artifactId
 *   and artifactVersion are non-null. This is enforced by assigning each
 *   active loop a unique combination of artifactId and command.
 *
 * Terminal loops (COMPLETED, FAILED, CANCELLED, TIMED_OUT) may share
 * artifact+command+version combinations freely.
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient connected to the target database.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - IDs for seeded core entities (artifacts, projects, etc.).
 */
export async function seedExecutionEntities(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  plan: SeedRunPlan = resolveSeedRunPlan()
): Promise<void> {
  const { organizationId, userId } = context;
  const { artifactIds } = coreResult;
  const counts = createUpsertCounts();

  seedLog(
    "Seeding execution entities (Loop rows across all LoopStatus values)…"
  );

  // ---------------------------------------------------------------------------
  // Loop definitions
  //
  // Active statuses (PENDING, CLAIMED, RUNNING) each get a unique
  // (artifactId, command, artifactVersion) to satisfy the partial unique index.
  // We use different artifactIds from the seeded set so no two active loops
  // share the same (artifactId, command, artifactVersion) triple.
  //
  // Terminal statuses (COMPLETED, FAILED, CANCELLED, TIMED_OUT) are free to
  // reuse artifact/command/version combinations.
  // ---------------------------------------------------------------------------

  type LoopDefinition = {
    key: string;
    status: LoopStatus;
    command: LoopCommand;
    artifactIndex: number | null;
    artifactVersion: number | null;
    prompt: string;
    startedAt: Date | null;
    completedAt: Date | null;
    prUrl: string | null;
    branchName: string | null;
    tokensInput: number;
    tokensOutput: number;
    error: { code: string; message: string } | null;
  };

  const hoursAgo = (h: number) => seedDate(plan.clock, -h * 3_600_000);

  const baseLoopDefinitions: LoopDefinition[] = [
    // --- Active loops (each has a unique artifactId+command combination) ---

    {
      key: `loop:${organizationId}:pending-plan`,
      status: LoopStatus.PENDING,
      command: LoopCommand.PLAN,
      // artifactIds[0] + PLAN + version 1 — unique active combination
      artifactIndex: 0,
      artifactVersion: 1,
      prompt: "Generate an implementation plan for the platform foundation.",
      startedAt: null,
      completedAt: null,
      prUrl: null,
      branchName: null,
      tokensInput: 0,
      tokensOutput: 0,
      error: null,
    },
    {
      key: `loop:${organizationId}:claimed-execute`,
      status: LoopStatus.CLAIMED,
      command: LoopCommand.EXECUTE,
      // artifactIds[1] + EXECUTE + version 1 — unique active combination
      artifactIndex: 1,
      artifactVersion: 1,
      prompt: "Execute the approved implementation plan.",
      startedAt: hoursAgo(1),
      completedAt: null,
      prUrl: null,
      branchName: "feat/execute-claimed",
      tokensInput: 120,
      tokensOutput: 45,
      error: null,
    },
    {
      key: `loop:${organizationId}:running-chat`,
      status: LoopStatus.RUNNING,
      command: LoopCommand.CHAT,
      // artifactIds[2] + CHAT + version 2 — unique active combination
      artifactIndex: 2,
      artifactVersion: 2,
      prompt:
        "Discuss architectural trade-offs for the API rate limiting layer.",
      startedAt: hoursAgo(0.5),
      completedAt: null,
      prUrl: null,
      branchName: null,
      tokensInput: 800,
      tokensOutput: 320,
      error: null,
    },

    {
      key: `loop:${organizationId}:blocked-execute`,
      status: LoopStatus.BLOCKED,
      command: LoopCommand.EXECUTE,
      // Deferred dispatch: gated on a non-terminal blocking artifact. BLOCKED is
      // excluded from the active partial unique index, so it never conflicts
      // with the active EXECUTE loop above.
      artifactIndex: 7,
      artifactVersion: 1,
      prompt: "Execute the billing integration once its blocking FEAT lands.",
      startedAt: null,
      completedAt: null,
      prUrl: null,
      branchName: null,
      tokensInput: 0,
      tokensOutput: 0,
      error: null,
    },

    // --- Terminal loops (partial unique index does not apply) ---

    {
      key: `loop:${organizationId}:completed-evaluate-prd`,
      status: LoopStatus.COMPLETED,
      command: LoopCommand.EVALUATE_PRD,
      artifactIndex: 3,
      artifactVersion: 1,
      prompt: "Evaluate the PRD for multi-tenant data isolation.",
      startedAt: hoursAgo(48),
      completedAt: hoursAgo(46),
      prUrl: null,
      branchName: null,
      tokensInput: 2400,
      tokensOutput: 950,
      error: null,
    },
    {
      key: `loop:${organizationId}:failed-plan`,
      status: LoopStatus.FAILED,
      command: LoopCommand.PLAN,
      artifactIndex: 4,
      artifactVersion: 1,
      prompt: "Generate implementation plan for event streaming pipeline.",
      startedAt: hoursAgo(72),
      completedAt: hoursAgo(71),
      prUrl: null,
      branchName: null,
      tokensInput: 1100,
      tokensOutput: 200,
      error: {
        code: "CONTEXT_LIMIT_EXCEEDED",
        message: "Token context limit exceeded during plan generation.",
      },
    },
    {
      key: `loop:${organizationId}:cancelled-execute`,
      status: LoopStatus.CANCELLED,
      command: LoopCommand.EXECUTE,
      // Terminal — no conflict with the RUNNING EXECUTE loop above (different status)
      artifactIndex: 5,
      artifactVersion: 1,
      prompt: "Execute the webhook delivery system feature.",
      startedAt: hoursAgo(120),
      completedAt: hoursAgo(119),
      prUrl: null,
      branchName: "feat/webhook-delivery",
      tokensInput: 500,
      tokensOutput: 150,
      error: null,
    },
    {
      key: `loop:${organizationId}:timed-out-chat`,
      status: LoopStatus.TIMED_OUT,
      command: LoopCommand.CHAT,
      // Terminal — no conflict with active CHAT loop above
      artifactIndex: 6,
      artifactVersion: 1,
      prompt: "Discuss design options for the observability dashboard.",
      startedAt: hoursAgo(96),
      completedAt: null,
      prUrl: null,
      branchName: null,
      tokensInput: 300,
      tokensOutput: 90,
      error: {
        code: "RUNNER_TIMEOUT",
        message:
          "Loop runner did not report heartbeat within the timeout window.",
      },
    },
  ];

  const activeAssignments = buildActiveLoopAssignments(
    artifactIds,
    plan.targets.loops
  );
  const loopRng =
    plan.rngMode === SeedRngMode.Perf
      ? createSeedRng(`${plan.rngSeed}:loops`)
      : null;
  const terminalLoopCount = Math.max(
    0,
    plan.targets.loops - activeAssignments.length
  );
  const terminalArtifactIndexes =
    plan.rngMode === SeedRngMode.Perf
      ? buildLongTailIndexSequence(terminalLoopCount, artifactIds.length)
      : null;
  const loopDefinitions: LoopDefinition[] = Array.from(
    { length: plan.targets.loops },
    (_unused, index) => {
      const base = baseLoopDefinitions[index % baseLoopDefinitions.length];
      // BLOCKED is neither active-assignable (PENDING/CLAIMED/RUNNING) nor one
      // of the terminal statuses the fill loop rewrites to, so emit its
      // canonical base definition verbatim to guarantee the status is seeded.
      // Long-tail repeats (index ≥ base count) still fall through to terminal.
      if (
        index < baseLoopDefinitions.length &&
        base.status === LoopStatus.BLOCKED
      ) {
        return base;
      }
      const activeAssignment = activeAssignments[index];
      if (activeAssignment) {
        return {
          ...base,
          key:
            index < baseLoopDefinitions.length
              ? base.key
              : `loop:${organizationId}:active-${base.status.toLowerCase()}-${index + 1}`,
          command: activeAssignment.command,
          artifactIndex: null,
          artifactVersion: activeAssignment.artifactVersion,
          startedAt:
            base.status === LoopStatus.PENDING
              ? null
              : hoursAgo(Math.max(0.5, index + 0.5)),
          completedAt: null,
        };
      }
      const terminalIndex = index - activeAssignments.length;
      const terminalStatuses = [
        LoopStatus.COMPLETED,
        LoopStatus.FAILED,
        LoopStatus.CANCELLED,
        LoopStatus.TIMED_OUT,
      ] as const;
      return {
        ...base,
        key:
          index < baseLoopDefinitions.length
            ? base.key
            : `loop:${organizationId}:terminal-${terminalIndex + 1}`,
        status: terminalStatuses[terminalIndex % terminalStatuses.length],
        command:
          loopRng?.pick(Object.values(LoopCommand)) ??
          Object.values(LoopCommand)[index % Object.values(LoopCommand).length],
        artifactIndex: terminalArtifactIndexes
          ? terminalArtifactIndexes[terminalIndex]
          : index,
        artifactVersion: (index % 3) + 1,
        startedAt: hoursAgo(index + 1),
        completedAt:
          terminalStatuses[terminalIndex % terminalStatuses.length] ===
          LoopStatus.TIMED_OUT
            ? null
            : hoursAgo(index),
      };
    }
  );

  await forEachSeedBatch({
    items: loopDefinitions,
    batchSize: plan.transaction.batchSize,
    label: "loops",
    runBatch: createSeedBatchTransactionRunner(prisma, plan.transaction),
    run: async (def, index, batchClient) => {
      const batchPrisma = batchClient ?? prisma;
      const loopId = deterministicUuid(def.key);
      const artifactId =
        def.artifactIndex === null
          ? (activeAssignments[index]?.artifactId ?? null)
          : pickOptional(artifactIds, def.artifactIndex);

      await upsertRow({
        model: "Loop",
        id: loopId,
        upsert: () =>
          batchPrisma.loop.upsert({
            where: { id: loopId },
            create: {
              id: loopId,
              organizationId,
              userId,
              status: def.status,
              command: def.command,
              artifactId,
              artifactVersion: def.artifactVersion,
              prompt: def.prompt,
              startedAt: def.startedAt,
              completedAt: def.completedAt,
              prUrl: def.prUrl,
              branchName: def.branchName,
              tokensInput: def.tokensInput,
              tokensOutput: def.tokensOutput,
              error: def.error ?? undefined,
            },
            update: {
              status: def.status,
              tokensInput: def.tokensInput,
              tokensOutput: def.tokensOutput,
              error: def.error ?? undefined,
            },
          }),
        counts,
      });
    },
  });

  logUpsertSummary(counts);
}
