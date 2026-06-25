import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, test } from "node:test";
import { gatewayLog } from "../src/main/gateway-logger.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  _resetMutexForTesting,
  registerUpdateAndRestartRoutes,
  type UpdateAndRestartOptions,
} from "../src/server/operations/update-and-restart.js";

afterEach(() => {
  _resetMutexForTesting();
  gatewayLog.clear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Capture = {
  statusCode: number;
  body: string;
  endCallback: (() => void) | null;
  serverResponse: ServerResponse;
};

/**
 * Builds a minimal mock ServerResponse.  All captured state lives on a single
 * `Capture` object so tests can read `capture.statusCode` and `capture.body`
 * after the dispatch resolves — there is no spread copy to worry about.
 */
function makeMockResponse(): Capture {
  const capture: Capture = {
    statusCode: 0,
    body: "",
    endCallback: null,
    serverResponse: null as unknown as ServerResponse,
  };

  const serverResponse = {
    get statusCode() {
      return capture.statusCode;
    },
    set statusCode(v: number) {
      capture.statusCode = v;
    },
    setHeader() {},
    end(body?: string, callback?: () => void) {
      capture.body = body ?? "";
      capture.endCallback = callback ?? null;
    },
  } as unknown as ServerResponse;

  capture.serverResponse = serverResponse;
  return capture;
}

/**
 * Builds a minimal mock OperationRequestContext and dispatches
 * POST /api/gateway/update-and-restart through the given dispatcher.
 */
async function dispatch(
  dispatcher: OperationDispatcher,
  response: ServerResponse
): Promise<boolean> {
  return dispatcher.dispatch({
    method: "POST",
    pathname: "/api/gateway/update-and-restart",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.alloc(0),
    body: "",
    request: {} as IncomingMessage,
    response,
  });
}

/**
 * Creates a dispatcher with the given option overrides and registers the route.
 */
function makeDispatcher(
  optionOverrides: Partial<UpdateAndRestartOptions> = {}
): OperationDispatcher {
  const defaults: UpdateAndRestartOptions = {
    isUpdateAndRestartEnabled: () => true,
    checkForUpdate: async () => ({ updateAvailable: false }),
    applyUpdate: async () => {},
    ...optionOverrides,
  };

  const dispatcher = new OperationDispatcher();
  registerUpdateAndRestartRoutes(dispatcher, defaults);
  return dispatcher;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("feature-flag disabled returns 501 with feature_disabled error", async () => {
  const capture = makeMockResponse();
  const dispatcher = makeDispatcher({
    isUpdateAndRestartEnabled: () => false,
  });

  const handled = await dispatch(dispatcher, capture.serverResponse);

  assert.equal(handled, true);
  assert.equal(capture.statusCode, 501);
  const body = JSON.parse(capture.body) as { error: string; feature: string };
  assert.equal(body.error, "feature_disabled");
  assert.equal(body.feature, "update_and_restart");
});

test("in-flight mutex returns 409 when update already in progress", async () => {
  // Trigger the first dispatch but leave it in-flight by providing a
  // checkForUpdate that never resolves, so the mutex stays set.
  let resolveFirstCheck!: (v: { updateAvailable: boolean }) => void;
  const checkForUpdatePromise = new Promise<{ updateAvailable: boolean }>(
    (resolve) => {
      resolveFirstCheck = resolve;
    }
  );

  const dispatcher = makeDispatcher({
    checkForUpdate: () => checkForUpdatePromise,
  });

  // Fire and forget — keep the first request hanging.
  const firstCapture = makeMockResponse();
  const firstDispatch = dispatch(dispatcher, firstCapture.serverResponse);

  // Give the event loop one tick so the handler can acquire the mutex.
  await Promise.resolve();

  // Second concurrent request should see 409.
  const secondCapture = makeMockResponse();
  const handled = await dispatch(dispatcher, secondCapture.serverResponse);

  assert.equal(handled, true);
  assert.equal(secondCapture.statusCode, 409);
  const body = JSON.parse(secondCapture.body) as { error: string };
  assert.equal(body.error, "update_in_progress");

  // Clean up: resolve the hanging first request so the mutex is freed.
  resolveFirstCheck({ updateAvailable: false });
  await firstDispatch;
});

test("checkForUpdate failure returns 502 with error message", async () => {
  const capture = makeMockResponse();
  const dispatcher = makeDispatcher({
    checkForUpdate: async () => {
      throw new Error("network timeout");
    },
  });

  const handled = await dispatch(dispatcher, capture.serverResponse);

  assert.equal(handled, true);
  assert.equal(capture.statusCode, 502);
  const body = JSON.parse(capture.body) as { error: string };
  assert.equal(body.error, "network timeout");
});

test("no update available returns 200 with updateAvailable false", async () => {
  const capture = makeMockResponse();
  const dispatcher = makeDispatcher({
    checkForUpdate: async () => ({ updateAvailable: false, version: "1.2.3" }),
  });

  const handled = await dispatch(dispatcher, capture.serverResponse);

  assert.equal(handled, true);
  assert.equal(capture.statusCode, 200);
  const body = JSON.parse(capture.body) as {
    updateAvailable: boolean;
    version?: string;
  };
  assert.equal(body.updateAvailable, false);
  assert.equal(body.version, "1.2.3");
});

test("update available returns 200 with updateAvailable true and updateInitiated true", async () => {
  let applyUpdateCalled = false;

  const capture = makeMockResponse();
  const dispatcher = makeDispatcher({
    checkForUpdate: async () => ({ updateAvailable: true }),
    applyUpdate: async () => {
      applyUpdateCalled = true;
    },
  });

  const handled = await dispatch(dispatcher, capture.serverResponse);

  assert.equal(handled, true);
  assert.equal(capture.statusCode, 200);
  const body = JSON.parse(capture.body) as {
    updateAvailable: boolean;
    updateInitiated: boolean;
  };
  assert.equal(body.updateAvailable, true);
  assert.equal(body.updateInitiated, true);

  // applyUpdate is called asynchronously after the response is flushed;
  // it should not have been called before the flush callback fires.
  assert.equal(
    applyUpdateCalled,
    false,
    "applyUpdate should not be called before flush callback"
  );
});

test("applyUpdate error is caught and does not throw unhandled rejection", async () => {
  const capture = makeMockResponse();

  // applyUpdate always rejects immediately when called.  The handler chains
  // .finally().catch() synchronously on the returned promise, so the rejection
  // is always handled — no unhandled rejection warning should escape.
  const dispatcher = makeDispatcher({
    checkForUpdate: async () => ({ updateAvailable: true }),
    applyUpdate: async () => {
      throw new Error("apply failed");
    },
  });

  await dispatch(dispatcher, capture.serverResponse);

  assert.equal(
    capture.statusCode,
    200,
    "response should be 200 before flush callback fires"
  );

  // Fire the flush callback synchronously (simulates TCP delivery completing).
  assert.ok(
    capture.endCallback,
    "end() should have been called with a flush callback"
  );
  capture.endCallback!();

  // Wait long enough for the setTimeout(_, 500) timer and the rejected promise
  // to settle.  If an unhandled rejection were thrown the test runner would
  // catch it and fail this test automatically.
  await new Promise<void>((resolve) => setTimeout(resolve, 600));

  const entries = gatewayLog.getEntries();
  assert.ok(
    entries.some(
      (entry) =>
        entry.level === "error" &&
        entry.tag === "update-and-restart" &&
        entry.message.includes("apply-update failed: apply failed")
    ),
    "expected applyUpdate failure to be logged"
  );

  // Reaching here means no unhandled rejection escaped.
  assert.ok(true, "no unhandled rejection was thrown");
});

test("mutex is cleared after successful completion (no update available)", async () => {
  const dispatcher = makeDispatcher({
    checkForUpdate: async () => ({ updateAvailable: false }),
  });

  // First request — succeeds.
  const firstCapture = makeMockResponse();
  await dispatch(dispatcher, firstCapture.serverResponse);
  assert.equal(firstCapture.statusCode, 200);

  // Second request — mutex must have been released, so it should also succeed.
  const secondCapture = makeMockResponse();
  await dispatch(dispatcher, secondCapture.serverResponse);
  assert.equal(secondCapture.statusCode, 200);
  const body = JSON.parse(secondCapture.body) as { updateAvailable: boolean };
  assert.equal(body.updateAvailable, false);
});

test("mutex is cleared after checkForUpdate failure", async () => {
  const dispatcher = makeDispatcher({
    checkForUpdate: async () => {
      throw new Error("transient error");
    },
  });

  // First request — fails with 502.
  const firstCapture = makeMockResponse();
  await dispatch(dispatcher, firstCapture.serverResponse);
  assert.equal(firstCapture.statusCode, 502);

  // Second request using a healthy checkForUpdate confirms the mutex was
  // released.  A new dispatcher is used because options are captured at
  // register-time and cannot be swapped on an existing dispatcher.
  const dispatcher2 = makeDispatcher({
    checkForUpdate: async () => ({ updateAvailable: false }),
  });

  const secondCapture = makeMockResponse();
  await dispatch(dispatcher2, secondCapture.serverResponse);
  assert.equal(secondCapture.statusCode, 200);
  const body = JSON.parse(secondCapture.body) as { updateAvailable: boolean };
  assert.equal(body.updateAvailable, false);
});
