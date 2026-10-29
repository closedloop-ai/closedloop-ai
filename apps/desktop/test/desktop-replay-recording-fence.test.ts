/**
 * ISS-12257: main's sign-in state flips before the renderer hears of it, and a
 * replay batch takes the identity of the moment it leaves. Main refuses replay
 * batches from the flip until the renderer reports the recording that follows
 * it, under the auth generation the flip started, so a batch recorded on one
 * side of a flip never leaves with the identity from the other.
 */
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import {
  authorizeDesktopReplayRequest,
  createDesktopReplayRecordingFence,
  type DesktopReplayRequest,
} from "../src/main/auth/desktop-replay-request-auth.js";
import { registerDesktopReplayRecordingIpcHandler } from "../src/main/ipc/desktop-replay-recording-ipc.js";

// Literals, not the shared constants: the host, path and channel are the
// contract under test.
const PROD_API_ORIGIN = "https://api.closedloop.ai";
const SNAPSHOT_POST: DesktopReplayRequest = {
  url: `${PROD_API_ORIGIN}/r/s?compression=gzip-js&ip=0&_=1759838400000&ver=1.372.6`,
  method: "POST",
  requestHeaders: { "Content-Type": "text/plain" },
};
const ACCESS_TOKEN = "desktop-access-token-under-test";
const REPORT_CHANNEL = "desktop:report-replay-recording";
const TRUSTED_SENDER = { id: "trusted-renderer" };
const RECORDING_REPORT = { signedIn: true, authGeneration: 1 };

/**
 * Main's sign-in state, auth generation and token, with the fence reading them
 * as production does. `setSignedIn` is a flip, so it moves the generation on
 * as the desktop session manager does.
 */
function mainProcess(signedIn: boolean) {
  const main = { signedIn, authGeneration: 0 };
  const setSignedIn = (next: boolean) => {
    main.signedIn = next;
    main.authGeneration += 1;
  };
  /** The report of a recording that starts now, under main's current state. */
  const recordingNow = () => ({
    signedIn: main.signedIn,
    authGeneration: main.authGeneration,
  });
  const fence = createDesktopReplayRecordingFence(
    () => main.signedIn,
    () => main.authGeneration
  );
  const deps = {
    getAccessToken: vi.fn(() =>
      Promise.resolve(main.signedIn ? ACCESS_TOKEN : null)
    ),
    resolveApiOrigin: () => PROD_API_ORIGIN,
    isRecordingSignInCurrent: fence.isCurrent,
  };
  const leave = () => authorizeDesktopReplayRequest(SNAPSHOT_POST, deps);
  return { setSignedIn, recordingNow, fence, deps, leave };
}

