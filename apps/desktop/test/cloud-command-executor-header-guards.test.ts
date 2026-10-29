/**
 * @file cloud-command-executor-header-guards.test.ts
 * @description ISS-8883 — a cloud command whose header VALUES or NAMES would
 * make `new Headers` / `Headers.set` throw must still reach the gateway with
 * the offending entry dropped, never fail before the fetch is issued.
 *
 * Driven through the real loopback gateway (`cloud-command-executor-harness`),
 * no `fetch` mock: the assertion is on the request the server actually
 * received, because "the executor did not throw" would be satisfied by the
 * old behaviour too (the throw was caught and turned into an error event).
 *
 * Every value `fetch` would refuse — a code point above U+00FF, NUL, CR, LF,
 * the other C0 controls, DEL — is dropped. Latin-1 and HTAB are NOT: `approvalReason` is
 * caller-authored prose the producer admits Latin-1 into (ISS-8880), so a
 * printable-ASCII gate here would move valid input. That distinction is the
 * reason `x-desktop-operation-id` keeps its stricter gate and is pinned too.
 */
import assert from "node:assert/strict";
import type http from "node:http";
import { afterEach, test } from "vitest";
import type { CloudCommandExecutor } from "../src/main/cloud/cloud-command-executor.js";
import type { DesktopCommandEvent } from "../src/main/cloud/cloud-protocol.js";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  closeGateway,
  countDone,
  createExecutor,
  type StreamEvent,
  startGateway,
  waitFor,
} from "./cloud-command-executor-harness.js";

Observability.initNoOp();

let executor: CloudCommandExecutor | null = null;

afterEach(async () => {
  Observability.reset();
  executor?.dispose();
  executor = null;
  await closeGateway();
});

const COMMAND_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const LATIN1_TAB_REASON = "Genehmigung für Größe\t(dringend)";

const THROWING_REASONS: Array<{ label: string; reason: string }> = [
  { label: "U+2019 curly apostrophe", reason: "Deploy the user’s branch" },
  { label: "embedded NUL", reason: "Deploy\u0000now" },
  { label: "embedded CR", reason: "Deploy\rnow" },
  { label: "embedded LF", reason: "Deploy\nnow" },
  {
    label: "embedded SOH (a C0 control fetch refuses at send time)",
    reason: "Deploy\u0001now",
  },
  { label: "embedded DEL", reason: "Deploy\u007fnow" },
];

for (const { label, reason } of THROWING_REASONS) {
  test(`an approval reason with an ${label} is dropped and the command still reaches the gateway`, async () => {
    const received = await dispatch({
      requiresApproval: true,
      approvalReason: reason,
    });

    assert.equal(received.headers["x-desktop-force-approval"], "1");
    assert.equal(received.headers["x-desktop-approval-reason"], undefined);
  });
}

test("a Latin-1 approval reason with a tab arrives byte-identical", async () => {
  const received = await dispatch({
    requiresApproval: true,
    approvalReason: LATIN1_TAB_REASON,
  });

  assert.equal(received.headers["x-desktop-force-approval"], "1");
  // Node decodes header bytes as latin1, which is exactly the ByteString the
  // executor set, so the round trip is the identity on this input.
  assert.equal(
    received.headers["x-desktop-approval-reason"],
    LATIN1_TAB_REASON
  );
});

test("a printable-ASCII approval reason is set verbatim", async () => {
  const received = await dispatch({
    requiresApproval: true,
    approvalReason: "Deploy the branch",
  });

  assert.equal(
    received.headers["x-desktop-approval-reason"],
    "Deploy the branch"
  );
});

for (const reason of [undefined, ""]) {
  test(`an approval reason of ${JSON.stringify(reason)} sends no reason header, as before`, async () => {
    const received = await dispatch({
      requiresApproval: true,
      approvalReason: reason,
    });

    assert.equal(received.headers["x-desktop-force-approval"], "1");
    assert.equal(received.headers["x-desktop-approval-reason"], undefined);
  });
}

test("a Latin-1 operationId still sends no x-desktop-operation-id header", async () => {
  // The operation id is a desktop-minted identifier and keeps the stricter
  // printable-ASCII gate; only the caller-authored values got the wider bound.
  const received = await dispatch({ operationId: "git_actión" });

  assert.equal(received.headers["x-desktop-operation-id"], undefined);
});

