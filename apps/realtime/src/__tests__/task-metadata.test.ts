import { DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DescribeDesiredStatus,
  TASK_METADATA_FAILED_EVENT,
  watchTaskStopping,
} from "../lifecycle/task-metadata";

const METADATA_URI = "http://169.254.170.2/v4/task-abc/";
const TASK_URL = "http://169.254.170.2/v4/task-abc/task";
const POLL_MS = 5000;
const BACKOFF_MS = 2 * POLL_MS;
const POLL_TIMEOUT_MS = 1500;
const CLUSTER_ARN =
  "arn:aws:ecs:us-east-1:000000000000:cluster/example-stage-realtime";
const TASK_ARN =
  "arn:aws:ecs:us-east-1:000000000000:task/example-stage-realtime/5626f5b4d0c34171af1beb570fc3c179";
const ECS_TASK = { cluster: CLUSTER_ARN, taskArn: TASK_ARN };

let stopWatch: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopWatch?.();
  stopWatch = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * What Fargate's metadata endpoint answered on stage through a whole
 * deregistration delay (ISS-12194): the agent's `DesiredStatus` stays RUNNING
 * until SIGTERM.
 */
function taskResponse(desiredStatus = "RUNNING"): Response {
  return Response.json({
    Cluster: CLUSTER_ARN,
    TaskARN: TASK_ARN,
    DesiredStatus: desiredStatus,
    KnownStatus: "RUNNING",
  });
}

function metadataFetch() {
  return vi.fn(async (_url: string, _init?: RequestInit) => taskResponse());
}

function desiredStatuses(...statuses: string[]) {
  return vi.fn<DescribeDesiredStatus>(
    async () => statuses.shift() ?? "STOPPED"
  );
}

