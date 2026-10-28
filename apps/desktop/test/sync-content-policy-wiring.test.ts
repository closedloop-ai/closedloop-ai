import assert from "node:assert/strict";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { test } from "vitest";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { flushAgentSessionSync } from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

/**
 * ISS-7775 — the PRODUCTION WIRING, asserted through the real sync service.
 *
 * `data-sync-tier-egress.test.ts` proves the producer honors a content policy.
 * That is not the same claim as "the service hands it the user's actual level",
 * and the difference is invisible to every other test in this repo: the producer
 * resolves an unstated policy to WITHHOLDING, so a service that stopped
 * forwarding `dataSyncLevel` entirely would keep every metadata-tier assertion
 * green while silently blanking turn previews for `full`-tier users — a
 * capability loss, not a leak, and therefore one no privacy test would catch.
 *
 * So both directions are driven end to end here, from `getDataSyncLevel` through
 * hydration, payload preparation (the in-process preparer this service builds
 * when none is injected) and out to the batch `sendBatch` receives.
 *
 * The sentinel is prose, not a credential.
 */

const TURN_TEXT_SENTINEL = "clsentinel-wiring-user-prompt";

test("the sync service withholds turn text when the machine is on the metadata level", async () => {
  const sent = await sendOneBatchAtLevel(DataSyncLevel.Metadata);
  // Anti-vacuity: the assertion below is satisfied by an ABSENT string, so a
  // tick that shipped nothing at all would pass it while observing no payload.
  assert.ok(sent.length > 0, "no batch was sent, so nothing was observed");
  assert.equal(
    JSON.stringify(sent).includes(TURN_TEXT_SENTINEL),
    false,
    "a metadata-level machine shipped turn text — the service is not forwarding its data-sync level to the payload producer"
  );
});

test("the sync service still ships turn text when the machine is on the full level", async () => {
  // POSITIVE CONTROL, and the assertion that actually needs the service to
  // forward the level: the producer's default is to withhold, so this is red
  // both when the wiring is missing and when it is wrong.
  const sent = await sendOneBatchAtLevel(DataSyncLevel.Full);
  assert.ok(sent.length > 0, "no batch was sent, so nothing was observed");
  assert.equal(
    JSON.stringify(sent).includes(TURN_TEXT_SENTINEL),
    true,
    "a full-level machine shipped no turn text — the service is withholding content the consent card says syncs at this level"
  );
});

/** Run one real sync tick on a machine reporting `level`, and return the batches. */
async function sendOneBatchAtLevel(
  level: DataSyncLevel
): Promise<AgentSessionSyncBatch[]> {
  const source = new FakeSyncSource([sessionWithTurnText()]);
  const sent: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getDataSyncLevel: () => level,
    sendBatch: (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true });
    },
  });
  service.start();
  await flushAgentSessionSync();
  service.stop();
  return sent;
}

function sessionWithTurnText(): SyncedAgentSession {
  return {
    ...makeSyncedSession("policy-wiring-session", "2026-06-08T12:00:00.000Z"),
    metadata: {
      messages: [
        {
          role: "user",
          timestamp: "2026-06-08T12:00:00.000Z",
          text: TURN_TEXT_SENTINEL,
        },
      ],
    } as SyncedAgentSession["metadata"],
  };
}
