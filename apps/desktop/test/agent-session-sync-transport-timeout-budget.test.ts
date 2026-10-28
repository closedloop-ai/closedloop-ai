/**
 * @file agent-session-sync-transport-timeout-budget.test.ts
 * @description ISS-7568 unit coverage for the ISS-5088 client-abort budget.
 *
 * `agent-session-sync-transport-timeout.test.ts` already drives the whole
 * `AgentSessionSyncService` through the ISS-5088 lane outcomes, but it never
 * constructs `TransportTimeoutBudget`, so the class's own contract has no
 * executable guard: the fold-policy shape it hands the bounded-failure fold, the
 * suppress/refund split, what re-arms it, and the ISS-7248 `charges()` view.
 *
 * Scope limit: `main/sync/AGENTS.md`'s "a server-answered HTTP 408 is ordinary
 * row-attributable — never collapse the two" is a WIRING rule about which acks
 * the service routes here, and no test that constructs this class alone can
 * guard it. The ISS-5088 service suite owns that half; this suite owns only the
 * policy this class produces once an ack has already been routed to it.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS,
  TRANSPORT_TIMEOUT_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { TransportTimeoutBudget } from "../src/main/agent-sync/agent-session-sync-transport-timeout-budget.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";

const KNOWN_CONNECTIVITY_LOSS = /known connectivity loss/;
const REFUNDED_TWO_SESSIONS =
  /refunded the transport_timeout retry budget for 2 session\(s\)/;
const PING_TIMEOUT_CAUSE = /a relay ping timeout/;

/** A `noteLoss` reporter that records instead of reaching the gateway log. */
function makeLogRecorder(): {
  log: (message: string) => void;
  lines: string[];
} {
  const lines: string[] = [];
  return { log: (message) => lines.push(message), lines };
}

test("ISS-7568: a fresh budget charges the row — a counted, bounded transport_timeout", () => {
  const budget = new TransportTimeoutBudget();
  const policy = budget.foldPolicy();

  assert.equal(policy.countsToward, true, "outside an outage the charge lands");
  assert.equal(policy.reason, DesktopAgentSessionsAckReason.TransportTimeout);
  assert.equal(policy.recoverable, true);
  assert.equal(policy.maxConsecutive, MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS);
  assert.equal(policy.backoffMs, TRANSPORT_TIMEOUT_BACKOFF_MS);
  assert.equal(policy.recordOutboxOnDefer, false);
  assert.equal(
    policy.deferLabel,
    DesktopAgentSessionsAckReason.TransportTimeout,
    "no outage, so the defer log says nothing extra"
  );
});

test("ISS-7568: inside an observed connectivity loss the policy suppresses the charge", () => {
  const budget = new TransportTimeoutBudget();
  budget.noteLoss("a relay ping timeout", makeLogRecorder().log);
  const policy = budget.foldPolicy();

  assert.equal(
    policy.countsToward,
    false,
    "a lane-wide stall must not burn a row's retry budget"
  );
  assert.match(String(policy.deferLabel), KNOWN_CONNECTIVITY_LOSS);
});

test("ISS-7568: noteLoss refunds every charge taken before the loss was observed", () => {
  const budget = new TransportTimeoutBudget();
  const charges = budget.foldPolicy().counter;
  charges.set("s1", 2);
  charges.set("s2", 1);
  const recorder = makeLogRecorder();

  budget.noteLoss("a relay ping timeout", recorder.log);

  assert.equal(
    budget.charges().size,
    0,
    "the pre-loss charges were handed back"
  );
  assert.equal(recorder.lines.length, 1, "reported the refund exactly once");
  // The COUNT and the CAUSE are the facts an operator acts on. The sentence
  // explaining why a lane-wide abort must not count is prose, deliberately not
  // pinned — an editorial rewrite is not a regression.
  assert.match(recorder.lines[0], REFUNDED_TWO_SESSIONS);
  assert.match(recorder.lines[0], PING_TIMEOUT_CAUSE);
});

test("ISS-7568: a quiet offline period refunds nothing, logs nothing, and still suppresses", () => {
  const budget = new TransportTimeoutBudget();
  const recorder = makeLogRecorder();

  budget.noteLoss("a relay ping timeout", recorder.log);

  assert.deepEqual(recorder.lines, [], "no charges to refund, so no log line");
  assert.equal(
    budget.foldPolicy().countsToward,
    false,
    "the suppression is armed whether or not anything was refunded"
  );
});

test("ISS-7568: only a verified server ack re-arms the budget", () => {
  const budget = new TransportTimeoutBudget();
  budget.noteLoss("a relay ping timeout", makeLogRecorder().log);

  budget.noteVerifiedAck();

  const policy = budget.foldPolicy();
  assert.equal(policy.countsToward, true, "proof the transport recovered");
  assert.equal(
    policy.deferLabel,
    DesktopAgentSessionsAckReason.TransportTimeout
  );
});

test("ISS-7568: re-arming is not a refund — a verified ack keeps the charges already taken", () => {
  const budget = new TransportTimeoutBudget();
  budget.foldPolicy().counter.set("s1", 2);

  budget.noteVerifiedAck();

  assert.equal(
    budget.charges().get("s1"),
    2,
    "the budget is bounded, not free: a row aborting on a healthy lane still exhausts it"
  );
});

test("ISS-7568: clearFor drops one row's charge and leaves its neighbours", () => {
  const budget = new TransportTimeoutBudget();
  const charges = budget.foldPolicy().counter;
  charges.set("s1", 2);
  charges.set("s2", 1);

  budget.clearFor("s1");

  assert.deepEqual([...budget.charges().keys()], ["s2"]);
  assert.equal(budget.charges().get("s2"), 1, "the neighbour kept its charge");
});

test("ISS-7568: clearFor does not re-arm — one row says nothing about the transport", () => {
  const budget = new TransportTimeoutBudget();
  budget.foldPolicy().counter.set("s1", 2);
  budget.noteLoss("a relay ping timeout", makeLogRecorder().log);
  budget.foldPolicy().counter.set("s1", 1);

  budget.clearFor("s1");

  assert.equal(
    budget.foldPolicy().countsToward,
    false,
    "only a verified ack re-arms; clearAll is the other reset"
  );
});

test("ISS-7568: clearAll drops every charge AND re-arms", () => {
  const budget = new TransportTimeoutBudget();
  const charges = budget.foldPolicy().counter;
  budget.noteLoss("a relay ping timeout", makeLogRecorder().log);
  charges.set("s1", 2);
  charges.set("s2", 1);

  budget.clearAll();

  assert.equal(budget.charges().size, 0);
  assert.equal(
    budget.foldPolicy().countsToward,
    true,
    "an identity change or hard reset starts from a clean transport belief"
  );
});

test("ISS-7568: charges() is a live view of the same map the fold charges, not a copy", () => {
  const budget = new TransportTimeoutBudget();
  const charges = budget.foldPolicy().counter;

  charges.set("s1", 3);
  assert.equal(
    budget.charges().get("s1"),
    3,
    "ISS-7248: the diagnostic reads the charge the fold took"
  );

  budget.clearFor("s1");
  assert.equal(
    charges.has("s1"),
    false,
    "and there stays exactly one owner of the charge"
  );
});