describe("watchTaskStopping", () => {
  it("fires on the ECS API's desiredStatus while the metadata endpoint still reads RUNNING", async () => {
    const fetchTask = metadataFetch();
    const describeDesiredStatus = desiredStatuses("RUNNING", "STOPPED");
    const onStopping = vi.fn();
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping,
      fetch: fetchTask as unknown as typeof fetch,
      describeDesiredStatus,
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onStopping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(onStopping).toHaveBeenCalledOnce();
  });

  it("reads the task's identity from {uri}/task once, then asks the ECS API every 5 s until it fires", async () => {
    const fetchTask = metadataFetch();
    const describeDesiredStatus = desiredStatuses(
      "RUNNING",
      "RUNNING",
      "STOPPED"
    );
    const onStopping = vi.fn();
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping,
      fetch: fetchTask as unknown as typeof fetch,
      describeDesiredStatus,
    });

    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(describeDesiredStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTask).toHaveBeenCalledWith(TASK_URL, expect.anything());
    expect(describeDesiredStatus).toHaveBeenCalledWith(
      ECS_TASK,
      expect.any(AbortSignal)
    );

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(onStopping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(describeDesiredStatus).toHaveBeenCalledTimes(3);
    expect(fetchTask).toHaveBeenCalledOnce();
    expect(onStopping).toHaveBeenCalledOnce();
  });

  it("logs the first failure of a run, keeps polling, and logs again after a recovery", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const outcomes = ["fail", "fail", "RUNNING", "fail", "STOPPED"];
    const describeDesiredStatus = vi.fn<DescribeDesiredStatus>(() => {
      const next = outcomes.shift();
      if (next === "fail") {
        return Promise.reject(new Error("AccessDeniedException"));
      }
      return Promise.resolve(next ?? "RUNNING");
    });
    const onStopping = vi.fn();
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping,
      fetch: metadataFetch() as unknown as typeof fetch,
      describeDesiredStatus,
    });

    // fail at 5 s, fail at 15 s, RUNNING at 25 s, fail at 30 s, STOPPED at 40 s.
    await vi.advanceTimersByTimeAsync(40_000);

    expect(onStopping).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: TASK_METADATA_FAILED_EVENT,
        error: "AccessDeniedException",
      })
    );
  });

  it("treats a non-2xx metadata answer or one without the task's identity as a failed poll, and retries the read", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const responses = [
      Response.json(
        { Cluster: CLUSTER_ARN, TaskARN: TASK_ARN },
        { status: 500 }
      ),
      Response.json({ DesiredStatus: "STOPPED" }),
    ];
    const describeDesiredStatus = desiredStatuses("STOPPED");
    const onStopping = vi.fn();
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping,
      fetch: (async () =>
        responses.shift() ?? taskResponse()) as unknown as typeof fetch,
      describeDesiredStatus,
    });

    await vi.advanceTimersByTimeAsync(POLL_MS + BACKOFF_MS);
    expect(describeDesiredStatus).not.toHaveBeenCalled();
    expect(onStopping).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    expect(describeDesiredStatus).toHaveBeenCalledWith(
      ECS_TASK,
      expect.any(AbortSignal)
    );
    expect(onStopping).toHaveBeenCalledOnce();
  });

  it("never overlaps polls: the next is scheduled once the previous answers", async () => {
    let answer: ((status: string) => void) | undefined;
    const describeDesiredStatus = vi.fn<DescribeDesiredStatus>(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        })
    );
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping: vi.fn(),
      fetch: metadataFetch() as unknown as typeof fetch,
      describeDesiredStatus,
    });

    await vi.advanceTimersByTimeAsync(POLL_MS + POLL_TIMEOUT_MS - 1);
    answer?.("RUNNING");
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(describeDesiredStatus).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(describeDesiredStatus).toHaveBeenCalledTimes(2);
  });

  it("gives up on a DescribeTasks call that ignores its abort signal, as a stalled credential lookup does, and polls again", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const send = vi
      .spyOn(ECSClient.prototype, "send")
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockImplementation(async () => ({
        tasks: [{ desiredStatus: "STOPPED" }],
        failures: [],
      }));
    const onStopping = vi.fn();
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping,
      fetch: metadataFetch() as unknown as typeof fetch,
    });

    await vi.advanceTimersByTimeAsync(POLL_MS + POLL_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: TASK_METADATA_FAILED_EVENT })
    );

    await vi.advanceTimersByTimeAsync(BACKOFF_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onStopping).toHaveBeenCalledOnce();
  });

  it("waits 10 s after a throttled poll, never longer, and returns to 5 s once a poll succeeds", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const throttled = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
    });
    const outcomes = ["throttle", "throttle", "throttle", "RUNNING"];
    const calledAt: number[] = [];
    const describeDesiredStatus = vi.fn<DescribeDesiredStatus>(() => {
      calledAt.push(Date.now() - startedAt);
      const next = outcomes.shift() ?? "RUNNING";
      return next === "throttle"
        ? Promise.reject(throttled)
        : Promise.resolve(next);
    });
    const startedAt = Date.now();
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping: vi.fn(),
      fetch: metadataFetch() as unknown as typeof fetch,
      describeDesiredStatus,
    });

    await vi.advanceTimersByTimeAsync(45_000);

    expect(calledAt).toEqual([5000, 15_000, 25_000, 35_000, 40_000, 45_000]);
  });

  it("keeps retrying without firing or throwing while every poll fails, so SIGTERM stays the trigger", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const describeDesiredStatus = vi.fn<DescribeDesiredStatus>(() =>
      Promise.reject(
        Object.assign(
          new Error("not authorized to perform: ecs:DescribeTasks"),
          {
            name: "AccessDeniedException",
          }
        )
      )
    );
    const onStopping = vi.fn();
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping,
      fetch: metadataFetch() as unknown as typeof fetch,
      describeDesiredStatus,
    });

    await vi.advanceTimersByTimeAsync(55_000);

    expect(describeDesiredStatus).toHaveBeenCalledTimes(6);
    expect(onStopping).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("logs the thrown value's type when a poll rejects with a non-Error", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping: vi.fn(),
      fetch: (() =>
        Promise.reject("connection refused")) as unknown as typeof fetch,
      describeDesiredStatus: desiredStatuses("STOPPED"),
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: TASK_METADATA_FAILED_EVENT,
        error: "string",
      })
    );
  });

  it("uses the global fetch and the ECS API in the task's own region when none is injected", async () => {
    const globalFetch = vi.fn(async () => taskResponse());
    vi.stubGlobal("fetch", globalFetch);
    const regions: string[] = [];
    const send = vi
      .spyOn(ECSClient.prototype, "send")
      .mockImplementation(async function (this: ECSClient) {
        regions.push(await this.config.region());
        return { tasks: [{ desiredStatus: "STOPPED" }], failures: [] };
      });
    const onStopping = vi.fn();
    try {
      stopWatch = watchTaskStopping({ metadataUri: METADATA_URI, onStopping });

      await vi.advanceTimersByTimeAsync(POLL_MS);

      expect(globalFetch).toHaveBeenCalledWith(TASK_URL, expect.anything());
      const command = send.mock.calls[0]?.[0];
      expect(command).toBeInstanceOf(DescribeTasksCommand);
      expect(command?.input).toEqual({
        cluster: CLUSTER_ARN,
        tasks: [TASK_ARN],
      });
      expect(regions).toEqual(["us-east-1"]);
      expect(onStopping).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats a DescribeTasks answer that lists the task only as a failure as a failed poll", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(ECSClient.prototype, "send").mockImplementation(async () => ({
      tasks: [],
      failures: [{ arn: TASK_ARN, reason: "MISSING" }],
    }));
    const onStopping = vi.fn();
    stopWatch = watchTaskStopping({
      metadataUri: METADATA_URI,
      onStopping,
      fetch: metadataFetch() as unknown as typeof fetch,
    });

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(onStopping).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: TASK_METADATA_FAILED_EVENT,
        error: "DescribeTasks returned no task: MISSING",
      })
    );
  });
});
