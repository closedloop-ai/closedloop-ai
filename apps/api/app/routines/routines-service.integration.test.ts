import type { CreateRoutineInput } from "@repo/api/src/types/routine";
import {
  createRoutineInputSchema,
  ROUTINE_RUN_HISTORY_CAP,
  RoutineComponentKind,
  RoutineNotifyMode,
  RoutineOrigin,
  RoutineProvider,
  RoutineRunStatus,
  RoutineRunsIn,
  RoutineRunsOn,
  RoutineScheduleKind,
  RoutineStatus,
  recordRoutineRunInputSchema,
} from "@repo/api/src/types/routine";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { routinesService } from "@/app/routines/service";

/**
 * FEA-4365 / PRD-566 — DB-backed CRUD + run-persistence coverage for the cloud
 * Routines store. Real Postgres via `withDb` (self-skips when DATABASE_URL is
 * unset), each case wrapped in an auto-rollback transaction.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

// Parse through the real input schema so fixtures are fully-typed
// `CreateRoutineInput` (defaults applied) exactly as a route would hand them to
// the service — no casts.
function claudeRoutineInput(
  overrides?: Partial<CreateRoutineInput>
): CreateRoutineInput {
  return createRoutineInputSchema.parse({
    name: "Open PRs summary",
    description: "Summarize open PRs weekday mornings.",
    instructions: "Summarize all open pull requests.",
    provider: RoutineProvider.Claude,
    modelId: "opus-4-8",
    runsOn: RoutineRunsOn.Cloud,
    origin: RoutineOrigin.Created,
    status: RoutineStatus.Active,
    scheduleKind: RoutineScheduleKind.Weekdays,
    scheduleDetail: "Runs weekdays at 9:00 AM CDT",
    cron: "0 9 * * 1-5",
    notifyMode: RoutineNotifyMode.AllRuns,
    folderOrRepo: "closedloop-ai/symphony-alpha",
    connectorIds: ["closedloop", "gmail"],
    permissionMode: "Settings default",
    ...overrides,
  });
}

// Happy-path create helper: createRoutine now returns null when a relation
// points at another org, so assert non-null for tests that expect success.
async function mustCreateRoutine(
  organizationId: string,
  overrides?: Partial<CreateRoutineInput>
) {
  const created = await routinesService.createRoutine(
    organizationId,
    claudeRoutineInput(overrides)
  );
  if (!created) {
    throw new Error("createRoutine returned null unexpectedly");
  }
  return created;
}

describeIfDb("routinesService CRUD (FEA-4365)", () => {
  it("creates a routine stamped with the caller org and reads it back", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const created = await mustCreateRoutine(organizationId);

      expect(created.organizationId).toBe(organizationId);
      expect(created.provider).toBe(RoutineProvider.Claude);
      expect(created.connectorIds).toEqual(["closedloop", "gmail"]);
      // Codex-only fields degrade to null for a Claude routine.
      expect(created.reasoningEffort).toBeNull();
      expect(created.runsIn).toBeNull();

      const fetched = await routinesService.getRoutine(
        organizationId,
        created.id
      );
      expect(fetched?.id).toBe(created.id);
    });
  });

  it("persists Codex-only provider-capability fields and hides Claude-only ones", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const created = await routinesService.createRoutine(
        organizationId,
        createRoutineInputSchema.parse({
          name: "Nightly Codex regression triage",
          provider: RoutineProvider.Codex,
          modelId: "gpt-5-6-sol",
          runsOn: RoutineRunsOn.Local,
          origin: RoutineOrigin.Discovered,
          status: RoutineStatus.Active,
          scheduleKind: RoutineScheduleKind.Daily,
          project: "Closedloop.ai - Active Work",
          runsIn: RoutineRunsIn.NewChat,
          hostMachine: "Kris Wong's MacBook Pro",
          reasoningEffort: "Medium",
        })
      );
      if (!created) {
        throw new Error("createRoutine returned null unexpectedly");
      }

      expect(created.provider).toBe(RoutineProvider.Codex);
      expect(created.reasoningEffort).toBe("Medium");
      expect(created.runsIn).toBe(RoutineRunsIn.NewChat);
      expect(created.hostMachine).toBe("Kris Wong's MacBook Pro");
      // Claude-only fields absent for Codex.
      expect(created.permissionMode).toBeNull();
      expect(created.worktree).toBe(false);
    });
  });

  it("updates only supplied fields and leaves the rest unchanged", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const created = await mustCreateRoutine(organizationId);

      const updated = await routinesService.updateRoutine(
        organizationId,
        created.id,
        { status: RoutineStatus.Paused }
      );
      expect(updated?.status).toBe(RoutineStatus.Paused);
      // Untouched field preserved.
      expect(updated?.name).toBe(created.name);
      expect(updated?.connectorIds).toEqual(["closedloop", "gmail"]);
    });
  });

  it("lists newest-updated first and paginates", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const first = await mustCreateRoutine(organizationId, { name: "first" });
      const second = await mustCreateRoutine(organizationId, {
        name: "second",
      });

      const listed = await routinesService.listRoutines({ organizationId });
      expect(listed.total).toBe(2);
      // second was created last → most recently updated → first in list.
      expect(listed.items[0]?.id).toBe(second.id);
      expect(listed.items[1]?.id).toBe(first.id);

      const page = await routinesService.listRoutines({
        organizationId,
        limit: 1,
        offset: 1,
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.id).toBe(first.id);
    });
  });

  it("deletes a routine and reports whether a row was removed", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const created = await mustCreateRoutine(organizationId);

      expect(
        await routinesService.deleteRoutine(organizationId, created.id)
      ).toBe(true);
      expect(
        await routinesService.getRoutine(organizationId, created.id)
      ).toBeNull();
      // Second delete is a no-op.
      expect(
        await routinesService.deleteRoutine(organizationId, created.id)
      ).toBe(false);
    });
  });

  it("upserts by desktop source id atomically (create then update the same row)", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      // A crewd ScheduledTask.id — an arbitrary string, NOT a UUID.
      const sourceId = "task-1";

      const first = await routinesService.upsertRoutineBySource(
        organizationId,
        sourceId,
        claudeRoutineInput({ name: "v1" })
      );
      expect(first?.sourceId).toBe(sourceId);
      expect(first?.name).toBe("v1");

      const second = await routinesService.upsertRoutineBySource(
        organizationId,
        sourceId,
        claudeRoutineInput({ name: "v2" })
      );
      // Same cloud PK — re-syncing the source id updated the SAME row.
      expect(second?.id).toBe(first?.id);
      expect(second?.name).toBe("v2");

      const listed = await routinesService.listRoutines({ organizationId });
      expect(listed.total).toBe(1);
    });
  });

  it("clears the outgoing provider's capability fields on a provider switch", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      // Claude routine with Claude-only fields populated.
      const created = await mustCreateRoutine(organizationId, {
        permissionMode: "Settings default",
        worktree: true,
        connectorIds: ["closedloop"],
        folderOrRepo: "closedloop-ai/symphony-alpha",
      });

      // Switch to Codex — Claude-only fields must be normalized away even though
      // the update body never mentions them.
      const switched = await routinesService.updateRoutine(
        organizationId,
        created?.id ?? "",
        { provider: RoutineProvider.Codex, modelId: "gpt-5-6-sol" }
      );
      expect(switched?.provider).toBe(RoutineProvider.Codex);
      expect(switched?.permissionMode).toBeNull();
      expect(switched?.worktree).toBe(false);
      expect(switched?.connectorIds).toEqual([]);
      expect(switched?.folderOrRepo).toBeNull();
    });
  });

  it("refuses to create a routine attached to another org's team or owner", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await createTestOrganization();
      const orgB = await createTestOrganization();
      const foreignUser = await createTestUser(orgB);

      const rejected = await routinesService.createRoutine(
        orgA,
        claudeRoutineInput({ ownerId: foreignUser.id })
      );
      // Owner belongs to org B → org A's create is refused, nothing persisted.
      expect(rejected).toBeNull();
      const listed = await routinesService.listRoutines({
        organizationId: orgA,
      });
      expect(listed.total).toBe(0);
    });
  });
});

describeIfDb("routinesService run persistence + retention (FEA-4365)", () => {
  it("records a run and stamps the routine's last-run bookkeeping", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const routine = await mustCreateRoutine(organizationId);

      const run = await routinesService.recordRun(
        organizationId,
        routine.id,
        recordRoutineRunInputSchema.parse({
          status: RoutineRunStatus.Success,
          summary: "Summarized 12 open PRs.",
          sessionId: "ses_3a91d0",
          sessionIds: ["ses_3a91d0"],
          provider: RoutineProvider.Claude,
          modelId: "opus-4-8",
          invokedComponents: [
            {
              id: "command:/code-review",
              name: "/code-review",
              kind: RoutineComponentKind.Command,
              cataloged: true,
            },
          ],
        })
      );

      expect(run?.status).toBe(RoutineRunStatus.Success);
      expect(run?.organizationId).toBe(organizationId);
      expect(run?.sessionIds).toEqual(["ses_3a91d0"]);

      const refreshed = await routinesService.getRoutine(
        organizationId,
        routine.id
      );
      expect(refreshed?.lastRunId).toBe(run?.id);
      expect(refreshed?.lastStatus).toBe(RoutineRunStatus.Success);
      expect(refreshed?.lastRunSessionId).toBe("ses_3a91d0");
    });
  });

  it("returns null recording a run for a routine owned by another org", async () => {
    await autoRollbackTransaction(async () => {
      const orgA = await createTestOrganization();
      const orgB = await createTestOrganization();
      const routineA = await mustCreateRoutine(orgA);

      const run = await routinesService.recordRun(
        orgB,
        routineA.id,
        recordRoutineRunInputSchema.parse({ status: RoutineRunStatus.Success })
      );
      expect(run).toBeNull();
    });
  });

  it("re-delivering a source run id updates the same row (idempotent) and transitions RUNNING→terminal", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const routine = await mustCreateRoutine(organizationId);

      // First delivery: the run is still RUNNING.
      const running = await routinesService.recordRun(
        organizationId,
        routine?.id ?? "",
        recordRoutineRunInputSchema.parse({
          sourceRunId: "run-1",
          status: RoutineRunStatus.Running,
          summary: "started",
        })
      );
      expect(running?.status).toBe(RoutineRunStatus.Running);

      // Redelivery of the SAME source run id with the terminal state.
      const finished = await routinesService.recordRun(
        organizationId,
        routine?.id ?? "",
        recordRoutineRunInputSchema.parse({
          sourceRunId: "run-1",
          status: RoutineRunStatus.Success,
          summary: "done",
        })
      );
      // Same cloud row updated in place — not a duplicate.
      expect(finished?.id).toBe(running?.id);
      expect(finished?.status).toBe(RoutineRunStatus.Success);

      const runs = await routinesService.listRuns({
        organizationId,
        routineId: routine?.id ?? "",
      });
      expect(runs.total).toBe(1);

      const refreshed = await routinesService.getRoutine(
        organizationId,
        routine?.id ?? ""
      );
      expect(refreshed?.lastStatus).toBe(RoutineRunStatus.Success);
    });
  });

  it("does not rewind the last-run badge when an older, out-of-order run arrives", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const routine = await mustCreateRoutine(organizationId);

      // Newest run first.
      const newest = await routinesService.recordRun(
        organizationId,
        routine?.id ?? "",
        recordRoutineRunInputSchema.parse({
          status: RoutineRunStatus.Success,
          summary: "newest",
          startedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
        })
      );
      // Then a backfilled OLDER run.
      await routinesService.recordRun(
        organizationId,
        routine?.id ?? "",
        recordRoutineRunInputSchema.parse({
          status: RoutineRunStatus.Failed,
          summary: "older backfill",
          startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        })
      );

      // Cache still reflects the genuinely-newest run, not the late older one.
      const refreshed = await routinesService.getRoutine(
        organizationId,
        routine?.id ?? ""
      );
      expect(refreshed?.lastRunId).toBe(newest?.id);
      expect(refreshed?.lastStatus).toBe(RoutineRunStatus.Success);
    });
  });

  it("bounds run history to the retention cap, sweeping the oldest runs", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const routine = await mustCreateRoutine(organizationId);

      const total = ROUTINE_RUN_HISTORY_CAP + 5;
      for (let i = 0; i < total; i++) {
        await routinesService.recordRun(
          organizationId,
          routine.id,
          recordRoutineRunInputSchema.parse({
            status: RoutineRunStatus.Success,
            summary: `run-${i}`,
            // Strictly increasing start times so the sweep keeps the newest.
            startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          })
        );
      }

      const runs = await routinesService.listRuns({
        organizationId,
        routineId: routine.id,
        limit: ROUTINE_RUN_HISTORY_CAP + 50,
      });
      // Never grows past the cap.
      expect(runs.total).toBe(ROUTINE_RUN_HISTORY_CAP);
      // The newest run survived; the oldest was swept.
      expect(runs.items[0]?.summary).toBe(`run-${total - 1}`);
      const summaries = runs.items.map((row) => row.summary);
      expect(summaries).not.toContain("run-0");
    });
  });
});
