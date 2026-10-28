import { DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { withDeadline } from "./deadline";

/** This task, as the ECS API names it. */
export type EcsTask = { cluster: string; taskArn: string };

/** The task's `desiredStatus`, read from the ECS API. */
export type DescribeDesiredStatus = (
  task: EcsTask,
  signal: AbortSignal
) => Promise<string>;

export type TaskStoppingWatchOptions = {
  /** `ECS_CONTAINER_METADATA_URI_V4`, injected by ECS into every container. */
  metadataUri: string;
  onStopping: () => void;
  fetch?: typeof fetch;
  describeDesiredStatus?: DescribeDesiredStatus;
  intervalMs?: number;
};

/**
 * PLN-2104 step 9: the drain starts when ECS begins stopping the task, while
 * the load balancer still holds its sockets. The ECS API's `desiredStatus`
 * says so: the scheduler sets it to STOPPED before it deregisters the target.
 * The task metadata endpoint's `DesiredStatus` does not: on stage it read
 * STOPPED only at SIGTERM, which ECS sends after the deregistration delay has
 * ended and the load balancer has closed every socket (ISS-12194). So the
 * endpoint is read once, for the task's identity, and each poll asks the ECS
 * API. Calls `onStopping` once, then stops polling. A failed poll, throttling
 * included, is logged on the first failure after a success and retried with a
 * doubled delay ({@link POLL_INTERVAL_MS}); SIGTERM still starts the drain
 * if no poll succeeds. Returns the stop function.
 */
export function watchTaskStopping(
  options: TaskStoppingWatchOptions
): () => void {
  const fetchTask = options.fetch ?? fetch;
  const describeDesiredStatus =
    options.describeDesiredStatus ?? createEcsDescribeDesiredStatus();
  const taskUrl = `${options.metadataUri.replace(TRAILING_SLASHES, "")}/task`;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  let task: EcsTask | undefined;
  let failing = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };

  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(poll, failing ? 2 * intervalMs : intervalMs);
    timer.unref();
  };

  const poll = async () => {
    try {
      task ??= await readTask(fetchTask, taskUrl);
      // The SDK awaits the credential lookup without the signal, so only the
      // deadline bounds a stalled one.
      const desiredStatus = await withDeadline(
        describeDesiredStatus(task, AbortSignal.timeout(POLL_TIMEOUT_MS)),
        POLL_TIMEOUT_MS
      );
      failing = false;
      if (desiredStatus === DESIRED_STATUS_STOPPED && !stopped) {
        stop();
        options.onStopping();
        return;
      }
    } catch (error) {
      if (!failing) {
        log.warn("Realtime could not read ECS task metadata", {
          event: TASK_METADATA_FAILED_EVENT,
          error: error instanceof Error ? error.message : typeof error,
        });
      }
      failing = true;
    }
    schedule();
  };

  schedule();
  return stop;
}

async function readTask(
  fetchTask: typeof fetch,
  taskUrl: string
): Promise<EcsTask> {
  const response = await fetchTask(taskUrl, {
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`task metadata answered ${response.status}`);
  }
  const task = TASK_METADATA.parse(await response.json());
  return { cluster: task.Cluster, taskArn: task.TaskARN };
}

/** One client per watcher, in the task's own region, read from its ARN. */
function createEcsDescribeDesiredStatus(): DescribeDesiredStatus {
  let client: ECSClient | undefined;
  return async (task, signal) => {
    const region = ARN_REGION.exec(task.taskArn)?.[1];
    if (region === undefined) {
      throw new Error("task metadata TaskARN is not an ECS task ARN");
    }
    client ??= new ECSClient({ region, maxAttempts: 1 });
    const answer = await client.send(
      new DescribeTasksCommand({
        cluster: task.cluster,
        tasks: [task.taskArn],
      }),
      { abortSignal: signal }
    );
    const desiredStatus = answer.tasks?.[0]?.desiredStatus;
    if (desiredStatus === undefined) {
      throw new Error(
        `DescribeTasks returned no task: ${answer.failures?.[0]?.reason ?? "no reason given"}`
      );
    }
    return desiredStatus;
  };
}

const TASK_METADATA = z.object({
  Cluster: z.string().min(1),
  TaskARN: z.string().min(1),
});
const DESIRED_STATUS_STOPPED = "STOPPED";
/**
 * ISS-12194. Detection must leave the 20 s drain window before the load
 * balancer closes the sockets: on stage ECS deregistered the target 9-11 s
 * after it began stopping the task, and the 45 s deregistration delay then
 * runs, so detection has 9 + 45 - 20 = 34 s. A failed poll waits twice the
 * interval, so two failed polls in a row cost P + 2P + 2P plus three 1.5 s
 * timeouts: 29.5 s at 5 s, 34.5 s at 6 s. At 6 tasks, 5 s is 1.2 DescribeTasks
 * calls/s per account, against ECS's documented 20/s sustained (100 burst)
 * for cluster resource reads.
 */
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 1500;
const TRAILING_SLASHES = /\/+$/;
const ARN_REGION = /^arn:[^:]+:ecs:([^:]+):/;

export const TASK_METADATA_FAILED_EVENT = "realtime.task_metadata_failed";