test("custom headers keep every entry Headers can hold and drop the rest, command still done", async () => {
  const received = await dispatch({
    headers: {
      "x-ok": "a",
      "x.dotted": "b",
      "x-empty": "",
      "x-latin": "café",
      "x-max": "\u00ff",
      "x-bad": "em—dash",
      "x-ctl": "a\u0001b",
      "x bad name": "ok",
      "x:colon": "ok",
    },
  });

  assert.equal(received.headers["x-ok"], "a");
  assert.equal(received.headers["x.dotted"], "b");
  assert.equal(received.headers["x-empty"], "");
  assert.equal(received.headers["x-latin"], "café");
  // U+00FF is the LAST sendable code point, so it is kept (pins `>`, not `>=`).
  assert.equal(received.headers["x-max"], "\u00ff");
  assert.equal(received.headers["x-bad"], undefined);
  assert.equal(received.headers["x-ctl"], undefined);
  assert.equal(received.headers["x bad name"], undefined);
  assert.equal(received.headers["x:colon"], undefined);
});

test("a command whose every custom header is dropped still completes", async () => {
  const received = await dispatch({
    headers: { "x bad name": "ok", "x-bad": "em—dash" },
  });

  assert.equal(received.headers["x bad name"], undefined);
  assert.equal(received.headers["x-bad"], undefined);
  assert.equal(received.headers["x-desktop-source"], "cloud-socket");
});

test("a header name fetch refuses at send time is dropped, command still done", async () => {
  // These are valid RFC 9110 tokens, so the name and value gates pass them;
  // undici throws on them when the request is SENT, which kills the command
  // exactly the way an unsendable VALUE used to. Uppercase pins the fold.
  const received = await dispatch({
    headers: {
      expect: "100-continue",
      "keep-alive": "timeout=5",
      "Transfer-Encoding": "chunked",
      upgrade: "websocket",
      "x-kept": "a",
    },
  });

  assert.equal(received.headers.expect, undefined);
  assert.equal(received.headers["keep-alive"], undefined);
  assert.equal(received.headers["transfer-encoding"], undefined);
  assert.equal(received.headers.upgrade, undefined);
  assert.equal(received.headers["x-kept"], "a");
  assert.equal(received.headers["x-desktop-source"], "cloud-socket");
});

test("a caller-supplied x-desktop- header never reaches the gateway", async () => {
  // The prefix is main-minted: the reason is the sentence on the human's
  // approval card and the operation id keys the risk tier. A cloud peer
  // supplying either is claiming authority it does not have.
  const received = await dispatch({
    headers: {
      "x-desktop-approval-reason": "caller-authored",
      "X-Desktop-Operation-Id": "caller_op",
      "x-desktop-force-approval": "1",
      "x-desktop-gateway-token": "stolen",
    },
    operationId: "git_action",
  });

  assert.equal(received.headers["x-desktop-approval-reason"], undefined);
  assert.equal(received.headers["x-desktop-operation-id"], "git_action");
  assert.equal(received.headers["x-desktop-force-approval"], undefined);
  assert.notEqual(received.headers["x-desktop-gateway-token"], "stolen");
});

test("a caller x-desktop-approval-reason cannot fill a reason main dropped", async () => {
  // The regression this pairs with: main SKIPS its own `.set` when the reason
  // is unsendable, so without the prefix strip the caller's entry would be the
  // sentence the human reads. The card must fall back to the generated reason.
  const received = await dispatch({
    requiresApproval: true,
    approvalReason: "Deploy the user\u2019s branch",
    headers: { "x-desktop-approval-reason": "caller-authored" },
  });

  assert.equal(received.headers["x-desktop-force-approval"], "1");
  assert.equal(received.headers["x-desktop-approval-reason"], undefined);
});

async function dispatch(
  overrides: Partial<DesktopCommandEvent>
): Promise<{ headers: http.IncomingHttpHeaders }> {
  let receivedHeaders: http.IncomingHttpHeaders | undefined;
  await startGateway((request, response) => {
    receivedHeaders = request.headers;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
    return Promise.resolve();
  });

  const events: StreamEvent[] = [];
  executor = createExecutor({
    maxInFlightCommands: 1,
    onEvent: (event) => events.push(event),
  });
  executor.setConnected(true);
  executor.enqueue({
    protocolVersion: "1",
    messageId: `${COMMAND_ID}-message`,
    timestamp: new Date().toISOString(),
    commandId: COMMAND_ID,
    operationId: "git_action",
    method: "GET",
    path: "/api/gateway/git",
    query: {},
    ...overrides,
  });

  await waitFor(() => countDone(events, COMMAND_ID) === 1);

  if (!receivedHeaders) {
    throw new Error("the gateway never received the request");
  }
  return { headers: receivedHeaders };
}
