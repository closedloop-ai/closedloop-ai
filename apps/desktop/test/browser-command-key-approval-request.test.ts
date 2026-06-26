import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyBrowserCommandKeyApprovalRequestCommand,
  handleBrowserCommandKeyApprovalRequestCommand,
} from "../src/main/browser-command-key-approval-request.js";
import type {
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamEvent,
} from "../src/main/cloud-protocol.js";
import {
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_METHOD,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON,
} from "../src/shared/contracts.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";

test("browser command key approval request uses API protocol literals", () => {
  assert.equal(
    BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
    "browser_key_approval_request"
  );
  assert.equal(
    BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH,
    "/api/gateway/internal/browser-key/approval-request"
  );
  assert.equal(BROWSER_COMMAND_KEY_APPROVAL_REQUEST_METHOD, "POST");
});

test("browser command key approval request matcher is exact and reserved", () => {
  assert.equal(
    classifyBrowserCommandKeyApprovalRequestCommand(makeApprovalCommand()),
    "match"
  );
  assert.equal(
    classifyBrowserCommandKeyApprovalRequestCommand(
      makeApprovalCommand({ operationId: "symphony_status" })
    ),
    "mismatch"
  );
  assert.equal(
    classifyBrowserCommandKeyApprovalRequestCommand(
      makeApprovalCommand({ method: "GET" })
    ),
    "mismatch"
  );
  assert.equal(
    classifyBrowserCommandKeyApprovalRequestCommand({
      operationId: "symphony_status",
      method: "GET",
      path: "/api/gateway/symphony/status/FEA-1",
    }),
    "not_reserved"
  );
});

test("reserved browser command key approval request acks done and notifies pending flow", async () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const events: Pick<
    DesktopCommandStreamEvent,
    "commandId" | "sequence" | "eventType" | "data"
  >[] = [];
  const notifiedFingerprints: string[] = [];
  let changedCount = 0;

  handleBrowserCommandKeyApprovalRequestCommand(
    makeApprovalCommand({
      body: { fingerprint: "  cl:abcdefghijklmnopqrstuv  " },
    }),
    {
      notifyPendingKeys: (fingerprint) => {
        notifiedFingerprints.push(fingerprint);
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: (event) => events.push(event),
      onChanged: () => {
        changedCount += 1;
      },
    }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(acks, [
    {
      commandId: "approval-command",
      accepted: true,
      state: "accepted",
    },
  ]);
  assert.deepEqual(events, [
    {
      commandId: "approval-command",
      sequence: 1,
      eventType: "done",
      data: {
        type: "done",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      },
    },
  ]);
  assert.equal(changedCount, 1);
  assert.deepEqual(notifiedFingerprints, ["cl:abcdefghijklmnopqrstuv"]);
});

test("reserved browser command key approval request accepts matching target context", async () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const notifiedFingerprints: string[] = [];

  handleBrowserCommandKeyApprovalRequestCommand(
    makeApprovalCommand({
      body: {
        fingerprint: "cl:abcdefghijklmnopqrstuv",
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
      },
    }),
    {
      getActiveTargetContext: () => ({
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
      }),
      notifyPendingKeys: (fingerprint) => {
        notifiedFingerprints.push(fingerprint);
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(acks, [
    {
      commandId: "approval-command",
      accepted: true,
      state: "accepted",
    },
  ]);
  assert.deepEqual(notifiedFingerprints, ["cl:abcdefghijklmnopqrstuv"]);
});

test("approval request with mismatched target context fails before notification", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  let notifyCount = 0;

  handleBrowserCommandKeyApprovalRequestCommand(
    makeApprovalCommand({
      body: {
        fingerprint: "cl:abcdefghijklmnopqrstuv",
        computeTargetId: OTHER_TARGET_ID,
        gatewayId: GATEWAY_ID,
      },
    }),
    {
      getActiveTargetContext: () => ({
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
      }),
      notifyPendingKeys: () => {
        notifyCount += 1;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    }
  );

  assert.equal(notifyCount, 0);
  assert.deepEqual(acks, [
    {
      commandId: "approval-command",
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON,
    },
  ]);
});

test("approval request with present context and no active target fails closed", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  let notifyCount = 0;

  handleBrowserCommandKeyApprovalRequestCommand(
    makeApprovalCommand({
      body: {
        fingerprint: "cl:abcdefghijklmnopqrstuv",
        computeTargetId: TARGET_ID,
        gatewayId: GATEWAY_ID,
      },
    }),
    {
      getActiveTargetContext: () => undefined,
      notifyPendingKeys: () => {
        notifyCount += 1;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    }
  );

  assert.equal(notifyCount, 0);
  assert.deepEqual(acks, [
    {
      commandId: "approval-command",
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON,
    },
  ]);
});

test("approval request with present-invalid target context cannot use legacy fallback", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  let notifyCount = 0;
  let legacyCount = 0;

  handleBrowserCommandKeyApprovalRequestCommand(
    makeApprovalCommand({
      body: {
        fingerprint: "cl:abcdefghijklmnopqrstuv",
        gatewayId: GATEWAY_ID,
      },
    }),
    {
      notifyPendingKeys: () => {
        notifyCount += 1;
      },
      onLegacyContextlessApproval: () => {
        legacyCount += 1;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    }
  );

  assert.equal(notifyCount, 0);
  assert.equal(legacyCount, 0);
  assert.deepEqual(acks, [
    {
      commandId: "approval-command",
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON,
    },
  ]);
});

test("malformed browser command key approval request fails without notification", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const events: Pick<
    DesktopCommandStreamEvent,
    "commandId" | "sequence" | "eventType" | "data"
  >[] = [];
  let notifyCount = 0;
  let changedCount = 0;

  handleBrowserCommandKeyApprovalRequestCommand(
    makeApprovalCommand({ body: { fingerprint: "not-a-fingerprint" } }),
    {
      notifyPendingKeys: () => {
        notifyCount += 1;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: (event) => events.push(event),
      onChanged: () => {
        changedCount += 1;
      },
    }
  );

  assert.equal(notifyCount, 0);
  assert.equal(changedCount, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(acks, [
    {
      commandId: "approval-command",
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_INVALID_REASON,
    },
  ]);
});

function makeApprovalCommand(
  overrides?: Partial<DesktopCommandEvent>
): DesktopCommandEvent {
  return {
    protocolVersion: "1",
    messageId: "approval-message",
    timestamp: "2026-05-09T00:00:00.000Z",
    commandId: "approval-command",
    operationId: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
    method: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_METHOD,
    path: BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH,
    body: { fingerprint: "cl:abcdefghijklmnopqrstuv" },
    ...overrides,
  };
}
