import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { MEMBER_PACK_INSTALL_PATH } from "@repo/api/src/types/member-pack-install";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import {
  type MemberPackInstaller,
  registerMemberPackInstallRoutes,
} from "../src/server/operations/member-pack-install.js";

type Capture = {
  statusCode: number;
  body: string;
  serverResponse: ServerResponse;
};

function makeMockResponse(): Capture {
  const capture: Capture = {
    statusCode: 0,
    body: "",
    serverResponse: null as unknown as ServerResponse,
  };
  capture.serverResponse = {
    get statusCode() {
      return capture.statusCode;
    },
    set statusCode(v: number) {
      capture.statusCode = v;
    },
    setHeader() {
      // no-op
    },
    end(body?: string) {
      capture.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return capture;
}

function dispatch(
  dispatcher: OperationDispatcher,
  response: ServerResponse,
  body: unknown
): Promise<boolean> {
  const serialized = body === undefined ? "" : JSON.stringify(body);
  return dispatcher.dispatch({
    method: "POST",
    pathname: MEMBER_PACK_INSTALL_PATH,
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.from(serialized),
    body: serialized,
    request: {} as IncomingMessage,
    response,
  });
}

function makeDispatcher(installPack: MemberPackInstaller): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerMemberPackInstallRoutes(dispatcher, installPack);
  return dispatcher;
}

test("accepts a valid install and starts the vetted streamRun (202)", async () => {
  const calls: Array<{ packId: string; harness: string }> = [];
  const dispatcher = makeDispatcher((packId, harness) => {
    calls.push({ packId, harness });
    return Promise.resolve({ started: true, runId: 7 });
  });
  const capture = makeMockResponse();

  const handled = await dispatch(dispatcher, capture.serverResponse, {
    packId: "gstack",
    harness: "claude",
  });

  assert.equal(handled, true);
  assert.equal(capture.statusCode, 202);
  assert.deepEqual(calls, [{ packId: "gstack", harness: "claude" }]);
  const parsed = JSON.parse(capture.body) as { accepted: boolean };
  assert.equal(parsed.accepted, true);
});

test("rejects a malformed body with 400 and never starts an install", async () => {
  let installCalled = false;
  const dispatcher = makeDispatcher(() => {
    installCalled = true;
    return Promise.resolve({ started: true });
  });
  const capture = makeMockResponse();

  const handled = await dispatch(dispatcher, capture.serverResponse, {
    packId: "",
  });

  assert.equal(handled, true);
  assert.equal(capture.statusCode, 400);
  assert.equal(installCalled, false);
});

test("rejects a null body and a blank harness before starting an install", async () => {
  let installCalls = 0;
  const dispatcher = makeDispatcher(() => {
    installCalls += 1;
    return Promise.resolve({ started: true });
  });
  const nullBodyCapture = makeMockResponse();
  const blankHarnessCapture = makeMockResponse();

  const nullBodyHandled = await dispatch(
    dispatcher,
    nullBodyCapture.serverResponse,
    null
  );
  const blankHarnessHandled = await dispatch(
    dispatcher,
    blankHarnessCapture.serverResponse,
    { packId: "gstack", harness: "  " }
  );

  assert.equal(nullBodyHandled, true);
  assert.equal(nullBodyCapture.statusCode, 400);
  assert.equal(blankHarnessHandled, true);
  assert.equal(blankHarnessCapture.statusCode, 400);
  assert.equal(installCalls, 0);
});

test("surfaces a not-started install as 422 with the installer's reason", async () => {
  const dispatcher = makeDispatcher(() =>
    Promise.resolve({
      started: false,
      error: { code: "ENOCLI", message: "no supported CLI on PATH" },
    })
  );
  const capture = makeMockResponse();

  const handled = await dispatch(dispatcher, capture.serverResponse, {
    packId: "gstack",
    harness: "claude",
  });

  assert.equal(handled, true);
  assert.equal(capture.statusCode, 422);
  const parsed = JSON.parse(capture.body) as { code: string };
  assert.equal(parsed.code, "ENOCLI");
});

test("returns a stable fallback when an installer cannot provide a reason", async () => {
  const dispatcher = makeDispatcher(() => Promise.resolve({ started: false }));
  const capture = makeMockResponse();

  const handled = await dispatch(dispatcher, capture.serverResponse, {
    packId: "gstack",
    harness: "claude",
  });

  assert.equal(handled, true);
  assert.equal(capture.statusCode, 422);
  assert.deepEqual(JSON.parse(capture.body), {
    error: "pack install could not be started",
    code: "pack_install_not_started",
  });
});

test("maps a rejected installer to the bounded gateway failure response", async () => {
  const stringDispatcher = makeDispatcher(() =>
    Promise.reject("install crashed")
  );
  const errorDispatcher = makeDispatcher(() =>
    Promise.reject(new Error("install errored"))
  );
  const stringCapture = makeMockResponse();
  const errorCapture = makeMockResponse();

  const stringHandled = await dispatch(
    stringDispatcher,
    stringCapture.serverResponse,
    {
      packId: "gstack",
      harness: "claude",
    }
  );
  const errorHandled = await dispatch(
    errorDispatcher,
    errorCapture.serverResponse,
    {
      packId: "gstack",
      harness: "claude",
    }
  );

  assert.equal(stringHandled, true);
  assert.equal(errorHandled, true);
  assert.equal(stringCapture.statusCode, 500);
  assert.equal(errorCapture.statusCode, 500);
  assert.deepEqual(JSON.parse(stringCapture.body), {
    error: "pack install failed",
    code: "pack_install_failed",
  });
  assert.deepEqual(JSON.parse(errorCapture.body), {
    error: "pack install failed",
    code: "pack_install_failed",
  });
});

test("does not register the route when no installer is wired (version-skew → 501 upstream)", async () => {
  // An older build simply never calls registerMemberPackInstallRoutes, so the
  // dispatcher does not handle the path and the router answers 501. Emulate
  // that by dispatching against a bare dispatcher.
  const dispatcher = new OperationDispatcher();
  const capture = makeMockResponse();

  const handled = await dispatch(dispatcher, capture.serverResponse, {
    packId: "gstack",
    harness: "claude",
  });

  assert.equal(handled, false);
});
