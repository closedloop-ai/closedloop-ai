/**
 * @file pack-scan-worker-entrypoint.test.ts
 * @description ISS-6708: the pack-scan utilityProcess entrypoint drains its
 * protocol and REPORTS rather than going quiet.
 *
 * The protocol (`pack-scan-worker-protocol.ts`) and the db-host runner
 * (`utility-process-pack-scan-runner.ts`) are both covered, but the runner's
 * suite drives a fake fork — nothing in the tree ever executes
 * `pack-scan-worker.ts` itself. So the residue is the entrypoint's own wiring:
 * that it subscribes to `parentPort`, and that a message it cannot service
 * comes back as a `failed` response instead of nothing at all. Silence there is
 * not a visible failure — the db-host simply waits out its timeout on every
 * scan, which is the shape this asserts against.
 *
 * Deliberately NOT re-tested here: the protocol's parsing/constructor rules and
 * the runner's request/response bookkeeping. Duplicating those through a worker
 * import buys no signal.
 *
 * SCOPE LIMIT, stated rather than implied. The `Run` dispatch — and with it the
 * `handleWorkerMessage` catch that turns a mid-compute throw into a `failed`
 * response — is NOT covered. Reaching it means executing the real
 * `computePackScan`: a recursive `readdirSync` sweep of every recent project
 * root plus `execFileSync`, whose result depends on the host's filesystem. That
 * is the slow, signal-free path ISS-6708 explicitly says not to add, and this
 * lane has no seam to stub the entrypoint's static imports. So a regression
 * confined to the `Run` branch's error reporting would not be caught here.
 */

import assert from "node:assert/strict";
import { afterEach, beforeAll, describe, it } from "vitest";
import {
  PackScanWorkerRequestType,
  PackScanWorkerResponseType,
} from "../src/main/packs/pack-scan-worker-protocol.js";

type MessageEvent = { data: unknown };
type MessageHandler = (event: MessageEvent) => void;

const posted: Record<string, unknown>[] = [];
let messageHandler: MessageHandler | null = null;

/**
 * The Electron `process.parentPort` the worker binds at import time. It does
 * not exist outside a utilityProcess, so the entrypoint can only be imported
 * with this in place — which is also what makes "did it subscribe at all"
 * observable.
 */
function installParentPortStub(): void {
  Reflect.set(process, "parentPort", {
    on: (event: string, handler: MessageHandler) => {
      if (event === "message") {
        messageHandler = handler;
      }
    },
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
    },
  });
}

/** Deliver one message and let the entrypoint's async handler settle. */
async function deliver(data: unknown): Promise<void> {
  if (!messageHandler) {
    throw new Error("the worker never subscribed to parentPort");
  }
  messageHandler({ data });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("pack-scan-worker entrypoint (ISS-6708)", () => {
  beforeAll(async () => {
    installParentPortStub();
    await import("../src/main/packs/pack-scan-worker.js");
  });

  afterEach(() => {
    posted.length = 0;
  });

  it("subscribes to parentPort messages at import", () => {
    assert.equal(typeof messageHandler, "function");
  });

  it("answers a request it cannot parse with a failed response, not silence", async () => {
    // The load-bearing one: with no response the db-host has nothing to fail
    // on and burns its whole timeout window on a message it could have been
    // told about immediately.
    await deliver({ requestId: "req-bad", type: "not-a-request-type" });

    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, PackScanWorkerResponseType.Failed);
    assert.equal(posted[0].requestId, "req-bad");
    assert.equal(posted[0].message, "invalid pack scan request");
  });

  it("stays silent for a message carrying no request id to answer on", async () => {
    // There is no correlation id to address a failure to, and posting an
    // unaddressed `failed` would resolve whichever request the db-host happens
    // to be tracking. Silence is correct here and the timeout is the signal.
    await deliver("this is not a message object");

    assert.deepEqual(posted, []);
  });

  it("serves a well-formed request, so the failure paths above are not the only reachable answer", async () => {
    // The control. Without it, an entrypoint that answered EVERY message with
    // "invalid pack scan request" would satisfy the assertions above.
    await deliver({
      requestId: "req-ok",
      scanRoots: {},
      type: PackScanWorkerRequestType.Definitions,
    });

    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, PackScanWorkerResponseType.Definitions);
    assert.equal(posted[0].requestId, "req-ok");
    assert.deepEqual(posted[0].definitions, []);
  });
});
