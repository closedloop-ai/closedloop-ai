/**
 * @file agent-session-sync-environment-gate.test.ts
 * @description ISS-7096 M3: the session lane's enqueue/drain ownership gate.
 * A hydrated candidate whose stamped identity pair belongs to ANOTHER account
 * is withheld from the upload batch (never sent to this environment's cloud),
 * while NULL-owner sessions still upload — the ISS-6168 boot claim may stamp
 * them as ours. The withheld rows' durable disposition is the environment
 * maintenance re-run (`parkForeignOutboxRows`), asserted via the maintenance
 * call the service issues after the drop.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSessionSyncBatch } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const IDENTITY = {
  organizationId: "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
  userId: "019c2a66-37e4-7221-9c3b-e159549f4c93",
};
const OTHER_IDENTITY = {
  organizationId: "019bec6e-27c2-7320-8be0-40e514918765",
  userId: "019e227c-52fb-75e5-bcad-b62cf2685dc6",
};

test("ISS-7096: a foreign-owned session is withheld from the batch; owned and unclaimed upload", async () => {
  const owned = Object.assign(
    makeSyncedSession("owned-session", "2026-08-10T12:01:00.000Z"),
    { userId: IDENTITY.userId, organizationId: IDENTITY.organizationId }
  );
  const foreign = Object.assign(
    makeSyncedSession("foreign-session", "2026-08-10T12:02:00.000Z"),
    {
      userId: OTHER_IDENTITY.userId,
      organizationId: OTHER_IDENTITY.organizationId,
    }
  );
  const unclaimed = makeSyncedSession(
    "unclaimed-session",
    "2026-08-10T12:03:00.000Z"
  );
  const source = new FakeSyncSource([owned, foreign, unclaimed]);
  const maintenanceCalls: string[] = [];
  Object.assign(source, {
    adoptOutboxRowsFromRetiredComputeTargets(
      sourceKey: string,
      _identity: unknown,
      _environmentKey: string | null
    ) {
      maintenanceCalls.push(sourceKey);
      return Promise.resolve({
        adoptedIds: [],
        declined: 0,
        skippedAlreadyLive: 0,
        retiredSourceKeys: 0,
        parkedRows: 0,
      });
    },
  });
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true as const });
    },
    "target-env-gate",
    undefined,
    IDENTITY
  );

  service.start();
  for (let i = 0; i < 3; i += 1) {
    service.refresh();
    await flushAgentSessionSync();
  }
  service.stop();

  const sentIds = sent
    .flatMap((batch) => batch.sessions.map((s) => s.externalSessionId))
    .sort();
  assert.deepEqual(
    sentIds,
    ["owned-session", "unclaimed-session"],
    "the foreign-owned session must never reach this environment's cloud"
  );
  // The durable disposition: dropping foreign candidates re-runs the outbox
  // environment maintenance (hydration already ran it once, so the drop makes
  // it at least two calls).
  assert.ok(
    maintenanceCalls.length >= 2,
    `expected a maintenance re-run after the foreign drop, saw ${maintenanceCalls.length} call(s)`
  );
});

test("ISS-7096: with no signed-in identity the gate stands down", async () => {
  const foreign = Object.assign(
    makeSyncedSession("foreign-ungated", "2026-08-10T12:02:00.000Z"),
    {
      userId: OTHER_IDENTITY.userId,
      organizationId: OTHER_IDENTITY.organizationId,
    }
  );
  const source = new FakeSyncSource([foreign]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true as const });
    },
    "target-env-ungated"
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(
    sent.flatMap((batch) => batch.sessions.map((s) => s.externalSessionId)),
    ["foreign-ungated"],
    "a null identity must degrade to the pre-gate behavior"
  );
});
