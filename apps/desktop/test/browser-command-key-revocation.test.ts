import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyBrowserCommandKeyRevocationCommand,
  handleBrowserCommandKeyRevocationCommand,
} from "../src/main/browser-command-key-revocation.js";
import type {
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamEvent,
} from "../src/main/cloud-protocol.js";
import {
  BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON,
  BROWSER_COMMAND_KEY_REVOKE_METHOD,
  BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID,
  BROWSER_COMMAND_KEY_REVOKE_PATH,
  BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON,
} from "../src/shared/contracts.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";

test("browser command key revocation uses API protocol literals", () => {
  assert.equal(BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID, "browser_key_revoke");
  assert.equal(
    BROWSER_COMMAND_KEY_REVOKE_PATH,
    "/api/gateway/internal/browser-key/revoke"
  );
  assert.equal(BROWSER_COMMAND_KEY_REVOKE_METHOD, "POST");
});

test("browser command key revocation matcher is limited to exact reserved command", () => {
  assert.equal(
    classifyBrowserCommandKeyRevocationCommand(makeRevokeCommand()),
    "match"
  );
  assert.equal(
    classifyBrowserCommandKeyRevocationCommand(
      makeRevokeCommand({ operationId: "symphony_status" })
    ),
    "mismatch"
  );
  assert.equal(
    classifyBrowserCommandKeyRevocationCommand(
      makeRevokeCommand({ method: "GET" })
    ),
    "mismatch"
  );
  assert.equal(
    classifyBrowserCommandKeyRevocationCommand({
      operationId: "symphony_status",
      method: "GET",
      path: "/api/gateway/symphony/status/FEA-1",
    }),
    "not_reserved"
  );
});

test("reserved browser command key revocation removes exact fingerprint and emits accepted done", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const events: Pick<
    DesktopCommandStreamEvent,
    "commandId" | "sequence" | "eventType" | "data"
  >[] = [];
  const removedFingerprints: string[] = [];
  let changedCount = 0;

  handleBrowserCommandKeyRevocationCommand(
    makeRevokeCommand({
      body: { fingerprint: "  cl:abcdefghijklmnopqrstuv  " },
    }),
    {
      removeAuthorizedKey: (fingerprint) => {
        removedFingerprints.push(fingerprint);
        return true;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: (event) => events.push(event),
      onChanged: () => {
        changedCount += 1;
      },
    }
  );

  assert.deepEqual(removedFingerprints, ["cl:abcdefghijklmnopqrstuv"]);
  assert.deepEqual(acks, [
    {
      commandId: "revoke-command",
      accepted: true,
      state: "accepted",
    },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "done");
  assert.equal(events[0].sequence, 1);
  assert.deepEqual(events[0].data, {
    type: "done",
    fingerprint: "cl:abcdefghijklmnopqrstuv",
    removed: true,
  });
  assert.equal(changedCount, 1);
});

test("reserved browser command key revocation accepts matching target context", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const removedFingerprints: string[] = [];

  handleBrowserCommandKeyRevocationCommand(
    makeRevokeCommand({
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
      removeAuthorizedKey: (fingerprint) => {
        removedFingerprints.push(fingerprint);
        return true;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    }
  );

  assert.deepEqual(removedFingerprints, ["cl:abcdefghijklmnopqrstuv"]);
  assert.deepEqual(acks, [
    {
      commandId: "revoke-command",
      accepted: true,
      state: "accepted",
    },
  ]);
});

test("revocation with mismatched target context fails before mutation", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  let removeCount = 0;

  handleBrowserCommandKeyRevocationCommand(
    makeRevokeCommand({
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
      removeAuthorizedKey: () => {
        removeCount += 1;
        return true;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    }
  );

  assert.equal(removeCount, 0);
  assert.deepEqual(acks, [
    {
      commandId: "revoke-command",
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_TARGET_CONTEXT_MISMATCH_REASON,
    },
  ]);
});

test("revocation with present-invalid target context fails before mutation", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  let removeCount = 0;

  handleBrowserCommandKeyRevocationCommand(
    makeRevokeCommand({
      body: {
        fingerprint: "cl:abcdefghijklmnopqrstuv",
        computeTargetId: TARGET_ID,
        gatewayId: null,
      },
    }),
    {
      removeAuthorizedKey: () => {
        removeCount += 1;
        return true;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: () => {},
    }
  );

  assert.equal(removeCount, 0);
  assert.deepEqual(acks, [
    {
      commandId: "revoke-command",
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON,
    },
  ]);
});

test("malformed browser command key revocation fails without mutation", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const events: Pick<
    DesktopCommandStreamEvent,
    "commandId" | "sequence" | "eventType" | "data"
  >[] = [];
  let removeCount = 0;

  handleBrowserCommandKeyRevocationCommand(
    makeRevokeCommand({ body: { fingerprint: "not-a-fingerprint" } }),
    {
      removeAuthorizedKey: () => {
        removeCount += 1;
        return true;
      },
      sendCommandAck: (event) => acks.push(event),
      sendCommandEvent: (event) => events.push(event),
    }
  );

  assert.equal(removeCount, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(acks, [
    {
      commandId: "revoke-command",
      accepted: false,
      state: "failed",
      reason: BROWSER_COMMAND_KEY_REVOKE_INVALID_REASON,
    },
  ]);
});

test("reserved browser command key revocation is idempotent when key is absent", () => {
  const acks: Pick<
    DesktopCommandAckEvent,
    "commandId" | "accepted" | "state" | "reason"
  >[] = [];
  const events: Pick<
    DesktopCommandStreamEvent,
    "commandId" | "sequence" | "eventType" | "data"
  >[] = [];
  let changedCount = 0;

  handleBrowserCommandKeyRevocationCommand(makeRevokeCommand(), {
    removeAuthorizedKey: () => false,
    sendCommandAck: (event) => acks.push(event),
    sendCommandEvent: (event) => events.push(event),
    onChanged: () => {
      changedCount += 1;
    },
  });

  assert.equal(acks[0].accepted, true);
  assert.equal(events[0].eventType, "done");
  assert.equal((events[0].data as Record<string, unknown>).removed, false);
  assert.equal(changedCount, 0);
});

function makeRevokeCommand(
  overrides?: Partial<DesktopCommandEvent>
): DesktopCommandEvent {
  return {
    protocolVersion: "1",
    messageId: "revoke-message",
    timestamp: "2026-05-09T00:00:00.000Z",
    commandId: "revoke-command",
    operationId: BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID,
    method: BROWSER_COMMAND_KEY_REVOKE_METHOD,
    path: BROWSER_COMMAND_KEY_REVOKE_PATH,
    body: { fingerprint: "cl:abcdefghijklmnopqrstuv" },
    ...overrides,
  };
}
