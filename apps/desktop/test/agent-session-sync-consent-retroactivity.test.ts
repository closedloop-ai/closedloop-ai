import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSessionSyncBatch } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { flushAgentSessionSync } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

/**
 * PLN-1694 M3 (item 12) — retroactivity, the last open question on ISS-5489 (Q3):
 * does the level chosen in the post-auth takeover apply to sessions this machine
 * parsed BEFORE anyone answered?
 *
 * It does, and this is the seam that makes it true. `agent-session-sync-service`
 * already has both static cases — a tier that forbids sync sends nothing, a tier
 * that permits it sends — but both start the lane with the answer already given.
 * Neither covers the TRANSITION, which is the only shape the takeover produces:
 * a corpus accumulates while consent is unanswered and the lane is dark, then
 * Save flips the tier and `applyDataSyncLevel` → `setCloudConnectionEnabled`
 * calls `refresh()`. If the lane ever became arrival-driven — enqueueing only
 * what lands after the gate opens — both existing cases would still pass while
 * every pre-consent session stayed on the machine forever.
 *
 * Off is the mirror image and needs no separate lane test: it never opens the
 * gate, so this same corpus stays put. What Off means for data that already
 * reached the cloud is a product decision, recorded on the plan rather than
 * encoded here — it is prospective, and deletes nothing.
 */
test("a corpus parsed before consent uploads once the chosen tier permits sync", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("pre-consent-1", "2026-08-12T12:01:00.000Z"),
    makeSyncedSession("pre-consent-2", "2026-08-12T12:02:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  let tierPermitsSync = false;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    isCloudSyncTierAllowed: () => tierPermitsSync,
    getSource: () => source,
    sendBatch: (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true });
    },
  });

  // P1→P4: signed in, lane live, consent unanswered. The sessions are already
  // on disk and none of them may leave.
  service.start();
  await flushAgentSessionSync();
  assert.equal(
    sent.length,
    0,
    "nothing may leave the machine before the consent question is answered"
  );

  // P5: Save. The tier lands and the connectivity setter re-kicks the lane.
  tierPermitsSync = true;
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.deepEqual(
    sent
      .flatMap((batch) =>
        batch.sessions.map((session) => session.externalSessionId)
      )
      .sort(),
    ["pre-consent-1", "pre-consent-2"],
    "the level chosen at the takeover applies to history parsed before it"
  );
});

test("choosing Off leaves that same corpus on the machine", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("stays-local", "2026-08-12T12:01:00.000Z"),
  ]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    // Off resolves to a tier that permits nothing, so the gate never opens —
    // including across the refresh that Save fires either way.
    isCloudSyncTierAllowed: () => false,
    getSource: () => source,
    sendBatch: (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true });
    },
  });

  service.start();
  await flushAgentSessionSync();
  service.refresh();
  await flushAgentSessionSync();
  service.stop();

  assert.equal(sent.length, 0);
});
