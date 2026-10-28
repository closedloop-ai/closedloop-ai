import assert from "node:assert/strict";
import type { Worker } from "node:worker_threads";
import { MetadataContentPolicy } from "@repo/lib/agent-sessions/metadata-preview";
import { test, vi } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { preparePayloadWorkerResponse } from "../src/main/agent-sync/agent-session-sync-payload-worker.js";
import { createAgentSessionPayloadWorkerPreparer } from "../src/main/agent-sync/agent-session-sync-payload-worker-runner.js";
import { makeSyncedSession } from "./fake-sync-source.js";

/**
 * ISS-7775 — the two hops between the sync service and the producer, which
 * PRODUCTION takes and no other test in this repo did.
 *
 * `sync-content-policy-wiring.test.ts` drives the real `AgentSessionSyncService`
 * but injects no `preparePayloads`, so it exercises the service's in-process
 * FALLBACK closure. Production does not use that closure:
 * `desktop-sync-lane-composition.ts` wires
 * `preparePayloads: createAgentSessionPayloadWorkerPreparer()`. So the policy
 * makes two more hops nothing covered — the runner serializing it onto the
 * worker request, and the worker reading it back off — and dropping it at either
 * one falls through to `DEFAULT_SYNC_CONTENT_POLICY` (withhold). That direction
 * is invisible to every privacy assertion in the suite: a `full`-tier user's
 * turn text, plan prose and definition text would simply stop syncing.
 *
 * Both hops are asserted here, the second BEHAVIOURALLY (what the producer
 * emitted) rather than by inspecting a call argument.
 */

const TURN_TEXT_SENTINEL = "clsentinel-worker-seam-prompt";

test("the runner serializes the content policy onto the worker request", () => {
  const workers: FakeWorker[] = [];
  const preparer = createAgentSessionPayloadWorkerPreparer((): Worker => {
    const fake = new FakeWorker();
    workers.push(fake);
    return fake as unknown as Worker;
  });

  // The promise never settles (no worker replies); only the posted request is
  // under test, so the rejection is swallowed rather than awaited.
  preparer([], 1000, false, false, MetadataContentPolicy.Retain).catch(
    () => undefined
  );

  const [posted] = workers[0].postMessage.mock.calls.at(-1) as [
    { contentPolicy?: string },
  ];
  assert.strictEqual(
    posted.contentPolicy,
    MetadataContentPolicy.Retain,
    "the runner dropped the content policy, so every packaged build falls through to the withholding default and a full-tier user silently stops syncing turn text"
  );
});

test("the worker applies the request's content policy, and withholds without one", () => {
  // BEHAVIOURAL, and both directions. Asserting only that the worker forwards
  // the field would pass against a worker that forwarded it to the wrong
  // argument; asserting only the `Retain` case would pass against one that
  // ignored the field and always retained.
  const retained = workerWireText(MetadataContentPolicy.Retain);
  assert.notEqual(
    retained,
    "",
    "the worker returned an error response, so neither assertion below observed a payload"
  );
  assert.equal(
    retained.includes(TURN_TEXT_SENTINEL),
    true,
    "the worker withheld turn text for a request that asked to retain it — the policy is not reaching the producer"
  );

  const unstated = workerWireText(undefined);
  assert.equal(
    unstated.includes(TURN_TEXT_SENTINEL),
    false,
    "a request stating no policy retained turn text — an unstated policy must resolve to withholding, never the permissive one"
  );
});

/** What the worker's own request handler emits for `contentPolicy`. */
function workerWireText(
  contentPolicy: MetadataContentPolicy | undefined
): string {
  const response = preparePayloadWorkerResponse({
    requestId: "seam-request",
    sessions: [sessionWithTurnText()],
    maxBytes: 256 * 1024,
    ...(contentPolicy === undefined ? {} : { contentPolicy }),
  });
  // An error response carries no payloads, so the caller sees `""` and its
  // `includes` assertion reads as "withheld" — which would make the `Retain`
  // case below fail loudly rather than pass vacuously. The assertion that the
  // worker succeeded lives in the test body (Biome forbids one in a helper).
  return response.ok ? JSON.stringify(response.payloads) : "";
}

function sessionWithTurnText(): SyncedAgentSession {
  return {
    ...makeSyncedSession("worker-seam-session", "2026-06-08T12:00:00.000Z"),
    metadata: {
      messages: [
        {
          role: "user",
          timestamp: "2026-06-08T12:00:00.000Z",
          text: TURN_TEXT_SENTINEL,
        },
      ],
    } as SyncedAgentSession["metadata"],
  };
}

/**
 * Minimal stand-in for a `node:worker_threads` Worker that records what the
 * runner posts. Mirrors the fake in
 * `agent-session-sync-payload-worker-runner.test.ts`; only `postMessage` is read
 * here, so the lifecycle surface is trimmed to what the runner touches.
 */
class FakeWorker {
  readonly postMessage = vi.fn((_message: unknown) => {
    // no-op: the runner never reads a return value.
  });
  readonly unref = vi.fn(() => this);
  readonly terminate = vi.fn(() => Promise.resolve(0));

  on(): this {
    return this;
  }
}
