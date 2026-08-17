import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  JobsIpcChannel,
  registerJobsIpcHandlers,
} from "../src/main/ipc/jobs-ipc.js";
import { createStubJobStore } from "../src/main/jobs/job-store.js";

type IpcHandler = (event: { sender?: unknown }, ...args: unknown[]) => unknown;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const TRUSTED_SENDER = {};

function registerHandlers({
  isTrustedSender = () => true,
}: {
  isTrustedSender?: (sender: unknown) => boolean;
} = {}): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerJobsIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as IpcHandler);
      },
    },
    {
      isTrustedSender,
      jobStore: createStubJobStore(),
    }
  );
  return handlers;
}

function getHandler(channel: JobsIpcChannel): {
  rejecting: IpcHandler;
  allowing: IpcHandler;
} {
  const rejecting = registerHandlers({ isTrustedSender: () => false }).get(
    channel
  );
  const allowing = registerHandlers().get(channel);
  if (!(rejecting && allowing)) {
    throw new Error(`handler for ${channel} was not registered`);
  }
  return { rejecting, allowing };
}

const JOB_ID = "job-123";
const LOG_LINES = 10;
const CHANNEL_ARGS: Record<JobsIpcChannel, unknown[]> = {
  [JobsIpcChannel.ListRunningJobs]: [],
  [JobsIpcChannel.ListCompletedJobs]: [],
  [JobsIpcChannel.GetJob]: [JOB_ID],
  [JobsIpcChannel.GetJobLogTail]: [JOB_ID, LOG_LINES],
};

describe("jobs IPC trusted-sender gate", () => {
  for (const channel of Object.values(JobsIpcChannel)) {
    const args = CHANNEL_ARGS[channel];

    test(`${channel} rejects untrusted senders before doing any work`, async () => {
      const { rejecting } = getHandler(channel);

      await assert.rejects(
        async () => await rejecting({ sender: "evil" }, ...args),
        UNTRUSTED_SENDER_ERROR
      );
    });

    test(`${channel} allows a trusted sender`, async () => {
      const { allowing } = getHandler(channel);

      // A trusted sender passes the guard and reaches the inert stub store,
      // which returns an empty/null result without throwing "untrusted sender".
      await assert.doesNotReject(
        async () => await allowing({ sender: TRUSTED_SENDER }, ...args)
      );
    });
  }
});
