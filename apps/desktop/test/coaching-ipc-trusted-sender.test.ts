import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CoachingIpcChannel,
  registerCoachingIpcHandlers,
} from "../src/main/ipc/coaching-ipc.js";

type IpcHandler = (event: { sender?: unknown }, ...args: unknown[]) => unknown;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const NOT_CONNECTED_ERROR = /Not connected/;
const REQUIRES_DISTRIBUTION_ID_ERROR = /requires a distribution id/;
const TRUSTED_SENDER = {};

type DeclineCall = {
  computeTargetId: string;
  distributionId: string;
};

type RegisterOverrides = {
  isTrustedSender?: (sender: unknown) => boolean;
  isAgentCoachingTipsEnabled?: () => boolean;
  getTraceCommentComputeTargetId?: () => string | null;
  declineDistributionById?: (
    computeTargetId: string,
    distributionId: string
  ) => Promise<void>;
  recordDeclinedDistributionId?: (distributionId: string) => void;
  assertDistributionAssigned?: (
    computeTargetId: string,
    distributionId: string
  ) => Promise<void>;
};

function registerHandlers(
  overrides: RegisterOverrides = {}
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  registerCoachingIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as IpcHandler);
      },
    },
    {
      isTrustedSender: overrides.isTrustedSender ?? (() => true),
      isAgentCoachingTipsEnabled:
        overrides.isAgentCoachingTipsEnabled ?? (() => true),
      isCoachingPacksEnabled: () => true,
      getActiveCoachingPackSeeded: () => null,
      coachingPacksDir: () => "/tmp/coaching-packs",
      getTraceCommentComputeTargetId:
        overrides.getTraceCommentComputeTargetId ?? (() => null),
      installCoachingDistributionById: () => Promise.resolve(undefined),
      declineDistributionById:
        overrides.declineDistributionById ?? (() => Promise.resolve(undefined)),
      recordDeclinedDistributionId:
        overrides.recordDeclinedDistributionId ??
        (() => {
          /* no-op default */
        }),
      assertDistributionAssigned:
        overrides.assertDistributionAssigned ??
        (() => Promise.resolve(undefined)),
    }
  );
  return handlers;
}

function getHandler(
  handlers: Map<string, IpcHandler>,
  channel: string
): IpcHandler {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`${channel} handler was not registered`);
  }
  return handler;
}

describe("coaching Generate IPC trusted-sender gate", () => {
  test("rejects untrusted senders before running the local harness", async () => {
    const handler = getHandler(
      registerHandlers({ isTrustedSender: () => false }),
      CoachingIpcChannel.Generate
    );

    await assert.rejects(
      async () => await handler({ sender: "evil" }, "prompt"),
      UNTRUSTED_SENDER_ERROR
    );
  });

  test("gates sender trust before the disabled short-circuit", async () => {
    // A trusted sender with coaching disabled short-circuits to the empty
    // result without spawning a process — proving the assert ran (no throw)
    // and precedes the disabled check.
    const handler = getHandler(
      registerHandlers({ isAgentCoachingTipsEnabled: () => false }),
      CoachingIpcChannel.Generate
    );

    assert.deepEqual(await handler({ sender: TRUSTED_SENDER }, "prompt"), {
      ok: true,
      output: "[]",
    });
  });
});