describe("createDesktopReplayRecordingFence", () => {
  it("refuses a signed-out recording's batch from the sign-in until the renderer reports the signed-in recording", async () => {
    const { setSignedIn, recordingNow, fence, leave } = mainProcess(false);
    fence.report(recordingNow());
    assert.deepEqual(await leave(), SNAPSHOT_POST.requestHeaders);

    setSignedIn(true);

    assert.equal(await leave(), null);

    fence.report(recordingNow());
    assert.equal((await leave())?.Authorization, `Bearer ${ACCESS_TOKEN}`);
  });

  it("refuses a signed-in recording's batch from the sign-out until the renderer reports the signed-out recording", async () => {
    const { setSignedIn, recordingNow, fence, leave } = mainProcess(true);
    fence.report(recordingNow());
    assert.equal((await leave())?.Authorization, `Bearer ${ACCESS_TOKEN}`);

    setSignedIn(false);

    assert.equal(await leave(), null);

    fence.report(recordingNow());
    assert.deepEqual(await leave(), SNAPSHOT_POST.requestHeaders);
  });

  it("refuses a batch whose sign-in state flipped while its token was read", async () => {
    const { setSignedIn, recordingNow, fence, deps } = mainProcess(true);
    fence.report(recordingNow());
    deps.getAccessToken.mockImplementationOnce(() => {
      setSignedIn(false);
      return Promise.resolve(ACCESS_TOKEN);
    });

    assert.equal(
      await authorizeDesktopReplayRequest(SNAPSHOT_POST, deps),
      null
    );
  });

  // A sign-out inside the renderer's wait to report the signed-in recording
  // (`waitForSentDesktopReplayBatches`) returns main to the state of the old
  // report while the signed-in recording is still live.
  it("refuses the signed-in recording's batch when a sign-out follows the sign-in before the renderer reports", async () => {
    const { setSignedIn, recordingNow, fence, leave } = mainProcess(false);
    fence.report(recordingNow());
    assert.deepEqual(await leave(), SNAPSHOT_POST.requestHeaders);

    setSignedIn(true);
    const signedInRecording = recordingNow();
    setSignedIn(false);

    assert.equal(await leave(), null);
    fence.report(signedInRecording);
    assert.equal(await leave(), null);
    fence.report(recordingNow());
    assert.deepEqual(await leave(), SNAPSHOT_POST.requestHeaders);
  });

  it("refuses the signed-out recording's batch when a sign-in follows the sign-out before the renderer reports", async () => {
    const { setSignedIn, recordingNow, fence, leave } = mainProcess(true);
    fence.report(recordingNow());
    assert.equal((await leave())?.Authorization, `Bearer ${ACCESS_TOKEN}`);

    setSignedIn(false);
    const signedOutRecording = recordingNow();
    setSignedIn(true);

    assert.equal(await leave(), null);
    fence.report(signedOutRecording);
    assert.equal(await leave(), null);
    fence.report(recordingNow());
    assert.equal((await leave())?.Authorization, `Bearer ${ACCESS_TOKEN}`);
  });

  // The renderer sent the report before it heard either flip: a sign-out and a
  // sign-in, possibly to another account, that bring main back to the
  // reported sign-in state with the old recording still live.
  it("refuses a signed-in recording's batch when its report, sent before a sign-out and a sign-in, arrives after them", async () => {
    const { setSignedIn, recordingNow, fence, leave } = mainProcess(false);
    fence.report(recordingNow());
    setSignedIn(true);
    const inFlight = recordingNow();

    setSignedIn(false);
    setSignedIn(true);
    fence.report(inFlight);

    assert.equal(await leave(), null);
    fence.report(recordingNow());
    assert.equal((await leave())?.Authorization, `Bearer ${ACCESS_TOKEN}`);
  });

  it("refuses a signed-out recording's batch when its report, sent before a sign-in and a sign-out, arrives after them", async () => {
    const { setSignedIn, recordingNow, fence, leave } = mainProcess(true);
    fence.report(recordingNow());
    setSignedIn(false);
    const inFlight = recordingNow();

    setSignedIn(true);
    setSignedIn(false);
    fence.report(inFlight);

    assert.equal(await leave(), null);
    fence.report(recordingNow());
    assert.deepEqual(await leave(), SNAPSHOT_POST.requestHeaders);
  });

  it("refuses a recording reported without an auth generation", async () => {
    const { fence, leave } = mainProcess(true);

    fence.report({ signedIn: true });

    assert.equal(await leave(), null);
  });

  it("refuses every batch until the renderer reports its first recording", async () => {
    const { leave } = mainProcess(false);

    assert.equal(await leave(), null);
  });

  it("leaves a request other than a snapshot POST alone while it refuses", async () => {
    const { setSignedIn, recordingNow, fence, deps } = mainProcess(false);
    fence.report(recordingNow());
    setSignedIn(true);
    const preflight = { ...SNAPSHOT_POST, method: "OPTIONS" };

    assert.deepEqual(
      await authorizeDesktopReplayRequest(preflight, deps),
      preflight.requestHeaders
    );
  });

  it.each([
    ["a bare sign-in state", true],
    ["a string", "true"],
    ["a negative auth generation", { signedIn: true, authGeneration: -1 }],
    ["nothing", undefined],
  ])("ignores %s as a report", async (_label, payload) => {
    const { recordingNow, fence, leave } = mainProcess(true);
    fence.report(recordingNow());

    fence.report(payload);

    assert.equal((await leave())?.Authorization, `Bearer ${ACCESS_TOKEN}`);
  });
});

describe("registerDesktopReplayRecordingIpcHandler", () => {
  function register() {
    const handlers = new Map<
      string,
      (event: unknown, ...args: unknown[]) => unknown
    >();
    const report = vi.fn();
    registerDesktopReplayRecordingIpcHandler(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      { isTrustedSender: (sender) => sender === TRUSTED_SENDER, report }
    );
    return { handlers, report };
  }

  it("passes the trusted renderer's report to the fence", () => {
    const { handlers, report } = register();

    const answer = handlers.get(REPORT_CHANNEL)?.(
      { sender: TRUSTED_SENDER },
      RECORDING_REPORT
    );

    assert.equal(answer, true);
    assert.deepEqual(report.mock.calls, [[RECORDING_REPORT]]);
  });

  it("refuses a report from any other sender", () => {
    const { handlers, report } = register();

    const answer = handlers.get(REPORT_CHANNEL)?.(
      { sender: { id: "other" } },
      RECORDING_REPORT
    );

    assert.equal(answer, false);
    assert.equal(report.mock.calls.length, 0);
  });
});
