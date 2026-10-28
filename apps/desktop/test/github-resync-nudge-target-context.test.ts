import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type ActiveCommandKeyTargetContext,
  BrowserCommandKeyTargetContextOutcome,
  classifyBrowserCommandKeyTargetContext,
  parseBrowserCommandKeyCommandTargetContext,
} from "../src/main/github/github-resync-nudge-target-context.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_GATEWAY_ID = "44444444-4444-4444-8444-444444444444";
const ACTIVE_CONTEXT: ActiveCommandKeyTargetContext = {
  computeTargetId: TARGET_ID,
  gatewayId: GATEWAY_ID,
};

test("command context parser distinguishes absent, invalid, and present matching context", () => {
  assert.deepEqual(
    parseBrowserCommandKeyCommandTargetContext({
      fingerprint: "cl:abcdefghijklmnopqrstuv",
    }),
    { kind: "absent" }
  );
  assert.deepEqual(
    parseBrowserCommandKeyCommandTargetContext({
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      gatewayId: GATEWAY_ID,
    }),
    { kind: "invalid" }
  );
  assert.deepEqual(
    parseBrowserCommandKeyCommandTargetContext({
      fingerprint: "cl:abcdefghijklmnopqrstuv",
      computeTargetId: TARGET_ID,
      gatewayId: null,
    }),
    { kind: "invalid" }
  );
  const present = parseBrowserCommandKeyCommandTargetContext({
    fingerprint: "cl:abcdefghijklmnopqrstuv",
    computeTargetId: TARGET_ID,
    gatewayId: GATEWAY_ID,
  });
  assert.ok(present.kind === "present");
  assert.equal(
    classifyBrowserCommandKeyTargetContext({
      commandContext: present,
      activeContext: ACTIVE_CONTEXT,
    }),
    BrowserCommandKeyTargetContextOutcome.Match
  );
});

/**
 * ISS-7486: this fold used to be a boolean, so three unrelated failures shared
 * one wire reason and 100% of production's 39,110 rejected acks landed in it.
 * Each row below is one of those conditions; collapsing any two makes this
 * table fail rather than silently rebuilding the bucket.
 */
const TARGET_CONTEXT_OUTCOME_CASES: readonly {
  name: string;
  commandContext:
    | { kind: "absent" }
    | { kind: "present"; context: ActiveCommandKeyTargetContext };
  activeContext?: ActiveCommandKeyTargetContext;
  expected: (typeof BrowserCommandKeyTargetContextOutcome)[keyof typeof BrowserCommandKeyTargetContextOutcome];
}[] = [
  {
    name: "a command with no context at all is absence, not disagreement",
    commandContext: { kind: "absent" },
    activeContext: ACTIVE_CONTEXT,
    expected: BrowserCommandKeyTargetContextOutcome.CommandContextAbsent,
  },
  {
    name: "an unresolvable active context is the desktop's own absence",
    commandContext: { kind: "present", context: ACTIVE_CONTEXT },
    activeContext: undefined,
    expected: BrowserCommandKeyTargetContextOutcome.ActiveContextUnresolved,
  },
  {
    name: "differing compute targets name the compute target",
    commandContext: {
      kind: "present",
      context: { computeTargetId: OTHER_TARGET_ID, gatewayId: GATEWAY_ID },
    },
    activeContext: ACTIVE_CONTEXT,
    expected: BrowserCommandKeyTargetContextOutcome.ComputeTargetMismatch,
  },
  {
    name: "differing gateways name the gateway",
    commandContext: {
      kind: "present",
      context: { computeTargetId: TARGET_ID, gatewayId: OTHER_GATEWAY_ID },
    },
    activeContext: ACTIVE_CONTEXT,
    expected: BrowserCommandKeyTargetContextOutcome.GatewayMismatch,
  },
  {
    name: "a command that names no gateway still matches on compute target",
    commandContext: {
      kind: "present",
      context: { computeTargetId: TARGET_ID },
    },
    activeContext: ACTIVE_CONTEXT,
    expected: BrowserCommandKeyTargetContextOutcome.Match,
  },
  {
    name: "a compute-target mismatch outranks a gateway that also differs",
    commandContext: {
      kind: "present",
      context: {
        computeTargetId: OTHER_TARGET_ID,
        gatewayId: OTHER_GATEWAY_ID,
      },
    },
    activeContext: ACTIVE_CONTEXT,
    expected: BrowserCommandKeyTargetContextOutcome.ComputeTargetMismatch,
  },
];

for (const outcomeCase of TARGET_CONTEXT_OUTCOME_CASES) {
  test(`target context classification: ${outcomeCase.name}`, () => {
    assert.equal(
      classifyBrowserCommandKeyTargetContext({
        commandContext: outcomeCase.commandContext,
        activeContext: outcomeCase.activeContext,
      }),
      outcomeCase.expected
    );
  });
}