// FEA-4050: the DistributionDecline handler must (a) reject untrusted senders,
// (b) validate the id, (c) persist the decline id-only when NOT connected, and
// (d) delegate to declineDistributionById when connected.
describe("DistributionDecline IPC handler (FEA-4050)", () => {
  test("rejects untrusted senders before touching any persistence", async () => {
    const declineCalls: DeclineCall[] = [];
    const idOnlyCalls: string[] = [];
    const handler = getHandler(
      registerHandlers({
        isTrustedSender: () => false,
        getTraceCommentComputeTargetId: () => "ct-001",
        declineDistributionById: (computeTargetId, distributionId) => {
          declineCalls.push({ computeTargetId, distributionId });
          return Promise.resolve();
        },
        recordDeclinedDistributionId: (distributionId) => {
          idOnlyCalls.push(distributionId);
        },
      }),
      CoachingIpcChannel.DistributionDecline
    );

    await assert.rejects(
      async () => await handler({ sender: "evil" }, "dist-001"),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(declineCalls.length, 0, "no cloud-scoped write for untrusted");
    assert.equal(idOnlyCalls.length, 0, "no id-only write for untrusted");
  });

  test("rejects an empty distribution id", async () => {
    const handler = getHandler(
      registerHandlers({ getTraceCommentComputeTargetId: () => "ct-001" }),
      CoachingIpcChannel.DistributionDecline
    );

    await assert.rejects(
      async () => await handler({ sender: TRUSTED_SENDER }, ""),
      REQUIRES_DISTRIBUTION_ID_ERROR
    );
  });

  test("delegates to declineDistributionById when connected", async () => {
    const declineCalls: DeclineCall[] = [];
    const idOnlyCalls: string[] = [];
    const handler = getHandler(
      registerHandlers({
        getTraceCommentComputeTargetId: () => "ct-001",
        declineDistributionById: (computeTargetId, distributionId) => {
          declineCalls.push({ computeTargetId, distributionId });
          return Promise.resolve();
        },
        recordDeclinedDistributionId: (distributionId) => {
          idOnlyCalls.push(distributionId);
        },
      }),
      CoachingIpcChannel.DistributionDecline
    );

    await handler({ sender: TRUSTED_SENDER }, "dist-001");

    assert.deepEqual(declineCalls, [
      { computeTargetId: "ct-001", distributionId: "dist-001" },
    ]);
    assert.equal(
      idOnlyCalls.length,
      0,
      "connected path does not id-only write"
    );
  });

  test("persists the decline id-only when NOT connected (no compute target)", async () => {
    // The reappear-after-restart bug the human reviewer flagged: an offline
    // decline that returned success without writing would re-surface the pack
    // the moment the cloud reconnected. It must persist the id durably now.
    const declineCalls: DeclineCall[] = [];
    const idOnlyCalls: string[] = [];
    const handler = getHandler(
      registerHandlers({
        getTraceCommentComputeTargetId: () => null,
        declineDistributionById: (computeTargetId, distributionId) => {
          declineCalls.push({ computeTargetId, distributionId });
          return Promise.resolve();
        },
        recordDeclinedDistributionId: (distributionId) => {
          idOnlyCalls.push(distributionId);
        },
      }),
      CoachingIpcChannel.DistributionDecline
    );

    await handler({ sender: TRUSTED_SENDER }, "dist-001");

    assert.deepEqual(
      idOnlyCalls,
      ["dist-001"],
      "the offline decline must be persisted id-only"
    );
    assert.equal(declineCalls.length, 0, "no cloud lookup when not connected");
  });
});

// ISS-5123: the pre-install revalidation handler is what stops a withdrawn but
// still-on-screen offer from installing. It must (a) reject untrusted senders
// before any cloud call, (b) validate the id, (c) fail CLOSED when not connected
// rather than waving the install through, and (d) delegate when connected.
describe("DistributionEnsureAssigned IPC handler (ISS-5123)", () => {
  test("rejects untrusted senders before any cloud lookup", async () => {
    const calls: DeclineCall[] = [];
    const handler = getHandler(
      registerHandlers({
        isTrustedSender: () => false,
        getTraceCommentComputeTargetId: () => "ct-001",
        assertDistributionAssigned: (computeTargetId, distributionId) => {
          calls.push({ computeTargetId, distributionId });
          return Promise.resolve();
        },
      }),
      CoachingIpcChannel.DistributionEnsureAssigned
    );

    await assert.rejects(
      async () => await handler({ sender: "evil" }, "dist-001"),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(calls.length, 0, "no cloud lookup for an untrusted sender");
  });

  test("rejects an empty distribution id", async () => {
    const handler = getHandler(
      registerHandlers({ getTraceCommentComputeTargetId: () => "ct-001" }),
      CoachingIpcChannel.DistributionEnsureAssigned
    );

    await assert.rejects(
      async () => await handler({ sender: TRUSTED_SENDER }, ""),
      REQUIRES_DISTRIBUTION_ID_ERROR
    );
  });

  test("fails closed when not connected — an unconfirmable offer must not install", async () => {
    const handler = getHandler(
      registerHandlers({ getTraceCommentComputeTargetId: () => null }),
      CoachingIpcChannel.DistributionEnsureAssigned
    );

    await assert.rejects(
      async () => await handler({ sender: TRUSTED_SENDER }, "dist-001"),
      NOT_CONNECTED_ERROR
    );
  });

  test("delegates to the cloud-authoritative check when connected", async () => {
    const calls: DeclineCall[] = [];
    const handler = getHandler(
      registerHandlers({
        getTraceCommentComputeTargetId: () => "ct-001",
        assertDistributionAssigned: (computeTargetId, distributionId) => {
          calls.push({ computeTargetId, distributionId });
          return Promise.resolve();
        },
      }),
      CoachingIpcChannel.DistributionEnsureAssigned
    );

    await handler({ sender: TRUSTED_SENDER }, "dist-001");

    assert.deepEqual(calls, [
      { computeTargetId: "ct-001", distributionId: "dist-001" },
    ]);
  });
});
