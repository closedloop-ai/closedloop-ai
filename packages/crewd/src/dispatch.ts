/**
 * Default dispatch: turns a due task into a run. `custom` tasks run their prompt
 * straight through the cascade; the crew pass kinds (review/apply/barry/sentinel)
 * delegate to injected orchestration runners (ported in a later phase). Keeping
 * orchestration injected means the daemon and cascade are usable — and testable —
 * before the full pass port lands.
 */
import { runCascade } from "./harness/cascade.js";
import type { HarnessRegistry } from "./harness/index.js";
import { PassKind, RunStatus, type ScheduledTask } from "./model.js";
import type {
  Dispatch,
  DispatchContext,
  DispatchOutcome,
} from "./scheduler/daemon.js";

export type OrchestrationRunner = (
  task: ScheduledTask,
  ctx: DispatchContext
) => Promise<DispatchOutcome>;
export type OrchestrationRunners = Partial<
  Record<PassKind, OrchestrationRunner>
>;

export type DispatchDeps = {
  orchestration?: OrchestrationRunners;
  registry?: HarnessRegistry;
  perAttemptTimeoutMs?: number;
};

export function createDispatch(deps: DispatchDeps = {}): Dispatch {
  return async (task, ctx) => {
    const runner = deps.orchestration?.[task.kind];
    if (runner) {
      return await runner(task, ctx);
    }
    if (task.kind === PassKind.Custom) {
      return await runCustom(task, ctx, deps);
    }
    return {
      status: RunStatus.Failed,
      harnessUsed: null,
      attempts: [],
      summary: `${task.kind} orchestration not wired`,
      error: `No orchestration runner registered for kind "${task.kind}"`,
    };
  };
}

async function runCustom(
  task: ScheduledTask,
  ctx: DispatchContext,
  deps: DispatchDeps
): Promise<DispatchOutcome> {
  const cascade = task.harnessCascade.length
    ? task.harnessCascade
    : ctx.defaultCascade;
  const cwd = typeof task.meta.cwd === "string" ? task.meta.cwd : process.cwd();
  const result = await runCascade({
    prompt: task.prompt,
    cwd,
    cascade,
    registry: deps.registry,
    perAttemptTimeoutMs: deps.perAttemptTimeoutMs,
  });
  return {
    status: result.ok ? RunStatus.Success : RunStatus.Failed,
    harnessUsed: result.harnessUsed,
    attempts: result.attempts,
    summary: result.ok
      ? `ran via ${result.harnessUsed}`
      : "all harnesses in cascade failed",
    error: result.ok ? null : "cascade exhausted",
  };
}
